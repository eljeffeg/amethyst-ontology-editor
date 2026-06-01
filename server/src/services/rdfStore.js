import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import oxigraph from "oxigraph";
import { DATA_DIR, getOntology, listOntologies } from "./authDb.js";
import { getBranchBasePath, getBranchFilePath, initOntologyRepo } from "./ontologyGit.js";
import { cacheGet, cacheInvalidate, cacheSet } from "./queryCache.js";

const { Store, NamedNode, BlankNode, Literal, DefaultGraph, Quad, namedNode, literal } = oxigraph;

const _workerUrl = new URL("./rdfLoadWorker.js", import.meta.url);

/**
 * Parse RDF text in a worker thread (non-blocking) and return N-Quads.
 * Offloads the slow synchronous Oxigraph parse (Turtle/RDF-XML/JSON-LD) so the
 * main event loop stays responsive while large ontologies are loaded.
 */
export function loadRdfTextInWorker(text, format, graphIri) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(_workerUrl, { workerData: { text, format, graphIri } });
    worker.once("message", ({ ok, nquads, error }) => {
      worker.terminate().catch(() => {});
      if (!ok) return reject(new Error(error));
      resolve(nquads);
    });
    worker.once("error", (err) => {
      worker.terminate().catch(() => {});
      reject(err);
    });
  });
}

let store;
const FORMAT = "text/turtle";
const ONTO_DIR = path.join(DATA_DIR, "ontologies");

// Guard against path traversal: confirm the resolved path stays under DATA_DIR.
// Returns the resolved (safe) path so callers MUST use the return value for I/O.
function assertSafePath(filePath) {
  const resolved = path.resolve(filePath);
  const base = path.resolve(DATA_DIR);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("[rdfStore] path traversal blocked");
  }
  return resolved;
}

// Construct the named graph IRI we use to isolate each ontology.
export function graphIriFor(ontologyId) {
  return `urn:ontology-editor:onto:${ontologyId}`;
}

export function graphIrisFor(ontologyIds) {
  const ids = Array.isArray(ontologyIds) ? ontologyIds : [ontologyIds];
  return ids.filter(Boolean).map(graphIriFor);
}

export function graphFileFor(ontologyId) {
  return path.join(ONTO_DIR, `${ontologyId}.ttl`);
}

/**
 * Validate and wrap a user-supplied IRI for safe SPARQL IRIREF embedding.
 * Rejects characters forbidden in SPARQL IRIREF per the grammar (§19.8):
 * control chars, space, <, >, ", {, }, |, ^, `, \.
 * Returns the IRI wrapped in angle brackets: `<value>`.
 */
export function safeIri(value) {
  const s = String(value ?? "");
  // SPARQL IRIREF grammar forbids: control chars (U+0000–U+0020), space, and <>"{}|^`\
  // Split into two checks so the regex contains no control-character literals.
  if ([...s].some((c) => c.charCodeAt(0) <= 0x20) || /[<>"{}|^`\\]/.test(s)) {
    throw new Error(`invalid IRI: ${s.slice(0, 80)}`);
  }
  return `<${s}>`;
}

// Debounced per-ontology persistence — two tiers:
//   pendingFastPersist : file-only write, ~2 s after the last change (no git)
//   pendingPersist     : full persist (file + git commit), ~10 s after the last change
const pendingFastPersist = new Map(); // ontologyId -> timer
const pendingPersist = new Map(); // ontologyId -> timer
const trackedOntologyIds = new Set(); // all IDs ever loaded / created
const LEGACY_FILE = path.join(DATA_DIR, "ontology.ttl");

export async function initRdfStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ONTO_DIR)) fs.mkdirSync(ONTO_DIR, { recursive: true });
  store = new Store();

  // Migrate legacy single-graph file into the first ontology if needed.
  const ontologies = await listOntologies();
  if (ontologies.length && fs.existsSync(LEGACY_FILE)) {
    const target = graphFileFor(ontologies[0].id);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(LEGACY_FILE, target);
      console.log(`[rdfStore] migrated legacy ontology.ttl -> ${path.basename(target)}`);
    }
    try {
      fs.unlinkSync(LEGACY_FILE);
    } catch {}
  }

  // Load every ontology's TTL into its named graph.
  // Branch ontologies live in their worktree (data/branches/{id}/{parentId}.ttl);
  // regular ontologies live directly in data/ontologies/{id}.ttl.
  let loadedCount = 0;
  let missingCount = 0;
  const needsRepersist = new Set(); // IDs whose on-disk file was repaired
  for (const o of ontologies) {
    const file = o.branch_of ? getBranchFilePath(o.id, o.branch_of) : graphFileFor(o.id);
    if (!fs.existsSync(file)) {
      missingCount++;
      console.warn(
        `[rdfStore] ⚠ No .ttl file for ontology "${o.name}" (${o.id})` +
          (o.branch_of ? ` [branch of ${o.branch_of}]` : "") +
          ` — expected at: ${file}`,
      );
      console.warn(
        `[rdfStore]   If you are using a cloud deployment, ensure DATA_DIR (${DATA_DIR}) is` +
          " mounted to a persistent volume so .ttl files survive container restarts.",
      );
      continue;
    }
    // Declare text outside try so the catch block can access it for repair.
    let text;
    try {
      text = normalizeRdfNamespaces(fs.readFileSync(file, "utf-8"));
      if (!text.trim()) {
        console.warn(`[rdfStore] ⚠ Empty .ttl file for ontology "${o.name}" (${o.id}) — skipping`);
        continue;
      }
      store.load(text, {
        format: FORMAT,
        to_graph_name: namedNode(graphIriFor(o.id)),
      });
      trackedOntologyIds.add(o.id);
      const gIri = graphIriFor(o.id);
      const qCount = [...store.match(null, null, null, namedNode(gIri))].length;
      console.log(
        `[rdfStore] loaded "${o.name}" (${o.id}) — ${qCount} quads from ${path.basename(file)}`,
      );
      loadedCount++;

      // Detect dangling blank-node references — a sign that this .ttl was
      // serialised by an older version of the code that silently dropped
      // anonymous class expressions (restrictions, intersectionOf, etc.).
      // We can only warn here; the fix is to re-import the original source.
      try {
        const danglingRows = store.query(
          `SELECT (COUNT(?bn) AS ?n) WHERE {
             GRAPH <${gIri}> {
               ?s ?p ?bn .
               FILTER(isBlank(?bn))
               FILTER NOT EXISTS { GRAPH <${gIri}> { ?bn ?p2 ?o2 } }
             }
           }`,
        );
        let danglingCount = 0;
        if (Array.isArray(danglingRows)) {
          for (const row of danglingRows) {
            if (row instanceof Map) {
              const v = row.get("n");
              if (v) danglingCount = Number.parseInt(v.value, 10) || 0;
            }
          }
        }
        if (danglingCount > 0) {
          console.warn(
            `[rdfStore] ⚠ "${o.name}" (${o.id}) has ${danglingCount} dangling blank-node ` +
              `reference(s). The on-disk .ttl was saved by an older version of the ` +
              `serialiser that dropped anonymous OWL expressions (restrictions, ` +
              `equivalentClass intersections, etc.). ` +
              `Re-import the original source file to restore the missing triples.`,
          );
          needsRepersist.add(o.id);
        }
      } catch {}
    } catch (err) {
      // First-pass failure: try to repair known bad patterns (e.g. prefix names
      // starting with digits, which are invalid in Turtle but were generated by
      // an older version of this code).
      const repaired = repairTurtlePrefixes(text);
      if (repaired) {
        try {
          store.load(repaired, {
            format: FORMAT,
            to_graph_name: namedNode(graphIriFor(o.id)),
          });
          trackedOntologyIds.add(o.id);
          const qCount = [...store.match(null, null, null, namedNode(graphIriFor(o.id)))].length;
          console.log(
            `[rdfStore] repaired & loaded "${o.name}" (${o.id}) — ${qCount} quads` +
              ` (will re-write ${path.basename(file)} with corrected Turtle)`,
          );
          loadedCount++;
          needsRepersist.add(o.id);
        } catch (repairErr) {
          // Extract the failing line from the repaired text to make diagnosis easier.
          const lineMatch = repairErr.message.match(/line (\d+)/);
          let ctxLine = "";
          if (lineMatch) {
            const lineNum = Number.parseInt(lineMatch[1], 10);
            const repLines = repaired.split("\n");
            const badLine = repLines[lineNum - 1];
            if (badLine) {
              ctxLine =
                `\n  ↳ line ${lineNum}: ` +
                `${badLine.length > 300 ? `${badLine.slice(0, 300)}…` : badLine}`;
            }
          }
          console.warn(
            `[rdfStore] ⚠ Failed to load "${o.name}" (${o.id}) even after repair:`,
            repairErr.message + ctxLine,
          );
        }
      } else {
        console.warn(`[rdfStore] ⚠ Failed to load "${o.name}" (${o.id}):`, err.message);
      }
    }
  }
  console.log(
    `[rdfStore] startup complete: ${loadedCount} ontologies loaded, ${missingCount} missing.`,
  );

  // Initialize the ontology git repo after all files are loaded.
  await initOntologyRepo();

  // Re-persist any files that were repaired so the on-disk .ttl now has
  // valid prefix names and will load cleanly on the next restart.
  for (const id of needsRepersist) {
    await persistOntology(id);
  }

  // Flush on exit — write .ttl files WITHOUT git commits so the process can
  // exit before the cloud platform's shutdown deadline (typically 30–60 s).
  // Git commits happen on the regular debounced persist path during normal use.
  const flush = async () => {
    // Cancel all pending debounce timers to avoid races with the flush below.
    for (const [, t] of pendingFastPersist) clearTimeout(t);
    pendingFastPersist.clear();
    for (const [, t] of pendingPersist) clearTimeout(t);
    pendingPersist.clear();
    try {
      await flushToDisk();
    } catch {}
  };
  process.on("SIGINT", async () => {
    await flush();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await flush();
    process.exit(0);
  });
}

export function getStore() {
  if (!store) throw new Error("rdfStore not initialized");
  return store;
}

