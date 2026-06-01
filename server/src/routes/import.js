import http from "node:http";
import https from "node:https";
import { Router } from "express";
import multer from "multer";
import oxigraph from "oxigraph";
import { v4 as uuid } from "uuid";
import { requireAuth, requireProjectRole } from "../middleware/auth.js";
import { requireSingleOntology, resolveOntology } from "../middleware/ontology.js";
import {
  addProjectMember,
  getDb,
  getOntology,
  getProject,
  getProjectRoleFor,
  logChange,
  projectRoleMeets,
} from "../services/authDb.js";
import {
  cacheInvalidate,
  generateFormattedTurtle,
  getOntologyRdfMeta,
  getOntologySubjectIri,
  getStore,
  graphIriFor,
  normalizeRdfNamespaces,
  persistOntology,
  reloadOntologyFromDisk,
  schedulePersist,
  validatePropertyTypeConflicts,
} from "../services/rdfStore.js";

const { namedNode } = oxigraph;

const OWL_IMPORTS_IRI = "http://www.w3.org/2002/07/owl#imports";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ── URL fetching helpers ──────────────────────────────────────────────────────

/**
 * Reject URLs that target private/internal infrastructure (SSRF prevention).
 * Allows only http: and https: and blocks loopback, link-local, RFC1918 ranges,
 * and well-known cloud metadata endpoints.
 */
// Strips trailing '#' and '/' characters from an IRI/URL without using a
// quantifier+anchor regex that backtrack polynomially on crafted strings.
function stripIriTrailing(s) {
  let end = s.length;
  while (end > 0 && (s[end - 1] === "#" || s[end - 1] === "/")) end--;
  return end < s.length ? s.slice(0, end) : s;
}

// Returns the validated, normalized URL string to use downstream.
// Throws if the URL targets private/internal infrastructure (SSRF prevention).
function validateFetchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Disallowed protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  const BLOCKED = [
    /^localhost$/,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^0:0:0:0:0:0:0:1$/,
    // Link-local / cloud metadata
    /^169\.254\./,
    /^fe80:/i,
    /^metadata\.google\.internal$/,
    // RFC1918 private ranges
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./,
    // mDNS
    /\.local$/,
  ];
  if (BLOCKED.some((re) => re.test(host))) {
    throw new Error(`Disallowed host: ${host}`);
  }
  // Return the normalized URL from the parsed object (not the raw input)
  return parsed.href;
}

/**
 * Follow redirects and return { text, contentType } for the given URL.
 * Limits to 5 redirects and a 32 MB body to stay reasonable.
 */
function httpGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    // validateFetchUrl throws on unsafe URLs and returns the normalized URL;
    // use safeUrl downstream so the value flowing into lib.get is sanitized.
    const safeUrl = validateFetchUrl(url);
    const parsed = new URL(safeUrl);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(
      safeUrl,
      {
        headers: {
          Accept:
            "text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8, application/n-triples;q=0.7, */*;q=0.5",
          "User-Agent": "Amethyst-Ontology-Editor",
        },
        timeout: 30_000,
      },
      (res) => {
        // Follow 3xx redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects fetching ${url}`));
          const next = validateFetchUrl(new URL(res.headers.location, url).toString());
          return resolve(httpGet(next, redirectsLeft - 1));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > 32 * 1024 * 1024) {
            res.destroy();
            reject(new Error(`Response too large fetching ${url}`));
          } else {
            chunks.push(chunk);
          }
        });
        res.on("end", () =>
          resolve({
            text: Buffer.concat(chunks).toString("utf-8"),
            contentType: res.headers["content-type"] || "",
            finalUrl: url, // the URL we actually fetched (after all redirects)
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

function detectFormatFromContentType(ct) {
  if (!ct) return null;
  const base = ct.split(";")[0].trim().toLowerCase();
  switch (base) {
    case "text/turtle":
      return "text/turtle";
    case "text/n3":
      return "text/n3";
    case "application/n-triples":
      return "application/n-triples";
    case "application/n-quads":
      return "application/n-quads";
    case "application/trig":
      return "application/trig";
    case "application/rdf+xml":
    case "application/xml":
    case "text/xml":
      return "application/rdf+xml";
    case "application/ld+json":
    case "application/json":
      return "application/ld+json";
    // HTML responses are NOT RDF — signal the caller to skip loading.
    case "text/html":
    case "application/xhtml+xml":
      return "text/html";
    default:
      return null;
  }
}

/**
 * Fetch `url`, load into `store`/`graphNode`, then for each `owl:imports` IRI
 * found in that graph create a NEW sibling ontology record in `projectId` and
 * load the imported content into its own named graph (recursively).
 *
 * Returns an array of newly-created sibling ontology objects { id, name, iri }.
 */
async function loadUrlWithImportsAsSiblings(
  url,
  store,
  graphNode,
  projectId,
  uid,
  visited = new Set(),
) {
  if (visited.has(url)) return { created: [], failed: [] };
  visited.add(url);

  const { text, contentType, finalUrl } = await httpGet(url);

  // Use the final URL (after redirects) for filename/extension detection.
  // Content-negotiated IRIs like `.../Core/` end with `/`, making the last
  // path segment empty → the original URL would give us no extension and
  // defaulting to Turtle, which breaks RDF/XML files served from GitHub raw.
  const effectiveFilename =
    (finalUrl || url).split("?")[0].split("/").filter(Boolean).pop() || "remote";
  const ctFormat = detectFormatFromContentType(contentType);

  // Reject HTML responses before they reach the RDF parser.
  // purl.obolibrary.org and similar content-negotiating servers can return an
  // HTML landing page when the Accept header isn't matched — passing that to
  // Oxigraph produces a cryptic "Invalid IRI code point ' '" parse error.
  if (ctFormat === "text/html") {
    throw new Error(
      `Server returned text/html instead of RDF (content-type: ${contentType}). ` +
        "The URL may require a different Accept header or the resource is unavailable.",
    );
  }

  const format = ctFormat || detectFormat(effectiveFilename, null);

  store.load(normalizeRdfNamespaces(text), { format, to_graph_name: graphNode });

  return _createSiblingsForImports(store, graphNode, projectId, uid, visited);
}

/**
 * After loading RDF text into `store`/`graphNode`, inspect the graph for
 * `owl:imports` triples and create a NEW sibling ontology record in `projectId`
 * for each one (recursively).
 *
 * Returns an array of newly-created sibling ontology objects { id, name, iri }.
 */
async function resolveOwlImportsAsSiblings(store, graphNode, projectId, uid, visited = new Set()) {
  return _createSiblingsForImports(store, graphNode, projectId, uid, visited);
}

/**
 * Internal: find owl:imports in `graphNode`, create a sibling ontology per
 * import URL, load each into its own graph, recurse.
 *
 * Returns { created: [...], failed: [{ iri, error }] }.
 */
async function _createSiblingsForImports(store, graphNode, projectId, uid, visited) {
  const importUrls = [];
  for (const quad of store.match(null, namedNode(OWL_IMPORTS_IRI), null, graphNode)) {
    if (quad.object.termType === "NamedNode") {
      importUrls.push(quad.object.value);
    }
  }

  const created = [];
  const failed = [];

  for (const imp of importUrls) {
    if (visited.has(imp)) continue;

    // De-duplicate: skip if an ontology with this IRI already exists in the
    // project (e.g. another file in the same project also declares the same
    // owl:imports — SKOS, DC Terms, etc.).
    const existing = await getDb().queryOne(
      "SELECT id FROM ontologies WHERE project_id = ? AND iri = ?",
      [projectId, imp],
    );
    if (existing) {
      visited.add(imp); // mark as seen so recursive calls skip it too
      continue;
    }

    const oid = uuid();
    const now = Date.now();
    const impName = (imp.split("?")[0].split("/").filter(Boolean).pop() || "import")
      .replace(/\.[^.]+$/, "")
      .replace(/[#/]+$/, "");
    try {
      await getDb().run(
        `INSERT INTO ontologies
          (id, name, iri, description, project_id,
           created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [oid, impName, imp, null, projectId, now, uid, now, uid],
      );

      const g = graphIriFor(oid);
      const sub = await loadUrlWithImportsAsSiblings(
        imp,
        store,
        namedNode(g),
        projectId,
        uid,
        visited,
      );
      persistOntology(oid);

      // Prefer rdfs:label / dcterms:title from the loaded graph over the
      // URL-fragment fallback we inserted above.
      const rdfLabel = getOntologyRdfMeta(oid).title;
      const finalName = rdfLabel || impName;
      if (rdfLabel) {
        await getDb().run("UPDATE ontologies SET name = ?, updated_at = ? WHERE id = ?", [
          rdfLabel,
          Date.now(),
          oid,
        ]);
      }
      created.push({ id: oid, name: finalName, iri: imp }, ...sub.created);
      failed.push(...sub.failed);
    } catch (err) {
      // Best-effort: remove the row if the fetch/load blew up.
      try {
        await getDb().run("DELETE FROM ontologies WHERE id = ?", [oid]);
      } catch {}
      const msg = err.message || String(err);
      console.warn(`[import] Failed to load owl:imports <${imp}>: ${msg}`);
      failed.push({ iri: imp, error: msg });
    }
  }
  return { created, failed };
}

// POST /api/import/ttl
//
// Three ingest modes, selected automatically:
//
//   1. Import into an EXISTING ontology — pass ?ontology=<id> (or let
//      resolveOntology pick the current one). Body may set `replace=true` to
//      clear the ontology's graph first.
//
//   2. Import as a NEW ontology in an existing project — add `new_ontology=true`
//      (plus ?project=<pid> if needed). The file is loaded into a freshly
//      created child ontology; siblings are untouched. `name` from the body
//      becomes the new ontology's display name (defaults to the filename).
//
//   3. Import as a NEW project — pass `new_project=true`. A new project is
//      created containing a single ontology seeded from the upload. `name`
//      is used for the project (and the ontology inherits it).
//
//   Source can be a multipart file upload OR a JSON body with `url` / `text`.
//   When `url` is supplied the server fetches the resource and also chases any
//   owl:imports IRIs declared in the ontology.
//
router.post("/ttl", requireAuth, upload.single("file"), async (req, res, next) => {
  // New-project mode short-circuits resolveOntology — there may be no project
  // context at all yet. Any authenticated user can create a new project from
  // an import (they become its manager).
  const flag = (v) => v === "true" || v === true;
  if (flag(req.body?.new_project)) return importAsNewProject(req, res);
  resolveOntology(req, res, async (err) => {
    if (err) return next(err);
    // Both remaining modes write into an existing project; caller needs editor+.
    const u = req.session.user;
    const role = await getProjectRoleFor(u.id, req.projectId, u.role);
    if (!role || !projectRoleMeets(role, "editor")) {
      return res.status(403).json({ error: "forbidden" });
    }
    if (flag(req.body?.new_ontology)) return importAsNewOntology(req, res);
    return requireSingleOntology(req, res, () => importIntoExistingOntology(req, res));
  });
});

function readUpload(req) {
  let text;
  let format = "text/turtle";
  let filename;
  if (req.file) {
    text = req.file.buffer.toString("utf-8");
    filename = req.file.originalname || "uploaded";
    format = detectFormat(filename, req.body?.format);
  } else if (req.body?.text) {
    text = req.body.text;
    filename = req.body?.name || "inline";
    if (req.body.format) format = req.body.format;
  }
  return { text, format, filename };
}

// ── Import handlers (async to support URL fetching) ──────────────────────────

async function importIntoExistingOntology(req, res) {
  const replace = req.body?.replace === "true" || req.body?.replace === true;
  const uid = req.session.user.id;
  const oid = req.ontologyId;
  const g = graphIriFor(oid);
  const store = getStore();
  const gNode = namedNode(g);

  try {
    const before = store.size;
    // CLEAR SILENT: no-op (rather than an error) when the named graph was
    // never created (e.g. the on-disk .ttl failed to load on startup).
    if (replace) {
      store.update(`CLEAR SILENT GRAPH <${g}>`);
      // Invalidate the query cache immediately so any cached counts/queries
      // for this ontology are not served after the graph is cleared.
      cacheInvalidate(oid);
    }

    let filename;
    let siblings = [];
    let failedImports = [];

    // Resolve owl:imports as sibling ontologies. The helper already de-duplicates
    // by IRI, so re-running it on subsequent saves is safe — it will simply skip
    // any import that already exists in the project.
    if (req.body?.url) {
      const url = req.body.url.toString().trim();
      const { text, contentType, finalUrl } = await httpGet(url);
      // Use the final URL (after redirects) for filename/format detection so
      // content-negotiated IRIs ending in `/` don't fall back to "text/turtle".
      const effectiveFilename =
        (finalUrl || url).split("?")[0].split("/").filter(Boolean).pop() || "remote";
      filename = effectiveFilename;
      const ctFmt = detectFormatFromContentType(contentType);
      if (ctFmt === "text/html") {
        throw new Error(
          `Server returned text/html instead of RDF (content-type: ${contentType}). ` +
            "The URL may require a different Accept header or the resource is unavailable.",
        );
      }
      const format = ctFmt || detectFormat(effectiveFilename, null);
      store.load(normalizeRdfNamespaces(text), { format, to_graph_name: gNode });
      // Invalidate stale cached SPARQL results so the freshly-loaded data is
      // visible immediately to all subsequent reads (meta, classes, graph, etc.).
      cacheInvalidate(oid);
      ({ created: siblings, failed: failedImports } = await resolveOwlImportsAsSiblings(
        store,
        gNode,
        req.projectId,
        uid,
      ));
    } else {
      const { text, format, filename: fn } = readUpload(req);
      filename = fn;
      if (!text) return res.status(400).json({ error: "no file, text, or url provided" });
      store.load(normalizeRdfNamespaces(text), { format, to_graph_name: gNode });
      // Invalidate stale cached SPARQL results so the freshly-loaded data is
      // visible immediately to all subsequent reads (meta, classes, graph, etc.).
      cacheInvalidate(oid);
      ({ created: siblings, failed: failedImports } = await resolveOwlImportsAsSiblings(
        store,
        gNode,
        req.projectId,
        uid,
      ));
    }

    const conflicts = validatePropertyTypeConflicts(oid);
    if (conflicts.length) {
      await reloadOntologyFromDisk(oid);
      throw new Error(
        `Properties declared as both owl:ObjectProperty and owl:DatatypeProperty: ${conflicts.join(", ")}`,
      );
    }

    const after = store.size;
    // Use the default persist delay (2 s) rather than the previous 100 ms.
    // Firing the heavy generateFormattedTurtle serializer 100 ms after import
    // blocked the Node.js event loop during the client's follow-up requests
    // (meta counts, graph data, etc.), making the UI appear broken for large
    // ontologies like D3FEND (~58K triples).
    schedulePersist(oid);

    // Auto-detect and persist the Base IRI from the imported content when the
    // ontology doesn't already have one.  A Turtle `@base <IRI>` is resolved by
    // Oxigraph into the owl:Ontology subject IRI, so querying the graph after
    // loading is the most format-agnostic way to recover it.
    if (!req.ontology?.iri) {
      const detectedIri = getOntologySubjectIri(oid);
      if (detectedIri) {
        await getDb().run(
          "UPDATE ontologies SET iri = ?, updated_at = ?, updated_by = ? WHERE id = ?",
          [detectedIri, Date.now(), uid, oid],
        );
      }
    }

    if (req.body?.name) {
      await getDb().run(
        "UPDATE ontologies SET name = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        [req.body.name, Date.now(), uid, oid],
      );
    }
    logChange(uid, oid, "import", {
      filename,
      added: after - before,
      replace,
      source: req.body?.url ? "url" : "file",
      importedOntologies: siblings.length,
      failedImports: failedImports.length,
    });
    res.json({
      ok: true,
      mode: "existing",
      ontology: await getOntology(oid),
      added: after - before,
      totalTriples: after,
      importedOntologies: siblings,
      failedImports,
    });
  } catch (err) {
    res.status(400).json({ error: `Import failed: ${err.message || err}` });
  }
}

async function importAsNewOntology(req, res) {
  if (!req.projectId) return res.status(400).json({ error: "project required" });

  const uid = req.session.user.id;
  const projectId = req.projectId;
  const now = Date.now();
  const oid = uuid();
  const iri = req.body?.iri || null;

  let filename;
  // loadFn returns the array of sibling ontologies created for owl:imports
  let loadFn;

  if (req.body?.url) {
    const url = req.body.url.toString().trim();
    filename = stripIriTrailing(url.split("?")[0].split("/").pop() || "remote") || "remote";
    loadFn = (store, gNode) => loadUrlWithImportsAsSiblings(url, store, gNode, projectId, uid);
  } else {
    const { text, format, filename: fn } = readUpload(req);
    filename = fn;
    if (!text) return res.status(400).json({ error: "no file, text, or url provided" });
    loadFn = (store, gNode) => {
      store.load(normalizeRdfNamespaces(text), { format, to_graph_name: gNode });
      return resolveOwlImportsAsSiblings(store, gNode, projectId, uid);
    };
  }

  const name = (req.body?.name || filename || "Imported ontology").toString();

  try {
    await getDb().run(
      `INSERT INTO ontologies
        (id, name, iri, description, project_id,
         created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [oid, name, iri, null, projectId, now, uid, now, uid],
    );

    const store = getStore();
    const g = graphIriFor(oid);
    const before = store.size;
    const { created: siblings, failed: failedImports } = await loadFn(store, namedNode(g));

    const conflicts = validatePropertyTypeConflicts(oid);
    if (conflicts.length) {
      store.update(`CLEAR SILENT GRAPH <${g}>`);
      throw new Error(
        `Properties declared as both owl:ObjectProperty and owl:DatatypeProperty: ${conflicts.join(", ")}`,
      );
    }

    const after = store.size;
    // Invalidate the query cache before persisting so the imported data is
    // visible to all reads immediately (new ontology — cache may be cold, but
    // explicit invalidation ensures correctness for all code paths).
    cacheInvalidate(oid);
    // Use schedulePersist (setTimeout-based) rather than calling persistOntology
    // directly.  persistOntology calls generateFormattedTurtle synchronously;
    // when triggered via a Promise.resolve() microtask continuation it runs
    // BEFORE res.json() fires, blocking the event loop for large ontologies
    // (e.g. D3FEND ~58K triples) and preventing the modal from closing.
    schedulePersist(oid);

    // If the caller didn't provide an explicit name, prefer rdfs:label /
    // dcterms:title from the loaded ontology graph over the filename fallback.
    if (!req.body?.name) {
      const rdfLabel = getOntologyRdfMeta(oid).title;
      if (rdfLabel) {
        await getDb().run("UPDATE ontologies SET name = ?, updated_at = ? WHERE id = ?", [
          rdfLabel,
          Date.now(),
          oid,
        ]);
      }
    }

    // Auto-detect the Base IRI from the imported content when none was
    // explicitly provided.  Oxigraph resolves `@base` / relative `<>` into the
    // owl:Ontology subject IRI, so a simple graph query is sufficient.
    if (!iri) {
      const detectedIri = getOntologySubjectIri(oid);
      if (detectedIri) {
        await getDb().run("UPDATE ontologies SET iri = ?, updated_at = ? WHERE id = ?", [
          detectedIri,
          Date.now(),
          oid,
        ]);
      }
    }

    logChange(uid, oid, "import-new-ontology", {
      filename,
      added: after - before,
      projectId,
      name,
      source: req.body?.url ? "url" : "file",
      importedOntologies: siblings.length,
      failedImports: failedImports.length,
    });
    res.json({
      ok: true,
      mode: "new-ontology",
      ontology: await getOntology(oid),
      added: after - before,
      totalTriples: after,
      importedOntologies: siblings,
      failedImports,
    });
  } catch (err) {
    // Best-effort rollback of the SQLite row if the RDF load blew up.
    try {
      await getDb().run("DELETE FROM ontologies WHERE id = ?", [oid]);
    } catch {}
    res.status(400).json({ error: `Import failed: ${err.message || err}` });
  }
}

async function importAsNewProject(req, res) {
  const uid = req.session.user.id;
  const now = Date.now();
  const pid = uuid();
  const oid = uuid();
  const iri = req.body?.iri || null;
  const description = req.body?.description || null;

  let filename;
  // loadFn receives (store, gNode, projectId) — projectId known only after DB insert
  let prepareLoad;

  if (req.body?.url) {
    const url = req.body.url.toString().trim();
    filename = stripIriTrailing(url.split("?")[0].split("/").pop() || "remote") || "remote";
    prepareLoad = (projectId) => (store, gNode) =>
      loadUrlWithImportsAsSiblings(url, store, gNode, projectId, uid);
  } else {
    const { text, format, filename: fn } = readUpload(req);
    filename = fn;
    if (!text) return res.status(400).json({ error: "no file, text, or url provided" });
    prepareLoad = (projectId) => (store, gNode) => {
      store.load(normalizeRdfNamespaces(text), { format, to_graph_name: gNode });
      return resolveOwlImportsAsSiblings(store, gNode, projectId, uid);
    };
  }

  const name = (req.body?.name || filename || "Imported project").toString();

  try {
    await getDb().run(
      `INSERT INTO projects (id, name, description, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [pid, name, description, now, uid, now, uid],
    );
    // The importer becomes the project's manager.
    await addProjectMember(pid, uid, "manager");

    await getDb().run(
      `INSERT INTO ontologies
          (id, name, iri, description, project_id,
           created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [oid, name, iri, null, pid, now, uid, now, uid],
    );

    const store = getStore();
    const g = graphIriFor(oid);
    const before = store.size;
    const loadFn = prepareLoad(pid);
    const { created: siblings, failed: failedImports } = await loadFn(store, namedNode(g));

    const conflicts = validatePropertyTypeConflicts(oid);
    if (conflicts.length) {
      store.update(`CLEAR SILENT GRAPH <${g}>`);
      throw new Error(
        `Properties declared as both owl:ObjectProperty and owl:DatatypeProperty: ${conflicts.join(", ")}`,
      );
    }

    const after = store.size;
    // Invalidate the query cache before persisting so the imported data is
    // visible to all reads immediately.
    cacheInvalidate(oid);
    // Use schedulePersist (setTimeout-based) — same reason as importAsNewOntology.
    schedulePersist(oid);

    // Sync the ontology's display name from rdfs:label / dcterms:title when no
    // explicit name was provided by the caller.
    if (!req.body?.name) {
      const rdfLabel = getOntologyRdfMeta(oid).title;
      if (rdfLabel) {
        await getDb().run("UPDATE ontologies SET name = ?, updated_at = ? WHERE id = ?", [
          rdfLabel,
          Date.now(),
          oid,
        ]);
      }
    }

    // Auto-detect the Base IRI from the imported content when none was
    // explicitly provided.  Oxigraph resolves `@base` / relative `<>` into the
    // owl:Ontology subject IRI, so a simple graph query is sufficient.
    if (!iri) {
      const detectedIri = getOntologySubjectIri(oid);
      if (detectedIri) {
        await getDb().run("UPDATE ontologies SET iri = ?, updated_at = ? WHERE id = ?", [
          detectedIri,
          Date.now(),
          oid,
        ]);
      }
    }

    logChange(uid, oid, "import-new-project", {
      filename,
      added: after - before,
      projectId: pid,
      name,
      source: req.body?.url ? "url" : "file",
      importedOntologies: siblings.length,
      failedImports: failedImports.length,
    });
    res.json({
      ok: true,
      mode: "new-project",
      project: await getProject(pid),
      ontology: await getOntology(oid),
      added: after - before,
      totalTriples: after,
      importedOntologies: siblings,
      failedImports,
    });
  } catch (err) {
    // Rollback both rows if anything fails.
    try {
      await getDb().run("DELETE FROM ontologies WHERE id = ?", [oid]);
    } catch {}
    try {
      await getDb().run("DELETE FROM projects WHERE id = ?", [pid]);
    } catch {}
    res.status(400).json({ error: `Import failed: ${err.message || err}` });
  }
}

// GET /api/import/export?ontology=<id>&format=text/turtle
router.get(
  "/export",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("viewer"),
  async (req, res) => {
    const format = (req.query.format || "text/turtle").toString();
    const oid = req.ontologyId;
    try {
      let text;
      if (format === "text/turtle") {
        // Use the custom formatter that produces Protégé-style output with
        // @prefix declarations, section headers, and ### IRI comments.
        text = generateFormattedTurtle(oid, req.ontology);
      } else {
        // Fall back to Oxigraph's native serialiser for other formats.
        text = getStore().dump({
          format,
          from_graph_name: namedNode(graphIriFor(oid)),
        });
      }
      const ext = extFor(format);
      const safeName = (req.ontology.name || "ontology").replace(/[^a-z0-9_-]+/gi, "_");
      res.setHeader("Content-Type", format);
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.${ext}"`);
      res.send(text);
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

function detectFormat(filename, hint) {
  if (hint) return hint;
  const ext = (filename.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "ttl":
      return "text/turtle";
    case "nt":
      return "application/n-triples";
    case "nq":
      return "application/n-quads";
    case "trig":
      return "application/trig";
    case "rdf":
    case "xml":
    case "owl":
      return "application/rdf+xml";
    case "jsonld":
    case "json":
      return "application/ld+json";
    case "n3":
      return "text/n3";
    default:
      return "text/turtle";
  }
}

function extFor(format) {
  switch (format) {
    case "text/turtle":
      return "ttl";
    case "application/n-triples":
      return "nt";
    case "application/n-quads":
      return "nq";
    case "application/trig":
      return "trig";
    case "application/rdf+xml":
      return "rdf";
    case "application/ld+json":
      return "jsonld";
    default:
      return "ttl";
  }
}

export { detectFormat, resolveOwlImportsAsSiblings };
export default router;
