import { Router } from "express";
import { requireAuth, requireProjectRole } from "../middleware/auth.js";
import { resolveOntology } from "../middleware/ontology.js";
import { cachedSelect, graphIriFor, NS } from "../services/rdfStore.js";

const router = Router();

const PREFIXES = `
PREFIX rdf:     <${NS.rdf}>
PREFIX rdfs:    <${NS.rdfs}>
PREFIX owl:     <${NS.owl}>
PREFIX xsd:     <${NS.xsd}>
PREFIX skos:    <http://www.w3.org/2004/02/skos/core#>
PREFIX schema:  <http://schema.org/>
PREFIX schemas: <https://schema.org/>
`;

/**
 * Build a Cytoscape-friendly graph model of the ontology, scoped to a single
 * ontology's named graph.
 * modes:
 *   'classes'     - class hierarchy + object property edges between classes (domain -> range)
 *   'properties'  - property graph: nodes are classes, edges are object properties
 *   'individuals' - individuals and their type/object-property links
 *   'full'        - everything together
 */
router.get("/", requireAuth, resolveOntology, requireProjectRole("viewer"), (req, res) => {
  const mode = (req.query.mode || "classes").toString();
  const limit = parseInt(req.query.limit || "500", 10);
  const scope = req.ontologyScope;

  // The write-target ontology's labels take priority over linked (read-only)
  // ontologies. The client passes this as ?writeOntology=<id> so graph nodes
  // show the user's own labels rather than those from imported/linked graphs.
  const writeOntologyId = (req.query.writeOntology || "").toString().trim() || null;
  const writeGraphIri = writeOntologyId ? graphIriFor(writeOntologyId) : null;

  // When the write target is a branch, exclude its parent AND all sibling
  // branches from the read scope — same logic as GET /entity.  Including the
  // parent causes deleted-from-branch subClassOf edges to persist in the graph
  // because the parent graph still has them.
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

  const nodes = new Map();
  const edges = [];
  // Hoisted so the response can always include inverse pairs (populated inside
  // the classes/full block below, empty for individuals/properties mode).
  let inverseRows = [];

  // Derive per-graph source-ontology info when the scope spans multiple ontologies.
  const scopeIds = Array.isArray(effectiveScope)
    ? effectiveScope.filter(Boolean)
    : effectiveScope
      ? [String(effectiveScope)]
      : [];
  const multiScope = scopeIds.length > 1;
  // Linked-context ontology IDs: passed by the client so the server can
  // distinguish "linked" (children should be visible) from "hidden"
  // (children should be suppressed) when tagging equivChildRows nodes.
  const linkedOntologiesParam = (req.query.linkedOntologies || "").toString().trim();
  const linkedOntologyIds = linkedOntologiesParam
    ? linkedOntologiesParam.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const GRAPH_IRI_PREFIX = "urn:ontology-editor:onto:";

  function addNode(iri, kind, label, sourceOntologyId) {
    if (!iri) return;
    if (!nodes.has(iri)) {
      const node = { id: iri, label: label || shortLabel(iri), kind };
      if (sourceOntologyId) node.sourceOntologyId = sourceOntologyId;
      nodes.set(iri, node);
    } else {
      const node = nodes.get(iri);
      if (label && !node.label) node.label = label;
      // sourceOntologyId: first encounter wins — do not overwrite.
    }
  }

  if (mode === "classes" || mode === "full") {
    if (multiScope) {
      // ── Multi-ontology scope: tag each class with its source named graph ──
      // FROM NAMED is placed after the projection so wrapQuery (which checks
      // for /\bFROM\b/ in that position) sees it and skips its own FROM injection.
      // VALUES ?g is redundant with FROM NAMED but makes the restriction explicit.
      const fromNamed = scopeIds.map((id) => `FROM NAMED <${graphIriFor(id)}>`).join("\n        ");
      const graphValues = scopeIds.map((id) => `<${graphIriFor(id)}>`).join(" ");
      const classRows = cachedSelect(
        `${PREFIXES}
        SELECT ?c ?label ?prefLabel ?writePrefLabel ?g
        ${fromNamed}
        WHERE {
          VALUES ?g { ${graphValues} }
          GRAPH ?g { ?c a owl:Class . FILTER(!isBlank(?c)) }
          OPTIONAL { GRAPH ?g { ?c rdfs:label ?label } }
          OPTIONAL { GRAPH ?g { ?c skos:prefLabel ?prefLabel } }
          ${writeGraphIri ? `OPTIONAL { GRAPH <${writeGraphIri}> { ?c skos:prefLabel ?writePrefLabel } }` : ""}
        } LIMIT ${limit}`,
        effectiveScope,
      );
      for (const r of classRows) {
        const gIri = r.g?.value;
        const sourceOntologyId = gIri?.startsWith(GRAPH_IRI_PREFIX)
          ? gIri.slice(GRAPH_IRI_PREFIX.length)
          : null;
        // Write-graph label wins; fall back to the owning graph's labels
        const label = r.writePrefLabel?.value || r.prefLabel?.value || r.label?.value;
        addNode(r.c.value, "class", label, sourceOntologyId);
      }
    } else {
      // Single-ontology scope — tag every class declaration with the sole
      // scope ID so the client can distinguish "declared here" from orphan
      // cross-ontology parent nodes (which have no sourceOntologyId).
      const singleScopeId = Array.isArray(effectiveScope) ? effectiveScope[0] : effectiveScope;
      const classRows = cachedSelect(
        PREFIXES +
          `
        SELECT ?c ?label ?prefLabel WHERE {
          ?c a owl:Class . FILTER(!isBlank(?c))
          OPTIONAL { ?c rdfs:label ?label }
          OPTIONAL { ?c skos:prefLabel ?prefLabel }
        } LIMIT ${limit}
      `,
        effectiveScope,
      );
      for (const r of classRows)
        addNode(r.c.value, "class", r.prefLabel?.value || r.label?.value, singleScopeId);
    }

    // Do NOT require `?child a owl:Class` here — that would filter out
    // cross-ontology subClassOf assertions where the child is only declared as
    // owl:Class in a linked/imported named graph but the rdfs:subClassOf triple
    // itself lives in the write ontology's graph.  The FILTER for non-blank IRI
    // subjects is sufficient; rdfs:subClassOf is semantically specific to class
    // hierarchies so false positives are not a concern in practice.
    // Do NOT require `?parent a owl:Class` either — that would filter out
    // cross-ontology parents only declared in a linked named graph.
    const subRows = cachedSelect(
      PREFIXES +
        `
      SELECT ?child ?parent WHERE {
        ?child rdfs:subClassOf ?parent .
        FILTER(!isBlank(?child) && isIRI(?child) && isIRI(?parent))
        FILTER(?child != ?parent)
      } LIMIT ${limit}
    `,
      effectiveScope,
    );
    for (const r of subRows) {
      // addNode is idempotent for already-seen IRIs; these calls just ensure
      // orphan parent IRIs (cross-ontology subClassOf targets) are in the map.
      addNode(r.child.value, "class");
      addNode(r.parent.value, "class");
      edges.push({
        id: `${r.child.value}->${r.parent.value}:sub`,
        source: r.child.value,
        target: r.parent.value,
        label: "subClassOf",
        kind: "subClassOf",
      });
    }

    const propEdges = cachedSelect(
      PREFIXES +
        `
      SELECT ?p ?plabel ?pprefLabel ?domain ?range WHERE {
        ?p a owl:ObjectProperty .
        { ?p rdfs:domain ?domain } UNION { ?p schema:domainIncludes ?domain } UNION { ?p schemas:domainIncludes ?domain }
        { ?p rdfs:range  ?range  } UNION { ?p schema:rangeIncludes  ?range  } UNION { ?p schemas:rangeIncludes  ?range  }
        FILTER(!isBlank(?domain) && !isBlank(?range))
        OPTIONAL { ?p rdfs:label ?plabel }
        OPTIONAL { ?p skos:prefLabel ?pprefLabel }
      } LIMIT ${limit}
    `,
      effectiveScope,
    );
    for (const r of propEdges) {
      addNode(r.domain.value, "class");
      addNode(r.range.value, "class");
      edges.push({
        id: `${r.domain.value}->${r.range.value}:${r.p.value}`,
        source: r.domain.value,
        target: r.range.value,
        label: r.pprefLabel?.value || r.plabel?.value || shortLabel(r.p.value),
        kind: "objectProperty",
        iri: r.p.value,
      });
    }

    // ── Mark inverse-of edges ─────────────────────────────────────────────
    // Query for owl:inverseOf declarations among the properties that appear
    // in this graph.  When "?p owl:inverseOf ?inv" is found, the edge whose
    // property IRI equals ?inv is the "inverse direction" and gets flagged
    // with isInverse: true so the client's "Hide inverse relationships"
    // toggle can hide it without affecting the forward direction.
    //
    // Search ALL named graphs (null scope) — owl:inverseOf declarations often
    // live in imported/linked ontologies rather than the write ontology's own
    // named graph, and restricting to the write scope would silently miss them.
    // IMPORTANT: null scope skips wrapQuery (no FROM clause injected), so a
    // bare triple pattern like `?p owl:inverseOf ?inv` only matches the DEFAULT
    // graph — which is always empty in this store because all ontology data
    // lives in named graphs.  Wrapping the pattern in `GRAPH ?g { ... }`
    // causes the SPARQL engine to iterate over ALL named graphs, which is the
    // same technique used by the label-enrichment query at the bottom of this
    // route.
    inverseRows = cachedSelect(
      PREFIXES +
        `
      SELECT DISTINCT ?p ?inv WHERE {
        GRAPH ?g {
          ?p owl:inverseOf ?inv .
          FILTER(isIRI(?p) && isIRI(?inv))
        }
      } LIMIT ${limit}
    `,
      null,
    );
    if (inverseRows.length > 0) {
      // Build a lookup of all (p, inv) pairs so we can detect symmetric
      // mutual declarations: A owl:inverseOf B  AND  B owl:inverseOf A.
      // For one-sided declarations: mark ?p (the declarer) as inverse so the
      // "forward" ?inv remains visible.
      // For symmetric pairs: only mark the alphabetically-later IRI so exactly
      // one of the pair is suppressed — we never want to hide both.
      const inversePairSet = new Set(inverseRows.map((r) => `${r.p.value} ${r.inv.value}`));
      const inverseIris = new Set();
      for (const r of inverseRows) {
        const p = r.p.value;
        const inv = r.inv.value;
        const isSymmetric = inversePairSet.has(`${inv} ${p}`);
        if (isSymmetric) {
          // Both sides declared — suppress only the later IRI string so one is kept.
          if (p > inv) inverseIris.add(p);
        } else {
          // One-sided declaration — suppress the declaring property (?p).
          inverseIris.add(p);
        }
      }
      for (const e of edges) {
        if (e.kind === "objectProperty" && e.iri && inverseIris.has(e.iri)) {
          e.isInverse = true;
        }
      }
    }

    // ── Synthesize missing forward edges from their declared inverse ───────
    // If an ontology declares `compromisedIn owl:inverseOf compromised` and
    // gives `compromisedIn` explicit rdfs:domain/range, the SPARQL propEdges
    // query above will find Identity --compromisedIn--> Incident but will NOT
    // find Incident --compromised--> Identity (no explicit domain/range on
    // `compromised`).  Without that edge, inheritance can never propagate the
    // incoming direction to subclasses of Identity.
    //
    // Solution: for every (p, inv) row where `inv` has no edge yet but `p`
    // does, synthesize a reversed edge for `inv`.  The synthesized edge is NOT
    // marked isInverse — it represents the canonical forward direction.
    {
      const propEdgesByIri = new Map();
      const existingEdgeIds = new Set(edges.map((e) => e.id));
      for (const e of edges) {
        if (e.kind === "objectProperty" && e.iri) {
          if (!propEdgesByIri.has(e.iri)) propEdgesByIri.set(e.iri, []);
          propEdgesByIri.get(e.iri).push(e);
        }
      }
      for (const r of inverseRows) {
        const pIri = r.p.value; // declaring inverse property (has edges)
        const invIri = r.inv.value; // forward property (may have no edges)
        const pHasEdges = propEdgesByIri.has(pIri);
        const invHasEdges = propEdgesByIri.has(invIri);
        if (!pHasEdges || invHasEdges) continue;
        // Synthesize: for every p edge (domain A → range B), add inv (B → A).
        for (const pe of propEdgesByIri.get(pIri)) {
          const synId = `${pe.target}->${pe.source}:${invIri}`;
          if (existingEdgeIds.has(synId)) continue;
          addNode(pe.target, "class");
          addNode(pe.source, "class");
          const synEdge = {
            id: synId,
            source: pe.target,
            target: pe.source,
            label: shortLabel(invIri),
            kind: "objectProperty",
            iri: invIri,
            // NOT isInverse — this is the forward/canonical direction.
          };
          edges.push(synEdge);
          existingEdgeIds.add(synId);
        }
      }
    }

    // ── owl:equivalentClass edges ─────────────────────────────────────────
    // Include these explicitly so the client can:
    //  (a) hide them via the "Hide equivalent imports" toggle, and
    //  (b) build the transitive-inheritance graph for the
    //      "Show inherited relationships" feature (equivalentClass peers
    //      inherit each other's object-property edges).
    //
    // Restrict to the visible+linked named graphs so equiv edges from
    // completely unrelated ontologies (other projects) are excluded.
    const equivScopeIds = [...new Set([...scopeIds, ...linkedOntologyIds])];
    const equivGraphVals = equivScopeIds.map((id) => `<${graphIriFor(id)}>`).join(" ");
    const equivRows =
      equivScopeIds.length > 0
        ? cachedSelect(
            PREFIXES +
              `
      SELECT DISTINCT ?a ?b WHERE {
        VALUES ?g { ${equivGraphVals} }
        GRAPH ?g {
          ?a owl:equivalentClass ?b .
          FILTER(isIRI(?a) && isIRI(?b))
        }
      } LIMIT ${limit}
    `,
            null,
          )
        : [];
    for (const r of equivRows) {
      addNode(r.a.value, "class");
      addNode(r.b.value, "class");
      edges.push({
        id: `${r.a.value}->equiv->${r.b.value}`,
        source: r.a.value,
        target: r.b.value,
        label: "equivalentClass",
        kind: "equivalentClass",
      });
    }

    // ── Subclasses of equivalent-class targets across ALL named graphs ────────
    // When a write-ontology class A is declared owl:equivalentClass B (where B
    // lives in a linked/imported named graph), B's children (C, D, …) are NOT
    // found by the main subRows query above (which is scoped to effectiveScope,
    // i.e. the write ontology only in linked-context mode).
    // Searching ALL named graphs (null scope → GRAPH ?g pattern) guarantees that
    // children of every equivalent-class target appear in the graph regardless
    // of which named graph stores their rdfs:subClassOf triples.
    if (equivRows.length > 0) {
      const equivTargetIris = new Set();
      for (const r of equivRows) {
        if (r.a?.value) equivTargetIris.add(r.a.value);
        if (r.b?.value) equivTargetIris.add(r.b.value);
      }
      const equivVals = [...equivTargetIris].map((iri) => `<${iri}>`).join(" ");
      try {
        const equivChildRows = cachedSelect(
          PREFIXES +
            `
          SELECT DISTINCT ?child ?parent ?g WHERE {
            GRAPH ?g {
              VALUES ?parent { ${equivVals} }
              ?child rdfs:subClassOf ?parent .
              FILTER(!isBlank(?child) && isIRI(?child) && ?child != ?parent)
            }
          }`,
          null, // null = search ALL named graphs via GRAPH ?g
        );
        const edgeIdSet = new Set(edges.map((e) => e.id));
        for (const r of equivChildRows) {
          const childIri = r.child?.value;
          const parentIri = r.parent?.value;
          const gIri = r.g?.value;
          if (!childIri || !parentIri) continue;
          // Only tag with sourceOntologyId when the child's ontology is in the
          // active scope OR is a linked-context ontology (client passed it via
          // ?linkedOntologies=). Hidden ontologies get null so the client's
          // orphan-node check hides their children correctly.
          const rawOntologyId = gIri?.startsWith(GRAPH_IRI_PREFIX)
            ? gIri.slice(GRAPH_IRI_PREFIX.length)
            : null;
          const sourceOntologyId =
            rawOntologyId &&
            (scopeIds.includes(rawOntologyId) || linkedOntologyIds.includes(rawOntologyId))
              ? rawOntologyId
              : null;
          addNode(childIri, "class", null, sourceOntologyId);
          addNode(parentIri, "class");
          const edgeId = `${childIri}->${parentIri}:sub`;
          if (!edgeIdSet.has(edgeId)) {
            edges.push({
              id: edgeId,
              source: childIri,
              target: parentIri,
              label: "subClassOf",
              kind: "subClassOf",
            });
            edgeIdSet.add(edgeId);
          }
        }
      } catch (_err) {
        // Best-effort — degrade gracefully if the store can't handle GRAPH ?g.
      }
    }
  }

  if (mode === "individuals" || mode === "full") {
    let typeRows;
    let indSourceId; // (row) => sourceOntologyId | null

    if (multiScope) {
      const fromNamed = scopeIds.map((id) => `FROM NAMED <${graphIriFor(id)}>`).join("\n        ");
      const graphValues = scopeIds.map((id) => `<${graphIriFor(id)}>`).join(" ");
      typeRows = cachedSelect(
        `${PREFIXES}
        SELECT ?i ?t ?label ?prefLabel ?g
        ${fromNamed}
        WHERE {
          VALUES ?g { ${graphValues} }
          GRAPH ?g {
            ?i a owl:NamedIndividual . FILTER(!isBlank(?i))
            OPTIONAL { ?i a ?t FILTER(?t != owl:NamedIndividual && !isBlank(?t)) }
            OPTIONAL { ?i rdfs:label ?label }
            OPTIONAL { ?i skos:prefLabel ?prefLabel }
          }
        } LIMIT ${limit}`,
        scope,
      );
      indSourceId = (r) => {
        const gIri = r.g?.value;
        return gIri?.startsWith(GRAPH_IRI_PREFIX) ? gIri.slice(GRAPH_IRI_PREFIX.length) : null;
      };
    } else {
      const singleIndScopeId = Array.isArray(scope) ? scope[0] : scope;
      typeRows = cachedSelect(
        PREFIXES +
          `
        SELECT ?i ?t ?label ?prefLabel WHERE {
          ?i a owl:NamedIndividual .
          OPTIONAL { ?i a ?t FILTER(?t != owl:NamedIndividual && !isBlank(?t)) }
          OPTIONAL { ?i rdfs:label ?label }
          OPTIONAL { ?i skos:prefLabel ?prefLabel }
        } LIMIT ${limit}
      `,
        scope,
      );
      indSourceId = () => singleIndScopeId;
    }

    // Class nodes added as rdf:type targets need a sourceOntologyId so the
    // client visibility check (sourceOntologyId === null → hide) doesn't
    // suppress them.  Use writeOntologyId as the best available fallback;
    // in "full" mode these nodes are already in the map with their real
    // sourceOntologyId from the classes pass, so addNode is a no-op for them.
    const classFallbackSrcId = writeOntologyId || scopeIds[0] || null;

    for (const r of typeRows) {
      addNode(r.i.value, "individual", r.prefLabel?.value || r.label?.value, indSourceId(r));
      if (r.t) {
        addNode(r.t.value, "class", null, classFallbackSrcId);
        edges.push({
          id: `${r.i.value}->${r.t.value}:type`,
          source: r.i.value,
          target: r.t.value,
          label: "type",
          kind: "type",
        });
      }
    }

    const instEdges = cachedSelect(
      PREFIXES +
        `
      SELECT ?s ?p ?o WHERE {
        ?s a owl:NamedIndividual . ?o a owl:NamedIndividual .
        ?s ?p ?o .
        ?p a owl:ObjectProperty .
      } LIMIT ${limit}
    `,
      scope,
    );
    for (const r of instEdges) {
      addNode(r.s.value, "individual");
      addNode(r.o.value, "individual");
      edges.push({
        id: `${r.s.value}->${r.o.value}:${r.p.value}`,
        source: r.s.value,
        target: r.o.value,
        label: shortLabel(r.p.value),
        kind: "relation",
        iri: r.p.value,
      });
    }

    // ── subClassOf + objectProperty edges between visible class nodes ─────
    // In individuals mode, class nodes are added as rdf:type targets but the
    // classes block never runs — so hierarchy and property edges are missing.
    // Object properties are often inherited (domain = ancestor class, not the
    // direct type), so we build a transitive ancestor map and surface inherited
    // properties on the visible (direct-type) class nodes.
    if (mode === "individuals") {
      const classIriSet = new Set(
        [...nodes.values()].filter((n) => n.kind === "class").map((n) => n.id),
      );
      if (classIriSet.size > 0) {
        const subRows = cachedSelect(
          PREFIXES +
            `
          SELECT ?child ?parent WHERE {
            ?child rdfs:subClassOf ?parent .
            FILTER(!isBlank(?child) && isIRI(?child) && isIRI(?parent))
            FILTER(?child != ?parent)
          } LIMIT ${limit}
        `,
          effectiveScope,
        );

        // Add subClassOf edges between visible classes.
        for (const r of subRows) {
          if (!classIriSet.has(r.child.value) || !classIriSet.has(r.parent.value)) continue;
          edges.push({
            id: `${r.child.value}->${r.parent.value}:sub`,
            source: r.child.value,
            target: r.parent.value,
            label: "subClassOf",
            kind: "subClassOf",
          });
        }

        // Build parent lookup for ancestor BFS.
        const parentsOf = new Map();
        for (const r of subRows) {
          if (!parentsOf.has(r.child.value)) parentsOf.set(r.child.value, new Set());
          parentsOf.get(r.child.value).add(r.parent.value);
        }

        // visibleDescendantsOf[ancestorIri] = [visible class IRIs that descend from it].
        // Used to map inherited property domain/range back to visible class nodes.
        const visibleDescendantsOf = new Map();
        for (const visClass of classIriSet) {
          const visited = new Set();
          const queue = [visClass];
          while (queue.length > 0) {
            const cur = queue.shift();
            if (visited.has(cur)) continue;
            visited.add(cur);
            if (!visibleDescendantsOf.has(cur)) visibleDescendantsOf.set(cur, []);
            visibleDescendantsOf.get(cur).push(visClass);
            for (const p of parentsOf.get(cur) || []) {
              if (!visited.has(p)) queue.push(p);
            }
          }
        }

        const propRows = cachedSelect(
          PREFIXES +
            `
          SELECT ?p ?plabel ?pprefLabel ?domain ?range WHERE {
            ?p a owl:ObjectProperty .
            { ?p rdfs:domain ?domain } UNION { ?p schema:domainIncludes ?domain } UNION { ?p schemas:domainIncludes ?domain }
            { ?p rdfs:range  ?range  } UNION { ?p schema:rangeIncludes  ?range  } UNION { ?p schemas:rangeIncludes  ?range  }
            FILTER(!isBlank(?domain) && !isBlank(?range))
            OPTIONAL { ?p rdfs:label ?plabel }
            OPTIONAL { ?p skos:prefLabel ?pprefLabel }
          } LIMIT ${limit}
        `,
          effectiveScope,
        );

        // Show an objectProperty edge when AT LEAST ONE side (domain or range)
        // has a visible individual class.  If the other side has no visible
        // descendants, add its class node directly so the edge can be drawn.
        // Example: ClassA categorizedBy ClassB — IndividualA a ClassB.
        // ClassA has no individuals but should appear because its range does.
        const propEdgeIdSet = new Set(edges.map((e) => e.id));
        for (const r of propRows) {
          const domainDescendants = visibleDescendantsOf.get(r.domain.value) || [];
          const rangeDescendants = visibleDescendantsOf.get(r.range.value) || [];
          // Skip only when neither side has any connection to a visible individual class.
          if (domainDescendants.length === 0 && rangeDescendants.length === 0) continue;
          // Domain: use visible descendants or add the class node directly.
          let domainSources;
          if (domainDescendants.length > 0) {
            domainSources = domainDescendants;
          } else {
            addNode(r.domain.value, "class", null, classFallbackSrcId);
            domainSources = [r.domain.value];
          }
          // Range: use visible descendants or add the class node directly.
          let rangeTargets;
          if (rangeDescendants.length > 0) {
            rangeTargets = rangeDescendants;
          } else {
            addNode(r.range.value, "class", null, classFallbackSrcId);
            rangeTargets = [r.range.value];
          }
          const label = r.pprefLabel?.value || r.plabel?.value || shortLabel(r.p.value);
          for (const src of domainSources) {
            for (const tgt of rangeTargets) {
              if (src === tgt) continue;
              const edgeId = `${src}->${tgt}:${r.p.value}`;
              if (propEdgeIdSet.has(edgeId)) continue;
              edges.push({ id: edgeId, source: src, target: tgt, label, kind: "objectProperty", iri: r.p.value });
              propEdgeIdSet.add(edgeId);
            }
          }
        }
      }
    }
  }

  if (mode === "properties") {
    const rows = cachedSelect(
      PREFIXES +
        `
      SELECT ?p ?plabel ?pprefLabel ?domain ?range WHERE {
        ?p a owl:ObjectProperty .
        OPTIONAL { ?p rdfs:label ?plabel }
        OPTIONAL { ?p skos:prefLabel ?pprefLabel }
        OPTIONAL { { ?p rdfs:domain ?domain } UNION { ?p schema:domainIncludes ?domain } UNION { ?p schemas:domainIncludes ?domain } }
        OPTIONAL { { ?p rdfs:range  ?range  } UNION { ?p schema:rangeIncludes  ?range  } UNION { ?p schemas:rangeIncludes  ?range  } }
      } LIMIT ${limit}
    `,
      scope,
    );
    for (const r of rows) {
      if (!r.domain || !r.range) continue;
      addNode(r.domain.value, "class");
      addNode(r.range.value, "class");
      edges.push({
        id: `${r.domain.value}->${r.range.value}:${r.p.value}`,
        source: r.domain.value,
        target: r.range.value,
        label: r.pprefLabel?.value || r.plabel?.value || shortLabel(r.p.value),
        kind: "objectProperty",
        iri: r.p.value,
      });
    }
  }

  // ── Label enrichment pass ────────────────────────────────────────────────
  // Nodes added as orphan cross-ontology parents (subClassOf targets) or
  // domain/range references only received a shortLabel because their defining
  // ontology was outside the main query scope.  Search ALL named graphs for
  // their labels; write-graph skos:prefLabel wins, then any prefLabel, then
  // rdfs:label, then the original shortLabel fallback is left unchanged.
  // All nodes with a null sourceOntologyId — these are cross-ontology parents
  // (subClassOf / domain / range targets) that were added without a source tag
  // because they weren't found by the classRows query (e.g. not explicitly
  // typed as owl:Class in their owning graph).  In multi-scope view mode these
  // nodes get hidden by the client's orphan-node check.  Fix: find which scope
  // graph each orphan node is actually declared in and backfill the id.
  const orphanNodes = [...nodes.entries()].filter(([, n]) => !n.sourceOntologyId);
  if (orphanNodes.length > 0 && scopeIds.length > 0) {
    const orphanVals = orphanNodes.map(([iri]) => `<${iri}>`).join(" ");
    const scopeGraphVals = scopeIds.map((id) => `<${graphIriFor(id)}>`).join(" ");
    try {
      // Use ?c ?p ?o (node as subject) rather than ?c a owl:Class — a class
      // referenced only as a rdfs:subClassOf target may not carry an explicit
      // owl:Class declaration, but it will have at least one own triple in its
      // defining ontology (labels, annotations, other subClassOf statements, etc.).
      const orphanGraphRows = cachedSelect(
        `${PREFIXES}
        SELECT DISTINCT ?c ?g WHERE {
          VALUES ?c { ${orphanVals} }
          VALUES ?g { ${scopeGraphVals} }
          GRAPH ?g { ?c ?p ?o }
        }`,
        null,
      );
      for (const r of orphanGraphRows) {
        const iri = r.c?.value;
        const gIri = r.g?.value;
        if (!iri || !gIri || !nodes.has(iri)) continue;
        const node = nodes.get(iri);
        if (!node.sourceOntologyId && gIri.startsWith(GRAPH_IRI_PREFIX)) {
          node.sourceOntologyId = gIri.slice(GRAPH_IRI_PREFIX.length);
        }
      }
    } catch (_err) {
      // Best-effort — non-fatal.
    }
  }

  const needsLabel = [...nodes.entries()].filter(([iri, n]) => n.label === shortLabel(iri));
  if (needsLabel.length > 0) {
    const vals = needsLabel.map(([iri]) => `<${iri}>`).join(" ");

    // null scope → wrapQuery skipped → GRAPH ?g ranges over all named graphs.
    const enrichRows = cachedSelect(
      `${PREFIXES}
      SELECT ?c ?prefLabel ?label WHERE {
        VALUES ?c { ${vals} }
        OPTIONAL { GRAPH ?g  { ?c skos:prefLabel ?prefLabel } }
        OPTIONAL { GRAPH ?g2 { ?c rdfs:label      ?label     } }
      }`,
      null,
    );
    const acc = new Map(); // iri -> { p, l }
    for (const r of enrichRows) {
      const iri = r.c?.value;
      if (!iri || !nodes.has(iri)) continue;
      const e = acc.get(iri) || {};
      if (!e.p && r.prefLabel?.value) e.p = r.prefLabel.value;
      if (!e.l && r.label?.value) e.l = r.label.value;
      acc.set(iri, e);
    }

    // Overlay write-graph prefLabel last so it always wins.
    if (writeGraphIri) {
      const wpRows = cachedSelect(
        `${PREFIXES}
        SELECT ?c ?prefLabel WHERE {
          VALUES ?c { ${vals} }
          GRAPH <${writeGraphIri}> { ?c skos:prefLabel ?prefLabel }
        }`,
        null,
      );
      for (const r of wpRows) {
        const iri = r.c?.value;
        if (iri && r.prefLabel?.value) {
          const e = acc.get(iri) || {};
          e.wp = r.prefLabel.value;
          acc.set(iri, e);
        }
      }
    }

    for (const [iri, { wp, p, l }] of acc) {
      const lbl = wp || p || l;
      if (lbl) nodes.get(iri).label = lbl;
    }
  }

  res.json({
    nodes: [...nodes.values()],
    edges,
    // Inverse pair data sent to the client so it can re-apply isInverse
    // marking after linked-context and other client-side edges are added.
    inversePairs: inverseRows.map((r) => ({ p: r.p.value, inv: r.inv.value })),
  });
});

function shortLabel(iri) {
  if (!iri) return "";
  // Also split on ':' so URN-style IRIs (urn:ns:LocalName) show just LocalName.
  const m = iri.match(/[#/:]([^#/:]+)$/);
  return m ? m[1] : iri;
}

export default router;