export async function persistOntology(ontologyId) {
  if (!store || !ontologyId) return;
  trackedOntologyIds.add(ontologyId);
  try {
    const record = await getOntology(ontologyId).catch(() => null);
    const text = generateFormattedTurtle(ontologyId, record);
    // mkdir({ recursive: true }) is a no-op when the dir already exists.
    await fs.promises.mkdir(ONTO_DIR, { recursive: true });

    // Branch ontologies write to their worktree path; regular ontologies write
    // to the main data/ontologies/{id}.ttl.
    const isBranch = !!record?.branch_of;
    const filePath = isBranch
      ? getBranchFilePath(ontologyId, record.branch_of)
      : graphFileFor(ontologyId);
    const safeFilePath = assertSafePath(filePath);

    // Ensure the destination directory exists (worktrees are created by git;
    // on first persist after a server restart the dir should already be there).
    const dir = path.dirname(safeFilePath);
    await fs.promises.mkdir(dir, { recursive: true });

    // Guard: never overwrite a non-empty .ttl file with empty content.
    // This can happen when an ontology's file was missing at startup (so the
    // in-memory store has 0 quads) and something later triggers a persist.
    // Wiping the file would destroy data that might still be recoverable.
    if (!text.trim()) {
      let existing = "";
      try {
        existing = (await fs.promises.readFile(safeFilePath, "utf-8")).trim();
      } catch {}
      if (existing) {
        console.warn(
          `[rdfStore] persist(${ontologyId}): store has 0 quads but file is non-empty — ` +
            "skipping overwrite to protect existing data.",
        );
        return;
      }
    }

    await fs.promises.writeFile(safeFilePath, text, "utf-8");
  } catch (err) {
    console.warn(
      `[rdfStore] persist(${String(ontologyId)
        .replace(/[\r\n%]/g, " ")
        .slice(0, 80)}) failed:`,
      err.message,
    );
  }
}

export async function persistAll() {
  await Promise.allSettled([...trackedOntologyIds].map(persistOntology));
}

/**
 * Flush all tracked ontologies to disk WITHOUT git commits.
 * Used in the SIGTERM/SIGINT handler so the process can exit quickly even
 * when many ontologies are tracked — git operations are skipped, but all
 * .ttl files are guaranteed to be written before process.exit() is called.
 */
export async function flushToDisk() {
  // Write all tracked ontologies in parallel — faster shutdown and no event-loop blocking.
  await Promise.allSettled(
    [...trackedOntologyIds].map(async (id) => {
      try {
        const record = await getOntology(id).catch(() => null);
        const text = generateFormattedTurtle(id, record);
        if (!text.trim()) return;

        const isBranch = !!record?.branch_of;
        const filePath = isBranch ? getBranchFilePath(id, record.branch_of) : graphFileFor(id);

        const dir = path.dirname(filePath);
        await fs.promises.mkdir(dir, { recursive: true });

        // Only write if content changed to avoid unnecessary disk I/O.
        let existing = "";
        try {
          existing = await fs.promises.readFile(filePath, "utf-8");
        } catch {}
        if (existing !== text) {
          await fs.promises.writeFile(filePath, text, "utf-8");
          console.log(`[rdfStore] flushed "${record?.name || id}" to disk`);
        }
      } catch (err) {
        console.warn(`[rdfStore] flushToDisk(${id}) failed:`, err.message);
      }
    }),
  );
}

/**
 * Write a single ontology's TTL file to disk without performing a git commit.
 * This is the fast persistence layer — called by the first tier of schedulePersist
 * to ensure data is safely on disk within a couple of seconds of a change, even
 * if the subsequent git commit is slow or temporarily fails.
 */
export async function writeFileToDisk(ontologyId) {
  if (!store || !ontologyId) return;
  trackedOntologyIds.add(ontologyId);
  try {
    const record = await getOntology(ontologyId).catch(() => null);
    const text = generateFormattedTurtle(ontologyId, record);

    const isBranch = !!record?.branch_of;
    const filePath = isBranch
      ? getBranchFilePath(ontologyId, record.branch_of)
      : graphFileFor(ontologyId);
    const safeFilePath = assertSafePath(filePath);

    // Guard: never overwrite a non-empty file with empty content.
    if (!text.trim()) {
      let existing = "";
      try {
        existing = (await fs.promises.readFile(safeFilePath, "utf-8")).trim();
      } catch {}
      if (existing) {
        console.warn(
          `[rdfStore] writeFileToDisk(${ontologyId}): store has 0 quads but file is non-empty — skipping.`,
        );
        return;
      }
    }

    const dir = path.dirname(safeFilePath);
    await fs.promises.mkdir(dir, { recursive: true });

    await fs.promises.writeFile(safeFilePath, text, "utf-8");
  } catch (err) {
    console.warn(
      `[rdfStore] writeFileToDisk(${String(ontologyId)
        .replace(/[\r\n%]/g, " ")
        .slice(0, 80)}) failed:`,
      err.message,
    );
  }
}

/**
 * Schedule persistence for an ontology after a change.
 *
 * Two-tier debounced approach:
 *  - Tier 1 (fast, ~2 s): writes the .ttl file to disk, no git commit.
 *    Fires 'ms' milliseconds after the LAST change — proper debounce.
 *    Ensures data is safely on disk quickly regardless of git latency.
 *  - Tier 2 (slow, ~10 s): full persistOntology (file + git commit).
 *    Fires 5× 'ms' after the LAST change so git commits are batched.
 *
 * Both timers are reset on every call (real debounce, not a one-shot throttle).
 */
export function schedulePersist(ontologyId, ms = 2000) {
  if (!ontologyId) return;

  // ── Tier 1: fast file write (no git) ───────────────────────────────────────
  if (pendingFastPersist.has(ontologyId)) clearTimeout(pendingFastPersist.get(ontologyId));
  const fastTimer = setTimeout(async () => {
    pendingFastPersist.delete(ontologyId);
    await writeFileToDisk(ontologyId);
  }, ms);
  pendingFastPersist.set(ontologyId, fastTimer);

  // ── Tier 2: full persist with git commit (batched, fires later) ────────────
  const gitMs = ms * 5; // 10 s when default ms=2000
  if (pendingPersist.has(ontologyId)) clearTimeout(pendingPersist.get(ontologyId));
  const fullTimer = setTimeout(async () => {
    pendingPersist.delete(ontologyId);
    await persistOntology(ontologyId);
  }, gitMs);
  pendingPersist.set(ontologyId, fullTimer);
}

// Copy all quads from one ontology's named graph into another (for branching).
// The target graph must not already contain the triples — it should be fresh.
export function copyOntologyGraph(sourceId, targetId) {
  if (!store || !sourceId || !targetId) return;
  const srcIri = graphIriFor(sourceId);
  const tgtIri = graphIriFor(targetId);
  // Use a SPARQL INSERT…WHERE so the copy runs entirely inside the Rust store —
  // this avoids the "null pointer passed to rust" error that occurs when accessing
  // Quad.subject on native-backed objects whose internal pointer was freed when
  // the match() iterator was finalized by the JS runtime.
  store.update(
    `INSERT { GRAPH <${tgtIri}> { ?s ?p ?o } } WHERE { GRAPH <${srcIri}> { ?s ?p ?o } }`,
  );
  trackedOntologyIds.add(targetId);
  persistOntology(targetId);
}

/**
 * Reload an ontology's named graph from its on-disk .ttl file.
 * Used after a git merge rewrites the file to sync Oxigraph with the new content.
 */
export async function reloadOntologyFromDisk(ontologyId) {
  const file = graphFileFor(ontologyId);
  try {
    const rawText = await fs.promises.readFile(file, "utf-8");
    const text = normalizeRdfNamespaces(rawText);
    if (!text.trim()) return false;
    // Drop existing named graph, then reload from file.
    try {
      getStore().update(`DROP GRAPH <${graphIriFor(ontologyId)}>`);
    } catch {}
    getStore().load(text, {
      format: FORMAT,
      to_graph_name: namedNode(graphIriFor(ontologyId)),
    });
    return true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[rdfStore] reloadFromDisk(${ontologyId}) failed:`, err.message);
    }
    return false;
  }
}

// Load ontology content from a raw Turtle/RDF string into the named graph.
// Used by GitHub sync to import file content fetched from the API.
// Pass { replace: true } to clear the existing graph first.
export async function loadOntologyFromText(ontologyId, text, { replace = false, format = FORMAT } = {}) {
  if (!store) throw new Error("rdfStore not initialized");
  const g = graphIriFor(ontologyId);
  const gNode = namedNode(g);
  if (replace) {
    try {
      store.update(`CLEAR SILENT GRAPH <${g}>`);
    } catch {}
  }
  const normalized = normalizeRdfNamespaces(text);
  const nquads = await loadRdfTextInWorker(normalized, format, g);
  store.load(nquads, { format: "application/n-quads", to_graph_name: gNode });
  trackedOntologyIds.add(ontologyId);
  schedulePersist(ontologyId, 2000);
}

/**
 * Check a loaded graph for properties declared as both owl:ObjectProperty
 * and owl:DatatypeProperty — invalid in OWL 2. Returns an array of
 * conflicting IRIs (empty = no conflicts).
 */
export function validatePropertyTypeConflicts(ontologyId) {
  const s = getStore();
  const g = namedNode(graphIriFor(ontologyId));
  const RDF_TYPE = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
  const OBJ = namedNode("http://www.w3.org/2002/07/owl#ObjectProperty");
  const DAT = namedNode("http://www.w3.org/2002/07/owl#DatatypeProperty");

  const objProps = new Set();
  for (const q of s.match(null, RDF_TYPE, OBJ, g)) {
    objProps.add(q.subject.value);
  }
  const conflicts = [];
  for (const q of s.match(null, RDF_TYPE, DAT, g)) {
    if (objProps.has(q.subject.value)) conflicts.push(q.subject.value);
  }
  return conflicts;
}

// Return all owl:imports IRI values declared in the given ontology's named graph.
export function getOntologyImportIris(ontologyId) {
  if (!store) return [];
  const g = graphIriFor(ontologyId);
  try {
    const rows = store.query(
      `SELECT ?iri WHERE { GRAPH <${g}> { ?s <http://www.w3.org/2002/07/owl#imports> ?iri . } }`,
    );
    return rows.map((r) => r.iri?.value).filter(Boolean);
  } catch {
    return [];
  }
}

// Return the current ontology content as a formatted Turtle string
// without writing anything to disk. Used for GitHub push operations.
export async function exportOntologyAsTurtle(ontologyId) {
  if (!store) throw new Error("rdfStore not initialized");
  const record = await getOntology(ontologyId).catch(() => null);
  return generateFormattedTurtle(ontologyId, record);
}

/**
 * Export an ontology in the given MIME format.
 * Uses the custom Protégé-style serializer for Turtle; Oxigraph's native
 * serializer for all other formats (RDF/XML, N-Triples, JSON-LD, etc.).
 */
export async function exportOntologyAs(ontologyId, format = "text/turtle") {
  if (!store) throw new Error("rdfStore not initialized");
  const record = await getOntology(ontologyId).catch(() => null);
  if (format === "text/turtle") return generateFormattedTurtle(ontologyId, record);
  if (format === "application/rdf+xml") return generateFormattedRdfXml(ontologyId, record);
  return store.dump({ format, from_graph_name: namedNode(graphIriFor(ontologyId)) });
}

// When an ontology is deleted: drop its graph and file.
export async function dropOntologyGraph(ontologyId) {
  try {
    getStore().update(`DROP GRAPH <${graphIriFor(ontologyId)}>`);
  } catch (err) {
    console.warn(`[rdfStore] drop graph failed:`, err.message);
  }
  const safeFile = assertSafePath(graphFileFor(ontologyId));
  try {
    await fs.promises.unlink(safeFile);
  } catch {}
}

/**
 * Delete a blank-node expression subgraph rooted at `bnodeId`.
 * Removes:
 *   1. The linking triple: <entityIri> <predicate> _:bnodeId  (in the ontology's named graph)
 *   2. All outgoing triples of _:bnodeId, recursively for every descendant blank node.
 *
 * Uses direct quad manipulation via store.match() / store.delete() so arbitrarily-nested
 * anonymous class expressions (intersectionOf lists, restrictions inside intersections,
 * rdf:List chains) are fully removed without leaving orphaned blank-node triples.
 */
export function deleteBlankNodeSubgraph(entityIri, predicate, bnodeId, ontologyId) {
  const s = getStore();
  const graphNode = namedNode(graphIriFor(ontologyId));
  const subjectNode = namedNode(entityIri);
  const predicateNode = namedNode(predicate);

  const toDelete = [];

  // Step 1: find the specific linking quad (entity → predicate → this blank node).
  // There may be multiple blank-node objects for the same predicate (e.g. multiple
  // rdfs:subClassOf restrictions) so we match by the blank-node's value.
  for (const q of s.match(subjectNode, predicateNode, null, graphNode)) {
    if (q.object.termType === "BlankNode" && q.object.value === bnodeId) {
      toDelete.push(q);
      break;
    }
  }

  // Step 2: BFS through the blank-node subgraph to collect all descendant quads.
  const visited = new Set();
  const queue = [bnodeId];
  while (queue.length > 0) {
    const curId = queue.shift();
    if (visited.has(curId)) continue;
    visited.add(curId);
    for (const q of s.match(new BlankNode(curId), null, null, graphNode)) {
      toDelete.push(q);
      if (q.object.termType === "BlankNode") queue.push(q.object.value);
    }
  }

  for (const q of toDelete) s.delete(q);
  cacheInvalidate(ontologyId);
  schedulePersist(ontologyId);
}

// Helpful namespaces
export const NS = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
};

