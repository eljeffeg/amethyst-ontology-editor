import { Router } from "express";
import { requireAuth, requireProjectRole } from "../middleware/auth.js";
import { requireSingleOntology, resolveOntology } from "../middleware/ontology.js";
import { getChangeById, getDb, logChange, updateChangeNote } from "../services/authDb.js";
import {
  cachedSelect,
  deleteBlankNodeSubgraph,
  graphIriFor,
  insertIntoGraph,
  NS,
  safeIri,
  select,
  update as storeUpdate,
} from "../services/rdfStore.js";

const router = Router();

const PREFIXES = `
PREFIX rdf:     <${NS.rdf}>
PREFIX rdfs:    <${NS.rdfs}>
PREFIX owl:     <${NS.owl}>
PREFIX xsd:     <${NS.xsd}>
PREFIX schema:  <http://schema.org/>
PREFIX schemas: <https://schema.org/>
PREFIX skos:    <http://www.w3.org/2004/02/skos/core#>
`;

// OWL property characteristics: short name (wire/UI token) <-> full IRI.
// Kept as the set of OWL 2 characteristic types; Functional is the only one
// semantically meaningful on a datatype property.
const CHAR_NAME_TO_IRI = {
  Functional: "http://www.w3.org/2002/07/owl#FunctionalProperty",
  InverseFunctional: "http://www.w3.org/2002/07/owl#InverseFunctionalProperty",
  Transitive: "http://www.w3.org/2002/07/owl#TransitiveProperty",
  Symmetric: "http://www.w3.org/2002/07/owl#SymmetricProperty",
  Asymmetric: "http://www.w3.org/2002/07/owl#AsymmetricProperty",
  Reflexive: "http://www.w3.org/2002/07/owl#ReflexiveProperty",
  Irreflexive: "http://www.w3.org/2002/07/owl#IrreflexiveProperty",
};
const CHAR_IRI_TO_NAME = Object.fromEntries(
  Object.entries(CHAR_NAME_TO_IRI).map(([k, v]) => [v, k]),
);
export const PROPERTY_CHARACTERISTIC_IRIS = Object.values(CHAR_NAME_TO_IRI);

// Axiom predicates that PUT /relations can manage. Each entry has:
//  - symmetric: whether the semantics imply both directions are true (in which
//    case we read from both sides and fully delete both sides when removed,
//    but only insert one direction to avoid redundant triples).
//  - action: audit-log action name for the change log.
const RELATION_PREDICATES = {
  "http://www.w3.org/2002/07/owl#inverseOf": {
    symmetric: true,
    action: "update-inverses",
  },
  "http://www.w3.org/2000/01/rdf-schema#subPropertyOf": {
    symmetric: false,
    action: "update-super-properties",
  },
  "http://www.w3.org/2002/07/owl#equivalentClass": {
    symmetric: true,
    action: "update-equivalents",
  },
  "http://www.w3.org/2002/07/owl#disjointWith": {
    symmetric: true,
    action: "update-disjoints",
  },
  // Annotation-ish predicates that take resource targets. Treated as
  // non-symmetric — an entity saying "see also X" is just an outgoing fact
  // from this side; we don't assume the target reciprocates.
  "http://www.w3.org/2000/01/rdf-schema#seeAlso": {
    symmetric: false,
    action: "update-see-also",
  },
  "http://www.w3.org/2000/01/rdf-schema#isDefinedBy": {
    symmetric: false,
    action: "update-is-defined-by",
  },
};

// Basic meta (ontology record + stats). Supports both single-ontology and
// union (project-wide) read mode via `req.ontologyScope`.
router.get("/meta", requireAuth, resolveOntology, requireProjectRole("viewer"), (req, res) => {
  const scope = req.ontologyScope;
  // In union mode the "record" is synthesized from the parent project so the
  // UI still has a name/iri/description to render; in single mode we echo the
  // ontology row as before.
  const row =
    req.scope?.mode === "union"
      ? {
          id: null,
          name: req.project?.name || "All ontologies",
          iri: null,
          description: req.project?.description || null,
          project_id: req.project?.id || null,
          union: true,
          ontologies: req.ontologies,
        }
      : req.ontology;

  const classCount =
    cachedSelect(
      `${PREFIXES}SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c a owl:Class FILTER(!isBlank(?c)) }`,
      scope,
    )[0]?.n?.value || "0";
  const opCount =
    cachedSelect(
      `${PREFIXES}SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE { ?p a owl:ObjectProperty }`,
      scope,
    )[0]?.n?.value || "0";
  const dpCount =
    cachedSelect(
      `${PREFIXES}SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE { ?p a owl:DatatypeProperty }`,
      scope,
    )[0]?.n?.value || "0";
  const indCount =
    cachedSelect(
      `${PREFIXES}SELECT (COUNT(DISTINCT ?i) AS ?n) WHERE { ?i a owl:NamedIndividual }`,
      scope,
    )[0]?.n?.value || "0";
  const tripleRow = cachedSelect("SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }", scope)[0];

  // Version info (owl:versionInfo) lives as a plain literal on the ontology
  // IRI itself — the OWL-idiomatic place for it. Only surfaces if the
  // ontology has a base IRI assigned. In union mode there's no single base
  // IRI, so we skip it.
  let versionInfo = null;
  if (row?.iri) {
    const vrow = cachedSelect(
      PREFIXES +
        `
      SELECT ?v WHERE { <${row.iri}> owl:versionInfo ?v } LIMIT 1
    `,
      scope,
    )[0];
    if (vrow?.v?.value) versionInfo = vrow.v.value;
  }

  res.json({
    meta: { ...row, versionInfo },
    stats: {
      triples: +(tripleRow?.n?.value || 0),
      classes: +classCount,
      objectProperties: +opCount,
      datatypeProperties: +dpCount,
      individuals: +indCount,
    },
  });
});

router.put(
  "/meta",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { name, iri, description, versionInfo } = req.body || {};
    const db = getDb();
    db.prepare(`UPDATE ontologies SET
      name = COALESCE(?, name),
      iri = COALESCE(?, iri),
      description = COALESCE(?, description),
      updated_at = ?, updated_by = ?
    WHERE id = ?`).run(
      name ?? null,
      iri ?? null,
      description ?? null,
      Date.now(),
      req.session.user.id,
      req.ontologyId,
    );
    const row = db.prepare("SELECT * FROM ontologies WHERE id = ?").get(req.ontologyId);

    // Sync owl:versionInfo on the ontology resource itself. We key off the
    // CURRENT (post-update) base IRI so renaming and setting version in the
    // same PUT stay consistent. If versionInfo is undefined (not sent), leave
    // the triple alone; explicit null / empty string clears it.
    let effectiveVersionInfo = null;
    if (versionInfo !== undefined && row?.iri) {
      const g = graphIriFor(req.ontologyId);
      try {
        storeUpdate(
          `${PREFIXES}\nDELETE WHERE { GRAPH <${g}> { <${row.iri}> owl:versionInfo ?v } }`,
          req.ontologyId,
        );
        const v = (versionInfo ?? "").toString().trim();
        if (v) {
          // Also make sure the ontology IRI is typed as owl:Ontology so the
          // version info has a subject that tools will recognize. Idempotent.
          insertIntoGraph(
            `<${row.iri}> a owl:Ontology .\n<${row.iri}> owl:versionInfo ${lit(v)} .`,
            req.ontologyId,
            PREFIXES,
          );
          effectiveVersionInfo = v;
        }
        logChange(req.session.user.id, req.ontologyId, "update-version-info", {
          iri: row.iri,
          versionInfo: v || null,
        });
      } catch (err) {
        // Surface the RDF-side failure alongside the SQLite update success.
        return res.status(400).json({ error: String(err.message || err) });
      }
    } else if (row?.iri) {
      // versionInfo wasn't part of this PUT — echo back what's currently stored
      // so the client stays in sync without a follow-up GET.
      const vrow = select(
        PREFIXES +
          `
      SELECT ?v WHERE { <${row.iri}> owl:versionInfo ?v } LIMIT 1
    `,
        req.ontologyId,
      )[0];
      if (vrow?.v?.value) effectiveVersionInfo = vrow.v.value;
    }
    logChange(req.session.user.id, req.ontologyId, "meta-update", {
      name,
      iri,
    });
    res.json({ meta: { ...row, versionInfo: effectiveVersionInfo } });
  },
);

