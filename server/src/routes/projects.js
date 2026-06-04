import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Router } from "express";
import { namedNode } from "oxigraph";
import { v4 as uuid } from "uuid";
import { requireAuth, requireProjectRole } from "../middleware/auth.js";
import {
  addProjectMember,
  deleteProjectWithOntologies,
  getCommentsList,
  getDb,
  getInvitesForProject,
  getOntology,
  getProject,
  insertCommentRecord,
  insertInviteRecord,
  insertOntologyRecord,
  insertProjectRecord,
  listOntologiesForProject,
  listProjectsWithOntologiesForUser,
  listUsers,
  logChange,
  removeProjectMember,
  setOntologyBranchLineage,
  setOntologyImported,
  updateCommentRecord,
  updateInviteEmailStatus,
  updateOntologyGitHubSync,
  updateOntologyPrUrl,
  updateProjectGitHub,
  updateProjectRecord,
} from "../services/authDb.js";
import {
  addDiscussionComment,
  createDiscussion,
  createIssue,
  createIssueComment,
  createPullRequest,
  ensureFreshToken,
  fetchFileContent,
  GitHubError,
  getGitHubUser,
  getIssue,
  getIssueComments,
  getOrCreateDiscussionCategory,
  getRepoDefaultBranch,
  listDiscussions,
  listIssues,
  listOntologyFiles,
  listOpenPRs,
  listRepoBranches,
} from "../services/githubService.js";
import { isMailerConfigured, sendInviteEmail } from "../services/mailer.js";
import {
  copyOntologyGraph,
  dropOntologyGraph,
  enrichOntology,
  exportOntologyAs,
  getOntologyImportIris,
  getOntologyRdfMeta,
  getOntologySubjectIri,
  getStore,
  graphIriFor,
  loadOntologyFromText,
  persistOntology,
  writeFileToDisk,
} from "../services/rdfStore.js";
import { detectFormat, resolveOwlImportsAsSiblings } from "./import.js";

const execFileP = promisify(execFile);
const router = Router();
const INVITE_EXPIRY_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