export function nn(iri) {
  return namedNode(iri);
}
export function lit(v, langOrType) {
  if (!langOrType) return literal(String(v));
  return literal(String(v), langOrType);
}

// Normalize a scope arg that might be a single ontology id or an array of ids
// (union across the project's child ontologies).
function scopeToIds(scope) {
  if (!scope) return [];
  if (Array.isArray(scope)) return scope.filter(Boolean);
  return [scope];
}

// Wrap a SPARQL query pattern so it runs only against the given ontology's graph(s).
// `scope` may be a single ontology id or an array of ids (for project-wide union).
function wrapQuery(query, scope) {
  const ids = scopeToIds(scope);
  if (!ids.length) return query;
  const fromClauses = ids.map((id) => `FROM <${graphIriFor(id)}>`).join(" ");
  // Only wrap SELECT / ASK / CONSTRUCT / DESCRIBE.  If the query already uses FROM or GRAPH, leave it alone.
  const m = query.match(/^([\s\S]*?)(\bSELECT\b|\bCONSTRUCT\b|\bASK\b|\bDESCRIBE\b)([\s\S]*)$/i);
  if (!m) return query;
  if (/\bFROM\b/i.test(m[3]) || /\bGRAPH\s*</i.test(m[3])) return query;
  if (/SELECT|CONSTRUCT|ASK/i.test(m[2])) {
    return query.replace(/\bWHERE\s*\{/i, `${fromClauses} WHERE {`);
  }
  return query;
}

// Run a SPARQL SELECT scoped to one or more ontologies; returns rows.
// Pass a single ontology id for single-ontology reads, or an array of ids
// for project-wide union reads.
export function select(query, scope) {
  const wrapped = scope ? wrapQuery(query, scope) : query;
  const result = getStore().query(wrapped);
  if (typeof result === "boolean") return result;
  if (!Array.isArray(result)) return [];
  const rows = [];
  for (const binding of result) {
    const row = {};
    if (binding instanceof Map) {
      for (const [k, v] of binding) row[k] = termToPlain(v);
    } else if (binding && typeof binding.subject !== "undefined") {
      row.subject = termToPlain(binding.subject);
      row.predicate = termToPlain(binding.predicate);
      row.object = termToPlain(binding.object);
      row.graph = termToPlain(binding.graph);
    }
    rows.push(row);
  }
  return rows;
}

// Raw query pass-through (no wrapping)
export function rawQuery(query) {
  return getStore().query(query);
}

/**
 * Cached wrapper around `select()`.
 *
 * Results are stored in the in-process query cache keyed by (scope, query).
 * The TTL defaults to QUERY_CACHE_TTL_MS (env var, default 15 s).
 * The cache is automatically invalidated whenever a write touches any
 * ontology that is part of `scope`.
 *
 * Use this for all read-only GET endpoints. Use plain `select()` when you
 * need a guaranteed fresh result (e.g. inside a write handler's "read-then-
 * modify" pattern, or inside collectDeprecated which is already piggybacking
 * on a cached list call).
 */
export function cachedSelect(query, scope, ttlMs) {
  const key = `${JSON.stringify(scope)}\x00${query}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const result = select(query, scope);
  cacheSet(key, result, scope, ttlMs);
  return result;
}

// Re-export so callers that bypass update() (e.g. import route using store.load()
// directly) can still invalidate the query cache for an ontology.
export { cacheInvalidate };

// Run SPARQL UPDATE; ontologyId optional (used for persistence scheduling only).
// Automatically invalidates any cached reads that involved the affected ontology.
export function update(query, ontologyId) {
  const r = getStore().update(query);
  if (ontologyId) {
    cacheInvalidate(ontologyId);
    schedulePersist(ontologyId);
  }
  return r;
}

// Convenience: INSERT DATA into a specific ontology's graph
export function insertIntoGraph(triplesTurtle, ontologyId, prefixes = "") {
  const g = graphIriFor(ontologyId);
  const q = `${prefixes}\nINSERT DATA { GRAPH <${g}> { ${triplesTurtle} } }`;
  return update(q, ontologyId);
}

export function deleteFromGraph(pattern, ontologyId, prefixes = "") {
  const g = graphIriFor(ontologyId);
  const q = `${prefixes}\nDELETE WHERE { GRAPH <${g}> { ${pattern} } }`;
  return update(q, ontologyId);
}

function termToPlain(term) {
  if (!term) return null;
  switch (term.termType) {
    case "NamedNode":
      return { type: "uri", value: term.value };
    case "BlankNode":
      return { type: "bnode", value: term.value };
    case "Literal":
      return {
        type: "literal",
        value: term.value,
        datatype: term.datatype ? term.datatype.value : null,
        language: term.language || null,
      };
    case "DefaultGraph":
      return { type: "graph", value: "" };
    default:
      return { type: term.termType, value: term.value };
  }
}

// ── Ontology-level metadata helpers ─────────────────────────────────────────
// Common Dublin Core Terms namespace used for title/description/creator/license.
const DCT_NS = "http://purl.org/dc/terms/";

/** Return the subject IRI of the first owl:Ontology declaration in the graph,
 *  or null if none is found.
 *
 *  When a Turtle file contains `@base <IRI>` and declares `<> a owl:Ontology`,
 *  Oxigraph resolves the relative `<>` to the absolute base IRI, so this query
 *  reliably recovers the base IRI for any RDF format — not only Turtle. */
export function getOntologySubjectIri(ontologyId) {
  if (!store || !ontologyId) return null;
  try {
    const g = graphIriFor(ontologyId);
    const q = `SELECT ?s WHERE {
      GRAPH <${g}> {
        ?s <${NS.rdf}type> <${NS.owl}Ontology> .
        FILTER(isIRI(?s))
      }
    } LIMIT 1`;
    const rows = select(q);
    return rows[0]?.s?.value ?? null;
  } catch {
    return null;
  }
}

/** Read owl:Ontology metadata from a named graph.
 *  Returns a plain object with any of: title, description, version,
 *  versionIri, creator, license  (all optional strings). */
export function getOntologyRdfMeta(ontologyId) {
  if (!store || !ontologyId) return {};
  try {
    const g = graphIriFor(ontologyId);
    const q = `SELECT ?p ?o WHERE {
      GRAPH <${g}> {
        ?s <${NS.rdf}type> <${NS.owl}Ontology> .
        ?s ?p ?o .
        FILTER(?p IN (
          <${NS.rdfs}label>,
          <${DCT_NS}title>,
          <${DCT_NS}description>,
          <${NS.owl}versionInfo>,
          <${NS.owl}versionIRI>,
          <${DCT_NS}creator>,
          <${DCT_NS}license>
        ))
      }
    }`;
    const rows = select(q);
    let rdfsLabel = null,
      dcTitle = null,
      dcDesc = null,
      version = null,
      versionIri = null,
      creator = null,
      license = null;
    for (const row of rows) {
      const p = row.p?.value;
      const v = row.o?.value;
      if (!p || v == null) continue;
      if (p === `${NS.rdfs}label`) {
        if (!rdfsLabel) rdfsLabel = v;
      } else if (p === `${DCT_NS}title`) {
        dcTitle = v;
      } else if (p === `${DCT_NS}description`) {
        dcDesc = v;
      } else if (p === `${NS.owl}versionInfo`) {
        version = v;
      } else if (p === `${NS.owl}versionIRI`) {
        versionIri = v;
      } else if (p === `${DCT_NS}creator`) {
        creator = v;
      } else if (p === `${DCT_NS}license`) {
        license = v;
      }
    }
    const meta = {};
    const title = dcTitle || rdfsLabel;
    if (title) meta.title = title;
    if (dcDesc) meta.description = dcDesc;
    if (version) meta.version = version;
    if (versionIri) meta.versionIri = versionIri;
    if (creator) meta.creator = creator;
    if (license) meta.license = license;
    return meta;
  } catch {
    return {};
  }
}

/** Write (replace) owl:Ontology metadata triples in a named graph.
 *  fields: { title?, description?, version?, creator?, license? }
 *  Each field present (even as "") replaces the existing triple.
 *  Fields absent (undefined) are left untouched. */
export function setOntologyRdfMeta(ontologyId, subjectIri, fields) {
  if (!store || !ontologyId || !subjectIri) return;
  const g = graphIriFor(ontologyId);
  const literalPreds = [
    [`${DCT_NS}title`, fields.title],
    [`${DCT_NS}description`, fields.description],
    [`${NS.owl}versionInfo`, fields.version],
    [`${DCT_NS}creator`, fields.creator],
  ];
  const iriPreds = [[`${DCT_NS}license`, fields.license]];

  for (const [pred, val] of literalPreds) {
    if (val === undefined) continue;
    update(`DELETE WHERE { GRAPH <${g}> { <${subjectIri}> <${pred}> ?o } }`);
    if (val?.trim()) {
      const escaped = val.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      update(`INSERT DATA { GRAPH <${g}> { <${subjectIri}> <${pred}> "${escaped}" } }`, ontologyId);
    }
  }
  for (const [pred, val] of iriPreds) {
    if (val === undefined) continue;
    update(`DELETE WHERE { GRAPH <${g}> { <${subjectIri}> <${pred}> ?o } }`);
    if (val?.trim()) {
      update(
        `INSERT DATA { GRAPH <${g}> { <${subjectIri}> <${pred}> ${safeIri(val.trim())} } }`,
        ontologyId,
      );
    }
  }
  schedulePersist(ontologyId);
}

/** Attach RDF metadata fields to an ontology DB row object. */
export function enrichOntology(ontologyRow) {
  if (!ontologyRow) return ontologyRow;
  const meta = getOntologyRdfMeta(ontologyRow.id);
  return {
    ...ontologyRow,
    rdfTitle: meta.title || null,
    rdfDescription: meta.description || null,
    rdfVersion: meta.version || null,
    rdfVersionIri: meta.versionIri || null,
    rdfCreator: meta.creator || null,
    rdfLicense: meta.license || null,
  };
}

// ── Turtle repair helper ─────────────────────────────────────────────────────

/**
 * Attempt to repair a Turtle file that has bare newlines inside single-quoted
 * string literals.  Turtle § 19 forbids literal line-breaks inside "…" strings;
 * they must be escaped as \n or the string must use triple-quotes.
 *
 * This is the only repair retained post-cleanup; all other repairs targeted
 * bugs in our own serializer that no longer exist (fixed at the source).
 *
 * Returns the repaired text string, or null if no repair was needed.
 */
function repairTurtlePrefixes(text) {
  if (!text) return null;
  let repaired = text;
  let changed = false;

  // ── Bare newlines inside single-quoted string literals ─────────────────────
  // Turtle § 19 forbids literal line-breaks inside "..." literals; they must be
  // escaped as \n / \r or the string must use triple-quotes ("""...""").
  // This is the cause of "Line jumps are not allowed in string literals, use \n".
  // We scan character-by-character to reliably detect string boundaries
  // (triple-quoted strings are left untouched; comments are skipped wholesale).
  {
    let fixed = "";
    let j = 0;
    let literalChanged = false;
    while (j < repaired.length) {
      const ch = repaired[j];
      if (ch === "#") {
        // Line comment — copy verbatim to end of line (no string parsing needed).
        while (j < repaired.length && repaired[j] !== "\n") fixed += repaired[j++];
      } else if (ch === '"') {
        if (repaired[j + 1] === '"' && repaired[j + 2] === '"') {
          // Triple-quoted string.
          // We must handle `""""` (and `"""""`, etc.) where extra `"` characters
          // appear immediately before the closing `"""`.  The Turtle spec closes
          // the string at the FIRST `"""`, leaving any extra `"` as stray tokens
          // that corrupt the rest of the file.  We escape them as `\"` so they
          // become valid content characters inside the triple-quoted literal.
          fixed += '"""';
          j += 3;
          while (j < repaired.length) {
            if (repaired[j] === "\\") {
              // Existing escape sequence — keep both chars.
              fixed += repaired[j] + (repaired[j + 1] ?? "");
              j += 2;
            } else if (repaired[j] === '"') {
              // Count consecutive quotes to distinguish content vs. closing.
              let qCount = 0;
              let qi = j;
              while (qi < repaired.length && repaired[qi] === '"') {
                qCount++;
                qi++;
              }
              if (qCount >= 3) {
                // The last 3 are the closing `"""`.
                // Any extras before them are content that must be escaped.
                for (let q = 0; q < qCount - 3; q++) {
                  fixed += '\\"';
                  literalChanged = true;
                }
                fixed += '"""';
                j = qi;
                break;
              }
              // 1 or 2 quotes — valid content inside triple-quoted string.
              for (let q = 0; q < qCount; q++) fixed += '"';
              j = qi;
            } else {
              fixed += repaired[j++];
            }
          }
        } else {
          // Single-quoted string — escape bare newlines / carriage returns.
          fixed += '"';
          j++;
          while (j < repaired.length) {
            if (repaired[j] === "\\") {
              // Existing escape sequence — copy both characters unchanged.
              fixed += repaired[j] + (repaired[j + 1] ?? "");
              j += 2;
            } else if (repaired[j] === '"') {
              fixed += '"';
              j++;
              break;
            } else if (repaired[j] === "\r" && repaired[j + 1] === "\n") {
              fixed += "\\n";
              j += 2;
              literalChanged = true;
            } else if (repaired[j] === "\n" || repaired[j] === "\r") {
              fixed += "\\n";
              j++;
              literalChanged = true;
            } else {
              fixed += repaired[j++];
            }
          }
        }
      } else {
        fixed += ch;
        j++;
      }
    }
    if (literalChanged) {
      repaired = fixed;
      changed = true;
    }
  }

  return changed ? repaired : null;
}