// List classes. Returns one row per class plus, on a second pass, all
// rdfs:subClassOf edges so the client can build a hierarchy view without a
// follow-up request. (We issue two queries instead of a single GROUP_CONCAT
// because Oxigraph's aggregate serialization is inconsistent about emitting
// the output variable when the input is unbound.)
router.get("/classes", requireAuth, resolveOntology, requireProjectRole("viewer"), (req, res) => {
  const scope = req.ontologyScope;
  const rows = cachedSelect(
    PREFIXES +
      `
    SELECT ?iri ?label ?prefLabel ?comment ?definition WHERE {
      ?iri a owl:Class
      FILTER(!isBlank(?iri))
      OPTIONAL { ?iri rdfs:label ?label }
      OPTIONAL { ?iri rdfs:comment ?comment }
      OPTIONAL { ?iri skos:prefLabel ?prefLabel }
      OPTIONAL { ?iri skos:definition ?definition }
    } ORDER BY ?iri
  `,
    scope,
  );

  // Do NOT require `?child a owl:Class` here — that would silently drop
  // cross-ontology subClassOf assertions where the child is only declared
  // as owl:Class in a linked/imported named graph but the rdfs:subClassOf
  // triple itself lives in the write ontology's named graph.  The FILTER
  // for IRI-valued subjects/objects is sufficient; rdfs:subClassOf is
  // semantically specific to class hierarchies so false positives are not
  // a concern in practice.
  const parentRows = cachedSelect(
    PREFIXES +
      `
    SELECT ?child ?parent WHERE {
      ?child rdfs:subClassOf ?parent .
      FILTER(isIRI(?child) && isIRI(?parent))
    }
  `,
    scope,
  );

  // Collapse parent rows into a map iri -> string[] so the client can iterate.
  const parentMap = new Map();
  for (const r of parentRows) {
    const c = r.child?.value;
    const p = r.parent?.value;
    if (!c || !p) continue;
    if (!parentMap.has(c)) parentMap.set(c, []);
    const arr = parentMap.get(c);
    if (!arr.includes(p)) arr.push(p);
  }

  // Equivalent / disjoint relations are symmetric in OWL: an assertion
  // `A owl:equivalentClass B` implies `B owl:equivalentClass A`. We collect
  // both orientations so each class lists every other class it's related to,
  // regardless of which side the axiom was originally asserted on.
  const equivRows = cachedSelect(
    PREFIXES +
      `
    SELECT ?a ?b WHERE {
      ?a a owl:Class . ?b a owl:Class .
      { ?a owl:equivalentClass ?b } UNION { ?b owl:equivalentClass ?a }
      FILTER(!isBlank(?a) && !isBlank(?b) && ?a != ?b)
    }
  `,
    scope,
  );
  const disjRows = cachedSelect(
    PREFIXES +
      `
    SELECT ?a ?b WHERE {
      ?a a owl:Class . ?b a owl:Class .
      { ?a owl:disjointWith ?b } UNION { ?b owl:disjointWith ?a }
      FILTER(!isBlank(?a) && !isBlank(?b) && ?a != ?b)
    }
  `,
    scope,
  );
  const collectSymmetric = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const a = r.a?.value,
        b = r.b?.value;
      if (!a || !b) continue;
      if (!m.has(a)) m.set(a, []);
      const arr = m.get(a);
      if (!arr.includes(b)) arr.push(b);
    }
    return m;
  };
  const equivMap = collectSymmetric(equivRows);
  const disjMap = collectSymmetric(disjRows);

  const deprecated = collectDeprecated(scope);

  // Deduplicate by IRI, giving priority to the write ontology's rows when
  // operating in union/all mode.  The old `dedupe` compared full row objects
  // and kept both the parent-graph row AND the branch-graph row when a class
  // had different prefLabels in each.  That caused React key collisions in the
  // ClassesView list — displaying whichever row came first rather than the
  // freshly-edited branch value.
  const writeOntologyId = req.query.writeOntology?.toString() || null;
  let classRows;
  if (writeOntologyId && Array.isArray(scope) && scope.includes(writeOntologyId)) {
    // Run a focused query on just the write ontology so its labels take priority.
    const writeSpecificRows = cachedSelect(
      PREFIXES +
        `
      SELECT ?iri ?label ?prefLabel ?comment ?definition WHERE {
        ?iri a owl:Class
        FILTER(!isBlank(?iri))
        OPTIONAL { ?iri rdfs:label ?label }
        OPTIONAL { ?iri rdfs:comment ?comment }
        OPTIONAL { ?iri skos:prefLabel ?prefLabel }
        OPTIONAL { ?iri skos:definition ?definition }
      } ORDER BY ?iri
    `,
      writeOntologyId,
    );
    const seenIris = new Set();
    classRows = [];
    for (const r of writeSpecificRows) {
      const iri = r.iri?.value;
      if (iri && !seenIris.has(iri)) {
        seenIris.add(iri);
        classRows.push(r);
      }
    }
    for (const r of rows) {
      const iri = r.iri?.value;
      if (iri && !seenIris.has(iri)) {
        seenIris.add(iri);
        classRows.push(r);
      }
    }
  } else {
    // Single-ontology or no write preference: deduplicate by IRI (first wins).
    const seenIris = new Set();
    classRows = [];
    for (const r of rows) {
      const iri = r.iri?.value;
      if (iri && !seenIris.has(iri)) {
        seenIris.add(iri);
        classRows.push(r);
      }
    }
  }

  const classes = classRows.map((row) => ({
    ...row,
    parents: parentMap.get(row.iri?.value) || [],
    equivalents: equivMap.get(row.iri?.value) || [],
    disjoints: disjMap.get(row.iri?.value) || [],
    deprecated: deprecated.has(row.iri?.value),
  }));
  res.json({ classes });
});

// Fetch the set of IRIs marked with `owl:deprecated "true"^^xsd:boolean`.
// Also tolerant of an untyped "true" literal (Protégé sometimes writes plain
// string literals) — we treat any truthy variant as deprecated. Accepts either
// a single ontology id or an array of ids (union mode).
function collectDeprecated(scope) {
  const rows = cachedSelect(
    PREFIXES +
      `
    SELECT ?iri ?v WHERE {
      ?iri owl:deprecated ?v .
      FILTER(!isBlank(?iri))
    }
  `,
    scope,
  );
  const out = new Set();
  for (const r of rows) {
    const iri = r.iri?.value;
    const v = r.v?.value;
    if (!iri || !v) continue;
    if (v === "true" || v === "1" || v === "TRUE" || v === "True") out.add(iri);
  }
  return out;
}

// List object / datatype / annotation properties. Each row also carries a
// `characteristics` string[] (e.g. ['Functional','Transitive']) so the client
// can render the OWL property-characteristic chip row without a second call.
router.get(
  "/properties",
  requireAuth,
  resolveOntology,
  requireProjectRole("viewer"),
  (req, res) => {
    const scope = req.ontologyScope;
    const q =
      PREFIXES +
      `
    SELECT ?iri ?kind ?label ?prefLabel ?domain ?range WHERE {
      { ?iri a owl:ObjectProperty     BIND('object' AS ?kind) }
      UNION
      { ?iri a owl:DatatypeProperty   BIND('datatype' AS ?kind) }
      UNION
      { ?iri a owl:AnnotationProperty BIND('annotation' AS ?kind) }
      OPTIONAL { ?iri rdfs:label ?label }
      OPTIONAL { ?iri skos:prefLabel ?prefLabel }
      OPTIONAL { { ?iri rdfs:domain ?domain } UNION { ?iri schema:domainIncludes ?domain } UNION { ?iri schemas:domainIncludes ?domain } FILTER(!isBlank(?domain)) }
      OPTIONAL { { ?iri rdfs:range  ?range  } UNION { ?iri schema:rangeIncludes  ?range  } UNION { ?iri schemas:rangeIncludes  ?range  } FILTER(!isBlank(?range)) }
    } ORDER BY ?iri
  `;
    // Dedupe by property IRI — a property with domain/range asserted via both
    // rdfs: and schema: predicates generates multiple SPARQL solution rows for
    // the same IRI.  Keep only the first row per IRI (ORDER BY ?iri gives a
    // stable, consistent pick).
    const rawRows = cachedSelect(q, scope);
    // Collect ALL domain and range IRIs per property before dedup so the client
    // has the full picture (a property may declare rdfs:domain / rdfs:range for
    // several classes, generating multiple SPARQL solution rows for the same IRI).
    const domainMap = new Map();
    const rangeMap = new Map();
    const iriSeen = new Set();
    const rows = [];
    for (const r of rawRows) {
      const iriVal = r.iri?.value;
      const domainVal = r.domain?.value;
      const rangeVal = r.range?.value;
      if (iriVal && domainVal) {
        if (!domainMap.has(iriVal)) domainMap.set(iriVal, []);
        const dArr = domainMap.get(iriVal);
        if (!dArr.includes(domainVal)) dArr.push(domainVal);
      }
      if (iriVal && rangeVal) {
        if (!rangeMap.has(iriVal)) rangeMap.set(iriVal, []);
        const rArr = rangeMap.get(iriVal);
        if (!rArr.includes(rangeVal)) rArr.push(rangeVal);
      }
      if (!iriVal || iriSeen.has(iriVal)) continue;
      iriSeen.add(iriVal);
      rows.push(r);
    }

    // Second pass: collect characteristic type triples.
    const charRows = cachedSelect(
      PREFIXES +
        `
    SELECT ?iri ?type WHERE {
      ?iri a ?type .
      FILTER(?type IN (
        owl:FunctionalProperty, owl:InverseFunctionalProperty,
        owl:TransitiveProperty, owl:SymmetricProperty,
        owl:AsymmetricProperty, owl:ReflexiveProperty, owl:IrreflexiveProperty
      ))
    }
  `,
      scope,
    );

    const charMap = new Map();
    for (const r of charRows) {
      const iri = r.iri?.value;
      const type = r.type?.value;
      if (!iri || !type) continue;
      const name = CHAR_IRI_TO_NAME[type];
      if (!name) continue;
      if (!charMap.has(iri)) charMap.set(iri, []);
      const arr = charMap.get(iri);
      if (!arr.includes(name)) arr.push(name);
    }

    // rdfs:subPropertyOf — direct parent properties (not the transitive closure).
    const supRows = cachedSelect(
      PREFIXES +
        `
    SELECT ?child ?parent WHERE {
      ?child rdfs:subPropertyOf ?parent .
      FILTER(!isBlank(?child) && !isBlank(?parent) && ?child != ?parent)
    }
  `,
      scope,
    );
    const superPropMap = new Map();
    for (const r of supRows) {
      const c = r.child?.value,
        p = r.parent?.value;
      if (!c || !p) continue;
      if (!superPropMap.has(c)) superPropMap.set(c, []);
      const arr = superPropMap.get(c);
      if (!arr.includes(p)) arr.push(p);
    }

    // owl:inverseOf is symmetric: `P1 inverseOf P2` implies `P2 inverseOf P1`.
    // Collect both orientations so the chip row is consistent from either side.
    const invRows = cachedSelect(
      PREFIXES +
        `
    SELECT ?a ?b WHERE {
      { ?a owl:inverseOf ?b } UNION { ?b owl:inverseOf ?a }
      FILTER(!isBlank(?a) && !isBlank(?b) && ?a != ?b)
    }
  `,
      scope,
    );
    const invMap = new Map();
    for (const r of invRows) {
      const a = r.a?.value,
        b = r.b?.value;
      if (!a || !b) continue;
      if (!invMap.has(a)) invMap.set(a, []);
      const arr = invMap.get(a);
      if (!arr.includes(b)) arr.push(b);
    }

    // Explicit (one-direction) owl:inverseOf: only triples as written in the
    // ontology, without the symmetric UNION. The subject is the property that
    // explicitly declares another as its inverse; the client uses this to nest
    // it under the referenced "parent" in the list without double-counting.
    const explicitInvRows = cachedSelect(
      PREFIXES +
        `
    SELECT ?s ?o WHERE {
      ?s owl:inverseOf ?o .
      FILTER(!isBlank(?s) && !isBlank(?o) && ?s != ?o)
    }
  `,
      scope,
    );
    const explicitInvMap = new Map();
    for (const r of explicitInvRows) {
      const s = r.s?.value,
        o = r.o?.value;
      if (!s || !o) continue;
      if (!explicitInvMap.has(s)) explicitInvMap.set(s, []);
      const arr = explicitInvMap.get(s);
      if (!arr.includes(o)) arr.push(o);
    }

    const deprecated = collectDeprecated(scope);
    const properties = rows.map((r) => ({
      ...r,
      characteristics: charMap.get(r.iri?.value) || [],
      superProperties: superPropMap.get(r.iri?.value) || [],
      inverses: invMap.get(r.iri?.value) || [],
      explicitInvOf: explicitInvMap.get(r.iri?.value) || [],
      deprecated: deprecated.has(r.iri?.value),
      domains: domainMap.get(r.iri?.value) || [],
      ranges: rangeMap.get(r.iri?.value) || [],
    }));
    res.json({ properties });
  },
);

