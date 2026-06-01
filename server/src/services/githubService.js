// GitHub REST + GraphQL API wrapper.
// All functions take a `token` (GitHub user access token) as their first arg.
// Throws GitHubError for API-level failures.
//
// GitHub App tokens expire after 8 hours. Call ensureFreshToken(userId) in
// route middleware instead of getUserGitHubToken to get an auto-refreshed token.

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "GitHubError";
  }
}

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

async function ghFetch(token, method, path, body) {
  // Prevent path-based SSRF: the path must be a relative GitHub API path.
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(`[github] invalid API path: ${String(path).slice(0, 80)}`);
  }
  const fullUrl = `${GITHUB_API}${path}`;
  // SSRF guard: verify the constructed URL resolves to the expected host.
  if (new URL(fullUrl).hostname !== "api.github.com") {
    throw new Error(`[github] SSRF guard: unexpected host in constructed URL`);
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Amethyst-Ontology-Editor",
  };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(fullUrl, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== null && Number(remaining) < 10) {
    console.warn(`[github] rate limit low: ${remaining} requests remaining`);
  }

  if (res.status === 204) return null;

  const data = res.headers.get("content-type")?.includes("application/json")
    ? await res.json()
    : await res.text();

  if (!res.ok) {
    const msg = data?.message || `GitHub API error ${res.status}`;
    throw new GitHubError(msg, res.status);
  }
  return data;
}

async function ghGraphQL(token, query, variables = {}) {
  const res = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Amethyst-Ontology-Editor",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new GitHubError(`GitHub GraphQL HTTP error ${res.status}`, res.status);
  }

  const json = await res.json();
  if (json.errors?.length) {
    const msg = json.errors[0].message;
    const status = json.errors[0].type === "NOT_FOUND" ? 404 : 422;
    throw new GitHubError(msg, status);
  }
  return json.data;
}

// ── Auth ──────────────────────────────────────────────────────────────────

export async function exchangeCodeForToken(code, clientId, clientSecret, redirectUri) {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Amethyst-Ontology-Editor",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json();
  if (data.error) throw new GitHubError(data.error_description || data.error, 400);
  // GitHub App response: { access_token, expires_in, refresh_token, refresh_token_expires_in, scope, token_type }
  // OAuth App response:  { access_token, scope, token_type }  (no expiry fields)
  return data;
}

// Exchange a refresh token for a new user access token (GitHub App only).
export async function refreshUserToken(clientId, clientSecret, refreshToken) {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Amethyst-Ontology-Editor",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new GitHubError(data.error_description || data.error, 401);
  return data; // { access_token, expires_in, refresh_token, refresh_token_expires_in, scope }
}

// Returns a valid token for userId, refreshing it if it's within 5 min of expiry.
// Returns null and clears the connection if the token is unrecoverable.
// Use this instead of getUserGitHubToken in route middleware.
export async function ensureFreshToken(userId) {
  const { getUserGitHubToken, updateGitHubToken, clearGitHubConnection } = await import(
    "./authDb.js"
  );
  const cred = await getUserGitHubToken(userId);
  if (!cred) return null;

  // PATs and OAuth App tokens have no expiresAt — return as-is.
  if (!cred.expiresAt) return cred;

  const REFRESH_WINDOW_MS = 5 * 60 * 1000;
  if (Date.now() < cred.expiresAt - REFRESH_WINDOW_MS) return cred;

  // Token is expired or about to expire — refresh it.
  if (!cred.refreshToken || !process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    await clearGitHubConnection(userId);
    return null;
  }

  try {
    const refreshed = await refreshUserToken(
      process.env.GITHUB_CLIENT_ID,
      process.env.GITHUB_CLIENT_SECRET,
      cred.refreshToken,
    );
    const newExpiresAt = refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : null;
    const updated = {
      token: refreshed.access_token,
      scope: refreshed.scope || cred.scope,
      expiresAt: newExpiresAt,
      refreshToken: refreshed.refresh_token || cred.refreshToken,
    };
    await updateGitHubToken(userId, updated);
    return { ...cred, ...updated };
  } catch (err) {
    console.error("[github] Token refresh failed for user", userId, "—", err.message);
    await clearGitHubConnection(userId);
    return null;
  }
}

export async function getGitHubUser(token) {
  return ghFetch(token, "GET", "/user");
  // Returns: { id, login, email, name, ... }
}

export async function validateToken(token) {
  try {
    await ghFetch(token, "GET", "/user");
    return true;
  } catch {
    return false;
  }
}

// ── Repo operations ───────────────────────────────────────────────────────

const ONTOLOGY_EXTENSIONS = /\.(ttl|owl|rdf|n3|jsonld|nt|nq|trig)$/i;

export async function listOntologyFiles(token, owner, repo, branch = "HEAD") {
  const data = await ghFetch(
    token,
    "GET",
    `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
  );
  if (!data?.tree) return [];
  return data.tree
    .filter((item) => item.type === "blob" && ONTOLOGY_EXTENSIONS.test(item.path))
    .map(({ path, sha, size }) => ({ path, sha, size }));
}

export async function fetchFileContent(token, owner, repo, filePath, ref = "HEAD") {
  const data = await ghFetch(
    token,
    "GET",
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${ref}`,
  );
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { content, sha: data.sha };
}

export async function getRepoDefaultBranch(token, owner, repo) {
  const data = await ghFetch(token, "GET", `/repos/${owner}/${repo}`);
  return data.default_branch || "main";
}