/**
 * Normalize known well-known namespace misspellings in any RDF text format.
 * Safe to apply to all text-based serializations (Turtle, N3, RDF/XML, JSON-LD,
 * N-Triples, etc.) — it only replaces specific wrong IRI strings with their
 * canonical forms.
 *
 * The most common authoring error corrected here is the RDF namespace written
 * with a forward-slash instead of the required hyphen before "rdf-syntax-ns":
 *
 *   WRONG:   http://www.w3.org/1999/02/22/rdf-syntax-ns#  (slash)
 *   CORRECT: http://www.w3.org/1999/02/22-rdf-syntax-ns#  (hyphen)
 *
 * When this misspelling is present every `rdf:type` triple is stored under the
 * wrong predicate IRI, so class / property / individual declarations are not
 * recognized and ontology-level metadata (title, description, creator…) is
 * invisible to all server-side SPARQL queries.
 *
 * Returns the text unchanged when no known misspellings are present.
 */
export function normalizeRdfNamespaces(text) {
  if (!text || typeof text !== "string") return text;
  const KNOWN_MISSPELLINGS = [
    // rdf: standard namespace — /22/ (slash) vs /22- (hyphen before "rdf-syntax-ns")
    ["http://www.w3.org/1999/02/22/rdf-syntax-ns#", "http://www.w3.org/1999/02/22-rdf-syntax-ns#"],
  ];
  let result = text;
  for (const [wrong, correct] of KNOWN_MISSPELLINGS) {
    if (result.includes(wrong)) {
      console.log(
        `[rdfStore] normalizeRdfNamespaces: corrected misspelled namespace\n` +
          `  wrong:   ${wrong}\n` +
          `  correct: ${correct}`,
      );
      result = result.split(wrong).join(correct);
    }
  }
  return result;
}

// ── Deterministic Protégé-style Turtle formatter ─────────────────────────────
// Used by persistOntology (on-disk .ttl files) and the export endpoint.
// Produces identical output for identical graph content across server restarts.

/**
 * Deterministically renumber blank nodes in a list of quads.
 * Quads are sorted first so blank-node encounter order is stable; then each
 * distinct blank node is assigned a label c0, c1, c2, … in encounter order.
 */
function canonicalizeBnodes(quads) {
  const termKey = (t) => {
    switch (t.termType) {
      case "NamedNode":
        return `N\x01${t.value}`;
      case "BlankNode":
        return `B\x01${t.value}`;
      case "Literal":
        return `L\x01${t.value}\x01${t.datatype?.value || ""}\x01${t.language || ""}`;
      default:
        return `?\x01${t.value}`;
    }
  };
  const quadKey = (q) => `${termKey(q.subject)}\x00${termKey(q.predicate)}\x00${termKey(q.object)}`;
  const sorted = [...quads].sort((a, b) => quadKey(a).localeCompare(quadKey(b)));

  const bnMap = new Map();
  let n = 0;
  for (const q of sorted) {
    if (q.subject.termType === "BlankNode" && !bnMap.has(q.subject.value))
      bnMap.set(q.subject.value, `c${n++}`);
    if (q.object.termType === "BlankNode" && !bnMap.has(q.object.value))
      bnMap.set(q.object.value, `c${n++}`);
  }
  if (bnMap.size === 0) return sorted; // no blank nodes — already sorted

  return sorted.map((q) => ({
    subject:
      q.subject.termType === "BlankNode"
        ? { termType: "BlankNode", value: bnMap.get(q.subject.value) }
        : q.subject,
    predicate: q.predicate,
    object:
      q.object.termType === "BlankNode"
        ? { termType: "BlankNode", value: bnMap.get(q.object.value) }
        : q.object,
    graph: q.graph,
  }));
}

const TURTLE_WELL_KNOWN_NS = [
  ["http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdf"],
  ["http://www.w3.org/2000/01/rdf-schema#", "rdfs"],
  ["http://www.w3.org/2002/07/owl#", "owl"],
  ["http://www.w3.org/2001/XMLSchema#", "xsd"],
  ["http://www.w3.org/XML/1998/namespace", "xml"],
  ["http://www.w3.org/2004/02/skos/core#", "skos"],
  ["http://purl.org/dc/terms/", "dcterms"],
  ["http://purl.org/dc/elements/1.1/", "dc"],
  ["http://schema.org/", "schema"],
  ["https://schema.org/", "schemas"],
];