// List individuals
router.get(
  "/individuals",
  requireAuth,
  resolveOntology,
  requireProjectRole("viewer"),
  (req, res) => {
    const scope = req.ontologyScope;
    const rows = cachedSelect(
      PREFIXES +
        `
    SELECT ?iri ?type ?label ?prefLabel WHERE {
      ?iri a owl:NamedIndividual .
      OPTIONAL { ?iri a ?type FILTER(?type != owl:NamedIndividual) }
      OPTIONAL { ?iri rdfs:label ?label }
      OPTIONAL { ?iri skos:prefLabel ?prefLabel }
    } ORDER BY ?iri
  `,
      scope,
    );
    const deprecated = collectDeprecated(scope);
    const individuals = dedupe(rows).map((r) => ({
      ...r,
      deprecated: deprecated.has(r.iri?.value),
    }));
    res.json({ individuals });
  },
);

// GET /entity/expressions — returns every blank-node OWL expression reachable
// from an entity (restrictions, anonymous class expressions, intersectionOf
// lists, etc.). Uses a multi-depth SPARQL UNION that collects all blank-node
// subject triples up to 5 hops from the entity — sufficient for any realistic
// OWL 2 ontology pattern. The client renders these as a read-only tree.
router.get(
  "/entity/expressions",
  requireAuth,
  resolveOntology,
  requireProjectRole("viewer"),
  (req, res) => {
    const iri = req.query.iri;
    if (!iri) return res.status(400).json({ error: "iri required" });
    const writeOntologyId = req.query.writeOntology?.toString() || null;
    const scope = req.ontologyScope;

    // When the write target is a branch, exclude its parent AND sibling branches —
    // same logic as GET /entity.
    let effectiveScope = scope;
    if (writeOntologyId && Array.isArray(scope)) {
      const writeOnto = (req.ontologies || []).find((o) => o.id === writeOntologyId);
      if (writeOnto?.branch_of) {
        const parentId = writeOnto.branch_of;
        const excludeIds = new Set(
          (req.ontologies || [])
            .filter((o) => o.id === parentId || (o.branch_of && o.branch_of === parentId))
            .map((o) => o.id),
        );
        excludeIds.delete(writeOntologyId);
        const filtered = scope.filter((id) => !excludeIds.has(id));
        if (filtered.length > 0) effectiveScope = filtered;
      }
    }

    // Which blank nodes are direct objects of this entity's triples?
    const topLevel = select(
      `${PREFIXES}SELECT DISTINCT ?pred ?bn WHERE { ${safeIri(iri)} ?pred ?bn . FILTER(isBlank(?bn)) }`,
      effectiveScope,
    ).map((r) => ({ predicate: r.pred?.value, bnode: r.bn?.value }));

    if (topLevel.length === 0) return res.json({ topLevel: [], bnodeMap: {} });

    // Multi-level SPARQL UNION collects all blank-node subject triples reachable
    // up to 5 hops.  Each UNION branch independently finds blank nodes at one
    // depth level and returns their outgoing triples (?s ?p ?o).
    const q =
      PREFIXES +
      `SELECT DISTINCT ?s ?p ?o WHERE {
        {
          ${safeIri(iri)} ?wp0 ?s . FILTER(isBlank(?s))
          ?s ?p ?o .
        } UNION {
          ${safeIri(iri)} ?wp0 ?wb0 . FILTER(isBlank(?wb0))
          ?wb0 ?wp1 ?s . FILTER(isBlank(?s))
          ?s ?p ?o .
        } UNION {
          ${safeIri(iri)} ?wp0 ?wb0 . FILTER(isBlank(?wb0))
          ?wb0 ?wp1 ?wb1 . FILTER(isBlank(?wb1))
          ?wb1 ?wp2 ?s . FILTER(isBlank(?s))
          ?s ?p ?o .
        } UNION {
          ${safeIri(iri)} ?wp0 ?wb0 . FILTER(isBlank(?wb0))
          ?wb0 ?wp1 ?wb1 . FILTER(isBlank(?wb1))
          ?wb1 ?wp2 ?wb2 . FILTER(isBlank(?wb2))
          ?wb2 ?wp3 ?s . FILTER(isBlank(?s))
          ?s ?p ?o .
        } UNION {
          ${safeIri(iri)} ?wp0 ?wb0 . FILTER(isBlank(?wb0))
          ?wb0 ?wp1 ?wb1 . FILTER(isBlank(?wb1))
          ?wb1 ?wp2 ?wb2 . FILTER(isBlank(?wb2))
          ?wb2 ?wp3 ?wb3 . FILTER(isBlank(?wb3))
          ?wb3 ?wp4 ?s . FILTER(isBlank(?s))
          ?s ?p ?o .
        }
      }`;

    try {
      const rows = select(q, effectiveScope);
      // Build bnodeMap: bnode_id → [{p, o}]
      const bnodeMap = {};
      for (const r of rows) {
        const s = r.s?.value;
        const p = r.p?.value;
        const o = r.o;
        if (!s || !p || !o) continue;
        if (!bnodeMap[s]) bnodeMap[s] = [];
        bnodeMap[s].push({ p, o });
      }
      res.json({ topLevel, bnodeMap });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// OWL property-constraint types for the restriction editor.
const RESTRICTION_CONSTRAINT = {
  minCardinality: `${NS.owl}minCardinality`,
  maxCardinality: `${NS.owl}maxCardinality`,
  cardinality: `${NS.owl}cardinality`,
  someValuesFrom: `${NS.owl}someValuesFrom`,
  allValuesFrom: `${NS.owl}allValuesFrom`,
  hasValue: `${NS.owl}hasValue`,
};
const CARDINALITY_CONSTRAINTS = new Set(["minCardinality", "maxCardinality", "cardinality"]);
const CLASS_CONSTRAINTS = new Set(["someValuesFrom", "allValuesFrom"]);

// POST /entity/restriction — add an owl:Restriction blank node linked to an entity.
// Supports all common cardinality, value, and class-quantifier restriction types.
router.post(
  "/entity/restriction",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const {
      iri,
      predicate = `${NS.rdfs}subClassOf`,
      onProperty,
      constraintType,
      value,
      valueKind = "literal",
      datatype,
    } = req.body || {};
    if (!iri) return res.status(400).json({ error: "iri required" });
    if (!onProperty) return res.status(400).json({ error: "onProperty required" });
    const constraintIri = RESTRICTION_CONSTRAINT[constraintType];
    if (!constraintIri) return res.status(400).json({ error: "unknown constraintType" });

    // Build the object value string for the constraint predicate.
    let objStr;
    if (CARDINALITY_CONSTRAINTS.has(constraintType)) {
      const n = Number.parseInt(value, 10);
      if (Number.isNaN(n) || n < 0)
        return res.status(400).json({ error: "value must be a non-negative integer" });
      objStr = `"${n}"^^<${NS.xsd}nonNegativeInteger>`;
    } else if (CLASS_CONSTRAINTS.has(constraintType)) {
      if (!value) return res.status(400).json({ error: "value (class IRI) required" });
      objStr = safeIri(value);
    } else {
      // hasValue — can be an IRI or literal
      if (value === undefined || value === null)
        return res.status(400).json({ error: "value required" });
      if (valueKind === "uri") {
        objStr = safeIri(value);
      } else if (datatype) {
        objStr = lit(String(value), { datatype });
      } else {
        objStr = lit(String(value));
      }
    }

    const g = graphIriFor(req.ontologyId);
    const sparql = `${PREFIXES}
INSERT DATA {
  GRAPH <${g}> {
    ${safeIri(iri)} ${safeIri(predicate)} _:newR .
    _:newR a owl:Restriction ;
           owl:onProperty ${safeIri(onProperty)} ;
           <${constraintIri}> ${objStr} .
  }
}`;
    try {
      storeUpdate(sparql, req.ontologyId);
      logChange(req.session.user.id, req.ontologyId, "add-restriction", {
        iri,
        predicate,
        onProperty,
        constraintType,
        value,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// DELETE /entity/expression — delete a blank-node expression subgraph (restriction,
// equivalentClass anonymous class, etc.) using direct BFS quad removal so the
// entire nested blank-node tree is cleaned up in one operation.
router.delete(
  "/entity/expression",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { iri, predicate, bnodeId } = req.body || {};
    if (!iri) return res.status(400).json({ error: "iri required" });
    if (!predicate) return res.status(400).json({ error: "predicate required" });
    if (!bnodeId) return res.status(400).json({ error: "bnodeId required" });
    try {
      deleteBlankNodeSubgraph(iri, predicate, bnodeId, req.ontologyId);
      logChange(req.session.user.id, req.ontologyId, "delete-expression", {
        iri,
        predicate,
        bnodeId,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// All axioms / triples for a single entity (scoped to this ontology's graph,
// or unioned across the project's graphs in union mode).
router.get("/entity", requireAuth, resolveOntology, requireProjectRole("viewer"), (req, res) => {
  const iri = req.query.iri;
  if (!iri) return res.status(400).json({ error: "iri required" });
  const writeOntologyId = req.query.writeOntology?.toString() || null;
  const scope = req.ontologyScope;

  // When the write target is a branch, exclude its parent AND sibling branches
  // from the read scope. The branch graph is a full copy of the parent at
  // creation time, so including the parent causes deleted-from-branch triples
  // to reappear. Sibling branches share the same parent-copy baseline and can
  // also surface stale triples that appear locked from this branch's perspective.
  let effectiveScope = scope;
  if (writeOntologyId && Array.isArray(scope)) {
    const writeOnto = (req.ontologies || []).find((o) => o.id === writeOntologyId);
    if (writeOnto?.branch_of) {
      const parentId = writeOnto.branch_of;
      const excludeIds = new Set(
        (req.ontologies || [])
          .filter((o) => o.id === parentId || (o.branch_of && o.branch_of === parentId))
          .map((o) => o.id),
      );
      excludeIds.delete(writeOntologyId); // always keep the write branch itself
      const filtered = scope.filter((id) => !excludeIds.has(id));
      if (filtered.length > 0) effectiveScope = filtered;
    }
  }

  // Use DISTINCT so that when the same triple exists in multiple named graphs
  // (e.g. write ontology + linked ontology both declare the same subClassOf)
  // the union query via FROM clauses doesn't return it more than once.
  const outgoing = cachedSelect(
    PREFIXES +
      `
    SELECT DISTINCT ?p ?o WHERE { ${safeIri(iri)} ?p ?o }
  `,
    effectiveScope,
  );
  const incoming = cachedSelect(
    PREFIXES +
      `
    SELECT DISTINCT ?s ?p WHERE { ?s ?p ${safeIri(iri)} }
  `,
    effectiveScope,
  );

  // Determine which ontology(ies) in the current read scope own triples for
  // this entity. Only computed in workspace (multi-ontology) mode since in
  // single-ontology mode there is only ever one graph and it is always the
  // write target.  The client uses this list to disable the Delete button
  // when the entity lives entirely in read-only (non-write-target) graphs.
  const scopeIds = Array.isArray(effectiveScope)
    ? effectiveScope
    : effectiveScope
      ? [effectiveScope]
      : [];
  let sourceOntologyIds = [];
  // Outgoing triples that exist in the write graph — used by the client to
  // detect which triples come exclusively from linked/imported (read-only)
  // ontologies so it can show a warning when a deletion doesn't fully remove
  // a relationship that also exists in a linked ontology.
  let writeOutgoing = null;
  if (scopeIds.length > 1) {
    try {
      const graphToId = new Map();
      for (const id of scopeIds) graphToId.set(graphIriFor(id), id);
      const graphValues = scopeIds.map((id) => `<${graphIriFor(id)}>`).join(" ");
      // Pass null scope so wrapQuery is not called — wrapQuery adds FROM
      // (default-graph) clauses which are irrelevant for GRAPH ?variable
      // patterns; GRAPH matching requires FROM NAMED, not FROM.  The VALUES
      // clause already restricts ?g to only the graphs owned by this project,
      // so omitting scope wrapping here is safe.
      const graphRows = select(
        `SELECT DISTINCT ?g WHERE { VALUES ?g { ${graphValues} } GRAPH ?g { ${safeIri(iri)} ?p ?o } }`,
        null,
      );
      sourceOntologyIds = [
        ...new Set(
          graphRows
            .map((r) => r.g?.value)
            .filter(Boolean)
            .map((g) => graphToId.get(g))
            .filter(Boolean),
        ),
      ];
    } catch {
      // Best-effort — don't fail the whole request on a source-detection error.
    }

    // Fetch outgoing triples scoped to only the write graph so the client can
    // determine which triples come exclusively from linked/imported ontologies.
    if (writeOntologyId) {
      try {
        writeOutgoing = select(
          `SELECT DISTINCT ?p ?o WHERE { GRAPH <${graphIriFor(writeOntologyId)}> { ${safeIri(iri)} ?p ?o } }`,
          null,
        );
      } catch {
        // Best-effort.
      }
    }
  }

  res.json({ iri, outgoing, incoming, sourceOntologyIds, writeOutgoing });
});

// Create / upsert a class
router.post(
  "/class",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { iri, label, definition, subClassOf } = req.body || {};
    if (!iri) return res.status(400).json({ error: "iri required" });
    const triples = [`${safeIri(iri)} a owl:Class .`];
    if (label) triples.push(`${safeIri(iri)} skos:prefLabel ${lit(label)} .`);
    if (definition) triples.push(`${safeIri(iri)} skos:definition ${lit(definition)} .`);
    if (Array.isArray(subClassOf)) {
      for (const parent of subClassOf)
        triples.push(`${safeIri(iri)} rdfs:subClassOf ${safeIri(parent)} .`);
    }
    try {
      insertIntoGraph(triples.join("\n"), req.ontologyId, PREFIXES);
      logChange(req.session.user.id, req.ontologyId, "create-class", { iri });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// Create / upsert a property
router.post(
  "/property",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const {
      iri,
      kind = "object",
      label,
      definition,
      domain,
      range,
      subPropertyOf,
      characteristics,
    } = req.body || {};
    if (!iri) return res.status(400).json({ error: "iri required" });
    const typeIri =
      {
        object: "owl:ObjectProperty",
        datatype: "owl:DatatypeProperty",
        annotation: "owl:AnnotationProperty",
      }[kind] || "owl:ObjectProperty";
    const triples = [`${safeIri(iri)} a ${typeIri} .`];
    if (label) triples.push(`${safeIri(iri)} skos:prefLabel ${lit(label)} .`);
    if (definition) triples.push(`${safeIri(iri)} skos:definition ${lit(definition)} .`);
    for (const d of Array.isArray(domain) ? domain : domain ? [domain] : []) {
      if (d) triples.push(`${safeIri(iri)} rdfs:domain ${safeIri(d)} .`);
    }
    for (const r of Array.isArray(range) ? range : range ? [range] : []) {
      if (r) triples.push(`${safeIri(iri)} rdfs:range ${safeIri(r)} .`);
    }
    if (subPropertyOf)
      triples.push(`${safeIri(iri)} rdfs:subPropertyOf ${safeIri(subPropertyOf)} .`);
    if (Array.isArray(characteristics)) {
      for (const name of characteristics) {
        const charIri = CHAR_NAME_TO_IRI[name];
        if (!charIri) continue;
        // Datatype/annotation properties: only Functional is semantically meaningful.
        const effKind = !kind || kind === "property" ? "object" : kind;
        if (effKind !== "object" && name !== "Functional") continue;
        triples.push(`${safeIri(iri)} a <${charIri}> .`);
      }
    }
    try {
      insertIntoGraph(triples.join("\n"), req.ontologyId, PREFIXES);
      logChange(req.session.user.id, req.ontologyId, "create-property", {
        iri,
        kind,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// Replace a property's characteristic set with the provided list. Diffs
// against the current state so we only INSERT what's new and DELETE what's
// gone — keeps the change log meaningful and avoids churn.
router.put(
  "/property/characteristics",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { iri, kind, characteristics } = req.body || {};
    if (!iri) return res.status(400).json({ error: "iri required" });
    if (!Array.isArray(characteristics))
      return res.status(400).json({ error: "characteristics[] required" });

    // Normalize + validate + filter-by-kind. Unknown/generic 'property' is
    // treated as 'object' (most permissive), matching the client helper.
    const effectiveKind = !kind || kind === "property" ? "object" : kind;
    const effective = new Set();
    for (const name of characteristics) {
      if (!CHAR_NAME_TO_IRI[name]) continue;
      if (effectiveKind !== "object" && name !== "Functional") continue;
      effective.add(name);
    }

    // Read current characteristics for this IRI.
    const current = new Set();
    const rows = select(
      PREFIXES +
        `
    SELECT ?type WHERE {
      ${safeIri(iri)} a ?type .
      FILTER(?type IN (
        owl:FunctionalProperty, owl:InverseFunctionalProperty,
        owl:TransitiveProperty, owl:SymmetricProperty,
        owl:AsymmetricProperty, owl:ReflexiveProperty, owl:IrreflexiveProperty
      ))
    }
  `,
      req.ontologyId,
    );
    for (const r of rows) {
      const name = CHAR_IRI_TO_NAME[r.type?.value];
      if (name) current.add(name);
    }

    const toAdd = [...effective].filter((n) => !current.has(n));
    const toRemove = [...current].filter((n) => !effective.has(n));
    const g = graphIriFor(req.ontologyId);

    try {
      if (toRemove.length) {
        const pat = toRemove.map((n) => `${safeIri(iri)} a <${CHAR_NAME_TO_IRI[n]}> .`).join("\n");
        storeUpdate(`DELETE DATA { GRAPH <${g}> { ${pat} } }`, req.ontologyId);
      }
      if (toAdd.length) {
        const pat = toAdd.map((n) => `${safeIri(iri)} a <${CHAR_NAME_TO_IRI[n]}> .`).join("\n");
        insertIntoGraph(pat, req.ontologyId, PREFIXES);
      }
      if (toAdd.length || toRemove.length) {
        logChange(req.session.user.id, req.ontologyId, "update-property-chars", {
          iri,
          added: toAdd,
          removed: toRemove,
        });
      }
      res.json({
        ok: true,
        characteristics: [...effective],
        added: toAdd,
        removed: toRemove,
      });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// Replace the complete set of outgoing triples `<iri> <predicate> ?t` with a
// new target set. Limited to a whitelisted set of axiom predicates
// (inverseOf, subPropertyOf, equivalentClass, disjointWith) so this endpoint
// can't be abused as a generic triple editor — other edits still go through
// POST /triple / DELETE /triple.
//
// For predicates whose semantics are symmetric (inverseOf, equivalentClass,
// disjointWith), we:
//   - READ the current relation from either side (a→b or b→a),
//   - INSERT only `<iri> <predicate> <target>` for added targets,
//   - DELETE both `<iri> <predicate> <target>` and `<target> <predicate> <iri>`
//     for removed targets (so a removal is complete regardless of which side
//     originally carried the axiom).
router.put(
  "/relations",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { iri, predicate, targets } = req.body || {};
    if (!iri) return res.status(400).json({ error: "iri required" });
    if (!predicate) return res.status(400).json({ error: "predicate required" });
    if (!Array.isArray(targets)) return res.status(400).json({ error: "targets[] required" });

    const spec = RELATION_PREDICATES[predicate];
    if (!spec) return res.status(400).json({ error: "predicate not allowed" });

    // Deduplicate + drop self-loops and any non-IRI junk.
    const desired = new Set();
    for (const t of targets) {
      if (typeof t !== "string" || !t) continue;
      if (t === iri) continue;
      desired.add(t);
    }

    // Read the current set, honoring symmetric semantics.
    const currentQuery = spec.symmetric
      ? `SELECT ?t WHERE {
         { ${safeIri(iri)} <${predicate}> ?t } UNION { ?t <${predicate}> ${safeIri(iri)} }
         FILTER(!isBlank(?t) && ?t != ${safeIri(iri)})
       }`
      : `SELECT ?t WHERE {
         ${safeIri(iri)} <${predicate}> ?t .
         FILTER(!isBlank(?t) && ?t != ${safeIri(iri)})
       }`;
    const currentRows = select(PREFIXES + currentQuery, req.ontologyId);
    const current = new Set();
    for (const r of currentRows) {
      const v = r.t?.value;
      if (v) current.add(v);
    }

    const toAdd = [...desired].filter((t) => !current.has(t));
    const toRemove = [...current].filter((t) => !desired.has(t));
    const g = graphIriFor(req.ontologyId);

    try {
      if (toRemove.length) {
        // For symmetric predicates, delete BOTH orientations so the axiom is
        // gone regardless of which side was asserted. For non-symmetric, delete
        // only the forward orientation (the reverse is a different assertion).
        //
        // Each triple is issued as a separate DELETE WHERE statement chained
        // with ';'. This is intentional: a single conjunctive DELETE WHERE
        // pattern only matches when ALL triples in the pattern exist — which
        // would make removal fail silently when the asserting side used one
        // orientation but the user hits remove from the mirror side.
        const stmts = [];
        for (const t of toRemove) {
          stmts.push(
            `DELETE WHERE { GRAPH <${g}> { ${safeIri(iri)} <${predicate}> ${safeIri(t)} } }`,
          );
          if (spec.symmetric) {
            stmts.push(
              `DELETE WHERE { GRAPH <${g}> { ${safeIri(t)} <${predicate}> ${safeIri(iri)} } }`,
            );
          }
        }
        storeUpdate(stmts.join(" ;\n"), req.ontologyId);
      }
      if (toAdd.length) {
        const lines = toAdd.map((t) => `${safeIri(iri)} <${predicate}> ${safeIri(t)} .`);
        insertIntoGraph(lines.join("\n"), req.ontologyId, PREFIXES);
      }
      if (toAdd.length || toRemove.length) {
        logChange(req.session.user.id, req.ontologyId, spec.action, {
          iri,
          predicate,
          added: toAdd,
          removed: toRemove,
        });
      }
      res.json({
        ok: true,
        targets: [...desired],
        added: toAdd,
        removed: toRemove,
      });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// Toggle the `owl:deprecated` boolean on an entity. We store as a typed
// xsd:boolean literal ("true"/"false"), but on removal we delete ANY value
// for the predicate so an imported ontology that used a plain string
// literal ("true") or alternative casing is also cleaned up.
router.put(
  "/entity/deprecated",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { iri, deprecated } = req.body || {};
    if (!iri) return res.status(400).json({ error: "iri required" });
    const g = graphIriFor(req.ontologyId);
    const OWL_DEPRECATED = "http://www.w3.org/2002/07/owl#deprecated";
    try {
      // Always wipe any existing value first — `owl:deprecated` is a single-
      // valued flag; multiple differing values would be nonsense.
      storeUpdate(
        `DELETE WHERE { GRAPH <${g}> { ${safeIri(iri)} <${OWL_DEPRECATED}> ?v } }`,
        req.ontologyId,
      );
      if (deprecated === true || deprecated === "true") {
        insertIntoGraph(
          `${safeIri(iri)} <${OWL_DEPRECATED}> "true"^^<http://www.w3.org/2001/XMLSchema#boolean> .`,
          req.ontologyId,
          PREFIXES,
        );
      }
      logChange(req.session.user.id, req.ontologyId, "update-deprecated", {
        iri,
        deprecated: !!deprecated,
      });
      res.json({ ok: true, deprecated: !!deprecated });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// Create / upsert an individual
router.post(
  "/individual",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { iri, types, label } = req.body || {};
    if (!iri) return res.status(400).json({ error: "iri required" });
    const triples = [`${safeIri(iri)} a owl:NamedIndividual .`];
    if (Array.isArray(types))
      for (const t of types) triples.push(`${safeIri(iri)} a ${safeIri(t)} .`);
    if (label) triples.push(`${safeIri(iri)} skos:prefLabel ${lit(label)} .`);
    try {
      insertIntoGraph(triples.join("\n"), req.ontologyId, PREFIXES);
      logChange(req.session.user.id, req.ontologyId, "create-individual", {
        iri,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// Add an arbitrary triple
router.post(
  "/triple",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { s, p, o, objectKind = "uri", datatype, language } = req.body || {};
    if (!s || !p || o === undefined) return res.status(400).json({ error: "s, p, o required" });
    const obj = objectKind === "literal" ? lit(o, { datatype, language }) : safeIri(o);
    try {
      insertIntoGraph(`${safeIri(s)} ${safeIri(p)} ${obj} .`, req.ontologyId);
      logChange(req.session.user.id, req.ontologyId, "add-triple", {
        s,
        p,
        o,
        objectKind,
        datatype,
        language,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// Rename an entity IRI — replaces every triple that references the old IRI
// (as subject or object) in this ontology's graph with the new IRI.
// Both directions are rewritten in a single atomic SPARQL Update so the graph
// is never left in a half-renamed state.
router.put(
  "/entity/iri",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { oldIri, newIri } = req.body || {};
    if (!oldIri) return res.status(400).json({ error: "oldIri required" });
    if (!newIri) return res.status(400).json({ error: "newIri required" });
    if (oldIri === newIri) return res.json({ ok: true, newIri });
    // Validate the new IRI is at least parseable as an absolute IRI.
    try {
      new URL(newIri);
    } catch {
      return res.status(400).json({ error: "newIri must be a valid absolute IRI" });
    }
    const g = graphIriFor(req.ontologyId);
    try {
      storeUpdate(
        `DELETE { GRAPH <${g}> { ${safeIri(oldIri)} ?p ?o } }
         INSERT { GRAPH <${g}> { ${safeIri(newIri)} ?p ?o } }
         WHERE  { GRAPH <${g}> { ${safeIri(oldIri)} ?p ?o } }
         ;
         DELETE { GRAPH <${g}> { ?s ?p ${safeIri(oldIri)} } }
         INSERT { GRAPH <${g}> { ?s ?p ${safeIri(newIri)} } }
         WHERE  { GRAPH <${g}> { ?s ?p ${safeIri(oldIri)} } }`,
        req.ontologyId,
      );
      logChange(req.session.user.id, req.ontologyId, "rename-entity-iri", {
        oldIri,
        newIri,
      });
      res.json({ ok: true, newIri });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// Delete a whole entity (all triples referencing IRI, in this ontology's graph)
router.delete(
  "/entity",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const iri = req.query.iri;
    if (!iri) return res.status(400).json({ error: "iri required" });
    const g = graphIriFor(req.ontologyId);
    try {
      storeUpdate(
        `
      DELETE WHERE { GRAPH <${g}> { ${safeIri(iri)} ?p ?o } } ;
      DELETE WHERE { GRAPH <${g}> { ?s ?p ${safeIri(iri)} } }
    `,
        req.ontologyId,
      );
      logChange(req.session.user.id, req.ontologyId, "delete-entity", { iri });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

router.delete(
  "/triple",
  requireAuth,
  resolveOntology,
  requireSingleOntology,
  requireProjectRole("editor"),
  (req, res) => {
    const { s, p, o, objectKind = "uri", datatype, language } = req.body || {};
    if (!s || !p || o === undefined) return res.status(400).json({ error: "s, p, o required" });
    const obj = objectKind === "literal" ? lit(o, { datatype, language }) : safeIri(o);
    const g = graphIriFor(req.ontologyId);
    try {
      storeUpdate(
        `DELETE DATA { GRAPH <${g}> { ${safeIri(s)} ${safeIri(p)} ${obj} } }`,
        req.ontologyId,
      );
      logChange(req.session.user.id, req.ontologyId, "delete-triple", {
        s,
        p,
        o,
        objectKind,
        datatype,
        language,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  },
);

// Recent change log. Scoped to the caller's current ontology/union via
// resolveOntology; the membership check blocks cross-project peeking.
router.get(
  "/changes",
  requireAuth,
  resolveOntology,
  requireProjectRole("viewer"),
  async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);
      // Prefer the resolved scope's ontology ids rather than trusting a raw
      // ?ontology= param (which has already been vetted by resolveOntology).
      const ids =
        req.scope?.mode === "union"
          ? req.ontologyIds || []
          : req.ontologyId
            ? [req.ontologyId]
            : [];

      const params = [];
      let extraJoin = "";
      let where = "";

      if (ids.length) {
        // Scoped to specific ontology/union — filter by resolved IDs.
        where = `WHERE c.ontology_id IN (${ids.map(() => "?").join(", ")})`;
        params.push(...ids);
      } else if (req.projectId) {
        // No specific ontology — return all changes for the whole project,
        // including project-level events (e.g. member add/remove, invite accept)
        // that carry no ontology_id but have a matching project_id column.
        extraJoin = "LEFT JOIN ontologies _o ON _o.id = c.ontology_id";
        where = "WHERE (_o.project_id = ? OR c.project_id = ?)";
        params.push(req.projectId, req.projectId);
      }

      params.push(limit);
      const rows = await getDb().query(
        `SELECT c.id, c.user_id, u.username, c.ontology_id, c.action, c.details, c.note, c.created_at
         FROM changes c
         LEFT JOIN users u ON u.id = c.user_id
         ${extraJoin}
         ${where}
         ORDER BY c.id DESC LIMIT ?`,
        params,
      );
      res.json({
        changes: rows.map((r) => ({ ...r, details: safeJson(r.details) })),
      });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  },
);

// Update the note/annotation on a history entry.
router.patch(
  "/changes/:id/note",
  requireAuth,
  resolveOntology,
  requireProjectRole("viewer"),
  async (req, res) => {
    try {
      const change = await getChangeById(req.params.id);
      if (!change) return res.status(404).json({ error: "change not found" });
      // Verify the change belongs to this project.
      const onto = await getDb().queryOne("SELECT project_id FROM ontologies WHERE id = ?", [
        change.ontology_id,
      ]);
      if (onto?.project_id && onto.project_id !== req.projectId)
        return res.status(403).json({ error: "forbidden" });
      await updateChangeNote(req.params.id, req.body?.note ?? null);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  },
);

// Undo a change by reversing its triple operation.
// Supported actions: add-triple (delete it back) and delete-triple (re-insert it).
router.post(
  "/changes/:id/undo",
  requireAuth,
  resolveOntology,
  requireProjectRole("editor"),
  async (req, res) => {
    try {
      const change = await getChangeById(req.params.id);
      if (!change) return res.status(404).json({ error: "change not found" });
      const onto = await getDb().queryOne("SELECT project_id FROM ontologies WHERE id = ?", [
        change.ontology_id,
      ]);
      if (onto?.project_id && onto.project_id !== req.projectId)
        return res.status(403).json({ error: "forbidden" });
      if (change.action !== "add-triple" && change.action !== "delete-triple")
        return res.status(400).json({ error: "action not reversible" });

      const d = safeJson(change.details);
      const { s, p, o, objectKind = "uri", datatype, language } = d || {};
      if (!s || !p || o === undefined) return res.status(400).json({ error: "incomplete details" });
      const obj = objectKind === "literal" ? lit(o, { datatype, language }) : safeIri(o);
      const g = graphIriFor(change.ontology_id);

      if (change.action === "add-triple") {
        // Undo an addition by deleting the triple.
        storeUpdate(
          `DELETE DATA { GRAPH <${g}> { ${safeIri(s)} ${safeIri(p)} ${obj} } }`,
          change.ontology_id,
        );
        logChange(req.session.user.id, change.ontology_id, "delete-triple", {
          s,
          p,
          o,
          objectKind,
          datatype,
          language,
        });
      } else {
        // Undo a deletion by re-inserting the triple.
        insertIntoGraph(`${safeIri(s)} ${safeIri(p)} ${obj} .`, change.ontology_id);
        logChange(req.session.user.id, change.ontology_id, "add-triple", {
          s,
          p,
          o,
          objectKind,
          datatype,
          language,
        });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  },
);

// Linked context: entities from sibling (linked) ontologies that are directly
// referenced by the primary (write) ontology but not defined there.  Enables
// "partial visibility" — showing only the cross-ontology entities that matter
// without loading the full sibling ontology into the workspace.
//
// Query params:
//   ?ontology=<primaryId>   – the primary ontology (resolved by middleware)
//   &search=<id1>,<id2>,…   – comma-separated sibling ontology IDs to search
router.get(
  "/linked-context",
  requireAuth,
  resolveOntology,
  requireProjectRole("viewer"),
  (req, res) => {
    const primaryId = req.ontologyId;
    if (!primaryId) {
      return res.status(400).json({
        error: "A single primary ontology is required (union mode not supported here)",
      });
    }

    const searchParam = (req.query.search || "").toString();
    const searchIds = searchParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!searchIds.length) {
      return res.json({ classes: [], properties: [] });
    }

    // Only permit IDs that are siblings in the same project — prevents
    // information leakage across projects.
    // Use String() on both sides: o.id comes from SQLite as an integer but
    // searchIds are URL-parsed strings, so a strict-equality Set lookup would
    // always miss (6 !== "6").
    const siblingSet = new Set((req.ontologies || []).map((o) => String(o.id)));
    const validSearchIds = searchIds.filter(
      (id) => siblingSet.has(String(id)) && String(id) !== String(primaryId),
    );
    if (!validSearchIds.length) {
      return res.json({ classes: [], properties: [] });
    }

    // ── Step 1: find IRIs referenced by the primary ontology that are NOT
    // defined (no rdf:type) within it, skipping standard OWL/RDF/RDFS/XSD IRIs.
    let externalIris;
    try {
      const extRows = cachedSelect(
        PREFIXES +
          `
        SELECT DISTINCT ?iri WHERE {
          {
            { ?s rdfs:subClassOf ?iri }
            UNION { ?s rdfs:domain ?iri }
            UNION { ?s rdfs:range ?iri }
            UNION { ?s rdfs:subPropertyOf ?iri }
            UNION { ?s owl:equivalentClass ?iri }
            UNION { ?s owl:disjointWith ?iri }
            UNION { ?s owl:inverseOf ?iri }
          }
          FILTER(!isBlank(?iri) && isIRI(?iri))
          FILTER(!STRSTARTS(STR(?iri), "${NS.owl}"))
          FILTER(!STRSTARTS(STR(?iri), "${NS.rdf}"))
          FILTER(!STRSTARTS(STR(?iri), "${NS.rdfs}"))
          FILTER(!STRSTARTS(STR(?iri), "${NS.xsd}"))
          FILTER(!STRSTARTS(STR(?iri), "http://schema.org/"))
          FILTER(!STRSTARTS(STR(?iri), "https://schema.org/"))
          FILTER(!STRSTARTS(STR(?iri), "http://www.w3.org/2004/02/skos/core#"))
          FILTER NOT EXISTS { ?iri rdf:type ?t . FILTER(!isBlank(?t)) }
        }
        `,
        primaryId,
      );
      externalIris = extRows.map((r) => r.iri?.value).filter(Boolean);
    } catch (err) {
      return res.status(500).json({ error: String(err.message || err) });
    }

    // iriValues may be empty when the primary ontology has no outward external
    // references, but we still need to run the reverse-ref queries below (which
    // find classes in linked ontologies that subClassOf write-ontology classes).
    // Do NOT early-return here — let the per-searchId loop handle both paths.
    const iriValues = externalIris.map((iri) => `<${iri}>`).join(" ");

    // ── Pre-fetch primary-ontology class IRIs for the reverse-ref pass ────────
    // These are used inside each per-searchId loop to find classes in the linked
    // ontology that subClassOf a class defined here.  Fetched once outside the
    // loop so the query is only executed and cached once regardless of how many
    // linked ontologies are being searched.
    let primaryClassValues = "";
    try {
      const primaryClassRows = cachedSelect(
        PREFIXES +
          `
        SELECT DISTINCT ?iri WHERE {
          {
            ?iri a owl:Class .
            FILTER(!isBlank(?iri))
          } UNION {
            ?s rdfs:subClassOf ?iri .
            FILTER(!isBlank(?iri) && isIRI(?iri))
            FILTER(!STRSTARTS(STR(?iri), "${NS.owl}"))
            FILTER(!STRSTARTS(STR(?iri), "${NS.rdf}"))
            FILTER(!STRSTARTS(STR(?iri), "${NS.rdfs}"))
          }
        }`,
        primaryId,
      );
      const primaryClassIris = primaryClassRows.map((r) => r.iri?.value).filter(Boolean);
      primaryClassValues = primaryClassIris.map((iri) => `<${iri}>`).join(" ");
    } catch (_err) {
      console.warn("[linked-context] primary class fetch failed:", _err?.message || _err);
      // Best-effort — if this fails, the reverse-ref pass is skipped.
    }

    const ontoById = new Map((req.ontologies || []).map((o) => [o.id, o]));
    const classes = [];
    const properties = [];
    // Flat list of { iri, domain, range, label } objects — one entry per
    // (property, domain, range) triple found in a linked ontology where BOTH
    // domain and range are visible linked nodes.  The main graph query only
    // searches the write ontology, so without this list objectProperty edges
    // that are purely internal to a linked ontology are never drawn.
    const propEdges = [];
    // Explicit (child, parent) pairs for subClassOf edges between linked
    // nodes found in EITHER the linked or write ontology's named graph.
    // Belt-and-suspenders alongside the parentMap approach — critical when
    // the user has written cross-ontology hierarchy assertions in the write
    // ontology (e.g. <LinkedA> rdfs:subClassOf <LinkedB> stored in the
    // write graph), which the linked-only parentMap query would silently miss.
    const subEdges = [];

    // ── Step 2: query each linked ontology for those external IRIs ────────────
    for (const searchId of validSearchIds) {
      const onto = ontoById.get(searchId) || { id: searchId, name: searchId };
      try {
        const deprSet = collectDeprecated(searchId);

        // Classes in this linked ontology that match the external IRI set.
        // Guard: skip when iriValues is empty (no external refs from primary
        // ontology) to avoid sending an empty VALUES clause, which some SPARQL
        // engines reject or handle inconsistently.
        const classRows = iriValues
          ? cachedSelect(
              PREFIXES +
                `
          SELECT ?iri ?label ?prefLabel ?comment ?definition WHERE {
            VALUES ?iri { ${iriValues} }
            ?iri a owl:Class .
            FILTER(!isBlank(?iri))
            OPTIONAL { ?iri rdfs:label ?label }
            OPTIONAL { ?iri rdfs:comment ?comment }
            OPTIONAL { ?iri skos:prefLabel ?prefLabel }
            OPTIONAL { ?iri skos:definition ?definition }
          }`,
              searchId,
            )
          : [];

        // Build the set of directly-matched class IRIs.
        const matchedClassIris = new Set(classRows.map((r) => r.iri?.value).filter(Boolean));

        // ── Step 2 (reverse-ref): Find linked-ontology classes that subClassOf write-ontology classes ──
        // Step 1 only scans the write (primary) ontology for outward references, so it misses
        // the "inward" case: a class defined in the linked ontology declares itself a subclass
        // of a class defined in the write ontology (e.g. linked:Child rdfs:subClassOf write:Parent).
        // We use a VALUES clause with the pre-fetched primary class IRIs (see primaryClassValues
        // above) scoped to the LINKED ontology — same reliable mechanism used throughout this file.
        const reverseRefDetailMap = new Map(); // iri → { label, prefLabel, comment, definition }
        if (primaryClassValues) {
          try {
            const reverseRefRows = cachedSelect(
              PREFIXES +
                `
              SELECT DISTINCT ?child ?parent ?label ?prefLabel ?comment ?definition WHERE {
                VALUES ?parent { ${primaryClassValues} }
                ?child rdfs:subClassOf ?parent .
                FILTER(!isBlank(?child) && isIRI(?child))
                FILTER(?child != ?parent)
                OPTIONAL { ?child rdfs:label ?label }
                OPTIONAL { ?child skos:prefLabel ?prefLabel }
                OPTIONAL { ?child rdfs:comment ?comment }
                OPTIONAL { ?child skos:definition ?definition }
              }`,
              [searchId, primaryId],
            );
            for (const r of reverseRefRows) {
              const iri = r.child?.value;
              if (!iri || matchedClassIris.has(iri)) continue;
              if (!reverseRefDetailMap.has(iri)) {
                reverseRefDetailMap.set(iri, {
                  label: r.label || null,
                  prefLabel: r.prefLabel || null,
                  comment: r.comment || null,
                  definition: r.definition || null,
                });
              }
              // Add to matchedClassIris so the descendant walk (Step 2a-post) also
              // finds any sub-subclasses of these classes within the linked ontology.
              matchedClassIris.add(iri);
            }
          } catch (_err) {
            // Best-effort — degrade gracefully.
            console.warn(
              `[linked-context] reverse-ref query failed for search=${String(searchId)
                .replace(/[\r\n%]/g, " ")
                .slice(0, 80)}:`,
              _err?.message || _err,
            );
          }
        }

        // ── Step 2a: Walk the full ancestor chain via rdfs:subClassOf+ ───────
        // This surfaces grandparents, great-grandparents, etc. so the user
        // sees the complete inheritance path even though only the direct parent
        // is referenced by the writable ontology.
        const ancestorDetailMap = new Map(); // iri → {label, prefLabel, comment, definition}
        if (matchedClassIris.size > 0) {
          const matchedValues = [...matchedClassIris].map((iri) => `<${iri}>`).join(" ");
          try {
            const ancRows = cachedSelect(
              PREFIXES +
                `
              SELECT DISTINCT ?class ?ancestor ?label ?prefLabel ?comment ?definition WHERE {
                VALUES ?class { ${matchedValues} }
                ?class rdfs:subClassOf+ ?ancestor .
                ?ancestor a owl:Class .
                FILTER(!isBlank(?ancestor) && isIRI(?ancestor))
                FILTER(!STRSTARTS(STR(?ancestor), "${NS.owl}"))
                FILTER(!STRSTARTS(STR(?ancestor), "${NS.rdf}"))
                FILTER(!STRSTARTS(STR(?ancestor), "${NS.rdfs}"))
                OPTIONAL { ?ancestor rdfs:label ?label }
                OPTIONAL { ?ancestor skos:prefLabel ?prefLabel }
                OPTIONAL { ?ancestor rdfs:comment ?comment }
                OPTIONAL { ?ancestor skos:definition ?definition }
              }`,
              // Search BOTH the linked ontology AND the write (primary) ontology
              // so the property path can traverse subClassOf triples stored in
              // either named graph.  This is essential when the write ontology
              // contains cross-ontology hierarchy assertions such as
              //   <LinkedA> rdfs:subClassOf <LinkedB>
              // that a linked-only query would silently miss, causing the
              // parent class to never appear in allLinkedIris (and thus never
              // show up as a visible node in the graph).
              [searchId, primaryId],
            );
            for (const r of ancRows) {
              const anc = r.ancestor?.value;
              if (!anc || matchedClassIris.has(anc)) continue;
              if (!ancestorDetailMap.has(anc)) {
                ancestorDetailMap.set(anc, {
                  label: r.label || null,
                  prefLabel: r.prefLabel || null,
                  comment: r.comment || null,
                  definition: r.definition || null,
                });
              }
            }
          } catch (_err) {
            // Property paths unsupported by store — silently degrade to direct matches only
          }
        }

        // ── Step 2a-post: Walk the descendant chain ───────────────────────────
        // Find all subclasses (children, grandchildren, etc.) of the matched
        // classes so the graph shows the complete class hierarchy rooted at each
        // directly-referenced linked class, not just the upward ancestor chain.
        // Searches both the linked ontology and the write ontology so that
        // cross-ontology subClassOf assertions (stored in the write graph) are
        // followed and their children surface as visible nodes in the graph.
        const descendantDetailMap = new Map(); // iri → {label, prefLabel, comment, definition}
        if (matchedClassIris.size > 0) {
          const matchedValues = [...matchedClassIris].map((iri) => `<${iri}>`).join(" ");
          try {
            const descRows = cachedSelect(
              PREFIXES +
                `
              SELECT DISTINCT ?child ?label ?prefLabel ?comment ?definition WHERE {
                VALUES ?ancestor { ${matchedValues} }
                ?child rdfs:subClassOf+ ?ancestor .
                FILTER(!isBlank(?child) && isIRI(?child))
                OPTIONAL { ?child rdfs:label ?label }
                OPTIONAL { ?child skos:prefLabel ?prefLabel }
                OPTIONAL { ?child rdfs:comment ?comment }
                OPTIONAL { ?child skos:definition ?definition }
              }`,
              [searchId, primaryId],
            );
            for (const r of descRows) {
              const child = r.child?.value;
              if (!child || matchedClassIris.has(child) || ancestorDetailMap.has(child)) continue;
              if (!descendantDetailMap.has(child)) {
                descendantDetailMap.set(child, {
                  label: r.label || null,
                  prefLabel: r.prefLabel || null,
                  comment: r.comment || null,
                  definition: r.definition || null,
                });
              }
            }
          } catch (_err) {
            // Property paths unsupported by store — silently degrade.
          }
        }

        // Extended IRI set = direct matches + all transitive ancestors + all descendants
        const allLinkedIris = new Set([
          ...matchedClassIris,
          ...ancestorDetailMap.keys(),
          ...descendantDetailMap.keys(),
        ]);

        // ── Step 2b: Build parent map for the full extended set ───────────────
        const parentMap = new Map();
        if (allLinkedIris.size > 0) {
          const extValues = [...allLinkedIris].map((iri) => `<${iri}>`).join(" ");
          const parentRows = cachedSelect(
            PREFIXES +
              `
            SELECT ?child ?parent WHERE {
              VALUES ?child { ${extValues} }
              ?child rdfs:subClassOf ?parent .
              FILTER(!isBlank(?child) && isIRI(?parent) && ?child != ?parent)
            }`,
            // Search BOTH graphs so subClassOf triples stored in the write
            // ontology (cross-ontology hierarchy assertions) are captured.
            [searchId, primaryId],
          );
          for (const r of parentRows) {
            const c = r.child?.value;
            const p = r.parent?.value;
            if (!c || !p) continue;
            if (!parentMap.has(c)) parentMap.set(c, []);
            if (!parentMap.get(c).includes(p)) parentMap.get(c).push(p);
          }
        }

        // Direct matches
        for (const row of classRows) {
          const iri = row.iri?.value;
          if (!iri) continue;
          classes.push({
            iri: { value: iri, termType: "NamedNode" },
            label: row.label || null,
            prefLabel: row.prefLabel || null,
            comment: row.comment || null,
            definition: row.definition || null,
            parents: parentMap.get(iri) || [],
            equivalents: [],
            disjoints: [],
            deprecated: deprSet.has(iri),
            sourceOntologyId: searchId,
            sourceOntologyName: onto.name || searchId,
          });
        }

        // Transitive ancestors (not directly referenced — surfaced via chain)
        for (const [iri, detail] of ancestorDetailMap) {
          classes.push({
            iri: { value: iri, termType: "NamedNode" },
            label: detail.label,
            prefLabel: detail.prefLabel,
            comment: detail.comment,
            definition: detail.definition,
            parents: parentMap.get(iri) || [],
            equivalents: [],
            disjoints: [],
            deprecated: deprSet.has(iri),
            sourceOntologyId: searchId,
            sourceOntologyName: onto.name || searchId,
            isAncestor: true,
          });
        }

        // Descendants (subclasses of matched classes — children, grandchildren, etc.)
        // These are classes that exist in the linked ontology beneath the
        // directly-referenced classes.  Surfacing them gives the user the full
        // class hierarchy below the linked entry points, not just the upward chain.
        for (const [iri, detail] of descendantDetailMap) {
          classes.push({
            iri: { value: iri, termType: "NamedNode" },
            label: detail.label,
            prefLabel: detail.prefLabel,
            comment: detail.comment,
            definition: detail.definition,
            parents: parentMap.get(iri) || [],
            equivalents: [],
            disjoints: [],
            deprecated: deprSet.has(iri),
            sourceOntologyId: searchId,
            sourceOntologyName: onto.name || searchId,
            isDescendant: true,
          });
        }

        // Reverse-referenced classes: classes in the linked ontology that declare
        // rdfs:subClassOf pointing to a class in the write (primary) ontology.
        // These were not found by the externalIris scan (Step 1 only sees outward
        // references from the write ontology) so they are not in classRows, but
        // they must appear in the graph so the hierarchy view shows them.
        for (const [iri, detail] of reverseRefDetailMap) {
          classes.push({
            iri: { value: iri, termType: "NamedNode" },
            label: detail.label,
            prefLabel: detail.prefLabel,
            comment: detail.comment,
            definition: detail.definition,
            parents: parentMap.get(iri) || [],
            equivalents: [],
            disjoints: [],
            deprecated: deprSet.has(iri),
            sourceOntologyId: searchId,
            sourceOntologyName: onto.name || searchId,
            isDescendant: true,
          });
        }

        // Object + datatype properties matching the external IRI set.
        // Guard: same as classRows — skip when iriValues is empty.
        const propRows = iriValues
          ? cachedSelect(
              PREFIXES +
                `
          SELECT ?iri ?label ?prefLabel ?comment ?kind ?domain ?range WHERE {
            VALUES ?iri { ${iriValues} }
            {
              ?iri a owl:ObjectProperty .
              BIND("object" AS ?kind)
            } UNION {
              ?iri a owl:DatatypeProperty .
              BIND("datatype" AS ?kind)
            }
            OPTIONAL { ?iri rdfs:label ?label }
            OPTIONAL { ?iri rdfs:comment ?comment }
            OPTIONAL { ?iri skos:prefLabel ?prefLabel }
            OPTIONAL { ?iri rdfs:domain ?domain . FILTER(!isBlank(?domain)) }
            OPTIONAL { ?iri rdfs:range  ?range  . FILTER(!isBlank(?range))  }
          }`,
              searchId,
            )
          : [];

        // Dedupe by IRI (domain/range OPTIONAL can produce multiple rows)
        const propSeen = new Set();
        for (const row of propRows) {
          const iri = row.iri?.value;
          if (!iri || propSeen.has(iri)) continue;
          propSeen.add(iri);
          properties.push({
            iri: { value: iri, termType: "NamedNode" },
            label: row.label || null,
            prefLabel: row.prefLabel || null,
            comment: row.comment || null,
            kind: { value: row.kind?.value || "object" },
            domain: row.domain ? { value: row.domain.value } : null,
            range: row.range ? { value: row.range.value } : null,
            deprecated: deprSet.has(iri),
            sourceOntologyId: searchId,
            sourceOntologyName: onto.name || searchId,
          });
        }

        // ── Step 2c: object property edges INTERNAL to this linked ontology ──
        // Find owl:ObjectProperties whose domain AND range are both in
        // allLinkedIris (the visible linked-node set).  The main graph query
        // only searches the write ontology's named graph, so without this pass
        // those edges are never returned and never rendered.
        if (allLinkedIris.size > 0) {
          const linkedNodeVals = [...allLinkedIris].map((i) => `<${i}>`).join(" ");
          try {
            const internalEdgeRows = cachedSelect(
              PREFIXES +
                `
              SELECT DISTINCT ?p ?plabel ?pprefLabel ?domain ?range WHERE {
                ?p a owl:ObjectProperty .
                { ?p rdfs:domain ?domain } UNION { ?p schema:domainIncludes ?domain } UNION { ?p schemas:domainIncludes ?domain }
                { ?p rdfs:range  ?range  } UNION { ?p schema:rangeIncludes  ?range  } UNION { ?p schemas:rangeIncludes  ?range  }
                VALUES ?domain { ${linkedNodeVals} }
                VALUES ?range  { ${linkedNodeVals} }
                FILTER(!isBlank(?domain) && !isBlank(?range))
                OPTIONAL { ?p rdfs:label ?plabel }
                OPTIONAL { ?p skos:prefLabel ?pprefLabel }
              }`,
              searchId,
            );
            const edgeSeen = new Set();
            for (const r of internalEdgeRows) {
              const pIri = r.p?.value;
              const domain = r.domain?.value;
              const range = r.range?.value;
              if (!pIri || !domain || !range) continue;
              // Deduplicate by the exact (property, domain, range) triple so
              // multiple domain/range alternatives don't generate phantom edges.
              const key = `${pIri}|${domain}|${range}`;
              if (edgeSeen.has(key)) continue;
              edgeSeen.add(key);
              propEdges.push({
                iri: pIri,
                domain,
                range,
                label: r.pprefLabel?.value || r.plabel?.value || null,
                sourceOntologyId: searchId,
                sourceOntologyName: onto.name || searchId,
              });
            }
          } catch (_err) {
            // Best-effort — don't fail the whole linked-context response if
            // the internal property query errors (e.g. VALUES clause too large).
          }
        }

        // ── Step 2d: explicit subClassOf edges between ALL visible linked nodes ──
        // Belt-and-suspenders alongside the parentMap (Step 2b).  Constraining
        // BOTH ?child and ?parent to allLinkedIris and searching both ontology
        // graphs (linked + write) ensures we capture every intra-linked
        // subClassOf edge regardless of which named graph stores the triple.
        // The client deduplicates against edges already drawn by the main query.
        if (allLinkedIris.size > 1) {
          const linkedNodeVals = [...allLinkedIris].map((i) => `<${i}>`).join(" ");
          try {
            const subEdgeRows = cachedSelect(
              PREFIXES +
                `
              SELECT DISTINCT ?child ?parent WHERE {
                VALUES ?child { ${linkedNodeVals} }
                VALUES ?parent { ${linkedNodeVals} }
                ?child rdfs:subClassOf ?parent .
                FILTER(?child != ?parent)
              }`,
              [searchId, primaryId],
            );
            const subEdgeSeen = new Set();
            for (const r of subEdgeRows) {
              const child = r.child?.value;
              const parent = r.parent?.value;
              if (!child || !parent) continue;
              const key = `${child}|${parent}`;
              if (subEdgeSeen.has(key)) continue;
              subEdgeSeen.add(key);
              subEdges.push({ child, parent });
            }
          } catch (_err) {
            // Best-effort — don't fail on VALUES clause size limits.
          }
        }
      } catch (err) {
        console.warn(
          `[linked-context] error querying ${String(searchId)
            .replace(/[\r\n%]/g, " ")
            .slice(0, 80)}:`,
          err.message,
        );
      }
    }

    // ── Final deduplication by IRI ──────────────────────────────────────────
    // The same entity IRI can be found once per linked ontology when the linked
    // ontologies import each other (e.g. STONEWORK, STONES Vocabularies, SKOS
    // Vocabulary, and STONES Object Properties all share the same class IRIs).
    // Keep exactly one entry per IRI, upgrading to the source whose named-graph
    // ID is a namespace prefix of the entity IRI — that is the ontology that
    // most directly defines it. When no namespace matches, the first-seen entry
    // is kept (stable across server restarts because contexts order is stable).
    const _ctxNsMap = new Map(
      validSearchIds.map((searchId) => {
        const onto = ontoById.get(searchId) || {};
        // The named graph / searchId is often the ontology IRI itself.
        // Also check onto.iri if available. Strip trailing '#' or '/' for
        // consistent prefix matching.
        const candidates = [onto.iri, searchId].filter(Boolean).map((s) => {
          // Avoid ReDoS: strip trailing '#'/'/' without backtracking regex
          let end = s.length;
          while (end > 0 && (s[end - 1] === "#" || s[end - 1] === "/")) end--;
          return end < s.length ? s.slice(0, end) : s;
        });
        return [searchId, candidates];
      }),
    );
    function _dedupeByIri(arr) {
      const best = new Map();
      for (const entry of arr) {
        const iri = entry.iri?.value || entry.iri;
        if (!iri) continue;
        if (!best.has(iri)) {
          best.set(iri, entry);
          continue;
        }
        // Check whether this candidate's source is a better namespace match
        // than the current best entry.
        const existingNss = _ctxNsMap.get(best.get(iri).sourceOntologyId) || [];
        const candidateNss = _ctxNsMap.get(entry.sourceOntologyId) || [];
        const existingMatches = existingNss.some((ns) => iri.startsWith(ns));
        const candidateMatches = candidateNss.some((ns) => iri.startsWith(ns));
        if (candidateMatches && !existingMatches) {
          best.set(iri, entry);
        }
      }
      return [...best.values()];
    }
    res.json({
      classes: _dedupeByIri(classes),
      properties: _dedupeByIri(properties),
      propEdges,
      subEdges,
    });
  },
);

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = JSON.stringify(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function lit(v, opts = {}) {
  const esc = String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  if (opts.datatype) return `"${esc}"^^${safeIri(opts.datatype)}`;
  if (opts.language) return `"${esc}"@${opts.language}`;
  return `"${esc}"`;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Helper: extract a human-readable local name from an IRI.
function shortIri(iri) {
  if (!iri) return "";
  const m = iri.match(/[#/:]([^#/:]+)$/);
  return m ? m[1] : iri;
}

// GET /export/markdown — hierarchical class list + object-property relationships.
// Returns a text/markdown file as a download.
router.get(
  "/export/markdown",
  requireAuth,
  resolveOntology,
  requireProjectRole("viewer"),
  (req, res) => {
    const scope = req.ontologyScope;

    // ── 1. Classes ────────────────────────────────────────────────────────────
    const classRows = cachedSelect(
      PREFIXES +
        `
      SELECT ?iri ?label ?prefLabel WHERE {
        ?iri a owl:Class
        FILTER(!isBlank(?iri))
        OPTIONAL { ?iri rdfs:label ?label }
        OPTIONAL { ?iri skos:prefLabel ?prefLabel }
      } ORDER BY ?iri
    `,
      scope,
    );

    const parentRows = cachedSelect(
      PREFIXES +
        `
      SELECT ?child ?parent WHERE {
        ?child rdfs:subClassOf ?parent .
        FILTER(isIRI(?child) && isIRI(?parent))
      }
    `,
      scope,
    );

    // Build maps.
    const classMap = new Map(); // iri -> { label }
    for (const r of classRows) {
      const iri = r.iri?.value;
      if (!iri) continue;
      const label = r.prefLabel?.value || r.label?.value || shortIri(iri);
      classMap.set(iri, label);
    }

    const childToParents = new Map(); // child iri -> parent iri[]
    const parentToChildren = new Map(); // parent iri -> child iri[]
    for (const r of parentRows) {
      const c = r.child?.value;
      const p = r.parent?.value;
      if (!c || !p || !classMap.has(c) || !classMap.has(p)) continue;
      if (!childToParents.has(c)) childToParents.set(c, []);
      if (!childToParents.get(c).includes(p)) childToParents.get(c).push(p);
      if (!parentToChildren.has(p)) parentToChildren.set(p, []);
      if (!parentToChildren.get(p).includes(c)) parentToChildren.get(p).push(c);
    }

    // Roots = classes with no known parents.
    const roots = [...classMap.keys()].filter((iri) => !childToParents.has(iri));

    // DFS tree walk → indented markdown list.
    const hierarchyLines = [];
    const visited = new Set();

    function walk(iri, depth) {
      if (visited.has(iri)) return;
      visited.add(iri);
      const indent = "  ".repeat(depth);
      hierarchyLines.push(`${indent}- **${classMap.get(iri)}** \`${shortIri(iri)}\``);
      const children = parentToChildren.get(iri) || [];
      for (const child of [...children].sort()) walk(child, depth + 1);
    }

    for (const root of [...roots].sort()) walk(root, 0);

    // Any cycles / orphans not reached yet.
    for (const iri of [...classMap.keys()].sort()) {
      if (!visited.has(iri)) walk(iri, 0);
    }

    // ── 2. Object properties (relationships) ─────────────────────────────────
    const propRows = cachedSelect(
      PREFIXES +
        `
      SELECT ?iri ?label ?prefLabel ?domain ?range WHERE {
        ?iri a owl:ObjectProperty .
        OPTIONAL { ?iri rdfs:label ?label }
        OPTIONAL { ?iri skos:prefLabel ?prefLabel }
        OPTIONAL {
          { ?iri rdfs:domain ?domain } UNION { ?iri schema:domainIncludes ?domain } UNION { ?iri schemas:domainIncludes ?domain }
          FILTER(!isBlank(?domain))
        }
        OPTIONAL {
          { ?iri rdfs:range  ?range  } UNION { ?iri schema:rangeIncludes  ?range  } UNION { ?iri schemas:rangeIncludes  ?range  }
          FILTER(!isBlank(?range))
        }
      } ORDER BY ?iri
    `,
      scope,
    );

    // Collect all domain/range per property (multiple rows possible).
    const propMeta = new Map(); // iri -> { label, domains: Set, ranges: Set }
    for (const r of propRows) {
      const iri = r.iri?.value;
      if (!iri) continue;
      if (!propMeta.has(iri)) {
        propMeta.set(iri, {
          label: r.prefLabel?.value || r.label?.value || shortIri(iri),
          domains: new Set(),
          ranges: new Set(),
        });
      } else if (!propMeta.get(iri).label || propMeta.get(iri).label === shortIri(iri)) {
        const l = r.prefLabel?.value || r.label?.value;
        if (l) propMeta.get(iri).label = l;
      }
      if (r.domain?.value) propMeta.get(iri).domains.add(r.domain.value);
      if (r.range?.value) propMeta.get(iri).ranges.add(r.range.value);
    }

    // ── 3. Ontology name ─────────────────────────────────────────────────────
    const metaRows = cachedSelect(
      PREFIXES +
        `
      SELECT ?label WHERE {
        ?ont a owl:Ontology .
        OPTIONAL { ?ont rdfs:label ?label }
      } LIMIT 1
    `,
      scope,
    );
    const ontologyName = metaRows[0]?.label?.value || "Ontology";

    // ── 4. Build markdown ─────────────────────────────────────────────────────
    const lines = [];
    lines.push(`# ${ontologyName}`);
    lines.push("");
    lines.push(`_Exported ${new Date().toISOString()}_`);
    lines.push("");

    lines.push("## Entities (Hierarchical)");
    lines.push("");
    if (hierarchyLines.length) {
      lines.push(...hierarchyLines);
    } else {
      lines.push("_No classes found._");
    }
    lines.push("");

    lines.push("## Relationships");
    lines.push("");
    if (propMeta.size) {
      lines.push("| Relationship | Source | Target |");
      lines.push("|---|---|---|");
      for (const [iri, meta] of [...propMeta.entries()].sort((a, b) =>
        a[1].label.localeCompare(b[1].label),
      )) {
        const name = `**${meta.label}** \`${shortIri(iri)}\``;
        const sources = meta.domains.size
          ? [...meta.domains]
              .map((d) => classMap.get(d) || shortIri(d))
              .sort()
              .join(", ")
          : "_any_";
        const targets = meta.ranges.size
          ? [...meta.ranges]
              .map((d) => classMap.get(d) || shortIri(d))
              .sort()
              .join(", ")
          : "_any_";
        lines.push(`| ${name} | ${sources} | ${targets} |`);
      }
    } else {
      lines.push("_No object properties found._");
    }
    lines.push("");

    const md = lines.join("\n");
    const filename = `${ontologyName.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(md);
  },
);

export default router;
