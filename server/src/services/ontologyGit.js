/**
 * ontologyGit.js
 *
 * Manages branch ontology files on disk.
 *
 * All branch / compare operations work directly on .ttl files without
 * requiring a git repository, making this compatible with GCSFuse and
 * other network / object-store filesystems where git cannot run.
 *
 * Merge and conflict resolution operate at the RDF triple level via
 * Oxigraph — see rdfStore.mergeOntologyBranch() / resolveOntologyConflict().
 *
 * For unified diffs, `git diff --no-index` is used as a convenient
 * text-diff tool (requires git binary but does NOT require a repository).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "./authDb.js";

const execFileP = promisify(execFile);

export const ONTO_DIR = path.join(DATA_DIR, "ontologies");
export const BRANCHES_DIR = path.join(DATA_DIR, "branches");

// ── Directory setup ───────────────────────────────────────────────────────────

/**
 * Ensure the ontology and branch storage directories exist.
 * Previously this initialized a git repo; no longer needed.
 */
export async function initOntologyRepo() {
  try {
    if (!fs.existsSync(ONTO_DIR)) fs.mkdirSync(ONTO_DIR, { recursive: true });
    if (!fs.existsSync(BRANCHES_DIR)) fs.mkdirSync(BRANCHES_DIR, { recursive: true });
    console.log("[ontologyBranch] data directories ready:", ONTO_DIR);
  } catch (err) {
    console.warn("[ontologyBranch] failed to create data directories:", err.message);
  }
}

// ── File paths ────────────────────────────────────────────────────────────────

/**
 * Returns the path to the working .ttl file for a branch ontology.
 * This is the file that receives live edits and is loaded by rdfStore.
 */
export function getBranchFilePath(branchId, parentId) {
  return path.join(BRANCHES_DIR, branchId, `${parentId}.ttl`);
}

/**
 * Returns the path to the base-snapshot .ttl for a branch.
 * The base is a copy of the parent's .ttl at the moment the branch was
 * created; it is used as the common ancestor in 3-way RDF merge.
 */
export function getBranchBasePath(branchId) {
  return path.join(BRANCHES_DIR, branchId, "base.ttl");
}

// ── Branch lifecycle ──────────────────────────────────────────────────────────

/**
 * Set up the directory for a new branch and save a base snapshot of the
 * parent's current .ttl file.
 *
 * The base snapshot is the 3-way merge anchor used by mergeOntologyBranch()
 * in rdfStore.js to correctly attribute changes to parent vs. branch without
 * a git history.
 */
export async function createBranch(branchId, parentId) {
  const branchDir = path.join(BRANCHES_DIR, branchId);
  try {
    await fs.promises.mkdir(branchDir, { recursive: true });

    const parentFile = path.join(ONTO_DIR, `${parentId}.ttl`);
    const basePath = getBranchBasePath(branchId);

    if (fs.existsSync(parentFile)) {
      await fs.promises.copyFile(parentFile, basePath);
    } else {
      // Parent not yet serialised — write an empty base so the file exists.
      await fs.promises.writeFile(basePath, "", "utf-8");
    }
    console.log(`[ontologyBranch] created branch dir + base snapshot for ${branchId}`);
  } catch (err) {
    console.warn(`[ontologyBranch] createBranch failed for ${branchId}:`, err.message);
  }
}

/**
 * Remove a branch's directory (data/branches/{branchId}/).
 * Called after a successful merge or when deleting a branch ontology.
 */
export async function deleteBranch(branchId) {
  const dir = path.join(BRANCHES_DIR, branchId);
  // Prevent path traversal: confirm resolved path stays inside BRANCHES_DIR
  const safeDir = path.resolve(dir);
  const safeBase = path.resolve(BRANCHES_DIR);
  if (!safeDir.startsWith(safeBase + path.sep)) {
    throw new Error("[ontologyBranch] path traversal blocked");
  }
  // Sanitize branchId for log messages to prevent log injection
  const safeId = String(branchId)
    .replace(/[\r\n%]/g, " ")
    .slice(0, 80);
  try {
    await fs.promises.rm(safeDir, { recursive: true, force: true });
    console.log(`[ontologyBranch] deleted branch directory for ${safeId}`);
  } catch (err) {
    console.warn(`[ontologyBranch] deleteBranch failed for ${safeId}:`, err.message);
  }
}

// ── Compare ───────────────────────────────────────────────────────────────────

/**
 * Return a unified diff showing what the branch adds/removes relative to its
 * parent using `git diff --no-index`.
 *
 * `git diff --no-index` compares two arbitrary files and requires only the
 * git binary — it does NOT need a git repository, making it safe on GCSFuse.
 *
 * Returns the raw unified-diff string, or "" when the files are identical,
 * one is missing, or git is unavailable.
 */
export async function compareBranch(branchId, parentId) {
  const parentFile = path.join(ONTO_DIR, `${parentId}.ttl`);
  const branchFile = getBranchFilePath(branchId, parentId);

  if (!fs.existsSync(parentFile) || !fs.existsSync(branchFile)) return "";

  try {
    // exit 0 → identical files (stdout is empty)
    const { stdout } = await execFileP("git", [
      "diff",
      "--no-index",
      "--unified=5",
      "--",
      parentFile,
      branchFile,
    ]);
    return stdout;
  } catch (err) {
    // exit 1 → differences found; stdout contains the diff
    if (err.code === 1 && err.stdout) return err.stdout;
    console.warn(`[ontologyBranch] compareBranch failed for ${branchId}:`, err.message);
    return "";
  }
}

// ── History ───────────────────────────────────────────────────────────────────

/**
 * Commit history is not maintained when running on GCSFuse / object storage.
 * Returns an empty array so callers degrade gracefully.
 */
export async function getFileHistory(_ontologyId, _limit) {
  return [];
}