// Preferred predicate display order (Protégé convention).
const TURTLE_PRED_ORDER = [
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
  "http://www.w3.org/2002/07/owl#versionIRI",
  "http://www.w3.org/2002/07/owl#versionInfo",
  "http://www.w3.org/2002/07/owl#imports",
  "http://www.w3.org/2000/01/rdf-schema#subClassOf",
  "http://www.w3.org/2000/01/rdf-schema#subPropertyOf",
  "http://www.w3.org/2002/07/owl#equivalentClass",
  "http://www.w3.org/2002/07/owl#disjointWith",
  "http://www.w3.org/2002/07/owl#inverseOf",
  "http://www.w3.org/2000/01/rdf-schema#domain",
  "http://www.w3.org/2000/01/rdf-schema#range",
  "http://www.w3.org/2000/01/rdf-schema#label",
  "http://www.w3.org/2000/01/rdf-schema#comment",
  "http://www.w3.org/2004/02/skos/core#prefLabel",
  "http://www.w3.org/2004/02/skos/core#altLabel",
  "http://www.w3.org/2004/02/skos/core#definition",
  "http://www.w3.org/2004/02/skos/core#scopeNote",
  "http://www.w3.org/2004/02/skos/core#example",
  "http://purl.org/dc/terms/title",
  "http://purl.org/dc/terms/description",
  "http://purl.org/dc/terms/creator",
  "http://purl.org/dc/terms/license",
  "http://www.w3.org/2002/07/owl#deprecated",
];

function turtleNsOf(iri) {
  const h = iri.lastIndexOf("#");
  if (h > 0) return iri.substring(0, h + 1);
  const s = iri.lastIndexOf("/");
  if (s > 7) return iri.substring(0, s + 1);
  return null;
}

/**
 * Minimum number of distinct IRIs that must share a namespace before we
 * auto-generate an abbreviated @prefix for it.  Well-known namespaces from
 * TURTLE_WELL_KNOWN_NS are always emitted regardless of this threshold.
 * Raising this value reduces prefix-table bloat in ontologies (like D3FEND)
 * that contain hundreds of single-use URL namespaces as annotation values.
 */
const PREFIX_MIN_USES = 3;