async function projectFromParam(req, res, next) {
  const p = await getProject(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  req.project = p;
  req.projectId = p.id;
  next();
}

// GET /api/projects  — list projects (and their ontologies) visible to the caller.
router.get("/", requireAuth, async (req, res) => {
  const { id, role } = req.session.user;
  const projects = await listProjectsWithOntologiesForUser(id);

  // Include the caller's project-level role in each project object so the
  // client can conditionally show manager-only UI (Users button, delete, etc.)
  // without a separate per-project membership fetch.
  const memberRoles =
    role === "admin"
      ? []
      : await getDb().query("SELECT project_id, role FROM project_members WHERE user_id = ?", [id]);
  const roleMap = new Map(memberRoles.map((r) => [r.project_id, r.role]));

  res.set("Cache-Control", "private, max-age=15");
  res.json({
    projects: projects.map((p) => ({
      ...p,
      userRole: role === "admin" ? "manager" : roleMap.get(p.id) || "viewer",
      ontologies: (p.ontologies || []).map(enrichOntology),
    })),
  });
});

// POST /api/projects  { name, description?, ontologyName?, ontologyIri?, skipOntology? }
// Pass skipOntology:true when the project will be immediately populated via GitHub sync.
router.post("/", requireAuth, async (req, res) => {
  const { name, description, ontologyName, ontologyIri, skipOntology } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const pid = uuid();
  const now = Date.now();
  const userId = req.session.user.id;

  await insertProjectRecord({ id: pid, name, description, now, userId });
  await addProjectMember(pid, userId, "manager");

  let oid = null;
  if (!skipOntology) {
    oid = uuid();
    await insertOntologyRecord({
      id: oid,
      name: ontologyName || name,
      iri: ontologyIri || null,
      description: null,
      projectId: pid,
      now,
      userId,
    });
    persistOntology(oid);
  }

  await logChange(userId, oid || pid, "create-project", { name, projectId: pid });
  const project = await getProject(pid);
  const ontologies = await listOntologiesForProject(pid);
  res.json({
    project: { ...project, ontologies: ontologies.map(enrichOntology) },
  });
});

// GET /api/projects/:id
router.get(
  "/:id",
  requireAuth,
  projectFromParam,
  requireProjectRole("viewer"),
  async (req, res) => {
    const ontologies = await listOntologiesForProject(req.params.id);
    res.json({
      project: { ...req.project, ontologies: ontologies.map(enrichOntology) },
    });
  },
);

// PATCH /api/projects/:id  { name?, description? }
router.patch(
  "/:id",
  requireAuth,
  projectFromParam,
  requireProjectRole("editor"),
  async (req, res) => {
    const { name, description } = req.body || {};
    await updateProjectRecord(req.params.id, {
      name,
      description,
      now: Date.now(),
      userId: req.session.user.id,
    });
    await logChange(req.session.user.id, null, "update-project", {
      id: req.params.id,
      name,
    });
    const updated = await getProject(req.params.id);
    const ontologies = await listOntologiesForProject(req.params.id);
    res.json({
      project: { ...updated, ontologies: ontologies.map(enrichOntology) },
    });
  },
);

// DELETE /api/projects/:id
router.delete(
  "/:id",
  requireAuth,
  projectFromParam,
  requireProjectRole("manager"),
  async (req, res) => {
    const children = await listOntologiesForProject(req.params.id);
    await Promise.allSettled(children.map((o) => dropOntologyGraph(o.id).catch(() => {})));
    await deleteProjectWithOntologies(
      req.params.id,
      children.map((o) => o.id),
    );
    await logChange(req.session.user.id, null, "delete-project", {
      id: req.params.id,
      name: req.project.name,
    });
    res.json({ ok: true });
  },
);

// GET /api/projects/:id/members
router.get(
  "/:id/members",
  requireAuth,
  projectFromParam,
  requireProjectRole("viewer"),
  async (req, res) => {
    const rows = await getDb().query(
      `SELECT pm.user_id, pm.role, pm.created_at, u.username, u.email
     FROM project_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ? ORDER BY pm.created_at ASC`,
      [req.params.id],
    );
    res.json({ members: rows });
  },
);

// PUT /api/projects/:id/members/:userId  { role }
router.put(
  "/:id/members/:userId",
  requireAuth,
  projectFromParam,
  requireProjectRole("manager"),
  async (req, res) => {
    const { role } = req.body || {};
    if (!["manager", "editor", "viewer"].includes(role))
      return res.status(400).json({ error: "role must be manager|editor|viewer" });
    await addProjectMember(req.params.id, req.params.userId, role);
    await logChange(req.session.user.id, null, "project-member-set", {
      projectId: req.params.id,
      userId: req.params.userId,
      role,
    });
    res.json({ ok: true });
  },
);

// DELETE /api/projects/:id/members/:userId
router.delete(
  "/:id/members/:userId",
  requireAuth,
  projectFromParam,
  requireProjectRole("manager"),
  async (req, res) => {
    await removeProjectMember(req.params.id, req.params.userId);
    await logChange(req.session.user.id, null, "project-member-remove", {
      projectId: req.params.id,
      userId: req.params.userId,
    });
    res.json({ ok: true });
  },
);

// GET /api/projects/:id/invites — list invites for this project
router.get(
  "/:id/invites",
  requireAuth,
  projectFromParam,
  requireProjectRole("manager"),
  async (req, res) => {
    const invites = await getInvitesForProject(req.params.id);
    res.json({ invites, mailerConfigured: isMailerConfigured() });
  },
);

// POST /api/projects/:id/invites — send invite for this project
router.post(
  "/:id/invites",
  requireAuth,
  projectFromParam,
  requireProjectRole("manager"),
  async (req, res) => {
    const { email: rawEmail, projectRole = "editor" } = req.body || {};
    const email = rawEmail ? String(rawEmail).trim() : null;
    if (email) {
      const _at = email.indexOf("@");
      if (
        email.length > 254 ||
        _at < 1 ||
        _at === email.length - 1 ||
        email.lastIndexOf(".") <= _at
      )
        return res.status(400).json({ error: "invalid email" });
    }
    if (!["manager", "editor", "viewer"].includes(projectRole))
      return res.status(400).json({ error: "projectRole must be manager|editor|viewer" });

    const token = crypto.randomBytes(24).toString("base64url");
    const now = Date.now();
    const expires = now + INVITE_EXPIRY_MS;

    await insertInviteRecord({
      token,
      email,
      invitedBy: req.session.user.id,
      role: "user", // server role
      projectId: req.params.id,
      projectRole,
      now,
      expires,
    });

    const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const inviteUrl = `${baseUrl}/invite/${token}`;

    let emailResult = { sent: false, reason: email ? "SMTP not configured" : "no email" };
    if (email && isMailerConfigured()) {
      emailResult = await sendInviteEmail({
        to: email,
        inviteUrl,
        invitedBy: req.session.user.username,
        role: projectRole,
      });
      await updateInviteEmailStatus(token, emailResult.sent, emailResult.reason);
    }

    await logChange(req.session.user.id, null, "create-project-invite", {
      email: email || null,
      projectId: req.params.id,
      projectRole,
      emailSent: emailResult.sent,
    });

    res.json({
      invite: {
        token,
        email,
        project_id: req.params.id,
        project_role: projectRole,
        inviteUrl,
        created_at: now,
        expires_at: expires,
        email_sent: emailResult.sent,
        email_error: emailResult.sent ? null : emailResult.reason || null,
      },
    });
  },
);

// DELETE /api/projects/:id/invites/:token — revoke invite
router.delete(
  "/:id/invites/:token",
  requireAuth,
  projectFromParam,
  requireProjectRole("manager"),
  async (req, res) => {
    const { deleteInviteRecord } = await import("../services/authDb.js");
    await deleteInviteRecord(req.params.token);
    await logChange(req.session.user.id, null, "revoke-project-invite", {
      projectId: req.params.id,
      token: req.params.token,
    });
    res.json({ ok: true });
  },
);

// GET /api/projects/:id/users — all users (for manager to add to project)
router.get(
  "/:id/users",
  requireAuth,
  projectFromParam,
  requireProjectRole("manager"),
  async (req, res) => {
    const users = await listUsers();
    res.json({ users });
  },
);

// ── GitHub integration ──────────────────────────────────────────────────────

async function requireGitHubToken(req, res, next) {
  const conn = await ensureFreshToken(req.session.user.id);
  if (!conn?.token) {
    return res.status(401).json({
      error: "GitHub connection required. Go to Settings → GitHub to connect your account.",
      code: "github_not_connected",
    });
  }
  req.githubToken = conn.token;
  req.githubLogin = conn.login;
  req.githubScope = conn.scope || "";
  next();
}

// PATCH /api/projects/:id/github — set or update the GitHub repo for a project
router.patch(
  "/:id/github",
  requireAuth,
  projectFromParam,
  requireProjectRole("manager"),
  async (req, res) => {
    const { github_repo, github_branch } = req.body || {};
    if (!github_repo) return res.status(400).json({ error: "github_repo is required" });
    if (!/^[\w.-]+\/[\w.-]+$/.test(github_repo))
      return res.status(400).json({ error: "github_repo must be in 'owner/repo' format" });

    const conn = await ensureFreshToken(req.session.user.id);
    const [owner, repo] = github_repo.split("/");
    let resolvedBranch = github_branch;
    if (!resolvedBranch && conn?.token) {
      try {
        resolvedBranch = await getRepoDefaultBranch(conn.token, owner, repo);
      } catch {
        resolvedBranch = "main";
      }
    }
    resolvedBranch = resolvedBranch || "main";

    await updateProjectGitHub(req.params.id, {
      githubRepo: github_repo,
      githubBranch: resolvedBranch,
      now: Date.now(),
      userId: req.session.user.id,
    });
    await logChange(req.session.user.id, null, "set-github-repo", {
      projectId: req.params.id,
      github_repo,
      github_branch: resolvedBranch,
    });
    const updated = await getProject(req.params.id);
    res.json({ project: updated });
  },
);

// POST /api/projects/:id/github/sync — pull ontology files from the repo
router.post(
  "/:id/github/sync",
  requireAuth,
  projectFromParam,
  requireProjectRole("editor"),
  requireGitHubToken,
  async (req, res) => {
    const project = req.project;
    if (!project.github_repo)
      return res.status(400).json({ error: "No GitHub repo configured for this project." });

    const [owner, repo] = project.github_repo.split("/");
    const branch = project.github_branch || "main";

    try {
      const files = await listOntologyFiles(req.githubToken, owner, repo, branch);
      if (!files.length) return res.json({ synced: 0, unchanged: 0, errors: [], ontologies: [] });

      const existing = await listOntologiesForProject(project.id);
      const byPath = new Map(existing.filter((o) => o.github_path).map((o) => [o.github_path, o]));

      const synced = [];
      const errors = [];
      // shared visited set prevents re-fetching the same import IRI across files
      const importVisited = new Set();
      const importedIds = new Set();

      for (const file of files) {
        try {
          const existingOntology = byPath.get(file.path);
          // If sha matches but the in-memory graph is empty (e.g. .ttl file was missing
          // at startup), treat as "updated" so we re-fetch and reload the content.
          const graphIsEmpty = existingOntology
            ? getStore()
                .match(null, null, null, namedNode(graphIriFor(existingOntology.id)))
                [Symbol.iterator]()
                .next().done
            : false;
          if (existingOntology?.github_sha === file.sha && !graphIsEmpty) {
            console.log(
              `[github-sync] file ${file.path} sha=${file.sha} → unchanged (id=${existingOntology.id})`,
            );
            // Backfill missing metadata from the already-loaded graph (no re-fetch needed).
            if (existingOntology && (!existingOntology.description || !existingOntology.iri)) {
              const detectedIri = !existingOntology.iri
                ? getOntologySubjectIri(existingOntology.id)
                : null;
              const { title: rdfTitle, description: rdfDescription } = getOntologyRdfMeta(
                existingOntology.id,
              );
              const bFields = [];
              const bVals = [];
              if (detectedIri) {
                bFields.push("iri = ?");
                bVals.push(detectedIri);
              }
              if (rdfTitle) {
                bFields.push("name = ?");
                bVals.push(rdfTitle);
              }
              if (rdfDescription && !existingOntology.description) {
                bFields.push("description = ?");
                bVals.push(rdfDescription);
              }
              if (bFields.length) {
                bVals.push(Date.now(), existingOntology.id);
                await getDb().run(
                  `UPDATE ontologies SET ${bFields.join(", ")}, updated_at = ? WHERE id = ?`,
                  bVals,
                );
              }
            }
            synced.push({ path: file.path, status: "unchanged" });
            continue;
          }

          const { content, sha } = await fetchFileContent(
            req.githubToken,
            owner,
            repo,
            file.path,
            branch,
          );
          const fileName = file.path
            .split("/")
            .pop()
            .replace(/\.(ttl|owl|rdf|n3|jsonld|nt|nq|trig)$/i, "");
          const format = detectFormat(file.path, null);

          // Construct the raw GitHub URL so the RDF parser can resolve relative
          // IRIs (e.g. owl:imports <../other.ttl>) against the file's location.
          const rawGitHubUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;

          console.log(
            `[github-sync] file ${file.path} sha=${sha} → ${existingOntology ? "updated" : "created"} baseIri=${rawGitHubUrl} fmt=${format} bytes=${content.length}`,
          );
          let ontologyId;
          if (existingOntology) {
            ontologyId = existingOntology.id;
            await loadOntologyFromText(ontologyId, content, {
              replace: true,
              format,
              baseIri: rawGitHubUrl,
            });
            await updateOntologyGitHubSync(ontologyId, {
              githubPath: file.path,
              githubSha: sha,
              now: Date.now(),
            });
            synced.push({ path: file.path, status: "updated", ontologyId });
          } else {
            ontologyId = uuid();
            const now = Date.now();
            await insertOntologyRecord({
              id: ontologyId,
              name: fileName,
              iri: null,
              description: null,
              projectId: project.id,
              now,
              userId: req.session.user.id,
            });
            try {
              await loadOntologyFromText(ontologyId, content, {
                replace: false,
                format,
                baseIri: rawGitHubUrl,
              });
            } catch (loadErr) {
              // Roll back the orphan DB record so next sync can retry cleanly.
              try {
                await getDb().run("DELETE FROM ontologies WHERE id = ?", [ontologyId]);
              } catch {}
              throw loadErr;
            }
            await updateOntologyGitHubSync(ontologyId, {
              githubPath: file.path,
              githubSha: sha,
              now,
            });
            synced.push({ path: file.path, status: "created", ontologyId });
          }

          // Mirror what import.js does: detect IRI from owl:Ontology subject
          // (resolves @base / relative <> declarations) and prefer RDF title
          // over the filename fallback.
          const detectedIri = getOntologySubjectIri(ontologyId);
          const { title: rdfTitle, description: rdfDescription } = getOntologyRdfMeta(ontologyId);
          console.log(
            `[github-sync] file ${file.path} id=${ontologyId} detectedIri=${detectedIri || "none"} title=${rdfTitle || "none"} desc=${rdfDescription ? "yes" : "no"}`,
          );
          if (detectedIri || rdfTitle || rdfDescription) {
            const fields = [];
            const vals = [];
            if (detectedIri && !existingOntology?.iri) {
              fields.push("iri = ?");
              vals.push(detectedIri);
            }
            if (rdfTitle) {
              fields.push("name = ?");
              vals.push(rdfTitle);
            }
            if (rdfDescription && !existingOntology?.description) {
              fields.push("description = ?");
              vals.push(rdfDescription);
            }
            if (fields.length) {
              vals.push(Date.now(), ontologyId);
              await getDb().run(
                `UPDATE ontologies SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`,
                vals,
              );
            }
          }

          // Resolve owl:imports using the same logic as URL/file imports.
          const gNode = namedNode(graphIriFor(ontologyId));
          const { created: siblings, failed: importFailed } = await resolveOwlImportsAsSiblings(
            getStore(),
            gNode,
            project.id,
            req.session.user.id,
            importVisited,
          );
          console.log(
            `[github-sync] file ${file.path} owl:imports: created=${siblings.length} failed=${importFailed.length}`,
          );
          for (const s of siblings) {
            importedIds.add(s.id);
            synced.push({ path: s.iri, status: "created", ontologyId: s.id, imported: true });
          }
          for (const f of importFailed) {
            errors.push({ path: f.iri, error: f.error });
          }
        } catch (err) {
          console.warn(`[github-sync] skipping ${file.path}: ${err.message}`);
          errors.push({ path: file.path, error: err.message });
        }
      }

      // Dedup: remove ontology rows for the same IRI that accumulated from prior
      // triple-imports (same ontology loaded via file, canonical IRI, and raw URL).
      // Keep the row with a github_path; fall back to the oldest created_at.
      const freshOntologies = await listOntologiesForProject(project.id);
      const byIriGroups = new Map();
      for (const o of freshOntologies) {
        if (!o.iri) continue;
        if (o.branch_of) continue; // branches intentionally share parent IRI — never dedup them
        if (!byIriGroups.has(o.iri)) byIriGroups.set(o.iri, []);
        byIriGroups.get(o.iri).push(o);
      }
      for (const [iri, group] of byIriGroups) {
        if (group.length < 2) continue;
        group.sort((a, b) => {
          if (a.github_path && !b.github_path) return -1;
          if (!a.github_path && b.github_path) return 1;
          return (a.created_at || 0) - (b.created_at || 0);
        });
        const kept = group[0];
        console.log(
          `[github-sync] dedup iri=${iri} keeping id=${kept.id} github_path=${kept.github_path || "none"} removing ${group.length - 1} dup(s)`,
        );
        for (const dup of group.slice(1)) {
          console.log(
            `[github-sync] dedup removing id=${dup.id} github_path=${dup.github_path || "none"}`,
          );
          await dropOntologyGraph(dup.id).catch(() => {});
          await getDb().run("DELETE FROM ontologies WHERE id = ?", [dup.id]);
        }
      }

      // Persist is_imported flag.
      // importedIds only contains IDs discovered during this sync run; unchanged
      // ontologies were skipped so their owl:imports were never traversed. Scan
      // the RDF store for every project ontology to pick up imports from skipped files.
      const finalOntologies = await listOntologiesForProject(project.id);
      const byIri = new Map(finalOntologies.filter((o) => o.iri).map((o) => [o.iri, o.id]));
      for (const o of finalOntologies) {
        for (const importIri of getOntologyImportIris(o.id)) {
          const importedId = byIri.get(importIri);
          if (importedId) importedIds.add(importedId);
        }
      }
      await Promise.all(
        finalOntologies.map((o) => setOntologyImported(o.id, importedIds.has(o.id))),
      );

      await logChange(req.session.user.id, null, "github-sync", {
        projectId: project.id,
        repo: project.github_repo,
        synced: synced.filter((s) => s.status !== "unchanged").length,
        errors: errors.length,
      });

      const ontologies = await listOntologiesForProject(project.id);
      res.json({
        synced: synced.filter((s) => s.status !== "unchanged").length,
        unchanged: synced.filter((s) => s.status === "unchanged").length,
        errors,
        ontologies: ontologies.map(enrichOntology),
      });
    } catch (err) {
      if (err instanceof GitHubError) {
        if (err.status === 401)
          return res.status(401).json({
            error: "GitHub token expired. Go to Settings → GitHub to reconnect.",
            code: "github_token_expired",
          });
        if (err.status === 404)
          return res.status(404).json({
            error: `Repository '${project.github_repo}' not found or not accessible.`,
          });
        if (err.status === 403)
          return res.status(403).json({
            error: "GitHub API rate limit exceeded or insufficient permissions.",
          });
      }
      console.error("[github-sync] error:", err);
      res.status(500).json({ error: `Sync failed: ${err.message}` });
    }
  },
);

// GET /api/projects/:id/github/branches
// Returns all repo branches with open-PR info for the branch picker.
router.get(
  "/:id/github/branches",
  requireAuth,
  projectFromParam,
  requireProjectRole("viewer"),
  requireGitHubToken,
  async (req, res) => {
    const project = req.project;
    if (!project.github_repo)
      return res.status(400).json({ error: "No GitHub repo configured for this project." });
    const [owner, repo] = project.github_repo.split("/");
    try {
      const defaultBranch = await getRepoDefaultBranch(req.githubToken, owner, repo);
      const [branches, prMap] = await Promise.all([
        listRepoBranches(req.githubToken, owner, repo),
        listOpenPRs(req.githubToken, owner, repo),
      ]);
      const result = branches
        .filter((b) => b.name !== defaultBranch)
        .map((b) => {
          const pr = prMap.get(b.name);
          return {
            name: b.name,
            prUrl: pr?.html_url || null,
            prNumber: pr?.number || null,
            prTitle: pr?.title || null,
          };
        });
      res.json({ branches: result, defaultBranch });
    } catch (err) {
      if (err instanceof GitHubError && err.status === 401)
        return res
          .status(401)
          .json({ error: "GitHub token expired.", code: "github_token_expired" });
      res.status(500).json({ error: err.message });
    }
  },
);

// POST /api/projects/:id/ontologies/:ontologyId/github/checkout
// Connect an existing GitHub branch to this ontology as an in-app branch.
router.post(
  "/:id/ontologies/:ontologyId/github/checkout",
  requireAuth,
  projectFromParam,
  requireProjectRole("editor"),
  requireGitHubToken,
  async (req, res) => {
    const project = req.project;
    if (!project.github_repo)
      return res.status(400).json({ error: "No GitHub repo configured for this project." });

    const ontology = await getOntology(req.params.ontologyId);
    if (!ontology || ontology.project_id !== project.id)
      return res.status(404).json({ error: "Ontology not found." });
    if (!ontology.github_path)
      return res
        .status(400)
        .json({ error: "Ontology is not linked to a GitHub file. Sync first." });

    const { branch_name, pr_url } = req.body || {};
    if (!branch_name) return res.status(400).json({ error: "branch_name is required." });

    const [owner, repo] = project.github_repo.split("/");
    const { createBranch } = await import("../services/ontologyGit.js");

    try {
      const { content } = await fetchFileContent(
        req.githubToken,
        owner,
        repo,
        ontology.github_path,
        branch_name,
      );

      const branchId = uuid();
      const now = Date.now();
      const userId = req.session.user.id;

      await insertOntologyRecord({
        id: branchId,
        name: `${ontology.name} [${branch_name.replace(/^amethyst\//, "")}]`,
        iri: ontology.iri || null,
        description: null,
        projectId: project.id,
        now,
        userId,
      });
      await setOntologyBranchLineage(branchId, {
        branchOf: ontology.id,
        branchedAt: now,
        branchedFromVersion: ontology.updated_at,
        githubPath: ontology.github_path,
        githubBranchName: branch_name,
      });
      if (pr_url) await updateOntologyPrUrl(branchId, pr_url);

      await writeFileToDisk(ontology.id);
      await createBranch(branchId, ontology.id);
      await loadOntologyFromText(branchId, content, { replace: true });

      await logChange(userId, branchId, "github-checkout", {
        repo: project.github_repo,
        branch: branch_name,
        filePath: ontology.github_path,
      });

      const record = await getOntology(branchId);
      res.json({ ontology: enrichOntology(record) });
    } catch (err) {
      if (err instanceof GitHubError && err.status === 401)
        return res
          .status(401)
          .json({ error: "GitHub token expired.", code: "github_token_expired" });
      console.error("[github-checkout] error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// POST /api/projects/:id/ontologies/:ontologyId/github/push
router.post(
  "/:id/ontologies/:ontologyId/github/push",
  requireAuth,
  projectFromParam,
  requireProjectRole("editor"),
  requireGitHubToken,
  async (req, res) => {
    const project = req.project;
    if (!project.github_repo)
      return res.status(400).json({ error: "No GitHub repo configured for this project." });

    const ontology = await getOntology(req.params.ontologyId);
    if (!ontology || ontology.project_id !== project.id)
      return res.status(404).json({ error: "Ontology not found in this project." });

    // For local branches without a github_path, inherit the parent's path.
    let githubPath = ontology.github_path;
    if (!githubPath && ontology.branch_of) {
      const parent = await getOntology(ontology.branch_of);
      githubPath = parent?.github_path || null;
    }
    if (!githubPath)
      return res
        .status(400)
        .json({ error: "Ontology is not linked to a GitHub file. Sync first." });

    // Fine-grained PATs don't carry OAuth scopes — their permissions are checked
    // by the GitHub API itself. Only block classic tokens that explicitly lack repo scope.
    const isFineGrained = req.githubScope === "fine-grained" || !req.githubScope.includes(":");
    if (!isFineGrained && !req.githubScope.includes("repo"))
      return res.status(403).json({
        error: "Repository write access required. Go to Settings → GitHub to upgrade your access.",
        code: "github_needs_repo_scope",
      });

    const [owner, repo] = project.github_repo.split("/");
    const baseBranch = project.github_branch || "main";
    const userId = req.session.user.id;

    // Determine whether this is a follow-up push to an existing GitHub branch
    // (ontology already has branch_of + github_branch_name) or a fresh push from
    // a root ontology that should create both a new GitHub branch and an in-app branch.
    const isGitHubBranch = !!(ontology.branch_of && ontology.github_branch_name);
    const branchName = isGitHubBranch
      ? ontology.github_branch_name
      : (req.body?.branch_name || `amethyst/edit-${ontology.id.slice(0, 8)}-${Date.now()}`).trim();
    const commitMessage = (req.body?.commit_message || `Amethyst: update ${githubPath}`).trim();

    try {
      const {
        ensureWorkspace,
        writeOntologyToWorkspace,
        writeToExistingBranch,
        commitFile,
        pushBranch,
      } = await import("../services/gitWorkspace.js");
      const { createBranch } = await import("../services/ontologyGit.js");

      const pushFormat = detectFormat(githubPath, null);
      const content = await exportOntologyAs(ontology.id, pushFormat);
      const ghUser = await getGitHubUser(req.githubToken);

      await ensureWorkspace(userId, req.githubToken, owner, repo, baseBranch);

      if (isGitHubBranch) {
        // Follow-up push — branch already exists on GitHub; check it out and write.
        await writeToExistingBranch(userId, owner, repo, branchName, githubPath, content);
      } else {
        // First push from root (or local branch) — create new GitHub branch from base.
        await writeOntologyToWorkspace(userId, owner, repo, branchName, githubPath, content);
      }

      await commitFile(userId, owner, repo, githubPath, commitMessage, {
        name: ghUser.name || ghUser.login,
        email: ghUser.email || `${ghUser.login}@users.noreply.github.com`,
      });
      await pushBranch(userId, req.githubToken, owner, repo, branchName);

      let branchOntologyId = null;

      if (!isGitHubBranch) {
        if (ontology.branch_of) {
          // Local branch being pushed to GitHub for the first time — just wire up
          // the github_path and github_branch_name on the existing branch ontology.
          await setOntologyBranchLineage(ontology.id, {
            branchOf: ontology.branch_of,
            branchedAt: ontology.branched_at,
            branchedFromVersion: ontology.branched_from_version,
            githubPath,
            githubBranchName: branchName,
          });
          branchOntologyId = ontology.id;
        } else {
          // First push from root — create an in-app branch ontology backed by the new GitHub branch.
          branchOntologyId = uuid();
          const now = Date.now();
          await insertOntologyRecord({
            id: branchOntologyId,
            name: `${ontology.name} [${branchName.replace(/^amethyst\//, "")}]`,
            iri: ontology.iri || null,
            description: null,
            projectId: project.id,
            now,
            userId,
          });
          await setOntologyBranchLineage(branchOntologyId, {
            branchOf: ontology.id,
            branchedAt: now,
            branchedFromVersion: ontology.updated_at,
            githubPath,
            githubBranchName: branchName,
          });
          // Flush parent to disk, set up branch directory, copy RDF graph.
          await writeFileToDisk(ontology.id);
          await createBranch(branchOntologyId, ontology.id);
          copyOntologyGraph(ontology.id, branchOntologyId);
        }
      }

      await logChange(userId, isGitHubBranch ? ontology.id : branchOntologyId, "github-push", {
        repo: project.github_repo,
        branch: branchName,
        filePath: githubPath,
      });

      res.json({
        ok: true,
        branch: branchName,
        repo: project.github_repo,
        filePath: githubPath,
        ...(branchOntologyId ? { branchOntologyId } : {}),
      });
    } catch (err) {
      if (err instanceof GitHubError) {
        if (err.status === 401)
          return res
            .status(401)
            .json({ error: "GitHub token expired.", code: "github_token_expired" });
        if (err.status === 403)
          return res.status(403).json({
            error: "Push failed. Ensure your GitHub token has repo write access.",
            code: "github_needs_repo_scope",
          });
        if (err.status === 422)
          return res
            .status(422)
            .json({ error: `Branch '${req.body?.branch_name}' may already exist.` });
      }
      console.error("[github-push] error:", err);
      res.status(500).json({ error: `Push failed: ${err.message}` });
    }
  },
);

// POST /api/projects/:id/ontologies/:ontologyId/github/pr
router.post(
  "/:id/ontologies/:ontologyId/github/pr",
  requireAuth,
  projectFromParam,
  requireProjectRole("editor"),
  requireGitHubToken,
  async (req, res) => {
    const project = req.project;
    const ontology = await getOntology(req.params.ontologyId);
    if (!ontology || ontology.project_id !== project.id)
      return res.status(404).json({ error: "Ontology not found." });

    const { branch_name, title, body: prBody } = req.body || {};
    if (!branch_name) return res.status(400).json({ error: "branch_name is required" });

    const [owner, repo] = project.github_repo.split("/");
    const base = project.github_branch || "main";

    try {
      const pr = await createPullRequest(req.githubToken, owner, repo, {
        head: branch_name,
        base,
        title: title || `Amethyst: update ${ontology.github_path}`,
        body:
          prBody ||
          `Ontology changes to \`${ontology.github_path}\` created via Amethyst Ontology Editor.`,
      });

      await updateOntologyPrUrl(ontology.id, pr.html_url);
      await logChange(req.session.user.id, ontology.id, "github-pr-created", {
        prUrl: pr.html_url,
        prNumber: pr.number,
        branch: branch_name,
      });

      // Best-effort workspace cleanup.
      try {
        const { cleanupWorkspace } = await import("../services/gitWorkspace.js");
        await cleanupWorkspace(req.session.user.id, owner, repo);
      } catch {}

      res.json({ ok: true, pr_url: pr.html_url, pr_number: pr.number });
    } catch (err) {
      if (err instanceof GitHubError && err.status === 422)
        return res.status(422).json({
          error: "Could not create PR. The branch may not exist or a PR may already be open.",
        });
      console.error("[github-pr] error:", err);
      res.status(500).json({ error: `PR creation failed: ${err.message}` });
    }
  },
);

// POST /api/projects/:id/github/discussions/sync — bidirectional Discussions sync
router.post(
  "/:id/github/discussions/sync",
  requireAuth,
  projectFromParam,
  requireProjectRole("editor"),
  requireGitHubToken,
  async (req, res) => {
    const project = req.project;
    if (!project.github_repo)
      return res.status(400).json({ error: "No GitHub repo configured for this project." });

    const [owner, repo] = project.github_repo.split("/");
    try {
      // Get or create the Amethyst Discussions category.
      let categoryId;
      try {
        categoryId = await getOrCreateDiscussionCategory(req.githubToken, owner, repo, "Amethyst");
      } catch (_err) {
        return res.status(400).json({
          error:
            "Could not access or create a Discussions category. Ensure Discussions are enabled on the repo.",
        });
      }

      // Pull discussions from GitHub.
      const discussions = await listDiscussions(req.githubToken, owner, repo, {
        categoryName: "Amethyst",
      });

      const localOntologies = await listOntologiesForProject(project.id);
      const ontoByName = new Map(localOntologies.map((o) => [o.name.toLowerCase(), o]));

      let pulled = 0;
      let pushed = 0;
      const errors = [];

      for (const discussion of discussions) {
        try {
          // Resolve ontology from title: "[ontology name] — [IRI | General]"
          const titleMatch = discussion.title.match(/^(.+?)\s*—\s*(.+)$/);
          if (!titleMatch) continue;
          const [, ontoName, entityLabel] = titleMatch;
          const ontology = ontoByName.get(ontoName.trim().toLowerCase());
          if (!ontology) continue;

          const targetIri = entityLabel.trim() === "General" ? null : entityLabel.trim();
          const existingComments = await getCommentsList({
            ontologyIds: [ontology.id],
            iri: targetIri,
          });
          const byDiscussionId = new Map(
            existingComments
              .filter((c) => c.github_discussion_id)
              .map((c) => [c.github_discussion_id, c]),
          );

          // Upsert root comment (the Discussion body).
          if (!byDiscussionId.has(discussion.id)) {
            await insertCommentRecord({
              ontologyId: ontology.id,
              targetIri,
              userId: null,
              body: `**@${discussion.author?.login}** (GitHub): ${discussion.body}`,
              parentId: null,
              githubDiscussionId: discussion.id,
              githubSyncedAt: Date.now(),
            });
            pulled++;
          }

          // Pull in discussion comment replies.
          for (const comment of discussion.comments?.nodes || []) {
            const byCommentId = new Map(
              existingComments
                .filter((c) => c.github_comment_id)
                .map((c) => [c.github_comment_id, c]),
            );
            if (!byCommentId.has(comment.id)) {
              const rootLocal = existingComments.find(
                (c) => c.github_discussion_id === discussion.id,
              );
              if (rootLocal) {
                await insertCommentRecord({
                  ontologyId: ontology.id,
                  targetIri,
                  userId: null,
                  body: `**@${comment.author?.login}** (GitHub): ${comment.body}`,
                  parentId: rootLocal.id,
                  githubCommentId: comment.id,
                  githubSyncedAt: Date.now(),
                });
                pulled++;
              }
            }
          }
        } catch (err) {
          errors.push({ discussion: discussion.title, error: err.message });
        }
      }

      // Push unsynced local comments to GitHub.
      const allLocalComments = await getCommentsList({
        ontologyIds: localOntologies.map((o) => o.id),
        iri: undefined,
      });
      const unsynced = allLocalComments.filter(
        (c) => !c.github_discussion_id && !c.github_comment_id && !c.parent_id,
      );

      for (const comment of unsynced) {
        try {
          const ontology = localOntologies.find((o) => o.id === comment.ontology_id);
          if (!ontology) continue;
          const entityLabel = comment.target_iri || "General";
          const title = `${ontology.name} — ${entityLabel}`;

          const discussion = await createDiscussion(req.githubToken, owner, repo, {
            categoryId,
            title,
            body: comment.body,
          });

          await updateCommentRecord(comment.id, {
            githubDiscussionId: discussion.id,
            githubSyncedAt: Date.now(),
          });
          pushed++;

          // Push any replies to this root comment.
          const replies = allLocalComments.filter((c) => c.parent_id === comment.id);
          for (const reply of replies) {
            const ghComment = await addDiscussionComment(req.githubToken, owner, repo, {
              discussionId: discussion.id,
              body: reply.body,
            });
            await updateCommentRecord(reply.id, {
              githubCommentId: ghComment.id,
              githubSyncedAt: Date.now(),
            });
          }
        } catch (err) {
          errors.push({ commentId: comment.id, error: err.message });
        }
      }

      await logChange(req.session.user.id, null, "github-discussions-sync", {
        projectId: project.id,
        pulled,
        pushed,
        errors: errors.length,
      });
      res.json({ pulled, pushed, errors });
    } catch (err) {
      if (err instanceof GitHubError) {
        if (err.status === 401)
          return res
            .status(401)
            .json({ error: "GitHub token expired.", code: "github_token_expired" });
      }
      console.error("[github-discussions-sync] error:", err);
      res.status(500).json({ error: `Discussions sync failed: ${err.message}` });
    }
  },
);

// GET /api/projects/:id/github/issues?state=open|closed|all&page=1
router.get(
  "/:id/github/issues",
  requireAuth,
  projectFromParam,
  requireProjectRole("viewer"),
  requireGitHubToken,
  async (req, res) => {
    const project = req.project;
    if (!project.github_repo)
      return res.status(400).json({ error: "No GitHub repo configured for this project." });
    const [owner, repo] = project.github_repo.split("/");
    const { state = "open", page = 1 } = req.query;
    try {
      const issues = await listIssues(req.githubToken, owner, repo, {
        state,
        page: Number(page),
      });
      // GitHub issues API includes PRs; filter them out.
      res.json({ issues: (issues || []).filter((i) => !i.pull_request) });
    } catch (err) {
      if (err instanceof GitHubError && err.status === 401)
        return res
          .status(401)
          .json({ error: "GitHub token expired.", code: "github_token_expired" });
      res.status(500).json({ error: err.message });
    }
  },
);

// GET /api/projects/:id/github/issues/:number
router.get(
  "/:id/github/issues/:number",
  requireAuth,
  projectFromParam,
  requireProjectRole("viewer"),
  requireGitHubToken,
  async (req, res) => {
    const project = req.project;
    if (!project.github_repo)
      return res.status(400).json({ error: "No GitHub repo configured for this project." });
    const [owner, repo] = project.github_repo.split("/");
    const { number } = req.params;
    if (!/^\d+$/.test(number)) return res.status(400).json({ error: "Invalid issue number." });
    try {
      const [issue, comments] = await Promise.all([
        getIssue(req.githubToken, owner, repo, number),
        getIssueComments(req.githubToken, owner, repo, number),
      ]);
      res.json({ issue, comments: comments || [] });
    } catch (err) {
      if (err instanceof GitHubError && err.status === 401)
        return res
          .status(401)
          .json({ error: "GitHub token expired.", code: "github_token_expired" });
      res.status(500).json({ error: err.message });
    }
  },
);

// POST /api/projects/:id/github/issues
router.post(
  "/:id/github/issues",
  requireAuth,
  projectFromParam,
  requireProjectRole("editor"),
  requireGitHubToken,
  async (req, res) => {
    const project = req.project;
    if (!project.github_repo)
      return res.status(400).json({ error: "No GitHub repo configured for this project." });
    const [owner, repo] = project.github_repo.split("/");
    const { title, body, labels } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: "title is required" });
    try {
      const issue = await createIssue(req.githubToken, owner, repo, {
        title: title.trim(),
        body: body?.trim() || "",
        labels,
      });
      res.json({ issue });
    } catch (err) {
      if (err instanceof GitHubError && err.status === 401)
        return res
          .status(401)
          .json({ error: "GitHub token expired.", code: "github_token_expired" });
      res.status(500).json({ error: err.message });
    }
  },
);

// POST /api/projects/:id/github/issues/:number/comments
router.post(
  "/:id/github/issues/:number/comments",
  requireAuth,
  projectFromParam,
  requireProjectRole("editor"),
  requireGitHubToken,
  async (req, res) => {
    const project = req.project;
    if (!project.github_repo)
      return res.status(400).json({ error: "No GitHub repo configured for this project." });
    const [owner, repo] = project.github_repo.split("/");
    const { number } = req.params;
    if (!/^\d+$/.test(number)) return res.status(400).json({ error: "Invalid issue number." });
    const { body } = req.body || {};
    if (!body?.trim()) return res.status(400).json({ error: "body is required" });
    try {
      const comment = await createIssueComment(req.githubToken, owner, repo, number, body.trim());
      res.json({ comment });
    } catch (err) {
      if (err instanceof GitHubError && err.status === 401)
        return res
          .status(401)
          .json({ error: "GitHub token expired.", code: "github_token_expired" });
      res.status(500).json({ error: err.message });
    }
  },
);

// GET /api/projects/:id/github/compare/:ontologyId[?vsMain=true]
// Returns a unified diff of the current in-app content vs the file on GitHub.
// Branch ontologies compare against their own branch by default; ?vsMain=true forces the project default branch.
router.get(
  "/:id/github/compare/:ontologyId",
  requireAuth,
  projectFromParam,
  requireProjectRole("viewer"),
  requireGitHubToken,
  async (req, res) => {
    const project = req.project;
    if (!project.github_repo)
      return res.status(400).json({ error: "No GitHub repo configured for this project." });

    const ontology = await getOntology(req.params.ontologyId);
    if (!ontology || ontology.project_id !== project.id)
      return res.status(404).json({ error: "Ontology not found." });
    if (!ontology.github_path)
      return res.status(400).json({ error: "Ontology is not linked to a GitHub file." });

    const [owner, repo] = project.github_repo.split("/");
    const defaultBranch = project.github_branch || "main";
    // Branch ontologies compare against their own GitHub branch unless ?vsMain=true.
    const vsMain = req.query.vsMain === "true";
    const branch =
      vsMain || !ontology.github_branch_name ? defaultBranch : ontology.github_branch_name;

    const fileFormat = detectFormat(ontology.github_path, null);
    let currentTtl, githubContent;
    try {
      currentTtl = await exportOntologyAs(ontology.id, fileFormat);
    } catch (err) {
      return res.status(500).json({ error: `Could not export current ontology: ${err.message}` });
    }

    try {
      const { content } = await fetchFileContent(
        req.githubToken,
        owner,
        repo,
        ontology.github_path,
        branch,
      );
      githubContent = content;
    } catch (err) {
      return res.status(500).json({ error: `Could not fetch file from GitHub: ${err.message}` });
    }

    // Write both versions to tmp files and run git diff --no-index.
    // Use the original file extension so the diff header shows the correct filename.
    const fileExt = path.extname(ontology.github_path) || ".ttl";
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sf-compare-"));
    const githubFile = path.join(tmpDir, `github${fileExt}`);
    const currentFile = path.join(tmpDir, `current${fileExt}`);
    try {
      await fs.promises.writeFile(githubFile, githubContent, "utf-8");
      await fs.promises.writeFile(currentFile, currentTtl, "utf-8");

      let diff = "";
      try {
        const { stdout } = await execFileP("git", [
          "diff",
          "--no-index",
          "--unified=5",
          "--",
          githubFile,
          currentFile,
        ]);
        diff = stdout;
      } catch (err) {
        if (err.code === 1 && err.stdout) diff = err.stdout;
        else throw err;
      }

      res.json({ diff, branch });
    } finally {
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

export default router;