export async function createPullRequest(token, owner, repo, { head, base, title, body }) {
  return ghFetch(token, "POST", `/repos/${owner}/${repo}/pulls`, {
    head,
    base,
    title,
    body: body || "",
  });
  // Returns: { number, html_url, state, ... }
}

// List all branches in a repo (paginates up to 300).
export async function listRepoBranches(token, owner, repo) {
  const branches = [];
  for (let page = 1; page <= 3; page++) {
    const page_data = await ghFetch(
      token,
      "GET",
      `/repos/${owner}/${repo}/branches?per_page=100&page=${page}`,
    );
    branches.push(...page_data);
    if (page_data.length < 100) break;
  }
  return branches.map((b) => ({ name: b.name, protected: b.protected }));
}

// List open PRs in a repo. Returns head branch name → { number, html_url, title } map.
export async function listOpenPRs(token, owner, repo) {
  const prs = await ghFetch(token, "GET", `/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
  const map = new Map();
  for (const pr of prs)
    map.set(pr.head.ref, { number: pr.number, html_url: pr.html_url, title: pr.title });
  return map;
}

export async function fetchRepoReadme(token, owner, repo) {
  try {
    const data = await ghFetch(token, "GET", `/repos/${owner}/${repo}/readme`);
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

// ── Discussions (GraphQL) ─────────────────────────────────────────────────

export async function getOrCreateDiscussionCategory(token, owner, repo, categoryName) {
  const repoData = await ghGraphQL(
    token,
    `query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        id
        discussionCategories(first: 25) {
          nodes { id name }
        }
      }
    }`,
    { owner, repo },
  );

  const categories = repoData.repository.discussionCategories.nodes;
  const existing = categories.find((c) => c.name === categoryName);
  if (existing) return existing.id;

  // Create the category (requires admin/maintainer on the repo)
  const created = await ghGraphQL(
    token,
    `mutation($repositoryId: ID!, $name: String!, $description: String!, $format: DiscussionCategoryFormat!) {
      createDiscussionCategory(input: {
        repositoryId: $repositoryId
        name: $name
        description: $description
        format: $format
      }) {
        discussionCategory { id name }
      }
    }`,
    {
      repositoryId: repoData.repository.id,
      name: categoryName,
      description: "Discussions synced from Amethyst Ontology Editor",
      format: "OPEN_ENDED",
    },
  );
  return created.createDiscussionCategory.discussionCategory.id;
}

export async function listDiscussions(
  token,
  owner,
  repo,
  { categoryName = "Amethyst", after } = {},
) {
  const repoData = await ghGraphQL(
    token,
    `query($owner: String!, $repo: String!, $after: String) {
      repository(owner: $owner, name: $repo) {
        discussions(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            number
            title
            body
            url
            createdAt
            updatedAt
            author { login }
            category { name }
            comments(first: 50) {
              nodes {
                id
                body
                url
                createdAt
                updatedAt
                author { login }
                replies(first: 25) {
                  nodes {
                    id
                    body
                    createdAt
                    updatedAt
                    author { login }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { owner, repo, after: after || null },
  );

  const allDiscussions = repoData.repository.discussions.nodes;
  return allDiscussions.filter((d) => d.category?.name === categoryName);
}

export async function createDiscussion(token, owner, repo, { categoryId, title, body }) {
  const repoData = await ghGraphQL(
    token,
    `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id } }`,
    { owner, repo },
  );

  const result = await ghGraphQL(
    token,
    `mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {
        repositoryId: $repositoryId
        categoryId: $categoryId
        title: $title
        body: $body
      }) {
        discussion { id number url }
      }
    }`,
    { repositoryId: repoData.repository.id, categoryId, title, body },
  );
  return result.createDiscussion.discussion;
}

export async function addDiscussionComment(
  token,
  _owner,
  _repo,
  { discussionId, body, replyToId },
) {
  const result = await ghGraphQL(
    token,
    `mutation($discussionId: ID!, $body: String!, $replyToId: ID) {
      addDiscussionComment(input: {
        discussionId: $discussionId
        body: $body
        replyToId: $replyToId
      }) {
        comment { id url }
      }
    }`,
    { discussionId, body, replyToId: replyToId || null },
  );
  return result.addDiscussionComment.comment;
}

export async function updateDiscussionComment(token, _owner, _repo, { commentId, body }) {
  const result = await ghGraphQL(
    token,
    `mutation($commentId: ID!, $body: String!) {
      updateDiscussionComment(input: { commentId: $commentId, body: $body }) {
        comment { id }
      }
    }`,
    { commentId, body },
  );
  return result.updateDiscussionComment.comment;
}

// ── Issues ────────────────────────────────────────────────────────────────────

export async function listIssues(
  token,
  owner,
  repo,
  { state = "open", page = 1, perPage = 30 } = {},
) {
  return ghFetch(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}&page=${page}&pulls=false`,
  );
}

export async function getIssue(token, owner, repo, number) {
  return ghFetch(token, "GET", `/repos/${owner}/${repo}/issues/${number}`);
}

export async function getIssueComments(
  token,
  owner,
  repo,
  number,
  { page = 1, perPage = 50 } = {},
) {
  return ghFetch(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${number}/comments?per_page=${perPage}&page=${page}`,
  );
}

export async function createIssueComment(token, owner, repo, number, body) {
  return ghFetch(token, "POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
}

export async function createIssue(token, owner, repo, { title, body, labels }) {
  return ghFetch(token, "POST", `/repos/${owner}/${repo}/issues`, { title, body, labels });
}