function turtleBuildPrefixTable(allIris, baseIri) {
  const nsToPrefix = new Map(TURTLE_WELL_KNOWN_NS);
  const prefixToNs = new Map(TURTLE_WELL_KNOWN_NS.map(([ns, pfx]) => [pfx, ns]));

  function addNs(ns, hint) {
    if (!ns || nsToPrefix.has(ns)) return;
    // Strip leading digits — Turtle prefix names (PN_CHARS_BASE) must start
    // with a letter, not a digit. e.g. hint "2024" becomes "ns2024".
    const raw = (hint || "ns")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .replace(/^[0-9]+/, ""); // remove leading digits so prefix starts with a letter
    const cand = raw.substring(0, 20) || "ns";
    let unique = cand;
    let i = 2;
    while (prefixToNs.has(unique)) unique = `${cand}${i++}`;
    nsToPrefix.set(ns, unique);
    prefixToNs.set(unique, ns);
  }

  // Always register the ontology's own base namespace regardless of use count.
  if (baseIri) {
    const ns = turtleNsOf(baseIri);
    if (ns && !nsToPrefix.has(ns)) {
      const stripped = ns.replace(/[#/]+$/, "");
      const parts = stripped.split(/[/#]/);
      addNs(ns, parts[parts.length - 1] || "ont");
    }
  }

  // Count how many IRIs fall under each candidate namespace.
  // Only namespaces with at least PREFIX_MIN_USES IRIs get an abbreviated prefix;
  // the rest are written as full <IRI> in the serialized Turtle.  This prevents
  // ontologies that use hundreds of unique URL namespaces as annotation values
  // (e.g. D3FEND's sparta.aerospace.org or learn.microsoft.com sub-paths) from
  // generating hundreds of meaningless generated prefixes.
  const nsCandidates = new Map(); // ns string → use count
  for (const iri of allIris) {
    // Skip IRIs already covered by a well-known or base-IRI prefix.
    let covered = false;
    for (const [ns] of nsToPrefix) {
      if (iri.startsWith(ns)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    const ns = turtleNsOf(iri);
    if (!ns) continue;
    nsCandidates.set(ns, (nsCandidates.get(ns) ?? 0) + 1);
  }

  for (const [ns, count] of nsCandidates) {
    if (nsToPrefix.has(ns)) continue; // already registered (e.g. added earlier)
    if (count < PREFIX_MIN_USES) continue; // too rare — emit full <IRI> instead
    const stripped = ns.replace(/[#/]+$/, "");
    const parts = stripped.split(/[/#]/);
    addNs(ns, parts[parts.length - 1] || "ns");
  }

  return nsToPrefix;
}

function turtleAbbrev(iri, nsToPrefix) {
  let bestLen = 0;
  let bestPfx = null;
  for (const [ns, pfx] of nsToPrefix) {
    if (iri.startsWith(ns) && ns.length > bestLen) {
      bestLen = ns.length;
      bestPfx = pfx;
    }
  }
  if (bestPfx !== null) {
    const local = iri.substring(bestLen);
    // Turtle PN_LOCAL cannot end with '.'; fall back to full <IRI> form.
    if (
      local &&
      /^[a-zA-Z_\u00C0-\uFFFF][a-zA-Z0-9_\-.:\u00B7-\uFFFF]*$/.test(local) &&
      !local.endsWith(".")
    ) {
      return `${bestPfx}:${local}`;
    }
  }
  return `<${iri}>`;
}

function turtleTerm(term, nsToPrefix) {
  switch (term.termType) {
    case "NamedNode":
      return turtleAbbrev(term.value, nsToPrefix);
    case "BlankNode":
      return `_:${term.value}`;
    case "Literal": {
      const dt = term.datatype?.value;
      const lang = term.language || null;
      const raw = term.value;
      const useTriple =
        raw.includes("\n") || raw.includes("\r") || (raw.match(/"/g) || []).length > 1;
      let base;
      if (useTriple) {
        // Escape ALL double-quotes so no sequence of `"` chars can close the
        // triple-quoted literal prematurely.
        const esc = raw.replace(/\\/g, "\\\\").replace(/\0/g, "\\u0000").replace(/"/g, '\\"');
        base = `"""${esc}"""`;
      } else {
        const esc = raw
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\t/g, "\\t")
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r");
        base = `"${esc}"`;
      }
      if (lang) return `${base}@${lang}`;
      if (dt && dt !== "http://www.w3.org/2001/XMLSchema#string") {
        return `${base}^^${turtleAbbrev(dt, nsToPrefix)}`;
      }
      return base;
    }
    default:
      return `<${term.value}>`;
  }
}

/** Deterministic sort key for an RDF term. */
function termSortKey(t) {
  switch (t.termType) {
    case "NamedNode":
      return `0\x00${t.value}`;
    case "Literal":
      return `1\x00${t.value}\x00${t.datatype?.value || ""}\x00${t.language || ""}`;
    case "BlankNode":
      return `2\x00${t.value}`;
    default:
      return `3\x00${t.value}`;
  }
}

/**
 * Serialize one entity block (subject + predicate-object pairs) as Turtle lines.
 * `objectSerializer` is an optional function `(term) => string` used to render
 * object terms; it defaults to plain `turtleTerm`.  The inline blank-node
 * serializer built inside generateFormattedTurtle passes itself here so that
 * anonymous class expressions are expanded inline as [ ... ] / ( ... ).
 */
function turtleEntityBlock(iri, predMap, nsToPrefix, objectSerializer) {
  const serObj = objectSerializer ?? ((o) => turtleTerm(o, nsToPrefix));
  // Blank node subjects are keyed as "_:c0"; emit them directly instead of
  // attempting IRI abbreviation (which would produce the invalid "<_:c0>").
  const subj = iri.startsWith("_:") ? iri : turtleAbbrev(iri, nsToPrefix);
  const pad = " ".repeat(subj.length + 1);

  const entries = [...predMap.entries()].sort(([pA], [pB]) => {
    const iA = TURTLE_PRED_ORDER.indexOf(pA);
    const iB = TURTLE_PRED_ORDER.indexOf(pB);
    if (iA !== -1 && iB !== -1) return iA - iB;
    if (iA !== -1) return -1;
    if (iB !== -1) return 1;
    return pA.localeCompare(pB);
  });

  const parts = entries.map(([pred, objects]) => {
    const p = turtleAbbrev(pred, nsToPrefix);
    // Sort objects for fully deterministic output.
    // Wrap serObj in an arrow so Array.map's extra (index, array) args are not
    // passed through — serializeObject uses its second param as contIndent.
    const os = [...objects]
      .sort((a, b) => termSortKey(a).localeCompare(termSortKey(b)))
      .map((o) => serObj(o))
      .join(" , ");
    return `${p} ${os}`;
  });

  if (parts.length === 0) return [`${subj} .`];
  if (parts.length === 1) return [`${subj} ${parts[0]} .`];

  const lines = [`${subj} ${parts[0]} ;`];
  for (let i = 1; i < parts.length - 1; i++) lines.push(`${pad}${parts[i]} ;`);
  lines.push(`${pad}${parts[parts.length - 1]} .`);
  return lines;
}

const _OWL_NS = "http://www.w3.org/2002/07/owl#";
const _RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

function turtleCategorize(subjectMap) {
  const cats = {
    ontology: [],
    objectProperties: [],
    datatypeProperties: [],
    annotationProperties: [],
    classes: [],
    individuals: [],
    other: [],
  };
  for (const [iri, predMap] of subjectMap) {
    // Blank node subjects (keyed as "_:c0") always go to the General Axioms
    // section so they are never miscategorised as Classes, Properties, etc.
    if (iri.startsWith("_:")) {
      cats.other.push(iri);
      continue;
    }
    const types = (predMap.get(_RDF_TYPE) || []).map((t) => t.value);
    if (types.includes(`${_OWL_NS}Ontology`)) cats.ontology.push(iri);
    else if (types.includes(`${_OWL_NS}ObjectProperty`)) cats.objectProperties.push(iri);
    else if (types.includes(`${_OWL_NS}DatatypeProperty`)) cats.datatypeProperties.push(iri);
    else if (types.includes(`${_OWL_NS}AnnotationProperty`)) cats.annotationProperties.push(iri);
    else if (types.includes(`${_OWL_NS}Class`)) cats.classes.push(iri);
    else if (types.includes(`${_OWL_NS}NamedIndividual`)) cats.individuals.push(iri);
    else cats.other.push(iri);
  }
  return cats;
}

function turtleSectionBanner(title) {
  return [
    "",
    "#################################################################",
    `#    ${title}`,
    "#################################################################",
    "",
  ];
}

/**
 * Load all quads for `oid`, canonicalize blank nodes, and build the shared
 * data structures used by both Turtle and RDF/XML serializers.
 *
 * Returns `null` when the graph is empty, otherwise:
 *   { subjectMap, allIris, bnodeRefCount }
 *
 *   subjectMap    – Map<iriOrBnodeKey, Map<predIri, Term[]>>
 *                   blank node keys use the "_:" prefix (e.g., "_:c0")
 *   allIris       – Set<string> of every named-node IRI encountered
 *   bnodeRefCount – Map<bnodeLabel, number> counting object-position references
 */
function buildCanonicalSubjectMap(oid) {
  const gNode = namedNode(graphIriFor(oid));
  let quads = [...getStore().match(null, null, null, gNode)];
  if (quads.length === 0) return null;

  quads = canonicalizeBnodes(quads);

  const subjectMap = new Map();
  const allIris = new Set();
  const bnodeRefCount = new Map();

  for (const quad of quads) {
    if (quad.subject.termType === "NamedNode") allIris.add(quad.subject.value);
    allIris.add(quad.predicate.value);
    if (quad.object.termType === "NamedNode") allIris.add(quad.object.value);
    if (quad.object.termType === "Literal" && quad.object.datatype)
      allIris.add(quad.object.datatype.value);
    if (quad.object.termType === "BlankNode") {
      const k = quad.object.value;
      bnodeRefCount.set(k, (bnodeRefCount.get(k) ?? 0) + 1);
    }

    let s;
    if (quad.subject.termType === "NamedNode") {
      s = quad.subject.value;
    } else if (quad.subject.termType === "BlankNode") {
      s = `_:${quad.subject.value}`;
    } else {
      continue;
    }
    if (!subjectMap.has(s)) subjectMap.set(s, new Map());
    const pm = subjectMap.get(s);
    const p = quad.predicate.value;
    if (!pm.has(p)) pm.set(p, []);
    pm.get(p).push(quad.object);
  }

  return { subjectMap, allIris, bnodeRefCount };
}

/**
 * Generate a deterministic, human-readable, Protégé-style Turtle serialization
 * of a single ontology's named graph.
 *
 * Unlike `store.dump()`, this function:
 *  - Canonicalizes blank node labels so output is stable across server restarts
 *  - Sorts triples, subjects, and object lists for deterministic git diffs
 *  - Emits @prefix declarations for every namespace used
 *  - Emits @base when the ontology record has a base IRI
 *  - Groups entities into labelled sections (Object Properties / Classes …)
 *  - Precedes each entity with a  ###  <IRI>  comment
 *  - Aligns predicate-object pairs for readability
 *  - Uses triple-quoted strings for long / multi-line literals
 */
export function generateFormattedTurtle(oid, ontologyRecord) {
  const data = buildCanonicalSubjectMap(oid);
  if (!data) return "";
  const { subjectMap, allIris, bnodeRefCount } = data;

  const baseIri = ontologyRecord?.iri ?? null;
  const nsToPrefix = turtleBuildPrefixTable(allIris, baseIri);

  // ── Inline blank-node serializer ────────────────────────────────────────────
  // Tracks which blank nodes were inlined during rendering so they are
  // excluded from the final General Axioms section (no duplicate emission).
  const inlinedBnodes = new Set();

  const _RDF_FIRST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
  const _RDF_REST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
  const _RDF_NIL = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";
  const _RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

  // Mutable entity pad — set by emitEntity before rendering each named entity
  // so that serializeObject can compute indentation relative to the entity.
  let _entityPad = "";

  /**
   * Serialize predicate-object pairs for a blank node's predMap.
   * `contIndent` is the whitespace prefix for continuation predicate lines.
   */
  function serializePredObjects(pm, contIndent) {
    const entries = [...pm.entries()].sort(([pA], [pB]) => {
      const iA = TURTLE_PRED_ORDER.indexOf(pA);
      const iB = TURTLE_PRED_ORDER.indexOf(pB);
      if (iA !== -1 && iB !== -1) return iA - iB;
      if (iA !== -1) return -1;
      if (iB !== -1) return 1;
      return pA.localeCompare(pB);
    });
    return entries.map(([pred, objects]) => {
      // Use the Turtle "a" shorthand inside anonymous blank nodes.
      const p = pred === _RDF_TYPE ? "a" : turtleAbbrev(pred, nsToPrefix);
      const os = [...objects]
        .sort((a, b) => termSortKey(a).localeCompare(termSortKey(b)))
        .map((o) => serializeObject(o, `${contIndent}    `))
        .join(" , ");
      return `${p} ${os}`;
    });
  }

  /**
   * Try to serialize a blank node as an rdf:List `( elem1 elem2 ... )`.
   * `listElemIndent` is the prefix for each list element line.
   * Returns the list string on success, or null if `bn` is not a valid list head.
   */
  function trySerializeList(bn, listElemIndent) {
    const elems = [];
    const visitedList = [];
    let cur = bn;
    while (cur !== null) {
      const cpm = subjectMap.get(`_:${cur}`);
      if (!cpm) return null;
      const firsts = cpm.get(_RDF_FIRST);
      const rests = cpm.get(_RDF_REST);
      if (!firsts?.length || !rests?.length) return null;
      elems.push(serializeObject(firsts[0], `${listElemIndent}    `));
      visitedList.push(cur);
      const rest = rests[0];
      if (rest.termType === "NamedNode" && rest.value === _RDF_NIL) {
        cur = null;
      } else if (rest.termType === "BlankNode") {
        if (visitedList.includes(rest.value)) return null; // cycle guard
        cur = rest.value;
      } else {
        return null;
      }
    }
    if (elems.length === 0) return null;
    for (const v of visitedList) inlinedBnodes.add(v);
    // If every element is a simple token (no embedded newlines), keep inline.
    // Otherwise put each element on its own indented line.
    const allSimple = elems.every((e) => !e.includes("\n"));
    if (allSimple) return `( ${elems.join(" ")} )`;
    const closingIndent = listElemIndent.slice(0, -4) || ""; // 4 less than elem indent
    return `(\n${listElemIndent}${elems.join(`\n${listElemIndent}`)}\n${closingIndent})`;
  }

  /**
   * Serialize any RDF term, inlining blank nodes that are referenced exactly
   * once.  Uses `[ ... ]` for restrictions/anonymous classes and `( ... )` for
   * rdf:List chains.  Multiply-referenced blank nodes fall back to `_:cN`.
   *
   * `contIndent` is the whitespace string used for continuation predicate lines
   * INSIDE the blank node — it is computed from the current entity's pad so
   * that the output aligns correctly when `[` is placed at `_entityPad + 4`.
   */
  function serializeObject(term, contIndent) {
    // Default: align with a blank node placed at _entityPad + 4 spaces.
    if (contIndent === undefined) contIndent = `${_entityPad}      `;

    if (term.termType !== "BlankNode") return turtleTerm(term, nsToPrefix);

    const bn = term.value; // canonicalized label, e.g. "c50"
    const key = `_:${bn}`;
    const pm = subjectMap.get(key);

    // Can only inline if the node is referenced exactly once and has triples.
    if (!pm || (bnodeRefCount.get(bn) ?? 0) !== 1) return `_:${bn}`;
    // Guard against re-entrant inlining (cycles).
    if (inlinedBnodes.has(bn)) return `_:${bn}`;
    inlinedBnodes.add(bn);

    // Try rdf:List first (owl:intersectionOf / owl:unionOf arguments).
    if (pm.has(_RDF_FIRST)) {
      const listStr = trySerializeList(bn, `${contIndent}    `);
      if (listStr !== null) return listStr;
      // List parse failed — fall through to [ ] with the node still inlined.
    }

    // Serialize as an anonymous blank node: [ pred obj ; pred obj ; ... ]
    const parts = serializePredObjects(pm, contIndent);
    if (parts.length === 0) return "[]";
    if (parts.length === 1) return `[ ${parts[0]} ]`;

    // Multi-predicate: first predicate on same line as `[`, rest aligned.
    const lines = [`[ ${parts[0]} ;`];
    for (let i = 1; i < parts.length - 1; i++) lines.push(`${contIndent}${parts[i]} ;`);
    lines.push(`${contIndent}${parts[parts.length - 1]} ]`);
    return lines.join("\n");
  }
  // ── End inline serializer ────────────────────────────────────────────────────

  const cats = turtleCategorize(subjectMap);

  const out = [];

  // @prefix declarations — standard prefixes first, then alphabetical.
  // Track which namespaces are actually used, using longest-match — the same
  // algorithm turtleAbbrev() uses when abbreviating IRIs in the body.  Using
  // first-match (break on first hit) caused undeclared-prefix parse errors:
  // turtleAbbrev would pick a longer namespace (e.g. modem:) but usedNs would
  // record a shorter one, so the longer prefix was never written as @prefix.
  const usedNs = new Set();
  for (const iri of allIris) {
    let bestLen = 0;
    let bestNs = null;
    for (const [ns] of nsToPrefix) {
      if (iri.startsWith(ns) && ns.length > bestLen) {
        bestLen = ns.length;
        bestNs = ns;
      }
    }
    if (bestNs) usedNs.add(bestNs);
  }
  const STD = ["rdf", "rdfs", "owl", "xsd", "xml"];
  const sortedPfx = [...nsToPrefix.entries()]
    .filter(([ns]) => usedNs.has(ns))
    .sort(([, pA], [, pB]) => {
      const iA = STD.indexOf(pA);
      const iB = STD.indexOf(pB);
      if (iA !== -1 && iB !== -1) return iA - iB;
      if (iA !== -1) return -1;
      if (iB !== -1) return 1;
      return pA.localeCompare(pB);
    });

  for (const [ns, pfx] of sortedPfx) out.push(`@prefix ${pfx}: <${ns}> .`);
  if (baseIri) out.push(`@base <${baseIri}> .`);
  out.push("");

  const emitEntity = (iri) => {
    out.push(`###  ${iri}`);
    const predMap = subjectMap.get(iri);
    if (!predMap) {
      out.push("");
      return;
    }
    // Update the entity pad so serializeObject can compute aligned indentation.
    const subj = iri.startsWith("_:") ? iri : turtleAbbrev(iri, nsToPrefix);
    _entityPad = " ".repeat(subj.length + 1);
    out.push(...turtleEntityBlock(iri, predMap, nsToPrefix, serializeObject));
    out.push("");
  };

  const emitSection = (iris, title) => {
    if (!iris.length) return;
    out.push(...turtleSectionBanner(title));
    for (const iri of [...iris].sort()) emitEntity(iri);
  };

  // Ontology declaration(s) first — no section banner.
  for (const iri of cats.ontology) emitEntity(iri);
  emitSection(cats.objectProperties, "Object Properties");
  emitSection(cats.datatypeProperties, "Data Properties");
  emitSection(cats.annotationProperties, "Annotation Properties");
  emitSection(cats.classes, "Classes");
  emitSection(cats.individuals, "Named Individuals");

  // General Axioms: named subjects that don't fit the categories above, PLUS
  // any blank-node subjects that were NOT already inlined into a named entity.
  //
  // The inlinedBnodes filter is applied INSIDE the loop, not as a pre-filter:
  // emitting one general axiom (e.g. an owl:AllDisjointClasses subject) inlines
  // its rdf:List cells, and those cells are themselves blank-node subjects in
  // cats.other — if we used a static pre-filter they'd be in the list before
  // their parent inlined them and would emit a second time as orphan cells.
  //
  // Sort axiom-like bnodes (those with predicates other than rdf:first/rdf:rest)
  // before pure list cells, so a list head's parent inlines the chain before
  // the iterator reaches the cells.
  const isListCellOnly = (iri) => {
    if (!iri.startsWith("_:")) return false;
    const pm = subjectMap.get(iri);
    if (!pm || pm.size === 0) return false;
    for (const p of pm.keys()) {
      if (p !== _RDF_FIRST && p !== _RDF_REST) return false;
    }
    return true;
  };
  const sortedGeneral = [...cats.other].sort((a, b) => {
    const aList = isListCellOnly(a) ? 1 : 0;
    const bList = isListCellOnly(b) ? 1 : 0;
    if (aList !== bList) return aList - bList;
    return a.localeCompare(b);
  });
  let generalBannerEmitted = false;
  for (const iri of sortedGeneral) {
    if (iri.startsWith("_:") && inlinedBnodes.has(iri.slice(2))) continue;
    if (!generalBannerEmitted) {
      out.push(...turtleSectionBanner("General Axioms"));
      generalBannerEmitted = true;
    }
    emitEntity(iri);
  }

  return out.join("\n");
}

// ── RDF/XML serializer ────────────────────────────────────────────────────────

function xmlEscape(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlAttrEscape(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

const OWL_TYPE_TO_ELEMENT = new Map([
  ["http://www.w3.org/2002/07/owl#Ontology", "owl:Ontology"],
  ["http://www.w3.org/2002/07/owl#ObjectProperty", "owl:ObjectProperty"],
  ["http://www.w3.org/2002/07/owl#DatatypeProperty", "owl:DatatypeProperty"],
  ["http://www.w3.org/2002/07/owl#AnnotationProperty", "owl:AnnotationProperty"],
  ["http://www.w3.org/2002/07/owl#Class", "owl:Class"],
  ["http://www.w3.org/2002/07/owl#NamedIndividual", "owl:NamedIndividual"],
  ["http://www.w3.org/2002/07/owl#Restriction", "owl:Restriction"],
  ["http://www.w3.org/2002/07/owl#AllDisjointClasses", "owl:AllDisjointClasses"],
  ["http://www.w3.org/2002/07/owl#AllDisjointProperties", "owl:AllDisjointProperties"],
  ["http://www.w3.org/2002/07/owl#AllDifferent", "owl:AllDifferent"],
  ["http://www.w3.org/2002/07/owl#NegativePropertyAssertion", "owl:NegativePropertyAssertion"],
]);

function rdfXmlSectionComment(title) {
  const bar = "/".repeat(87);
  return `\n\n    <!-- \n    ${bar}\n    //\n    // ${title}\n    //\n    ${bar}\n     -->`;
}

/**
 * Generate a deterministic, Protégé-style RDF/XML serialization of a single
 * ontology's named graph. Matches Protégé's output conventions so that diffs
 * produced by the in-app compare tool align with PR diffs on GitHub.
 */
export function generateFormattedRdfXml(oid, ontologyRecord) {
  const data = buildCanonicalSubjectMap(oid);
  if (!data) return "";
  const { subjectMap, allIris, bnodeRefCount } = data;

  const baseIri = ontologyRecord?.iri ?? null;
  const nsToPrefix = turtleBuildPrefixTable(allIris, baseIri);

  // Resolve an IRI to a prefixed XML QName, or null if not possible.
  function iriToQName(iri) {
    let bestLen = 0;
    let bestPfx = null;
    for (const [ns, pfx] of nsToPrefix) {
      if (iri.startsWith(ns) && ns.length > bestLen) {
        bestLen = ns.length;
        bestPfx = pfx;
      }
    }
    if (bestPfx !== null) {
      const local = iri.substring(bestLen);
      if (local && /^[a-zA-Z_À-￿][a-zA-Z0-9_\-.·-￿]*$/.test(local)) {
        return `${bestPfx}:${local}`;
      }
    }
    return null;
  }

  // Pick the primary OWL element type for a predMap.
  function primaryTypeElement(predMap) {
    const types = (predMap.get(_RDF_TYPE) || []).map((t) => t.value);
    for (const t of types) {
      const elem = OWL_TYPE_TO_ELEMENT.get(t);
      if (elem) return { elem, primaryTypeIri: t };
    }
    return { elem: "rdf:Description", primaryTypeIri: null };
  }

  const _RDF_FIRST_X = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
  const _RDF_REST_X = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
  const _RDF_NIL_X = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";

  const inlinedBnodes = new Set();

  // Attempt to walk a blank node chain as an rdf:List. Returns member Terms or null.
  function tryGetListMembers(bn) {
    const members = [];
    const visited = [];
    let cur = bn;
    while (cur !== null) {
      const cpm = subjectMap.get(`_:${cur}`);
      if (!cpm) return null;
      const firsts = cpm.get(_RDF_FIRST_X);
      const rests = cpm.get(_RDF_REST_X);
      if (!firsts?.length || !rests?.length) return null;
      members.push(firsts[0]);
      visited.push(cur);
      const rest = rests[0];
      if (rest.termType === "NamedNode" && rest.value === _RDF_NIL_X) {
        cur = null;
      } else if (rest.termType === "BlankNode") {
        if (visited.includes(rest.value)) return null;
        cur = rest.value;
      } else {
        return null;
      }
    }
    if (members.length === 0) return null;
    for (const v of visited) inlinedBnodes.add(v);
    return members;
  }

  // Serialize a blank node inline as a child element of `predElem`.
  function serializeBnodeChild(bn, predElem, indent) {
    const pm = subjectMap.get(`_:${bn}`);
    if (!pm || (bnodeRefCount.get(bn) ?? 0) !== 1 || inlinedBnodes.has(bn)) {
      return `<${predElem} rdf:nodeID="${bn}"/>`;
    }
    inlinedBnodes.add(bn);

    // rdf:List → rdf:parseType="Collection"
    if (pm.has(_RDF_FIRST_X)) {
      const members = tryGetListMembers(bn);
      if (members !== null) {
        const memberLines = members.map((m) => {
          if (m.termType === "NamedNode") {
            return `${indent}    <rdf:Description rdf:about="${xmlAttrEscape(m.value)}"/>`;
          }
          if (m.termType === "BlankNode") {
            return serializeBnodeElement(m.value, `${indent}    `);
          }
          return `${indent}    <!-- literal collection member unsupported -->`;
        });
        return `<${predElem} rdf:parseType="Collection">\n${memberLines.join("\n")}\n${indent}</${predElem}>`;
      }
    }

    const { elem: innerElem, primaryTypeIri } = primaryTypeElement(pm);
    const childLines = buildPredicateLines(pm, primaryTypeIri, `${indent}    `);
    if (childLines.length === 0) {
      return `<${predElem}>\n${indent}    <${innerElem}/>\n${indent}</${predElem}>`;
    }
    return `<${predElem}>\n${indent}    <${innerElem}>\n${childLines.join("\n")}\n${indent}    </${innerElem}>\n${indent}</${predElem}>`;
  }

  // Serialize a blank node as a standalone element with rdf:nodeID.
  function serializeBnodeElement(bn, indent) {
    const pm = subjectMap.get(`_:${bn}`);
    if (!pm) return `${indent}<rdf:Description rdf:nodeID="${bn}"/>`;
    inlinedBnodes.add(bn);
    const { elem, primaryTypeIri } = primaryTypeElement(pm);
    const childLines = buildPredicateLines(pm, primaryTypeIri, `${indent}    `);
    if (childLines.length === 0) return `${indent}<${elem} rdf:nodeID="${bn}"/>`;
    return `${indent}<${elem} rdf:nodeID="${bn}">\n${childLines.join("\n")}\n${indent}</${elem}>`;
  }

  // Build sorted predicate-object child lines for a subject.
  // `skipTypeIri` is the primary type IRI already encoded in the element name.
  function buildPredicateLines(pm, skipTypeIri, indent) {
    const lines = [];

    const sortedPreds = [...pm.entries()].sort(([pA], [pB]) => {
      const iA = TURTLE_PRED_ORDER.indexOf(pA);
      const iB = TURTLE_PRED_ORDER.indexOf(pB);
      if (iA !== -1 && iB !== -1) return iA - iB;
      if (iA !== -1) return -1;
      if (iB !== -1) return 1;
      return pA.localeCompare(pB);
    });

    for (const [pred, objects] of sortedPreds) {
      if (pred === _RDF_TYPE) {
        // Emit additional types not encoded in the element name.
        const extras = [...objects]
          .filter((o) => o.termType === "NamedNode" && o.value !== skipTypeIri)
          .sort((a, b) => termSortKey(a).localeCompare(termSortKey(b)));
        for (const t of extras) {
          lines.push(`${indent}<rdf:type rdf:resource="${xmlAttrEscape(t.value)}"/>`);
        }
        continue;
      }

      const predElem = iriToQName(pred) ?? "rdf:Description";
      const sortedObjs = [...objects].sort((a, b) => termSortKey(a).localeCompare(termSortKey(b)));

      for (const obj of sortedObjs) {
        if (obj.termType === "NamedNode") {
          lines.push(`${indent}<${predElem} rdf:resource="${xmlAttrEscape(obj.value)}"/>`);
        } else if (obj.termType === "Literal") {
          const lang = obj.language;
          const dt = obj.datatype?.value;
          const text = xmlEscape(obj.value);
          if (lang) {
            lines.push(`${indent}<${predElem} xml:lang="${lang}">${text}</${predElem}>`);
          } else if (dt && dt !== "http://www.w3.org/2001/XMLSchema#string") {
            lines.push(
              `${indent}<${predElem} rdf:datatype="${xmlAttrEscape(dt)}">${text}</${predElem}>`,
            );
          } else {
            lines.push(`${indent}<${predElem}>${text}</${predElem}>`);
          }
        } else if (obj.termType === "BlankNode") {
          lines.push(`${indent}${serializeBnodeChild(obj.value, predElem, indent)}`);
        }
      }
    }

    return lines;
  }

  // ── Namespace declarations ────────────────────────────────────────────────
  const usedNs = new Set();
  for (const iri of allIris) {
    for (const [ns] of nsToPrefix) {
      if (iri.startsWith(ns)) {
        usedNs.add(ns);
        break;
      }
    }
  }
  const STD_XML_PFX = ["rdf", "rdfs", "owl", "xsd", "xml"];
  const sortedPfx = [...nsToPrefix.entries()]
    .filter(([ns]) => usedNs.has(ns))
    .sort(([, pA], [, pB]) => {
      const iA = STD_XML_PFX.indexOf(pA);
      const iB = STD_XML_PFX.indexOf(pB);
      if (iA !== -1 && iB !== -1) return iA - iB;
      if (iA !== -1) return -1;
      if (iB !== -1) return 1;
      return pA.localeCompare(pB);
    });

  // ── rdf:RDF opening element ───────────────────────────────────────────────
  const out = ['<?xml version="1.0"?>'];

  let defaultNs = null;
  const rdfRdfAttrs = [];

  if (baseIri) {
    const baseNs = turtleNsOf(baseIri);
    if (baseNs) {
      defaultNs = baseNs;
      rdfRdfAttrs.push(`xmlns="${xmlAttrEscape(baseNs)}"`);
      rdfRdfAttrs.push(`xml:base="${xmlAttrEscape(baseNs.replace(/[#/]+$/, ""))}"`);
    }
  }

  for (const [ns, pfx] of sortedPfx) {
    if (ns === defaultNs) continue;
    rdfRdfAttrs.push(`xmlns:${pfx}="${xmlAttrEscape(ns)}"`);
  }

  if (rdfRdfAttrs.length === 0) {
    out.push("<rdf:RDF>");
  } else {
    const align = " ".repeat(9); // align attrs after "<rdf:RDF "
    out.push(`<rdf:RDF ${rdfRdfAttrs[0]}`);
    for (let i = 1; i < rdfRdfAttrs.length; i++) {
      out.push(`${align}${rdfRdfAttrs[i]}`);
    }
    out[out.length - 1] += ">";
  }

  // ── Categorize and emit ───────────────────────────────────────────────────
  const cats = turtleCategorize(subjectMap);

  function emitNamedEntity(iri) {
    const predMap = subjectMap.get(iri);
    if (!predMap) return;
    const { elem, primaryTypeIri } = primaryTypeElement(predMap);
    const aboutAttr = `rdf:about="${xmlAttrEscape(iri)}"`;
    const childLines = buildPredicateLines(predMap, primaryTypeIri, "        ");
    out.push(`\n\n    <!-- ${iri} -->\n`);
    if (childLines.length === 0) {
      out.push(`    <${elem} ${aboutAttr}/>`);
    } else {
      out.push(`    <${elem} ${aboutAttr}>`);
      out.push(...childLines);
      out.push(`    </${elem}>`);
    }
  }

  function emitXmlSection(iris, title) {
    if (!iris.length) return;
    out.push(rdfXmlSectionComment(title));
    for (const iri of [...iris].sort()) emitNamedEntity(iri);
  }

  for (const iri of cats.ontology) emitNamedEntity(iri);
  emitXmlSection(cats.objectProperties, "Object Properties");
  emitXmlSection(cats.datatypeProperties, "Data Properties");
  emitXmlSection(cats.annotationProperties, "Annotation Properties");
  emitXmlSection(cats.classes, "Classes");
  emitXmlSection(cats.individuals, "Named Individuals");

  const generalAxioms = cats.other.filter(
    (iri) => !iri.startsWith("_:") || !inlinedBnodes.has(iri.slice(2)),
  );
  if (generalAxioms.length > 0) {
    out.push(rdfXmlSectionComment("General Axioms"));
    for (const iri of generalAxioms) {
      if (iri.startsWith("_:")) {
        const bn = iri.slice(2);
        out.push(`\n\n    <!-- Axiom -->\n`);
        out.push(serializeBnodeElement(bn, "    "));
      } else {
        emitNamedEntity(iri);
      }
    }
  }

  out.push("\n\n</rdf:RDF>");
  return out.join("\n");
}

// ── RDF-level branch merge ────────────────────────────────────────────────────

/**
 * Compute a stable string key for an RDF term (for set-based quad comparison).
 * Blank nodes are keyed by their canonicalized label so that matching across
 * graphs works correctly when both sides were serialized by the same formatter.
 */
function _quadKey(q) {
  const s = q.subject.termType === "BlankNode" ? `_:${q.subject.value}` : `<${q.subject.value}>`;
  const p = `<${q.predicate.value}>`;
  let o;
  if (q.object.termType === "NamedNode") {
    o = `<${q.object.value}>`;
  } else if (q.object.termType === "BlankNode") {
    o = `_:${q.object.value}`;
  } else {
    // Literal
    const dt = q.object.datatype?.value ?? "";
    const lang = q.object.language ?? "";
    o = `"${q.object.value}"^^${dt}@${lang}`;
  }
  return `${s}\x00${p}\x00${o}`;
}

/**
 * Merge a branch's RDF graph back into its parent using 3-way RDF merge.
 *
 * Strategy: load the base snapshot into a temporary named graph in the MAIN
 * store, then apply all changes via SPARQL UPDATE — entirely inside the Rust
 * store, with zero JS-side quad/term object access.  This avoids the
 * "null pointer passed to rust" error that occurs when native Oxigraph term
 * objects are retained past their backing iterator's lifetime.
 *
 * Merge rules:
 *   - branch added something (not in base) → add to parent
 *   - branch removed something (in base, not in branch) → remove from parent
 *
 * Returns:
 *   { ok: true }
 *       — clean merge; parent named graph updated in-memory and scheduled for persist.
 */
export async function mergeOntologyBranch(branchId, parentId) {
  const parentGIri = graphIriFor(parentId);
  const branchGIri = graphIriFor(branchId);
  // Unique IRI for the temporary base graph — avoids collision if multiple
  // merges run concurrently (unlikely but safe).
  const baseGIri = `urn:rdfstore:merge-base:${branchId}`;

  // ── Load base.ttl into a temporary named graph in the main store ────────────
  // Keeping everything inside the main store means all merge operations can be
  // expressed as SPARQL UPDATEs — no native term objects cross the JS/Rust
  // boundary.
  let baseLoaded = false;
  const basePath = getBranchBasePath(branchId);
  if (fs.existsSync(basePath)) {
    const baseTurtle = fs.readFileSync(basePath, "utf-8").trim();
    if (baseTurtle) {
      try {
        // Drop any stale base graph from a previous failed/interrupted merge.
        try {
          store.update(`DROP GRAPH <${baseGIri}>`);
        } catch {}
        store.load(baseTurtle, { format: FORMAT, to_graph_name: namedNode(baseGIri) });
        baseLoaded = true;
      } catch (err) {
        console.warn("[rdfStore] mergeOntologyBranch: could not parse base.ttl:", err.message);
      }
    }
  }

  // ── Apply 3-way merge via SPARQL UPDATE ─────────────────────────────────────
  if (baseLoaded) {
    // Step 1: remove from parent what branch deleted (in base + parent, not in branch).
    store.update(`
      DELETE { GRAPH <${parentGIri}> { ?s ?p ?o } }
      WHERE {
        GRAPH <${baseGIri}>   { ?s ?p ?o }
        GRAPH <${parentGIri}> { ?s ?p ?o }
        FILTER NOT EXISTS { GRAPH <${branchGIri}> { ?s ?p ?o } }
      }
    `);

    // Step 2: add to parent what branch added (not in base, not already in parent).
    store.update(`
      INSERT { GRAPH <${parentGIri}> { ?s ?p ?o } }
      WHERE {
        GRAPH <${branchGIri}> { ?s ?p ?o }
        FILTER NOT EXISTS { GRAPH <${baseGIri}>   { ?s ?p ?o } }
        FILTER NOT EXISTS { GRAPH <${parentGIri}> { ?s ?p ?o } }
      }
    `);

    // Drop the temporary base graph.
    try {
      store.update(`DROP GRAPH <${baseGIri}>`);
    } catch {}
  } else {
    // No base snapshot — fall back to a simple union merge:
    // add all branch triples that are not already in the parent.
    store.update(`
      INSERT { GRAPH <${parentGIri}> { ?s ?p ?o } }
      WHERE {
        GRAPH <${branchGIri}> { ?s ?p ?o }
        FILTER NOT EXISTS { GRAPH <${parentGIri}> { ?s ?p ?o } }
      }
    `);
  }

  cacheInvalidate(parentId);
  schedulePersist(parentId);
  return { ok: true };
}

/**
 * Resolve a pending RDF merge conflict by choosing one side.
 *
 * choice "ours"   → keep parent as-is (branch changes discarded).
 * choice "theirs" → replace parent graph with branch graph content.
 *
 * In both cases the parent is persisted and the in-memory store is correct
 * — no reloadOntologyFromDisk() needed after calling this.
 */
export async function resolveOntologyConflict(branchId, parentId, choice) {
  const parentGIri = graphIriFor(parentId);
  const branchGIri = graphIriFor(branchId);

  if (choice === "theirs") {
    // Replace parent graph with branch graph.
    store.update(`DELETE WHERE { GRAPH <${parentGIri}> { ?s ?p ?o } }`);
    store.update(
      `INSERT { GRAPH <${parentGIri}> { ?s ?p ?o } }
       WHERE  { GRAPH <${branchGIri}> { ?s ?p ?o } }`,
    );
    cacheInvalidate(parentId);
  }
  // "ours": parent graph is already correct — nothing to change in the store.

  await persistOntology(parentId);
}

export { BlankNode, DefaultGraph, Literal, NamedNode, Quad, Store };
