// Manages ephemeral git workspaces in /tmp for GitHub push operations.
// GCFuse (Google Cloud Storage FUSE) is incompatible with git, so all
// git operations happen here in /tmp, never touching the data/ directory.

import { execFile as _execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(_execFile);
const BASE_TMP = "/tmp/amethyst-git";

function workspaceKey(userId, owner, repo) {
  // Sanitize to avoid path traversal
  const safe = (s) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safe(userId)}-${safe(owner)}-${safe(repo)}`;
}

export function getWorkspacePath(userId, owner, repo) {
  return path.join(BASE_TMP, workspaceKey(userId, owner, repo));
}

export function workspaceExists(userId, owner, repo) {
  return fs.existsSync(path.join(getWorkspacePath(userId, owner, repo), ".git"));
}

// Clone the repo if the workspace doesn't exist, or pull latest if it does.
// The token is embedded in the HTTPS remote URL and not persisted on disk.
export async function ensureWorkspace(userId, token, owner, repo, branch) {
  await fs.promises.mkdir(BASE_TMP, { recursive: true });
  const wsPath = getWorkspacePath(userId, owner, repo);
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  if (workspaceExists(userId, owner, repo)) {
    // Pull latest on the tracked branch — reset any local changes first.
    await execFile("git", ["-C", wsPath, "fetch", "origin"], { env: gitEnv() });
    await execFile("git", ["-C", wsPath, "checkout", branch], { env: gitEnv() });
    await execFile("git", ["-C", wsPath, "reset", "--hard", `origin/${branch}`], { env: gitEnv() });
    // Update the remote URL in case the token changed.
    await execFile("git", ["-C", wsPath, "remote", "set-url", "origin", remoteUrl], {
      env: gitEnv(),
    });
  } else {
    await execFile("git", ["clone", "--depth", "1", "--branch", branch, remoteUrl, wsPath], {
      env: gitEnv(),
    });
  }
}

// Create a new local branch and write ontology content to the file path.
export async function writeOntologyToWorkspace(userId, owner, repo, branchName, filePath, content) {
  const wsPath = getWorkspacePath(userId, owner, repo);
  // Create new branch from HEAD (which is the tracked base branch after ensureWorkspace).
  // Use -B so a stale local branch from a prior push attempt is reset rather than erroring.
  await execFile("git", ["-C", wsPath, "checkout", "-B", branchName], { env: gitEnv() });

  // Write the file, creating parent dirs as needed.
  const fullPath = path.join(wsPath, filePath);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, content, "utf-8");
}

// Check out an existing remote branch and write ontology content.
// Used for follow-up pushes when the GitHub branch already exists.
// Assumes ensureWorkspace() was already called (so origin is reachable).
export async function writeToExistingBranch(userId, owner, repo, branchName, filePath, content) {
  const wsPath = getWorkspacePath(userId, owner, repo);
  // Explicitly fetch the branch by name — the workspace may have been cloned with
  // --single-branch so `git fetch origin` (no args) only updates the base branch.
  const remoteExists = await execFile("git", ["-C", wsPath, "fetch", "origin", branchName], {
    env: gitEnv(),
  })
    .then(() => true)
    .catch(() => false);

  if (remoteExists) {
    await execFile("git", ["-C", wsPath, "checkout", "-B", branchName, "FETCH_HEAD"], {
      env: gitEnv(),
    });
  } else {
    // Branch was deleted on remote (e.g. PR merged) — re-create from current HEAD.
    await execFile("git", ["-C", wsPath, "checkout", "-B", branchName], { env: gitEnv() });
  }
  const fullPath = path.join(wsPath, filePath);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, content, "utf-8");
}

// Stage a single file and commit it.
export async function commitFile(userId, owner, repo, filePath, commitMessage, author) {
  const wsPath = getWorkspacePath(userId, owner, repo);
  const env = {
    ...gitEnv(),
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  await execFile("git", ["-C", wsPath, "add", filePath], { env });
  let stdout;
  try {
    ({ stdout } = await execFile("git", ["-C", wsPath, "commit", "-m", commitMessage], { env }));
  } catch (err) {
    // "nothing to commit" means the workspace already has identical content.
    // Treat as success — the push step will still advance the remote ref if needed.
    const out = (err.stdout || "") + (err.stderr || "");
    if (out.includes("nothing to commit") || out.includes("nothing added to commit")) {
      const { stdout: headOut } = await execFile("git", ["-C", wsPath, "rev-parse", "HEAD"], {
        env: gitEnv(),
      });
      return { sha: headOut.trim() };
    }
    throw err;
  }
  // Extract commit SHA from output like "[branch abc1234] message"
  const shaMatch = stdout.match(/\[[\w/.-]+ ([0-9a-f]+)\]/);
  return { sha: shaMatch?.[1] || "unknown" };
}

// Push the local branch to GitHub origin.
// The remote URL already contains the token (set in ensureWorkspace).
export async function pushBranch(userId, token, owner, repo, branchName) {
  const wsPath = getWorkspacePath(userId, owner, repo);
  // Re-set the remote URL with the current token to ensure freshness.
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  await execFile("git", ["-C", wsPath, "remote", "set-url", "origin", remoteUrl], {
    env: gitEnv(),
  });
  await execFile("git", ["-C", wsPath, "push", "origin", branchName], { env: gitEnv() });
}

// Remove the workspace directory.
export async function cleanupWorkspace(userId, owner, repo) {
  const wsPath = getWorkspacePath(userId, owner, repo);
  await fs.promises.rm(wsPath, { recursive: true, force: true });
}

// List all active workspace directories (for debug/admin).
export async function listWorkspaces() {
  try {
    await fs.promises.mkdir(BASE_TMP, { recursive: true });
    const entries = await fs.promises.readdir(BASE_TMP, { withFileTypes: true });
    return await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const full = path.join(BASE_TMP, e.name);
          const stat = await fs.promises.stat(full).catch(() => null);
          return { path: full, name: e.name, mtime: stat?.mtimeMs };
        }),
    );
  } catch {
    return [];
  }
}

// Returns a clean environment for git — strips HOME-based credential helpers
// and disables interactive prompts so git never hangs waiting for input.
function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  };
}
