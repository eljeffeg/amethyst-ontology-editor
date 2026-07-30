import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Edit,
  Info,
  Lock,
  MessageSquare,
  MoreVertical,
  Network,
  Plus,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  ANNOTATION_PREDICATE_IRIS,
  AXIOM_PREDICATE_IRIS,
  allowedCharacteristics,
  api,
  OWL_DEPRECATED,
  OWL_DISJOINT_WITH,
  OWL_EQUIVALENT_CLASS,
  OWL_INVERSE_OF,
  PROPERTY_CHARACTERISTIC_IRIS,
  PROPERTY_CHARACTERISTICS,
  predicateLabel,
  RDFS_IS_DEFINED_BY,
  RDFS_SEE_ALSO,
  RDFS_SUB_PROPERTY_OF,
  resourceLabel,
  SKOS_DEFINITION,
  SKOS_PREF_LABEL,
  SKOS_SCOPE_NOTE,
  shortLabel,
  term,
} from "../lib/api.js";
import { BUILTIN_DATATYPES } from "../lib/datatypes.js";
import Comments from "./Comments.jsx";
import { useProject } from "./OntologyPicker.jsx";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const _OWL_PROP_TYPES = new Set([
  "http://www.w3.org/2002/07/owl#ObjectProperty",
  "http://www.w3.org/2002/07/owl#DatatypeProperty",
  "http://www.w3.org/2002/07/owl#AnnotationProperty",
]);

// Predicates whose semantics are symmetric — for these we also filter the
// mirror-direction assertion out of the incoming list, so an axiom only
// appears in the dedicated Axioms row.
const SYMMETRIC_AXIOM_IRIS = new Set([OWL_INVERSE_OF, OWL_EQUIVALENT_CLASS, OWL_DISJOINT_WITH]);

// Predicates rendered in their own dedicated panels; excluded from the raw
// "Advanced assertions" section so each fact appears exactly once.
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const RDFS_COMMENT = "http://www.w3.org/2000/01/rdf-schema#comment";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDFS_DOMAIN_IRI = "http://www.w3.org/2000/01/rdf-schema#domain";
const RDFS_RANGE_IRI = "http://www.w3.org/2000/01/rdf-schema#range";

// Schema.org equivalents for domain/range — both http: and https: variants
// appear in real-world ontologies; treat them identically to rdfs:domain/range.
const SCHEMA_DOMAIN_INCLUDES = "http://schema.org/domainIncludes";
const SCHEMA_RANGE_INCLUDES = "http://schema.org/rangeIncludes";
const SCHEMAS_DOMAIN_INCLUDES = "https://schema.org/domainIncludes";
const SCHEMAS_RANGE_INCLUDES = "https://schema.org/rangeIncludes";

// All predicates that express "this property applies to this class" (domain).
const DOMAIN_PREDICATES = new Set([
  RDFS_DOMAIN_IRI,
  SCHEMA_DOMAIN_INCLUDES,
  SCHEMAS_DOMAIN_INCLUDES,
]);

// All predicates that express "this property points at this class/type" (range).
const RANGE_PREDICATES = new Set([RDFS_RANGE_IRI, SCHEMA_RANGE_INCLUDES, SCHEMAS_RANGE_INCLUDES]);

const SECTION_HANDLED = new Set([
  RDFS_LABEL,
  RDFS_COMMENT,
  RDFS_SUB_CLASS_OF,
  RDFS_DOMAIN_IRI,
  SCHEMA_DOMAIN_INCLUDES,
  SCHEMAS_DOMAIN_INCLUDES,
  RDFS_RANGE_IRI,
  SCHEMA_RANGE_INCLUDES,
  SCHEMAS_RANGE_INCLUDES,
  RDF_TYPE, // rdf:type shown in BasicSection; filtered out of Advanced
  SKOS_PREF_LABEL, // handled in BasicSection — preferred label
  SKOS_DEFINITION, // handled in BasicSection — definition
  SKOS_SCOPE_NOTE, // handled in BasicSection — scope note
]);

// OWL metaclass IRIs that are structural / already shown elsewhere —
// filtered from the type badges in BasicSection so only semantic class
// memberships (e.g. an individual's rdf:type <SomeClass>) appear.
const OWL_METACLASS_IRIS = new Set([
  "http://www.w3.org/2002/07/owl#Class",
  "http://www.w3.org/2002/07/owl#NamedIndividual",
  "http://www.w3.org/2002/07/owl#Ontology",
  "http://www.w3.org/2002/07/owl#ObjectProperty",
  "http://www.w3.org/2002/07/owl#DatatypeProperty",
  "http://www.w3.org/2002/07/owl#AnnotationProperty",
  "http://www.w3.org/2002/07/owl#FunctionalProperty",
  "http://www.w3.org/2002/07/owl#InverseFunctionalProperty",
  "http://www.w3.org/2002/07/owl#TransitiveProperty",
  "http://www.w3.org/2002/07/owl#SymmetricProperty",
  "http://www.w3.org/2002/07/owl#AsymmetricProperty",
  "http://www.w3.org/2002/07/owl#ReflexiveProperty",
  "http://www.w3.org/2002/07/owl#IrreflexiveProperty",
]);

// Persist the Comments panel open/closed state across entity switches and
// across tab navigations (Classes ↔ Properties ↔ Individuals). Each view
// creates its own EntityDetail instance, so without this they'd all start
// in the default-open state and ignore the user's previous choice.
const COMMENTS_VISIBLE_KEY = "ontology-editor:comments-visible";
function readCommentsVisible() {
  try {
    return localStorage.getItem(COMMENTS_VISIBLE_KEY) !== "false";
  } catch {
    return true;
  }
}
function writeCommentsVisible(v) {
  try {
    localStorage.setItem(COMMENTS_VISIBLE_KEY, v ? "true" : "false");
  } catch {}
}

export default function EntityDetail({ iri, kind, onDelete, onUpdate, onClose, compact }) {
  const { writeOntologyId, workspaceMode, currentOntology, currentProject, ontologies } =
    useProject();
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAddTriple, setShowAddTriple] = useState(false);
  const [showComments, setShowComments] = useState(readCommentsVisible);
  // Persist every toggle so the next EntityDetail instance (on a different
  // tab or after re-selecting) opens in the same state.
  useEffect(() => {
    writeCommentsVisible(showComments);
  }, [showComments]);
  const [commentCount, setCommentCount] = useState(null);
  const [infoTopic, setInfoTopic] = useState(null);
  // Blank-node OWL expressions (restrictions, equivalentClass, etc.)
  const [expressions, setExpressions] = useState(null);
  useEffect(() => {
    setExpressions(null);
    api
      .entityExpressions(iri)
      .then(setExpressions)
      .catch(() => {});
  }, [iri]);

  // Ontology-wide candidate lists shared across all pickers (hierarchy,
  // relationships, attributes, domain/range). Loaded once on mount.
  const [classList, setClassList] = useState(null);
  const [propList, setPropList] = useState(null);

  const scrollRef = useRef(null);
  const load = useCallback(() => {
    setLoading(true);
    api
      .entity(iri)
      .then(setData)
      .finally(() => setLoading(false));
  }, [iri]);
  // Silent reload used after mutations – fetches fresh data without
  // triggering the loading overlay, so scroll position is preserved.
  // Returns the Promise so callers can await it before triggering graph updates.
  const reload = useCallback(() => {
    const savedScroll = scrollRef.current?.scrollTop ?? 0;
    return api.entity(iri).then((d) => {
      setData(d);
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = savedScroll;
      });
    });
  }, [iri]);
  useEffect(() => {
    load();
  }, [load]);

  // Fetch how many comments exist for this IRI as a tiny badge.
  useEffect(() => {
    api
      .comments(iri)
      .then((r) => setCommentCount(r.comments.length))
      .catch(() => setCommentCount(null));
  }, [iri]);

  // Load class / property candidate lists once per component mount.
  // Uses visible scope so pickers respect the current workspace visibility.
  useEffect(() => {
    api
      .classes()
      .then((r) => setClassList(r.classes))
      .catch(() => setClassList([]));
    api
      .propertiesAll()
      .then((r) => setPropList(r.properties))
      .catch(() => setPropList([]));
  }, []);

  const del = async () => {
    if (!confirm(`Delete ${shortLabel(iri)} and all its triples?`)) return;
    try {
      await api.deleteEntity(iri);
      onDelete?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const isPropertyKind =
    kind === "object" || kind === "datatype" || kind === "annotation" || kind === "property";
  // owl:Datatype is a subclass of rdfs:Class in OWL 2 — show the same
  // hierarchy, equivalentClass/disjointWith axioms, and annotations sections.
  const isClassKind = kind === "class" || kind === "owl-datatype";

  // Characteristics currently asserted on this property — derived from the
  // outgoing `a owl:*Property` triples so the chip row is always in sync with
  // the store without a second round-trip.
  const characteristics = useMemo(() => {
    if (!isPropertyKind || !data?.outgoing) return [];
    const set = new Set();
    for (const row of data.outgoing) {
      if (row.p?.value !== RDF_TYPE) continue;
      if (row.o?.type !== "uri") continue;
      if (!PROPERTY_CHARACTERISTIC_IRIS.has(row.o.value)) continue;
      const spec = PROPERTY_CHARACTERISTICS.find((c) => c.iri === row.o.value);
      if (spec) set.add(spec.name);
    }
    return [...set];
  }, [data, isPropertyKind]);

  // Current axiom targets per predicate. For symmetric predicates we union
  // outgoing <iri> <p> ?t with incoming ?t <p> <iri> so the row reflects the
  // full semantic set regardless of which direction the triple was asserted.
  const axiomTargets = useMemo(() => {
    const out = {
      [OWL_INVERSE_OF]: new Set(),
      [RDFS_SUB_PROPERTY_OF]: new Set(),
      [OWL_EQUIVALENT_CLASS]: new Set(),
      [OWL_DISJOINT_WITH]: new Set(),
    };
    if (!data) return out;
    for (const r of data.outgoing || []) {
      const p = r.p?.value;
      if (!AXIOM_PREDICATE_IRIS.has(p)) continue;
      if (r.o?.type !== "uri") continue;
      if (r.o.value === iri) continue;
      out[p].add(r.o.value);
    }
    for (const r of data.incoming || []) {
      const p = r.p?.value;
      if (!SYMMETRIC_AXIOM_IRIS.has(p)) continue;
      if (r.s?.value === iri) continue;
      out[p].add(r.s.value);
    }
    // Convert to arrays for stable rendering.
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
  }, [data, iri]);

  // Current annotation targets per predicate. Unlike axioms these are all
  // directional (only ever read from outgoing triples). seeAlso/isDefinedBy
  // carry IRI objects; deprecated is a boolean literal we normalize down to a
  // single true/false flag.
  const annotationTargets = useMemo(() => {
    const out = { [RDFS_SEE_ALSO]: [], [RDFS_IS_DEFINED_BY]: [] };
    if (!data?.outgoing) return out;
    for (const r of data.outgoing) {
      const p = r.p?.value;
      if (p !== RDFS_SEE_ALSO && p !== RDFS_IS_DEFINED_BY) continue;
      // seeAlso/isDefinedBy are defined to take an IRI in OWL 2 — we ignore
      // stray literals rather than let them round-trip through the PUT
      // endpoint (which would reject them anyway).
      if (r.o?.type !== "uri") continue;
      if (!out[p].includes(r.o.value)) out[p].push(r.o.value);
    }
    return out;
  }, [data]);

  const deprecated = useMemo(() => {
    if (!data?.outgoing) return false;
    for (const r of data.outgoing) {
      if (r.p?.value !== OWL_DEPRECATED) continue;
      if (r.o?.type !== "literal") continue;
      const v = (r.o.value || "").toString().toLowerCase();
      if (v === "true" || v === "1") return true;
    }
    return false;
  }, [data]);

  // Resolve the ontology name for the entity being displayed.
  // Uses sourceOntologyIds from the loaded entity data to find the actual
  // owning ontology, falling back to the write-target ontology name.
  const entityOntologyName = useMemo(() => {
    if (!data?.sourceOntologyIds || !ontologies?.length) return currentOntology?.name || null;
    for (const sid of data.sourceOntologyIds) {
      const onto = ontologies.find((o) => o.id === sid);
      if (onto) return onto.name;
    }
    return currentOntology?.name || null;
  }, [data, ontologies, currentOntology]);

  // In workspace mode, an entity is "read-only" if all its triples live in
  // ontologies that are not the designated write target.  Deletion is blocked;
  // add/edit operations still write to the write ontology and remain available.
  const entityIsReadOnly = useMemo(() => {
    const sources = data?.sourceOntologyIds;
    if (!sources || sources.length === 0) return false;
    // Imported (owl:imports) ontologies are always read-only regardless of workspace mode.
    const isImportedSource = sources.some((sid) => {
      const onto = ontologies.find((o) => String(o.id) === String(sid));
      return !!onto?.is_imported && !onto?.branch_of;
    });
    if (isImportedSource) return true;
    // In workspace mode, also read-only if all sources are outside the write target.
    if (!workspaceMode) return false;
    return !sources.includes(writeOntologyId);
  }, [workspaceMode, data, writeOntologyId, ontologies]);

  // ── Derived data for the section-based layout ─────────────────────────────

  // Primary label: prefer skos:prefLabel, fall back to rdfs:label.
  // Returns { value, language, predicate } so saveLabel knows which triple to update.
  const currentLabel = useMemo(() => {
    if (!data?.outgoing) return null;
    const prefRow = data.outgoing.find(
      (r) => r.p?.value === SKOS_PREF_LABEL && r.o?.type === "literal",
    );
    if (prefRow)
      return {
        value: prefRow.o.value,
        language: prefRow.o.language || "",
        predicate: SKOS_PREF_LABEL,
      };
    const labelRow = data.outgoing.find(
      (r) => r.p?.value === RDFS_LABEL && r.o?.type === "literal",
    );
    return labelRow
      ? {
          value: labelRow.o.value,
          language: labelRow.o.language || "",
          predicate: RDFS_LABEL,
        }
      : null;
  }, [data]);

  // skos:definition — formal definition of the entity.
  const currentDefinition = useMemo(() => {
    if (!data?.outgoing) return null;
    const row = data.outgoing.find(
      (r) => r.p?.value === SKOS_DEFINITION && r.o?.type === "literal",
    );
    return row
      ? { value: row.o.value, language: row.o.language || "", predicate: SKOS_DEFINITION }
      : null;
  }, [data]);

  // rdfs:comment — editorial note / general comment.
  const currentComment = useMemo(() => {
    if (!data?.outgoing) return null;
    const row = data.outgoing.find((r) => r.p?.value === RDFS_COMMENT && r.o?.type === "literal");
    return row
      ? { value: row.o.value, language: row.o.language || "", predicate: RDFS_COMMENT }
      : null;
  }, [data]);

  // skos:scopeNote — note clarifying the intended scope of the entity.
  const currentScopeNote = useMemo(() => {
    if (!data?.outgoing) return null;
    const row = data.outgoing.find(
      (r) => r.p?.value === SKOS_SCOPE_NOTE && r.o?.type === "literal",
    );
    return row
      ? { value: row.o.value, language: row.o.language || "", predicate: SKOS_SCOPE_NOTE }
      : null;
  }, [data]);

  // Parent classes: outgoing rdfs:subClassOf (class entities only).
  // Deduplicate: in union/all-ontology mode the same triple may appear in
  // multiple named graphs and be returned more than once by the entity query.
  const parentClassIris = useMemo(() => {
    if (!isClassKind || !data?.outgoing) return [];
    return [
      ...new Set(
        data.outgoing
          .filter((r) => r.p?.value === RDFS_SUB_CLASS_OF && r.o?.type === "uri")
          .map((r) => r.o.value),
      ),
    ];
  }, [data, isClassKind]);

  // Set of predicate+object value keys present in the write graph only.
  // Null when write-specific data isn't available (single-ontology mode).
  const writeOutgoingSet = useMemo(() => {
    if (!data?.writeOutgoing) return null;
    return new Set(
      data.writeOutgoing.map((r) => `${r.p?.value}\x00${r.o?.value || r.o}`).filter(Boolean),
    );
  }, [data]);

  // Parent class IRIs whose subClassOf triple exists ONLY in a linked/imported
  // ontology — not in the write graph. These cannot be deleted from this view.
  const linkedOnlyParentIris = useMemo(() => {
    if (!writeOutgoingSet) return new Set();
    return new Set(
      parentClassIris.filter((iri) => !writeOutgoingSet.has(`${RDFS_SUB_CLASS_OF}\x00${iri}`)),
    );
  }, [parentClassIris, writeOutgoingSet]);

  // Child classes: incoming rdfs:subClassOf pointing at this class.
  // Deduplicated for the same reason as parentClassIris.
  const childClassIris = useMemo(() => {
    if (!isClassKind || !data?.incoming) return [];
    return [
      ...new Set(
        data.incoming
          .filter((r) => r.p?.value === RDFS_SUB_CLASS_OF && r.s?.type === "uri")
          .map((r) => r.s.value),
      ),
    ];
  }, [data, isClassKind]);

  // Domain IRIs declared on a property entity (outgoing domain predicates —
  // handles rdfs:domain and all schema.org domainIncludes variants).
  // Deduplicated for the same reason as parentClassIris.
  const domainIris = useMemo(() => {
    if (!isPropertyKind || !data?.outgoing) return [];
    return [
      ...new Set(
        data.outgoing
          .filter((r) => DOMAIN_PREDICATES.has(r.p?.value) && r.o?.type === "uri")
          .map((r) => r.o.value),
      ),
    ];
  }, [data, isPropertyKind]);

  // Range IRIs declared on a property entity (outgoing range predicates).
  // Deduplicated for the same reason as parentClassIris.
  const rangeIris = useMemo(() => {
    if (!isPropertyKind || !data?.outgoing) return [];
    return [
      ...new Set(
        data.outgoing
          .filter((r) => RANGE_PREDICATES.has(r.p?.value) && r.o?.type === "uri")
          .map((r) => r.o.value),
      ),
    ];
  }, [data, isPropertyKind]);

  // IRI → property record lookup built from the loaded property list.
  const propMap = useMemo(() => {
    const m = new Map();
    for (const p of propList || []) {
      const pi = p.iri?.value;
      if (pi) m.set(pi, p);
    }
    return m;
  }, [propList]);

  // For class entities: split incoming domain triples by property kind.
  // Handles rdfs:domain and schema.org domainIncludes (http + https).
  const { relationshipProps, attributeProps } = useMemo(() => {
    if (!isClassKind || !data?.incoming) return { relationshipProps: [], attributeProps: [] };
    const rel = [],
      attr = [];
    // Track which property IRIs we've already added to avoid duplicates when
    // multiple domain predicates point to the same property.
    const seen = new Set();
    for (const r of data.incoming) {
      if (!DOMAIN_PREDICATES.has(r.p?.value) || r.s?.type !== "uri") continue;
      if (seen.has(r.s.value)) continue;
      const prop = propMap.get(r.s.value);
      if (!prop) continue;
      seen.add(r.s.value);
      const k = prop.kind?.value;
      if (k === "object") rel.push(prop);
      else if (k === "datatype") attr.push(prop);
    }
    return { relationshipProps: rel, attributeProps: attr };
  }, [data, isClassKind, propMap]);

  // Full transitive ancestor set — used by both inherited attributes and relationships.
  const ancestorClassIris = useMemo(() => {
    if (!isClassKind || !classList || parentClassIris.length === 0) return new Set();
    const parentOf = new Map();
    const equivsOf = new Map();
    for (const c of classList) {
      const ci = c.iri?.value;
      if (!ci) continue;
      if (Array.isArray(c.parents)) parentOf.set(ci, c.parents);
      // Also collect each class's equivalents so we can follow them during
      // the ancestor BFS.  This makes properties defined on an equivalent
      // class visible as inherited properties for all subclasses of the
      // class that declared owl:equivalentClass.
      if (Array.isArray(c.equivalents)) equivsOf.set(ci, c.equivalents);
    }
    const ancestors = new Set();
    const queue = [...parentClassIris];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (ancestors.has(cur) || cur === iri) continue;
      ancestors.add(cur);
      // Walk subClassOf parents.
      for (const p of parentOf.get(cur) || []) {
        if (!ancestors.has(p) && p !== iri) queue.push(p);
      }
      // Also expand through equivalentClass targets of each ancestor so that
      // properties whose domain is an equivalent class propagate to children.
      for (const e of equivsOf.get(cur) || []) {
        if (!ancestors.has(e) && e !== iri) queue.push(e);
      }
    }
    return ancestors;
  }, [isClassKind, classList, parentClassIris, iri]);

  // Equivalent classes (direct owl:equivalentClass targets) plus their transitive
  // parent classes. Properties whose domain is any of these IRIs are surfaced in
  // the "Inherited" section just like properties inherited from subClassOf parents,
  // because owl:equivalentClass implies mutual subclassing in OWL semantics.
  const equivalentClassAncestorIris = useMemo(() => {
    const equivTargets = axiomTargets[OWL_EQUIVALENT_CLASS] || [];
    if (!isClassKind || !classList || equivTargets.length === 0) return new Set();
    const parentOf = new Map();
    for (const c of classList) {
      const ci = c.iri?.value;
      if (ci && Array.isArray(c.parents)) parentOf.set(ci, c.parents);
    }
    const visited = new Set();
    const queue = [...equivTargets];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (visited.has(cur) || cur === iri) continue;
      visited.add(cur);
      for (const p of parentOf.get(cur) || []) {
        if (!visited.has(p) && p !== iri) queue.push(p);
      }
    }
    return visited;
  }, [isClassKind, classList, axiomTargets, iri]);

  const inheritedAttributeProps = useMemo(() => {
    if (
      !isClassKind ||
      !propList ||
      (ancestorClassIris.size === 0 && equivalentClassAncestorIris.size === 0)
    )
      return [];
    const directAttrIris = new Set(attributeProps.map((p) => p.iri?.value));
    const seen = new Set();
    const props = [];
    for (const p of propList) {
      if (p.kind?.value !== "datatype") continue;
      // Use the full domains array when available (server returns all declared
      // domains); fall back to the single domain field for backward compat.
      const allDomains =
        Array.isArray(p.domains) && p.domains.length > 0
          ? p.domains
          : p.domain?.value
            ? [p.domain.value]
            : [];
      if (!allDomains.some((d) => ancestorClassIris.has(d) || equivalentClassAncestorIris.has(d)))
        continue;
      if (directAttrIris.has(p.iri?.value)) continue;
      if (seen.has(p.iri?.value)) continue;
      seen.add(p.iri?.value);
      props.push(p);
    }
    return props;
  }, [isClassKind, propList, ancestorClassIris, equivalentClassAncestorIris, attributeProps]);

  // Inherited relationships: object properties whose domain OR range is any
  // ancestor class or any equivalent class (and their ancestors).
  //
  // Outgoing inherited:  ancestor is the domain  → this class can USE the property
  // Incoming inherited:  ancestor is the range   → this class can be POINTED AT by the property
  //
  // Each entry carries an `inheritedDirection` field ("outgoing" | "incoming")
  // so the row component can render the appropriate arrow.
  const inheritedRelationshipProps = useMemo(() => {
    if (
      !isClassKind ||
      !propList ||
      (ancestorClassIris.size === 0 && equivalentClassAncestorIris.size === 0)
    )
      return [];
    const allAncestors = new Set([...ancestorClassIris, ...equivalentClassAncestorIris]);
    // Properties already shown as direct outgoing or range-of sections.
    const directRelIris = new Set(relationshipProps.map((p) => p.iri?.value));
    const seen = new Set();
    const props = [];
    for (const p of propList) {
      if (p.kind?.value !== "object") continue;
      const propIri = p.iri?.value;
      if (!propIri) continue;
      // ── Outgoing: ancestor is the domain ─────────────────────────────────
      const allDomains =
        Array.isArray(p.domains) && p.domains.length > 0
          ? p.domains
          : p.domain?.value
            ? [p.domain.value]
            : [];
      const isInheritedOutgoing = allDomains.some((d) => allAncestors.has(d));
      // ── Incoming: ancestor is the range ──────────────────────────────────
      const allRanges =
        Array.isArray(p.ranges) && p.ranges.length > 0
          ? p.ranges
          : p.range?.value
            ? [p.range.value]
            : [];
      const isInheritedIncoming = allRanges.some((r) => allAncestors.has(r));
      if (!isInheritedOutgoing && !isInheritedIncoming) continue;
      if (directRelIris.has(propIri)) continue;
      if (seen.has(propIri)) continue;
      seen.add(propIri);
      // When both apply (ancestor is both domain and range), prefer outgoing.
      const inheritedDirection =
        isInheritedIncoming && !isInheritedOutgoing ? "incoming" : "outgoing";
      props.push({ ...p, inheritedDirection });
    }
    return props;
  }, [isClassKind, propList, ancestorClassIris, equivalentClassAncestorIris, relationshipProps]);

  // Properties that declare this class as their rdfs:range (or schema rangeIncludes).
  // These show in a "Range of" section; filtered from Advanced assertions.
  const rangeOfProps = useMemo(() => {
    if (!isClassKind || !data?.incoming) return [];
    const seen = new Set();
    const props = [];
    for (const r of data.incoming) {
      if (!RANGE_PREDICATES.has(r.p?.value) || r.s?.type !== "uri") continue;
      if (seen.has(r.s.value)) continue;
      const prop = propMap.get(r.s.value);
      if (!prop) continue;
      seen.add(r.s.value);
      props.push(prop);
    }
    return props;
  }, [data, isClassKind, propMap]);

  // Non-metaclass rdf:type values shown as badges in BasicSection.
  const typeAssertions = useMemo(() => {
    if (!data?.outgoing) return [];
    return data.outgoing
      .filter(
        (r) => r.p?.value === RDF_TYPE && r.o?.type === "uri" && !OWL_METACLASS_IRIS.has(r.o.value),
      )
      .map((r) => r.o.value);
  }, [data]);

  // Assertions shown in the Advanced (collapsed) section. rdf:type and all
  // other section-handled predicates are excluded since they appear elsewhere.
  const outgoingDisplay = useMemo(() => {
    if (!data?.outgoing) return [];
    return data.outgoing.filter((r) => {
      if (AXIOM_PREDICATE_IRIS.has(r.p?.value)) return false;
      if (ANNOTATION_PREDICATE_IRIS.has(r.p?.value)) return false;
      if (SECTION_HANDLED.has(r.p?.value)) return false;
      return true;
    });
  }, [data]);

  const incomingDisplay = useMemo(() => {
    if (!data?.incoming) return [];
    return data.incoming.filter((r) => {
      if (SYMMETRIC_AXIOM_IRIS.has(r.p?.value)) return false;
      if (isClassKind && r.p?.value === RDFS_SUB_CLASS_OF) return false;
      // Filter all domain-style predicates (rdfs:domain + schema.org variants)
      if (isClassKind && DOMAIN_PREDICATES.has(r.p?.value)) return false;
      // Filter range predicates — shown in the "Range of" section instead
      if (isClassKind && RANGE_PREDICATES.has(r.p?.value)) return false;
      return true;
    });
  }, [data, isClassKind]);

  const toggleCharacteristic = async (name) => {
    const next = characteristics.includes(name)
      ? characteristics.filter((n) => n !== name)
      : [...characteristics, name];
    try {
      await api.setPropertyCharacteristics(iri, kind, next);
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const setAxiomTargets = async (predicate, nextTargets) => {
    try {
      await api.setRelations(iri, predicate, nextTargets);
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const setAnnotationTargets = async (predicate, nextTargets) => {
    try {
      await api.setRelations(iri, predicate, nextTargets);
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const toggleDeprecated = async (next) => {
    try {
      await api.setDeprecated(iri, next);
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  // Replace an individual's class memberships (rdf:type triples, excluding
  // owl:NamedIndividual and other OWL metaclasses). Diffs current vs. desired
  // and issues add/delete triple calls — /relations doesn't whitelist rdf:type.
  const setIndividualClasses = async (nextClassIris) => {
    const current = new Set(typeAssertions);
    const desired = new Set(nextClassIris);
    const toAdd = [...desired].filter((c) => !current.has(c));
    const toRemove = [...current].filter((c) => !desired.has(c));
    try {
      for (const c of toRemove) {
        await api.deleteTriple({ s: iri, p: RDF_TYPE, o: c, objectKind: "uri" });
      }
      for (const c of toAdd) {
        await api.addTriple({ s: iri, p: RDF_TYPE, o: c, objectKind: "uri" });
      }
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  /** Reload just the OWL expressions panel without a full entity reload. */
  const reloadExpressions = useCallback(() => {
    setExpressions(null);
    api
      .entityExpressions(iri)
      .then(setExpressions)
      .catch(() => {});
  }, [iri]);

  /** Delete a blank-node expression (restriction, equivalentClass, etc.) by BFS removal. */
  const deleteExpression = useCallback(
    async (predicate, bnodeId) => {
      try {
        await api.deleteExpression({ iri, predicate, bnodeId });
        reloadExpressions();
        onUpdate?.();
      } catch (e) {
        alert(e.message);
      }
    },
    [iri, reloadExpressions, onUpdate],
  );

  // ── New handlers ──────────────────────────────────────────────────────────

  const saveLabel = async (newVal) => {
    // Save to whichever predicate the label currently lives in, defaulting to rdfs:label.
    const targetPred = currentLabel?.predicate ?? RDFS_LABEL;
    try {
      if (currentLabel)
        await api.deleteTriple({
          s: iri,
          p: targetPred,
          o: currentLabel.value,
          objectKind: "literal",
          language: currentLabel.language || undefined,
        });
      // Only add the new triple when a non-empty value was provided.
      if (newVal.trim())
        await api.addTriple({
          s: iri,
          p: targetPred,
          o: newVal.trim(),
          objectKind: "literal",
          language: "en",
        });
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const saveDefinition = async (newVal) => {
    try {
      if (currentDefinition)
        await api.deleteTriple({
          s: iri,
          p: SKOS_DEFINITION,
          o: currentDefinition.value,
          objectKind: "literal",
          language: currentDefinition.language || undefined,
        });
      if (newVal.trim())
        await api.addTriple({
          s: iri,
          p: SKOS_DEFINITION,
          o: newVal.trim(),
          objectKind: "literal",
          language: "en",
        });
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const saveComment = async (newVal) => {
    try {
      if (currentComment)
        await api.deleteTriple({
          s: iri,
          p: RDFS_COMMENT,
          o: currentComment.value,
          objectKind: "literal",
          language: currentComment.language || undefined,
        });
      if (newVal.trim())
        await api.addTriple({
          s: iri,
          p: RDFS_COMMENT,
          o: newVal.trim(),
          objectKind: "literal",
          language: "en",
        });
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const saveScopeNote = async (newVal) => {
    try {
      if (currentScopeNote)
        await api.deleteTriple({
          s: iri,
          p: SKOS_SCOPE_NOTE,
          o: currentScopeNote.value,
          objectKind: "literal",
          language: currentScopeNote.language || undefined,
        });
      if (newVal.trim())
        await api.addTriple({
          s: iri,
          p: SKOS_SCOPE_NOTE,
          o: newVal.trim(),
          objectKind: "literal",
          language: "en",
        });
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const addParentClass = async (targetIri) => {
    try {
      await api.addTriple({
        s: iri,
        p: RDFS_SUB_CLASS_OF,
        o: targetIri,
        objectKind: "uri",
      });
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const removeParentClass = async (targetIri) => {
    try {
      await api.deleteTriple({
        s: iri,
        p: RDFS_SUB_CLASS_OF,
        o: targetIri,
        objectKind: "uri",
      });
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  // Adding a child means asserting rdfs:subClassOf <this class> on the child.
  const addChildClass = async (childIri) => {
    try {
      await api.addTriple({
        s: childIri,
        p: RDFS_SUB_CLASS_OF,
        o: iri,
        objectKind: "uri",
      });
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const removeChildClass = async (childIri) => {
    try {
      await api.deleteTriple({
        s: childIri,
        p: RDFS_SUB_CLASS_OF,
        o: iri,
        objectKind: "uri",
      });
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const linkPropDomain = async (propIri) => {
    try {
      await api.addTriple({
        s: propIri,
        p: RDFS_DOMAIN_IRI,
        o: iri,
        objectKind: "uri",
      });
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const unlinkPropDomain = async (propIri) => {
    try {
      await api.deleteTriple({
        s: propIri,
        p: RDFS_DOMAIN_IRI,
        o: iri,
        objectKind: "uri",
      });
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const linkPropRange = async (propIri) => {
    try {
      await api.addTriple({
        s: propIri,
        p: RDFS_RANGE_IRI,
        o: iri,
        objectKind: "uri",
      });
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const unlinkPropRange = async (propIri) => {
    try {
      // Remove all range-predicate variants pointing to this class
      for (const pred of RANGE_PREDICATES) {
        try {
          await api.deleteTriple({
            s: propIri,
            p: pred,
            o: iri,
            objectKind: "uri",
          });
        } catch {}
      }
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const _applyIriSet = async (subject, predicate, current, next) => {
    const cur = new Set(current),
      nxt = new Set(next);
    for (const t of nxt)
      if (!cur.has(t))
        await api.addTriple({
          s: subject,
          p: predicate,
          o: t,
          objectKind: "uri",
        });
    for (const t of cur)
      if (!nxt.has(t))
        await api.deleteTriple({
          s: subject,
          p: predicate,
          o: t,
          objectKind: "uri",
        });
  };

  // Always write new domain/range assertions as standard rdfs:domain/rdfs:range.
  // Deletions cover all variants so schema.org triples get cleaned up too.
  const setDomainTargets = async (nextTargets) => {
    try {
      const cur = new Set(domainIris),
        nxt = new Set(nextTargets);
      for (const t of nxt)
        if (!cur.has(t))
          await api.addTriple({
            s: iri,
            p: RDFS_DOMAIN_IRI,
            o: t,
            objectKind: "uri",
          });
      // Remove from all domain predicate variants
      for (const t of cur) {
        if (nxt.has(t)) continue;
        for (const pred of DOMAIN_PREDICATES) {
          try {
            await api.deleteTriple({
              s: iri,
              p: pred,
              o: t,
              objectKind: "uri",
            });
          } catch {}
        }
      }
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const setRangeTargets = async (nextTargets) => {
    try {
      const cur = new Set(rangeIris),
        nxt = new Set(nextTargets);
      for (const t of nxt)
        if (!cur.has(t))
          await api.addTriple({
            s: iri,
            p: RDFS_RANGE_IRI,
            o: t,
            objectKind: "uri",
          });
      for (const t of cur) {
        if (nxt.has(t)) continue;
        for (const pred of RANGE_PREDICATES) {
          try {
            await api.deleteTriple({
              s: iri,
              p: pred,
              o: t,
              objectKind: "uri",
            });
          } catch {}
        }
      }
      reload();
      onUpdate?.();
    } catch (e) {
      alert(e.message);
    }
  };

  // Rename the entity IRI. All triples referencing the old IRI (as subject or
  // object) in the write ontology are rewritten to use the new IRI in a single
  // server-side SPARQL Update. After success the URL hash is updated so the
  // parent view re-selects the entity at its new address.
  const saveIri = async (newIri) => {
    const trimmed = newIri.trim();
    if (!trimmed || trimmed === iri) return;
    try {
      await api.renameEntityIri(iri, trimmed);
      onUpdate?.();
      // Navigate to the same view page with the new IRI so the detail panel
      // stays open without a full reload. Replace so Back-button stays clean.
      navigate(`${location.pathname}#iri=${encodeURIComponent(trimmed)}`, { replace: true });
    } catch (e) {
      alert(e.message);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 min-w-0 overflow-auto" ref={scrollRef}>
        <div className="p-5 space-y-4">
          {/* Page header — label + kind badge + IRI + action buttons */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2
                  className={`text-base font-semibold text-slate-100 truncate ${deprecated ? "line-through text-slate-400" : ""}`}
                >
                  {currentLabel?.value || shortLabel(iri)}
                </h2>
                {deprecated && (
                  <span
                    className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] tracking-normal font-semibold normal-case"
                    title="Marked with owl:deprecated"
                  >
                    Deprecated
                  </span>
                )}
                {entityIsReadOnly && (
                  <span
                    className="px-1.5 py-0.5 rounded-full bg-slate-700/50 text-slate-400 border border-slate-600/50 text-[10px] tracking-normal font-medium normal-case flex items-center gap-1"
                    title="This entity's triples live in a read-only ontology. Switch the write target to delete it. You can still add new triples about it in the writable ontology."
                  >
                    <Lock size={9} strokeWidth={2.5} aria-hidden="true" />
                    Read-only
                  </span>
                )}
                {!entityIsReadOnly && (
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 tracking-wide">
                    writeable
                  </span>
                )}
                {entityOntologyName && (
                  <span className="shrink-0 text-[10px] text-slate-500">
                    from: {entityOntologyName}
                  </span>
                )}
              </div>
              <div
                className={`text-[11px] font-mono text-slate-500 mt-0.5 truncate ${deprecated ? "line-through" : ""}`}
              >
                {iri}
              </div>
            </div>
            <div className="flex gap-2 shrink-0 items-center">
              {compact ? (
                <>
                  <EntityKebabMenu
                    iri={iri}
                    kind={kind}
                    onDelete={del}
                    deleteDisabled={entityIsReadOnly}
                  />
                  {onClose && (
                    <button
                      type="button"
                      className="btn-ghost p-1"
                      onClick={onClose}
                      title="Close panel"
                      aria-label="Close panel"
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={`btn-danger${entityIsReadOnly ? " opacity-40 cursor-not-allowed" : ""}`}
                    onClick={del}
                    disabled={entityIsReadOnly}
                    title={
                      entityIsReadOnly
                        ? "This entity is defined in a read-only ontology. Switch the write target to delete it."
                        : undefined
                    }
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="btn p-2.25"
                    onClick={() => navigate(`/#iri=${encodeURIComponent(iri)}`)}
                    title="View in graph"
                    aria-label="View in graph"
                  >
                    <Network size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setShowComments((s) => !s)}
                    title="Toggle comments"
                  >
                    <MessageSquare size={14} aria-hidden="true" />
                    Comments
                    {commentCount ? <span className="chip">{commentCount}</span> : null}
                  </button>
                </>
              )}
            </div>
          </div>

          {loading ? (
            <div className="text-slate-500 text-sm">Loading…</div>
          ) : (
            <>
              {/* ── Basic: inline-editable name + description ── */}
              <BasicSection
                label={currentLabel}
                definition={currentDefinition}
                comment={currentComment}
                scopeNote={currentScopeNote}
                iri={iri}
                shortName={shortLabel(iri)}
                deprecated={deprecated}
                typeAssertions={kind === "individual" ? [] : typeAssertions}
                datatypeRange={kind === "datatype" ? rangeIris : []}
                onSetDatatypeRange={kind === "datatype" ? setRangeTargets : undefined}
                onSaveLabel={saveLabel}
                onSaveDefinition={saveDefinition}
                onSaveComment={saveComment}
                onSaveScopeNote={saveScopeNote}
                onSaveIri={saveIri}
                readOnly={entityIsReadOnly}
              />

              {/* ── Classes (individual only): editable rdf:type memberships ── */}
              {kind === "individual" && (
                <IndividualClassesSection
                  typeAssertions={typeAssertions}
                  classList={classList}
                  onSetClasses={setIndividualClasses}
                  readOnly={entityIsReadOnly}
                />
              )}

              {/* ── Hierarchy: parent / child classes ── */}
              {isClassKind && (
                <HierarchySection
                  iri={iri}
                  parentClassIris={parentClassIris}
                  childClassIris={childClassIris}
                  classList={classList}
                  ancestorClassIris={ancestorClassIris}
                  linkedOnlyParentIris={linkedOnlyParentIris}
                  onAddParent={addParentClass}
                  onRemoveParent={removeParentClass}
                  onAddChild={addChildClass}
                  onRemoveChild={removeChildClass}
                  entityIsReadOnly={entityIsReadOnly}
                />
              )}

              {/* ── Relationships: object properties with domain = this class ── */}
              {isClassKind && (
                <PropertyDomainSection
                  sectionTitle={term("ObjectPropertyPlural")}
                  sectionNote={`Source (domain) and target (range)`}
                  iconKind="arrow"
                  propKind="object"
                  props={relationshipProps}
                  rangeProps={rangeOfProps}
                  inheritedProps={inheritedRelationshipProps}
                  equivalentAncestorIris={equivalentClassAncestorIris}
                  allProps={propList}
                  onAdd={linkPropDomain}
                  onRemove={unlinkPropDomain}
                  onAddRange={linkPropRange}
                  onRemoveRange={unlinkPropRange}
                  readOnly={entityIsReadOnly}
                />
              )}

              {/* ── Attributes: datatype properties with domain = this class ── */}
              {isClassKind && (
                <PropertyDomainSection
                  sectionTitle={term("DatatypePropertyPlural")}
                  sectionNote={`${term("DatatypeProperty")}s with this ${term("Class").toLowerCase()} as ${term("domain").toLowerCase()}`}
                  iconKind="tag"
                  propKind="datatype"
                  props={attributeProps}
                  inheritedProps={inheritedAttributeProps}
                  equivalentAncestorIris={equivalentClassAncestorIris}
                  allProps={propList}
                  onAdd={linkPropDomain}
                  onRemove={unlinkPropDomain}
                  readOnly={entityIsReadOnly}
                />
              )}

              {/* ── Associated Classes (property entities): domain + range for object props ── */}
              {isPropertyKind && (
                <DomainRangeSection
                  kind={kind}
                  domainIris={domainIris}
                  rangeIris={rangeIris}
                  classList={classList}
                  onSetDomain={setDomainTargets}
                  onSetRange={setRangeTargets}
                  readOnly={entityIsReadOnly}
                />
              )}

              {/* ── Characteristics (properties only, below Associated Classes) ── */}
              {isPropertyKind && (
                <CharacteristicsRow
                  kind={kind}
                  active={characteristics}
                  onToggle={toggleCharacteristic}
                  readOnly={entityIsReadOnly}
                />
              )}

              {/* ── Axioms ── */}
              {(isPropertyKind || isClassKind) && (
                <AxiomsSection
                  iri={iri}
                  kind={kind}
                  targets={axiomTargets}
                  onSetTargets={setAxiomTargets}
                  onInfo={() => setInfoTopic("axioms")}
                  ancestorClassIris={isClassKind ? ancestorClassIris : undefined}
                  classList={isClassKind ? classList : undefined}
                  readOnly={entityIsReadOnly}
                />
              )}

              {/* ── OWL Expressions: blank-node restrictions, equivalentClass, etc. ── */}
              {isClassKind && (
                <OWLExpressionsSection
                  iri={iri}
                  topLevel={expressions?.topLevel || []}
                  bnodeMap={expressions?.bnodeMap || {}}
                  loading={expressions === null}
                  onDeleteExpression={deleteExpression}
                  onAdded={() => {
                    reloadExpressions();
                    onUpdate?.();
                  }}
                  propList={propList}
                  classList={classList}
                  entityIsReadOnly={entityIsReadOnly}
                />
              )}

              {/* ── Annotations ── */}
              <AnnotationsSection
                kind={kind}
                targets={annotationTargets}
                deprecated={deprecated}
                onSetTargets={setAnnotationTargets}
                onToggleDeprecated={toggleDeprecated}
                onInfo={() => setInfoTopic("annotations")}
                readOnly={entityIsReadOnly}
              />

              {/* ── Advanced: collapsible raw assertions + Add button ── */}
              <AdvancedSection
                outgoing={outgoingDisplay}
                incoming={incomingDisplay}
                defaultOpen={kind === "individual"}
                iri={iri}
                onAdd={() => setShowAddTriple(true)}
                onDeleteOutgoing={async (r) => {
                  await api.deleteTriple({
                    s: iri,
                    p: r.p.value,
                    o: r.o.value,
                    objectKind: r.o.type === "literal" ? "literal" : "uri",
                    datatype: r.o.datatype,
                    language: r.o.language,
                  });
                  reload();
                  onUpdate?.();
                }}
                onInfoOutgoing={() => setInfoTopic("outgoing")}
                onInfoIncoming={() => setInfoTopic("incoming")}
                readOnly={entityIsReadOnly}
              />
            </>
          )}
        </div>

        {showAddTriple && (
          <AddTripleModal
            iri={iri}
            onClose={() => setShowAddTriple(false)}
            onAdded={() => {
              setShowAddTriple(false);
              reload();
              onUpdate?.();
            }}
          />
        )}
        {infoTopic === "outgoing" && (
          <AssertionInfoModal kind={kind} direction="outgoing" onClose={() => setInfoTopic(null)} />
        )}
        {infoTopic === "incoming" && (
          <AssertionInfoModal kind={kind} direction="incoming" onClose={() => setInfoTopic(null)} />
        )}
        {infoTopic === "axioms" && (
          <AxiomsInfoModal kind={kind} onClose={() => setInfoTopic(null)} />
        )}
        {infoTopic === "annotations" && (
          <AnnotationsInfoModal kind={kind} onClose={() => setInfoTopic(null)} />
        )}
      </div>
      {showComments && !compact && (
        <Comments
          targetIri={iri}
          title={`Comments on ${shortLabel(iri)}`}
          projectGithubRepo={currentProject?.github_repo}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BasicSection — inline-editable name and description
// ═══════════════════════════════════════════════════════════════════════════
function BasicSection({
  label,
  definition,
  comment,
  scopeNote,
  iri,
  shortName,
  deprecated,
  typeAssertions,
  datatypeRange,
  onSetDatatypeRange,
  onSaveLabel,
  onSaveDefinition,
  onSaveComment,
  onSaveScopeNote,
  onSaveIri,
  readOnly,
}) {
  return (
    <section className="panel">
      <header className="px-4 py-2 border-b border-ink-700 text-xs uppercase tracking-wider text-slate-400">
        Basic
      </header>
      <div className="divide-y divide-ink-700/60">
        {/* ── Name ── */}
        <div className="px-4 py-3">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">
            Name{" "}
            <span className="normal-case text-slate-600">
              ({label?.predicate === SKOS_PREF_LABEL ? "skos:prefLabel" : "rdfs:label"})
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex-1 min-w-0">
              <InlineTextField
                value={label?.value || ""}
                placeholder={shortName}
                deprecated={deprecated}
                onSave={onSaveLabel}
                readOnly={readOnly}
              />
            </div>
            {typeAssertions && typeAssertions.length > 0 && (
              <div className="flex flex-wrap gap-1 shrink-0">
                {typeAssertions.map((t) => (
                  <span
                    key={t}
                    title={t}
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] bg-brand-900/40 border border-brand-700/50 text-brand-300 font-mono"
                  >
                    {shortLabel(t)}
                  </span>
                ))}
              </div>
            )}
            {onSetDatatypeRange && (
              <DatatypeChip
                rangeIris={datatypeRange}
                onSetRange={onSetDatatypeRange}
                readOnly={readOnly}
              />
            )}
          </div>
          <InlineIriField value={iri} onSave={readOnly ? undefined : onSaveIri} />
        </div>
        {/* ── Definition (skos:definition) ── */}
        <div className="px-4 py-3">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">
            Definition <span className="normal-case text-slate-600">(skos:definition)</span>
          </div>
          <InlineTextArea
            value={definition?.value || ""}
            placeholder="Click to add a definition…"
            deprecated={deprecated}
            onSave={onSaveDefinition}
            readOnly={readOnly}
          />
        </div>
        {/* ── Comment (rdfs:comment) ── */}
        <CollapsibleTextAreaField
          label="Comment"
          badge="(rdfs:comment)"
          value={comment?.value || ""}
          deprecated={deprecated}
          onSave={onSaveComment}
          readOnly={readOnly}
        />
        {/* ── Scope Note (skos:scopeNote) ── */}
        <CollapsibleTextAreaField
          label="Scope Note"
          badge="(skos:scopeNote)"
          value={scopeNote?.value || ""}
          deprecated={deprecated}
          onSave={onSaveScopeNote}
          readOnly={readOnly}
        />
      </div>
    </section>
  );
}

function InlineTextField({ value, placeholder, deprecated, onSave, readOnly }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef(null);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };
  if (editing) {
    return (
      <input
        ref={ref}
        className="input w-full text-base font-semibold"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      title="Click to edit"
      className={`w-full text-left group flex items-center gap-2 rounded px-2 py-1 -ml-2 ${readOnly ? "cursor-default" : "hover:bg-ink-800/50 transition-colors"} ${deprecated ? "line-through text-slate-400" : ""}`}
      onClick={() => {
        if (readOnly) return;
        setDraft(value);
        setEditing(true);
      }}
    >
      {value ? (
        <span className="text-base font-semibold text-slate-100">{value}</span>
      ) : (
        <span className="text-sm text-slate-500 italic">{placeholder}</span>
      )}
      {!readOnly && (
        <Edit
          size={11}
          className="opacity-0 group-hover:opacity-40 shrink-0 transition"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

function InlineTextArea({ value, placeholder, deprecated, onSave, readOnly }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef(null);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };
  if (editing) {
    return (
      <textarea
        ref={ref}
        className="input w-full text-sm resize-none"
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      title="Click to edit"
      className={`w-full text-left group flex items-start gap-2 rounded px-2 py-1 -ml-2 ${readOnly ? "cursor-default" : "hover:bg-ink-800/50 transition-colors"} ${deprecated ? "line-through text-slate-400" : ""}`}
      onClick={() => {
        if (readOnly) return;
        setDraft(value);
        setEditing(true);
      }}
    >
      {value ? (
        <span className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap wrap-break-word min-h-6">
          {value}
        </span>
      ) : (
        <span className="text-sm text-slate-500 italic min-h-6">{readOnly ? "" : placeholder}</span>
      )}
      {!readOnly && (
        <Edit
          size={11}
          className="opacity-0 group-hover:opacity-40 shrink-0 mt-0.5 transition"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CollapsibleTextAreaField — compact label row when empty; textarea revealed
// on click. Used for rdfs:comment and skos:scopeNote so empty
// fields don't waste vertical space with a placeholder text block.
// ═══════════════════════════════════════════════════════════════════════════
function CollapsibleTextAreaField({ label, badge, value, deprecated, onSave, readOnly }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef(null);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };
  return (
    <div className="px-4 py-2">
      {/* Label row — always visible; clicking it opens the textarea */}
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 group mb-0.5"
        onClick={() => {
          if (readOnly) return;
          setDraft(value || "");
          setEditing(true);
        }}
        title={readOnly ? label : `Click to edit ${label}`}
      >
        <div className="text-[10px] text-slate-500 uppercase tracking-wider">
          {label} <span className="normal-case text-slate-600">{badge}</span>
        </div>
        {!readOnly && (
          <Edit
            size={10}
            className="opacity-0 group-hover:opacity-40 shrink-0 text-slate-400 transition"
            aria-hidden="true"
          />
        )}
      </button>
      {/* Editing: textarea */}
      {editing && (
        <textarea
          ref={ref}
          className="input w-full text-sm resize-none mt-1"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
        />
      )}
      {/* Has value and not editing: show text */}
      {!editing && value && (
        <button
          type="button"
          title={readOnly ? undefined : "Click to edit"}
          className={`w-full text-left group flex items-start gap-2 rounded px-2 py-1 -ml-2 ${readOnly ? "cursor-default" : "hover:bg-ink-800/50 transition-colors"} ${deprecated ? "line-through text-slate-400" : ""}`}
          onClick={() => {
            if (readOnly) return;
            setDraft(value);
            setEditing(true);
          }}
        >
          <span className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap wrap-break-word">
            {value}
          </span>
          {!readOnly && (
            <Edit
              size={11}
              className="opacity-0 group-hover:opacity-40 shrink-0 mt-0.5 transition"
              aria-hidden="true"
            />
          )}
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// InlineIriField — inline-editable IRI display in BasicSection.
// Renders as a small monospace text line with a pencil icon on hover.
// Clicking opens a full-width input. Enter/blur commits; Escape cancels.
// Validation requires the new value to parse as an absolute IRI via URL().
// ═══════════════════════════════════════════════════════════════════════════
function InlineIriField({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [err, setErr] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const commit = () => {
    const v = draft.trim();
    if (!v || v === value) {
      setEditing(false);
      setErr(null);
      return;
    }
    try {
      new URL(v);
    } catch {
      setErr("Must be a valid absolute IRI (e.g. https://example.org/MyClass)");
      return;
    }
    setErr(null);
    setEditing(false);
    onSave?.(v);
  };

  if (editing) {
    return (
      <div className="mt-1 pl-2 space-y-1">
        <input
          ref={ref}
          className="input w-full text-[11px] font-mono"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (err) setErr(null);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
              setErr(null);
            }
          }}
        />
        {err && <div className="text-[10px] text-red-300 pl-0.5">{err}</div>}
      </div>
    );
  }

  return (
    <button
      type="button"
      title={onSave ? "Click to edit IRI" : value}
      className="mt-1 pl-2 w-full text-left group flex items-center gap-1 rounded hover:bg-ink-800/50 transition-colors"
      onClick={() => {
        if (!onSave) return;
        setDraft(value);
        setEditing(true);
      }}
    >
      <span className="text-[10px] font-mono text-slate-500 truncate">{value}</span>
      {onSave && (
        <Edit
          size={9}
          className="opacity-0 group-hover:opacity-40 shrink-0 text-slate-400 transition"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DatatypeChip — inline-editable datatype range chip for datatype properties.
// Display: emerald pill showing the short type name (e.g. "boolean") with a
// pencil icon on hover. Clicking opens an inline <select> with all built-in
// datatypes. When no range is set, renders a dashed "+ type" prompt instead.
// ═══════════════════════════════════════════════════════════════════════════
function DatatypeChip({ rangeIris, onSetRange, readOnly }) {
  const [editing, setEditing] = useState(false);
  const selectRef = useRef(null);
  const currentIri = rangeIris[0] ?? null;
  // Track whether the current IRI is in our known list (so we can add a
  // fallback option for custom or externally-imported datatypes).
  const isKnown = !currentIri || BUILTIN_DATATYPES.some((d) => d.iri === currentIri);

  useEffect(() => {
    if (editing) selectRef.current?.focus();
  }, [editing]);

  const pick = async (e) => {
    const val = e.target.value;
    setEditing(false);
    // "" means "none" — clear the range
    await onSetRange(val ? [val] : []);
  };

  if (editing) {
    return (
      <select
        ref={selectRef}
        className="input text-[11px] py-0.5 h-auto font-mono w-auto max-w-40 shrink-0"
        value={currentIri ?? ""}
        onBlur={() => setEditing(false)}
        onChange={pick}
      >
        <option value="">— no type —</option>
        {/* Preserve unrecognised current datatype as a selectable option */}
        {!isKnown && currentIri && <option value={currentIri}>{shortLabel(currentIri)}</option>}
        {BUILTIN_DATATYPES.map((t) => (
          <option key={t.iri} value={t.iri}>
            {t.label}
          </option>
        ))}
      </select>
    );
  }

  if (!currentIri) {
    if (readOnly) return null;
    return (
      <button
        type="button"
        title="Set datatype (rdfs:range)"
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border border-dashed border-emerald-800/60 text-emerald-700 hover:border-emerald-600 hover:text-emerald-500 transition font-mono"
      >
        + type
      </button>
    );
  }

  return (
    <button
      type="button"
      title={readOnly ? currentIri : `${currentIri} — click to change`}
      onClick={readOnly ? undefined : () => setEditing(true)}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-emerald-900/30 border border-emerald-700/40 text-emerald-300 font-mono ${readOnly ? "cursor-default" : "group hover:border-emerald-500/60 hover:bg-emerald-900/50 transition"}`}
    >
      <span>{shortLabel(currentIri)}</span>
      {!readOnly && (
        <Edit
          size={10}
          strokeWidth={2.5}
          className="opacity-0 group-hover:opacity-60 transition shrink-0"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HierarchySection — parent / child class pickers
// ═══════════════════════════════════════════════════════════════════════════
function HierarchySection({
  iri,
  parentClassIris,
  childClassIris,
  classList,
  ancestorClassIris,
  linkedOnlyParentIris,
  onAddParent,
  onRemoveParent,
  onAddChild,
  onRemoveChild,
  entityIsReadOnly,
}) {
  const navigate = useNavigate();
  const [addingParent, setAddingParent] = useState(false);
  const [parentPick, setParentPick] = useState("");
  const [addingChild, setAddingChild] = useState(false);
  const [childPick, setChildPick] = useState("");
  const [ancestorsOpen, setAncestorsOpen] = useState(false);

  const classMap = useMemo(() => {
    const m = new Map();
    for (const c of classList || []) {
      const ci = c.iri?.value;
      if (ci) m.set(ci, c.prefLabel?.value || c.label?.value || shortLabel(ci));
    }
    return m;
  }, [classList]);

  // Available as parents: exclude self, existing parents
  const availableParents = useMemo(() => {
    const taken = new Set([...parentClassIris, iri]);
    return (classList || [])
      .map((c) => ({
        iri: c.iri?.value,
        label: c.prefLabel?.value || c.label?.value || shortLabel(c.iri?.value),
      }))
      .filter((c) => c.iri && !taken.has(c.iri))
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  }, [classList, parentClassIris, iri]);

  // Available as children: exclude self, existing children, and existing parents
  const availableChildren = useMemo(() => {
    const taken = new Set([...childClassIris, ...parentClassIris, iri]);
    return (classList || [])
      .map((c) => ({
        iri: c.iri?.value,
        label: c.prefLabel?.value || c.label?.value || shortLabel(c.iri?.value),
      }))
      .filter((c) => c.iri && !taken.has(c.iri))
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  }, [classList, childClassIris, parentClassIris, iri]);

  const doAddParent = async () => {
    if (!parentPick) return;
    await onAddParent(parentPick);
    setParentPick("");
    setAddingParent(false);
  };

  const doAddChild = async () => {
    if (!childPick) return;
    await onAddChild(childPick);
    setChildPick("");
    setAddingChild(false);
  };

  return (
    <section className="panel">
      <header className="px-4 py-2 border-b border-ink-700 text-xs uppercase tracking-wider text-slate-400">
        Hierarchy
      </header>
      <div className="divide-y divide-ink-700/60">
        {/* Parent classes */}
        <div className="px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-slate-300">Parent {term("ClassPlural")}</div>
            {!addingParent && (
              <button
                type="button"
                className="btn-ghost text-[11px]"
                onClick={() => setAddingParent(true)}
              >
                + Add
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {parentClassIris.length === 0 && !addingParent && (
              <span className="text-[11px] text-slate-500">
                None — root {term("Class").toLowerCase()}
              </span>
            )}
            {parentClassIris.map((t) => {
              const isLinkedOnly = linkedOnlyParentIris?.has(t);
              return (
                <span key={t} className="relative group/chip">
                  <EntityChip
                    iri={t}
                    label={classMap.get(t) || shortLabel(t)}
                    onRemove={isLinkedOnly ? undefined : () => onRemoveParent(t)}
                    onNavigate={() => navigate(`/classes#iri=${encodeURIComponent(t)}`)}
                    dim={isLinkedOnly}
                  />
                  {isLinkedOnly && (
                    <span
                      className="absolute -top-1 -right-1 bg-ink-700 rounded-full p-px text-slate-500"
                      title="Defined in an imported ontology — cannot be removed here"
                    >
                      <Lock size={8} strokeWidth={2.5} aria-hidden="true" />
                    </span>
                  )}
                </span>
              );
            })}
          </div>
          {linkedOnlyParentIris?.size > 0 && (
            <p className="text-[10px] text-slate-500 leading-tight">
              <Lock size={8} className="inline mr-0.5 mb-px" aria-hidden="true" />
              Locked relationships are defined in another ontology and cannot be removed here.
            </p>
          )}
          {addingParent && (
            <div className="flex items-center gap-2 pt-1">
              {classList == null ? (
                <span className="text-xs text-slate-500">Loading…</span>
              ) : availableParents.length === 0 ? (
                <span className="text-xs text-slate-500">
                  No other {term("ClassPlural").toLowerCase()} available.
                </span>
              ) : (
                <select
                  className="input flex-1"
                  value={parentPick}
                  onChange={(e) => setParentPick(e.target.value)}
                >
                  <option value="">Select parent {term("Class").toLowerCase()}…</option>
                  {availableParents.map((c) => (
                    <option key={c.iri} value={c.iri}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn-primary text-xs"
                disabled={!parentPick}
                onClick={doAddParent}
              >
                Add
              </button>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => {
                  setAddingParent(false);
                  setParentPick("");
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {/* Child classes */}
        <div className="px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-slate-300">Child {term("ClassPlural")}</div>
            {!addingChild && !entityIsReadOnly && (
              <button
                type="button"
                className="btn-ghost text-[11px]"
                onClick={() => setAddingChild(true)}
              >
                + Add
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {childClassIris.length === 0 && !addingChild && (
              <span className="text-[11px] text-slate-500">None</span>
            )}
            {childClassIris.map((t) => (
              <EntityChip
                key={t}
                iri={t}
                label={classMap.get(t) || shortLabel(t)}
                onRemove={() => onRemoveChild(t)}
                onNavigate={() => navigate(`/classes#iri=${encodeURIComponent(t)}`)}
              />
            ))}
          </div>
          {addingChild && (
            <div className="flex items-center gap-2 pt-1">
              {classList == null ? (
                <span className="text-xs text-slate-500">Loading…</span>
              ) : availableChildren.length === 0 ? (
                <span className="text-xs text-slate-500">
                  No other {term("ClassPlural").toLowerCase()} available.
                </span>
              ) : (
                <select
                  className="input flex-1"
                  value={childPick}
                  onChange={(e) => setChildPick(e.target.value)}
                >
                  <option value="">Select child {term("Class").toLowerCase()}…</option>
                  {availableChildren.map((c) => (
                    <option key={c.iri} value={c.iri}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn-primary text-xs"
                disabled={!childPick}
                onClick={doAddChild}
              >
                Add
              </button>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => {
                  setAddingChild(false);
                  setChildPick("");
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {/* Transitive ancestors — read-only, collapsed by default */}
        {ancestorClassIris && ancestorClassIris.size > 0 && (
          <div className="border-t border-ink-700/40">
            <button
              type="button"
              className="w-full px-4 py-2 flex items-center justify-between hover:bg-ink-800/30 transition-colors"
              onClick={() => setAncestorsOpen((o) => !o)}
            >
              <span className="text-xs font-medium text-slate-400">
                All ancestors ({ancestorClassIris.size})
              </span>
              <ChevronDown
                size={12}
                className={`transition-transform text-slate-600 ${ancestorsOpen ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
            {ancestorsOpen && (
              <div className="px-4 pb-3 flex flex-wrap gap-1.5">
                {[...ancestorClassIris].map((t) => (
                  <EntityChip
                    key={t}
                    iri={t}
                    label={classMap.get(t) || shortLabel(t)}
                    onNavigate={() => navigate(`/classes#iri=${encodeURIComponent(t)}`)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function EntityChip({ iri, label, onRemove, onNavigate, dim = false }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-ink-800 border border-ink-600 ${dim ? "text-slate-500 border-ink-700" : "text-slate-200"}`}
      title={iri}
    >
      {onNavigate ? (
        <button
          type="button"
          className="font-mono hover:text-brand-200 hover:underline transition-colors"
          onClick={onNavigate}
          title={`Open ${label}`}
        >
          {label}
        </button>
      ) : (
        <span className="font-mono">{label}</span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-slate-500 hover:text-red-300 transition"
          title="Remove"
          aria-label={`Remove ${label}`}
        >
          <X size={10} strokeWidth={3} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

// PropRow — one row in Relationships / Attributes. Clicking the name
// navigates to that property's editor page. endpointIri is the range (for
// outgoing/domain rows) or domain (for incoming/range rows).
function PropRow({ prop, iconKind, endpointIri, directionLabel, onRemove }) {
  const navigate = useNavigate();
  const pi = prop.iri?.value;
  const pl = prop.prefLabel?.value || prop.label?.value || shortLabel(pi);
  const epLabel = endpointIri ? shortLabel(endpointIri) : null;
  const endpointType = directionLabel === "source" ? "to" : "from";
  return (
    <div className="px-4 py-2 flex items-center gap-3 group hover:bg-ink-800/40 border-b border-ink-700/30 last:border-0">
      <PropKindIcon kind={iconKind} />
      {/* Clickable property name */}
      <button
        type="button"
        className="flex-1 min-w-0 text-left"
        title={`Open ${pl} in editor`}
        onClick={() => navigate(`/properties/relationships#iri=${encodeURIComponent(pi)}`)}
      >
        <div className="text-sm font-medium text-slate-200 truncate hover:text-brand-200 hover:underline transition-colors">
          {pl}
        </div>
        {(prop.prefLabel?.value || prop.label?.value) && (
          <div className="text-[10px] font-mono text-slate-600 truncate">{shortLabel(pi)}</div>
        )}
      </button>
      {/* Endpoint chip: range class for outgoing, domain class for incoming */}
      {epLabel && (
        <>
          <span className="text-xs text-slate-500">{endpointType} </span>
          <button
            type="button"
            title={`Open ${epLabel} (${endpointIri})`}
            onClick={() => navigate(`/classes#iri=${encodeURIComponent(endpointIri)}`)}
            className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-ink-800 border border-ink-600 text-slate-300 hover:text-brand-200 hover:border-brand-600/50 hover:bg-ink-700 transition-colors"
          >
            {epLabel}
          </button>
        </>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-300 transition shrink-0"
          title={`Remove ${directionLabel} relationship`}
          aria-label={`Remove ${pl}`}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PropertyDomainSection — shows Outgoing (domain) and Incoming (range) sub-sections.
// When rangeProps + handlers are not provided it behaves like the old single list.
// inheritedProps (optional): read-only props inherited from parent classes.
// equivalentAncestorIris (optional): set of equivalent-class and their ancestor
//   IRIs — used to show a ≡ indicator instead of ↑ on inherited rows.
// ═══════════════════════════════════════════════════════════════════════════
function PropertyDomainSection({
  sectionTitle,
  sectionNote,
  iconKind,
  propKind,
  props,
  rangeProps,
  inheritedProps,
  equivalentAncestorIris,
  allProps,
  onAdd,
  onRemove,
  onAddRange,
  onRemoveRange,
  readOnly,
}) {
  const [addingDomain, setAddingDomain] = useState(false);
  const [addingRange, setAddingRange] = useState(false);
  const [domainPick, setDomainPick] = useState("");
  const [rangePick, setRangePick] = useState("");
  const addDomainRef = useRef(null);
  const addRangeRef = useRef(null);
  const hasRange = !!onAddRange;
  const hasInherited = (inheritedProps || []).length > 0;

  useEffect(() => {
    if (addingDomain)
      addDomainRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
  }, [addingDomain]);
  useEffect(() => {
    if (addingRange)
      addRangeRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
  }, [addingRange]);

  const existingDomainIris = useMemo(() => new Set(props.map((p) => p.iri?.value)), [props]);
  const existingRangeIris = useMemo(
    () => new Set((rangeProps || []).map((p) => p.iri?.value)),
    [rangeProps],
  );

  const available = useMemo(
    () =>
      (allProps || [])
        .filter(
          (p) =>
            (propKind == null || p.kind?.value === propKind) &&
            !existingDomainIris.has(p.iri?.value),
        )
        .map((p) => ({
          iri: p.iri?.value,
          label: p.prefLabel?.value || p.label?.value || shortLabel(p.iri?.value),
        }))
        .filter((p) => p.iri)
        .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())),
    [allProps, propKind, existingDomainIris],
  );

  const availableRange = useMemo(
    () =>
      (allProps || [])
        .filter(
          (p) =>
            (propKind == null || p.kind?.value === propKind) &&
            !existingRangeIris.has(p.iri?.value),
        )
        .map((p) => ({
          iri: p.iri?.value,
          label: p.prefLabel?.value || p.label?.value || shortLabel(p.iri?.value),
        }))
        .filter((p) => p.iri)
        .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())),
    [allProps, propKind, existingRangeIris],
  );

  const doAddDomain = async () => {
    if (!domainPick) return;
    await onAdd(domainPick);
    setDomainPick("");
    setAddingDomain(false);
  };
  const doAddRange = async () => {
    if (!rangePick) return;
    await onAddRange(rangePick);
    setRangePick("");
    setAddingRange(false);
  };

  // Inline add-form used by both subsections.
  const AddForm = ({ available: avail, pick, onPick, onConfirm, onCancel, label }) => (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        {allProps == null ? (
          <span className="text-xs text-slate-500">Loading…</span>
        ) : avail.length === 0 ? (
          <span className="text-xs text-slate-500">No additional properties available.</span>
        ) : (
          <select className="input flex-1" value={pick} onChange={(e) => onPick(e.target.value)}>
            <option value="">Select {label} property…</option>
            {avail.map((p) => (
              <option key={p.iri} value={p.iri}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn-primary text-xs" disabled={!pick} onClick={onConfirm}>
          Add
        </button>
        <button type="button" className="btn-ghost text-xs" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <section className="panel">
      <header className="px-4 py-2 border-b border-ink-700 text-xs uppercase tracking-wider text-slate-400 flex items-center justify-between gap-2">
        <span>{sectionTitle}</span>
        <span className="text-[10px] normal-case tracking-normal text-slate-500">
          {sectionNote}
        </span>
      </header>

      {/* ── Outgoing subsection ── */}
      {hasRange && (
        <div className="px-4 py-1 flex items-center justify-between border-b border-ink-700/40 bg-ink-900/40">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            Outgoing ({props.length})
          </span>
          {!addingDomain && !readOnly && (
            <button
              type="button"
              className="btn-ghost text-[11px]"
              onClick={() => setAddingDomain(true)}
              title="Add a property that uses this class as its source (rdfs:domain)"
            >
              + Add
            </button>
          )}
        </div>
      )}
      {props.length === 0 && !addingDomain && (
        <div className={`px-4 py-2 text-[11px] text-slate-500 ${hasRange ? "" : ""}`}>None</div>
      )}
      {props.map((p) => (
        <PropRow
          key={p.iri?.value}
          prop={p}
          iconKind={iconKind}
          endpointIri={p.range?.value}
          directionLabel="source"
          onRemove={readOnly ? undefined : () => onRemove(p.iri?.value)}
        />
      ))}
      {addingDomain ? (
        <div ref={addDomainRef}>
          <AddForm
            available={available}
            pick={domainPick}
            onPick={setDomainPick}
            onConfirm={doAddDomain}
            onCancel={() => {
              setAddingDomain(false);
              setDomainPick("");
            }}
            label="source"
          />
        </div>
      ) : (
        !hasRange &&
        !readOnly && (
          <div className="px-4 py-3">
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => setAddingDomain(true)}
            >
              + Add {sectionTitle.toLowerCase()}…
            </button>
          </div>
        )
      )}

      {/* ── Incoming subsection ── */}
      {hasRange && (
        <>
          <div className="px-4 py-1 flex items-center justify-between border-t border-b border-ink-700/40 bg-ink-900/40">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">
              Incoming ({(rangeProps || []).length})
            </span>
            {!addingRange && !readOnly && (
              <button
                type="button"
                className="btn-ghost text-[11px]"
                onClick={() => setAddingRange(true)}
                title="Add a property that uses this class as its target (rdfs:range)"
              >
                + Add
              </button>
            )}
          </div>
          {(rangeProps || []).length === 0 && !addingRange && (
            <div className="px-4 py-2 text-xs text-slate-500">None</div>
          )}
          {(rangeProps || []).map((p) => (
            <PropRow
              key={`range:${p.iri?.value}`}
              prop={p}
              iconKind="arrow-in"
              endpointIri={p.domain?.value}
              directionLabel="target"
              onRemove={() => onRemoveRange(p.iri?.value)}
            />
          ))}
          {addingRange && (
            <div ref={addRangeRef}>
              <AddForm
                available={availableRange}
                pick={rangePick}
                onPick={setRangePick}
                onConfirm={doAddRange}
                onCancel={() => {
                  setAddingRange(false);
                  setRangePick("");
                }}
                label="target"
              />
            </div>
          )}
        </>
      )}

      {/* ── Inherited sub-area ── */}
      {hasInherited && (
        <InheritedSubArea
          inheritedProps={inheritedProps}
          iconKind={iconKind}
          equivalentAncestorIris={equivalentAncestorIris}
        />
      )}
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// InheritedSubArea — collapsible "Inherited" area inside PropertyDomainSection.
// Groups inherited properties so that owl:inverseOf pairs are visually nested:
// if prop A has explicitInvOf pointing to prop B (also in the inherited list),
// A is indented under B and tagged with a chip-inv badge.
// ═══════════════════════════════════════════════════════════════════════════
function InheritedSubArea({ inheritedProps, iconKind, equivalentAncestorIris }) {
  const [open, setOpen] = useState(false);
  const list = inheritedProps || [];

  // Build a lookup of prop IRI → prop for fast membership checks.
  const byIri = useMemo(() => {
    const m = new Map();
    for (const p of list) {
      const pi = p.iri?.value;
      if (pi) m.set(pi, p);
    }
    return m;
  }, [list]);

  // Determine which props are "inverse children":
  // prop A is an inverse child of prop B when A.explicitInvOf contains B's IRI
  // and B is also in the inherited list. Those props are nested below B.
  const orderedRows = useMemo(() => {
    // Sort outgoing before incoming, then alphabetically within each direction group.
    const sorted = [...list].sort((a, b) => {
      const aOut = (a.inheritedDirection || "outgoing") === "outgoing" ? 0 : 1;
      const bOut = (b.inheritedDirection || "outgoing") === "outgoing" ? 0 : 1;
      if (aOut !== bOut) return aOut - bOut;
      const aLabel = (
        a.prefLabel?.value ||
        a.label?.value ||
        shortLabel(a.iri?.value) ||
        ""
      ).toLowerCase();
      const bLabel = (
        b.prefLabel?.value ||
        b.label?.value ||
        shortLabel(b.iri?.value) ||
        ""
      ).toLowerCase();
      return aLabel.localeCompare(bLabel);
    });

    const inverseChildIris = new Set();
    const inverseChildrenOf = new Map(); // parent IRI → [child prop, ...]

    for (const prop of sorted) {
      const propIri = prop.iri?.value;
      for (const invIri of prop.explicitInvOf || []) {
        if (byIri.has(invIri)) {
          inverseChildIris.add(propIri);
          if (!inverseChildrenOf.has(invIri)) inverseChildrenOf.set(invIri, []);
          inverseChildrenOf.get(invIri).push(prop);
        }
      }
    }

    // Flatten into an ordered list: root prop → its inverse children → next root prop…
    // Insert a divider sentinel between the outgoing and incoming groups.
    const result = [];
    let lastDir = null;
    for (const p of sorted) {
      if (inverseChildIris.has(p.iri?.value)) continue; // rendered as a child below its parent
      const dir = p.inheritedDirection || "outgoing";
      if (lastDir === "outgoing" && dir === "incoming") {
        result.push({ isDivider: true });
      }
      lastDir = dir;
      result.push({ prop: p, isInverseChild: false });
      for (const child of inverseChildrenOf.get(p.iri?.value) || []) {
        result.push({ prop: child, isInverseChild: true });
      }
    }
    return result;
  }, [list, byIri]);

  return (
    <>
      <button
        type="button"
        className="w-full px-4 py-1 flex items-center justify-between border-t border-ink-700/40 bg-ink-900/30 hover:bg-ink-900/60 transition-colors"
        onClick={() => setOpen((o) => !o)}
        title="Properties inherited from parent classes (read-only)"
      >
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          Inherited ({list.length})
        </span>
        <ChevronDown
          size={12}
          className={`transition-transform text-slate-600 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <>
          <div className="px-4 py-1.5 text-[10px] text-slate-600 italic border-b border-ink-700/20">
            Read-only — defined on a parent or equivalent{" "}
            {list.length === 1 ? term("Class") : term("ClassPlural")}. Edit on the source{" "}
            {term("Class").toLowerCase()} to modify.
          </div>
          {orderedRows.map((entry) => {
            if (entry.isDivider) {
              return (
                <div
                  key="__dir-divider__"
                  className="mx-4 my-0.5 border-t border-dashed border-ink-400/50"
                  aria-hidden="true"
                />
              );
            }
            const { prop, isInverseChild } = entry;
            return (
              <InheritedPropRow
                key={prop.iri?.value}
                prop={prop}
                iconKind={iconKind}
                equivalentAncestorIris={equivalentAncestorIris}
                isInverseChild={isInverseChild}
              />
            );
          })}
        </>
      )}
    </>
  );
}

// Read-only row for an inherited attribute. Same visual style as PropRow but
// without a remove button, and with the source class shown as an "inherited
// from" chip instead of a range chip.
// equivalentAncestorIris: when provided, a ≡ icon is shown instead of ↑ on
// outgoing-inherited rows whose domain is an equivalent class.
// prop.inheritedDirection: "outgoing" (ancestor is domain → this class can USE it)
//                          "incoming" (ancestor is range → this class can be pointed AT)
// isInverseChild: when true the row is indented and tagged with a chip-inv badge
//                 to show it is the inverse counterpart of the row above it.
function InheritedPropRow({ prop, iconKind, equivalentAncestorIris, isInverseChild }) {
  const navigate = useNavigate();
  const pi = prop.iri?.value;
  const pl = prop.prefLabel?.value || prop.label?.value || shortLabel(pi);
  const direction = prop.inheritedDirection || "outgoing";
  const isIncoming = direction === "incoming";
  // For outgoing: show the domain (ancestor that declared the property).
  // For incoming: show the domain (the class that points TO this class's ancestor via this property).
  const domainIri = prop.domain?.value;
  const domainLabel = domainIri ? shortLabel(domainIri) : null;
  const isViaEquivalent = !isIncoming && !!(domainIri && equivalentAncestorIris?.has(domainIri));
  return (
    <div
      className={`py-2 flex items-center gap-3 hover:bg-ink-800/30 border-b border-ink-700/20 last:border-0 opacity-70 ${
        isInverseChild ? "pl-10 pr-4 border-l-2 border-l-violet-800/40" : "px-4"
      }`}
    >
      <PropKindIcon kind={isIncoming ? "arrow-in" : iconKind} />
      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <button
          type="button"
          className="min-w-0 text-left"
          title={`Open ${pl} in editor`}
          onClick={() => navigate(`/properties/relationships#iri=${encodeURIComponent(pi)}`)}
        >
          <div className="text-sm font-medium text-slate-400 truncate hover:text-brand-200 hover:underline transition-colors">
            {pl}
          </div>
          {(prop.prefLabel?.value || prop.label?.value) && (
            <div className="text-[10px] font-mono text-slate-600 truncate">{shortLabel(pi)}</div>
          )}
        </button>
        {/* chip-inv badge — immediately right of the name, on inverse-child rows */}
        {isInverseChild && (
          <span
            className="chip-inv shrink-0 text-[11px] px-1.25 py-0 -mt-3"
            title="Inverse relationship (owl:inverseOf)"
          >
            inv
          </span>
        )}
      </div>
      {domainLabel && (
        <span
          title={
            isIncoming
              ? `Inherited incoming — ${domainIri} points to an ancestor of this class via this property`
              : isViaEquivalent
                ? `Inherited via equivalent class ${domainIri}`
                : `Inherited from ${domainIri}`
          }
          className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-ink-900/60 border border-ink-700/40 text-slate-500"
        >
          {isIncoming ? (
            <ArrowLeft size={8} strokeWidth={2.5} aria-hidden="true" />
          ) : isViaEquivalent ? (
            <ArrowLeftRight size={8} strokeWidth={2.5} aria-hidden="true" />
          ) : (
            <ArrowUp size={8} strokeWidth={2.5} aria-hidden="true" />
          )}
          {domainLabel}
        </span>
      )}
    </div>
  );
}

function PropKindIcon({ kind }) {
  if (kind === "arrow-in") {
    return (
      <div
        title="Outgoing Relationship"
        className="shrink-0 w-6 h-6 rounded bg-brand-900/40 border border-brand-600/40 flex items-center justify-center"
      >
        <ArrowRight size={12} strokeWidth={2.5} className="text-emerald-400" aria-hidden="true" />
      </div>
    );
  }
  if (kind === "arrow") {
    return (
      <div
        title="Incoming Relationship"
        className="shrink-0 w-6 h-6 rounded bg-brand-900/40 border border-brand-600/40 flex items-center justify-center"
      >
        <ArrowLeft size={12} strokeWidth={2.5} className="text-emerald-400" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className="shrink-0 w-6 h-6 rounded bg-brand-900/30 border border-brand-700/30 flex items-center justify-center">
      <Tag size={12} strokeWidth={2.5} className="text-emerald-400" aria-hidden="true" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DomainRangeSection — for property entities: source class(es) + target
// ═══════════════════════════════════════════════════════════════════════════
function DomainRangeSection({
  kind,
  domainIris,
  rangeIris,
  classList,
  onSetDomain,
  onSetRange,
  readOnly,
}) {
  const isDatatypeProp = kind === "datatype";
  const navigate = useNavigate();
  // Section title respects the Class / Entity terminology setting.
  const sectionTitle = `Associated ${term("ClassPlural")}`;

  const classCandidates = useMemo(
    () =>
      (classList || [])
        .map((c) => ({
          iri: c.iri?.value,
          label: c.prefLabel?.value || c.label?.value || shortLabel(c.iri?.value),
        }))
        .filter((c) => c.iri),
    [classList],
  );

  return (
    <section className="panel">
      <header className="px-4 py-2 border-b border-ink-700 text-xs uppercase tracking-wider text-slate-400">
        {sectionTitle}
      </header>
      <div className="divide-y divide-ink-700/60">
        <IriSetRow
          title={`${term("DomainClassPlural")}`}
          targets={domainIris}
          candidates={classCandidates}
          emptyHint={`No ${term("ClassPlural").toLowerCase()} available.`}
          onSetTargets={onSetDomain}
          onNavigate={(iri) => navigate(`/classes#iri=${encodeURIComponent(iri)}`)}
          readOnly={readOnly}
        />
        {/* For datatype properties show an inline dropdown using all built-in datatypes.
            For object / annotation properties show the class-based target picker. */}
        {isDatatypeProp ? (
          <DatatypeRangeRow rangeIris={rangeIris} onSetRange={onSetRange} readOnly={readOnly} />
        ) : (
          <IriSetRow
            title={`${term("RangeClassPlural")}`}
            targets={rangeIris}
            candidates={classCandidates}
            emptyHint="No candidates available."
            onSetTargets={onSetRange}
            onNavigate={(iri) => navigate(`/classes#iri=${encodeURIComponent(iri)}`)}
            readOnly={readOnly}
          />
        )}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// IndividualClassesSection — editable list of an individual's rdf:type classes.
// An instance can belong to multiple classes; this section diffs the current
// set against the user's selection and persists via add/delete triple calls.
// ═══════════════════════════════════════════════════════════════════════════
function IndividualClassesSection({ typeAssertions, classList, onSetClasses, readOnly }) {
  const navigate = useNavigate();
  const sectionTitle = `${term("ClassPlural")}`;

  const classCandidates = useMemo(
    () =>
      (classList || [])
        .map((c) => ({
          iri: c.iri?.value,
          label: c.prefLabel?.value || c.label?.value || shortLabel(c.iri?.value),
        }))
        .filter((c) => c.iri),
    [classList],
  );

  return (
    <section className="panel">
      <header className="px-4 py-2 border-b border-ink-700 text-xs uppercase tracking-wider text-slate-400">
        {sectionTitle}
      </header>
      <div className="divide-y divide-ink-700/60">
        <IriSetRow
          title={`${term("ClassPlural")} (rdf:type)`}
          targets={typeAssertions}
          candidates={classCandidates}
          emptyHint={`No ${term("ClassPlural").toLowerCase()} available.`}
          onSetTargets={onSetClasses}
          onNavigate={(iri) => navigate(`/classes#iri=${encodeURIComponent(iri)}`)}
          readOnly={readOnly}
        />
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DatatypeRangeRow — visible datatype selector for the "Associated Classes"
// panel on datatype properties. Replaces the previously-hidden range row with
// a full-width <select> populated from BUILTIN_DATATYPES. Selecting a value
// immediately persists the new rdfs:range triple; selecting "(none)" clears it.
// Unknown IRIs (e.g. imported from an external ontology) are preserved as an
// extra option so they're not silently lost when the user opens the selector.
// ═══════════════════════════════════════════════════════════════════════════
function DatatypeRangeRow({ rangeIris, onSetRange, readOnly }) {
  const currentIri = rangeIris[0] ?? "";
  const isKnown = !currentIri || BUILTIN_DATATYPES.some((d) => d.iri === currentIri);

  const handleChange = async (e) => {
    const val = e.target.value;
    await onSetRange(val ? [val] : []);
  };

  return (
    <div className="px-4 py-3 space-y-1.5">
      <div className="text-xs font-semibold text-slate-200">
        Datatype{" "}
        <span className="normal-case font-normal text-slate-500 text-[10px]">(rdfs:range)</span>
      </div>
      <select
        className="input w-full text-sm font-mono"
        value={currentIri}
        onChange={handleChange}
        disabled={readOnly}
      >
        <option value="">(none)</option>
        {/* Preserve unrecognised current datatype so it stays selectable */}
        {!isKnown && currentIri && <option value={currentIri}>{shortLabel(currentIri)}</option>}
        {BUILTIN_DATATYPES.map((dt) => (
          <option key={dt.iri} value={dt.iri}>
            {dt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// Simplified AxiomRow-alike that accepts normalized { iri, label } candidates
// (used by DomainRangeSection where we mix XSD types with class IRIs).
// onNavigate(iri): optional callback — when provided, the class label becomes
// a clickable link (e.g. to /classes#iri=...) instead of plain text.
function IriSetRow({ title, targets, candidates, emptyHint, onSetTargets, onNavigate, readOnly }) {
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");

  const labelFor = useMemo(() => {
    const m = new Map();
    for (const c of candidates) m.set(c.iri, c.label);
    return m;
  }, [candidates]);

  const available = useMemo(() => {
    const taken = new Set(targets);
    return candidates
      .filter((c) => c.iri && !taken.has(c.iri))
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  }, [candidates, targets]);

  const doAdd = async () => {
    if (!pick) return;
    await onSetTargets([...targets, pick]);
    setPick("");
    setAdding(false);
  };
  const doRemove = async (t) => onSetTargets(targets.filter((x) => x !== t));

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-200">{title}</div>
        {!adding && !readOnly && (
          <button type="button" className="btn-ghost text-[11px]" onClick={() => setAdding(true)}>
            + Add
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {targets.length === 0 && !adding && (
          <span className="text-[11px] text-slate-500">None</span>
        )}
        {targets.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-ink-800 border border-ink-600 text-slate-200"
            title={t}
          >
            {onNavigate ? (
              <button
                type="button"
                className="font-mono hover:text-brand-200 hover:underline transition-colors"
                onClick={() => onNavigate(t)}
                title={`Open ${labelFor.get(t) || shortLabel(t)}`}
              >
                {labelFor.get(t) || shortLabel(t)}
              </button>
            ) : (
              <span className="font-mono">{labelFor.get(t) || shortLabel(t)}</span>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={() => doRemove(t)}
                className="text-slate-500 hover:text-red-300 transition"
                title="Remove"
              >
                <X size={10} strokeWidth={3} aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
      </div>
      {adding && (
        <div className="flex items-center gap-2 pt-1">
          {available.length === 0 ? (
            <span className="text-xs text-slate-500">{emptyHint}</span>
          ) : (
            <select className="input flex-1" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Select…</option>
              {available.map((c) => (
                <option key={c.iri} value={c.iri}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn-primary text-xs" disabled={!pick} onClick={doAdd}>
            Add
          </button>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => {
              setAdding(false);
              setPick("");
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AdvancedSection — collapsible raw outgoing / incoming assertions
// ═══════════════════════════════════════════════════════════════════════════
function AdvancedSection({
  outgoing,
  incoming,
  defaultOpen = false,
  iri,
  onAdd,
  onDeleteOutgoing,
  onInfoOutgoing,
  onInfoIncoming,
  readOnly,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const total = outgoing.length + incoming.length;

  return (
    <section className="panel">
      <header className="px-4 py-2 border-b border-ink-700 text-xs uppercase tracking-wider text-slate-400 flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer hover:text-slate-200 transition-colors text-left"
          onClick={() => setOpen((o) => !o)}
        >
          <span>
            Advanced assertions{" "}
            <span className="normal-case tracking-normal text-slate-600 ml-1">({total})</span>
          </span>
          <ChevronDown
            size={14}
            className={`transition-transform shrink-0 ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
        {!readOnly && (
          <button type="button" className="btn-ghost text-[11px] shrink-0" onClick={onAdd}>
            + Add
          </button>
        )}
      </header>
      {open && (
        <div>
          {outgoing.length > 0 && (
            <>
              <div className="px-4 py-1.5 flex items-center gap-2 text-[10px] text-slate-500 uppercase tracking-wider border-b border-ink-700/40">
                <span>Outgoing ({outgoing.length})</span>
                <InfoIconButton onClick={onInfoOutgoing} label="What is outgoing?" />
              </div>
              <div className="divide-y divide-ink-700/60">
                {outgoing.map((r) => (
                  <TripleRow
                    key={`${r.p.value}:${r.o?.value}`}
                    p={r.p}
                    o={r.o}
                    onDelete={readOnly ? undefined : () => onDeleteOutgoing(r)}
                  />
                ))}
              </div>
            </>
          )}
          {incoming.length > 0 && (
            <>
              <div className="px-4 py-1.5 flex items-center gap-2 text-[10px] text-slate-500 uppercase tracking-wider border-b border-ink-700/40">
                <span>Incoming ({incoming.length})</span>
                <InfoIconButton onClick={onInfoIncoming} label="What is incoming?" />
              </div>
              <div className="divide-y divide-ink-700/60">
                {incoming.map((r) => (
                  <TripleRow key={`${r.s.value}:${r.p.value}`} s={r.s} p={r.p} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function _Section({ title, note, onInfo, infoLabel, children }) {
  return (
    <section className="panel">
      <header className="px-4 py-2 border-b border-ink-700 text-xs uppercase tracking-wider text-slate-400 flex items-center justify-between gap-2">
        <span>{title}</span>
        {(note || onInfo) && (
          <span className="flex items-center gap-2">
            {note && (
              <span className="text-[10px] normal-case tracking-normal text-slate-500">{note}</span>
            )}
            {onInfo && (
              <InfoIconButton
                onClick={onInfo}
                label={infoLabel || `What is ${title.toLowerCase()}?`}
              />
            )}
          </span>
        )}
      </header>
      <div className="divide-y divide-ink-700/60">{children}</div>
    </section>
  );
}

// Small circled-i button used in section headers to surface an info modal.
// Kept as a shared component so every section's icon looks identical.
function InfoIconButton({ onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="text-slate-500 hover:text-brand-300 transition shrink-0"
    >
      <Info size={14} aria-hidden="true" />
    </button>
  );
}

// Compact chip strip for OWL property characteristics. Tapping a chip adds or
// removes the corresponding `a owl:*Property` type assertion. For datatype /
// annotation properties only Functional is shown (the rest have no meaning
// there in OWL 2).
function CharacteristicsRow({ kind, active, onToggle, readOnly }) {
  const [infoOpen, setInfoOpen] = useState(false);
  const options = allowedCharacteristics(kind);
  if (!options.length) return null;
  return (
    <>
      <section className="panel">
        <header className="px-4 py-2 border-b border-ink-700 text-xs uppercase tracking-wider text-slate-400 flex items-center justify-between">
          <span>Characteristics</span>
          <span className="flex items-center gap-2">
            <span className="text-[10px] normal-case tracking-normal text-slate-500">
              Click to toggle · stored as <code className="font-mono">owl:*Property</code> type
              triples
            </span>
            <InfoIconButton
              onClick={() => setInfoOpen(true)}
              label="What do these characteristics mean?"
            />
          </span>
        </header>
        <div className="px-4 py-3 flex flex-wrap gap-2">
          {options.map((c) => {
            const on = active.includes(c.name);
            return (
              <button
                type="button"
                key={c.name}
                onClick={readOnly ? undefined : () => onToggle(c.name)}
                disabled={readOnly}
                title={c.tip}
                className={`px-2.5 py-1 rounded-full border text-xs transition ${readOnly ? "opacity-60 cursor-default" : ""} ${
                  on
                    ? "bg-brand-600 border-brand-400 text-white shadow-xs shadow-brand-900/40"
                    : "bg-ink-800 border-ink-600 text-slate-300 hover:bg-ink-700 hover:border-ink-500"
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${on ? "bg-white" : "bg-slate-500"}`}
                    aria-hidden
                  />
                  {c.label}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {infoOpen && <CharacteristicsInfoModal kind={kind} onClose={() => setInfoOpen(false)} />}
    </>
  );
}

// Reference sheet for OWL 2 property characteristics. Summaries paraphrase the
// Protégé documentation — the modal links out for the full originals and for
// the W3C OWL 2 Primer's formal examples.
function CharacteristicsInfoModal({ kind, onClose }) {
  const options = allowedCharacteristics(kind);
  const text = {
    Functional:
      "For any given subject, the property has at most one value — one outgoing relationship per individual. If multiple values are asserted, a reasoner will infer they denote the same object.",
    InverseFunctional:
      "The inverse of this property is Functional: each target can have at most one incoming relationship along this property. If multiple subjects point to the same target, they will be inferred to denote the same object. (Object properties only.)",
    Transitive:
      'If x is related to y and y is related to z along this property, then x is also related to z. A single "hop" is implied over any chain of two.',
    Symmetric:
      "The property is its own inverse: if x is related to y then y is related back to x along the same property.",
    Asymmetric:
      "If x is related to y along this property, then y is NOT related to x along the same property.",
    Reflexive: "Every individual is related to itself via this property.",
    Irreflexive: "No individual can be related to itself via this property.",
  };
  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-xs grid place-items-center z-50"
      role="presentation"
    >
      <div role="presentation" className="panel w-full max-w-xl p-5 max-h-[85vh] overflow-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">Property characteristics</h3>
          <button type="button" className="btn-ghost p-1" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-4">
          Each characteristic is stored as an <code className="font-mono">rdf:type</code> assertion
          pointing at the matching OWL metaclass (e.g.&nbsp;
          <code className="font-mono">owl:TransitiveProperty</code>). A reasoner uses these to infer
          new facts.
          {kind !== "object" && (
            <>
              {" "}
              Only <strong>Functional</strong> is semantically meaningful for datatype / annotation
              properties in OWL 2, so the others are hidden here.
            </>
          )}
        </p>
        <dl className="space-y-3">
          {options.map((c) => (
            <div key={c.name} className="bg-ink-900/60 border border-ink-700/60 rounded-md p-3">
              <dt className="flex items-center justify-between gap-2 mb-1">
                <span className="font-semibold text-slate-100">{c.label}</span>
                <code className="text-[10px] font-mono text-brand-300/80">
                  owl:{c.name}Property
                </code>
              </dt>
              <dd className="text-sm text-slate-300 leading-relaxed">{text[c.name]}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 pt-3 border-t border-ink-700/60 text-[11px] text-slate-500 space-y-1">
          <div>
            Summaries adapted from the{" "}
            <a
              className="text-brand-300 hover:underline"
              href="https://protegeproject.github.io/protege/views/object-property-characteristics/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Protégé documentation
            </a>
            .
          </div>
          <div>
            Full formal definitions:{" "}
            <a
              className="text-brand-300 hover:underline"
              href="https://www.w3.org/TR/owl2-primer/#Property_Characteristics"
              target="_blank"
              rel="noopener noreferrer"
            >
              W3C OWL 2 Primer — Property Characteristics
            </a>
            .
          </div>
        </div>
        <div className="flex justify-end pt-4">
          <button type="button" className="btn-primary text-xs" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// Axioms that stay presentational (chip rows) rather than being editable
// via raw triple CRUD. For classes: equivalentClass / disjointWith. For
// properties: inverseOf (object only) and subPropertyOf (same-kind parent
// properties). Each row renders current targets as removable chips and a
// "+ add" picker that lists candidate entities of the correct type.
function AxiomsSection({
  iri,
  kind,
  targets,
  onSetTargets,
  onInfo,
  ancestorClassIris: ancestorClassIrisParam,
  classList: classListParam,
  readOnly,
}) {
  const isPropertyKind =
    kind === "object" || kind === "datatype" || kind === "annotation" || kind === "property";
  const isClassKind = kind === "class";

  const [inheritedAxiomsOpen, setInheritedAxiomsOpen] = useState(false);

  // Lazily loaded candidate lists for the pickers. Classes for class axioms,
  // properties of matching kind for property axioms.
  const [classList, setClassList] = useState(null);
  const [propList, setPropList] = useState(null);

  useEffect(() => {
    if (isClassKind && !classList)
      api
        .classes()
        .then((r) => setClassList(r.classes))
        .catch(() => setClassList([]));
    if (isPropertyKind && !propList)
      api
        .propertiesAll()
        .then((r) => setPropList(r.properties))
        .catch(() => setPropList([]));
  }, [isClassKind, isPropertyKind, propList, classList]);

  // Build the set of rows to render — order picks mirror Protégé ("Equivalent
  // To", "Disjoint With" on classes; "Inverse Of", "SubProperty Of" on
  // properties). For object properties both apply; for datatype/annotation
  // only subPropertyOf is semantically useful.
  const rows = [];
  if (isClassKind) {
    rows.push({
      predicate: OWL_EQUIVALENT_CLASS,
      title: `Equivalent ${term("ClassPlural").toLowerCase()}`,
      candidates: classList,
      emptyHint: `No other ${term("ClassPlural").toLowerCase()} to choose from.`,
    });
    rows.push({
      predicate: OWL_DISJOINT_WITH,
      title: `Disjoint with`,
      candidates: classList,
      emptyHint: `No other ${term("ClassPlural").toLowerCase()} to choose from.`,
    });
  }
  if (isPropertyKind) {
    // inverseOf is only meaningful for object properties.
    if (kind === "object" || kind === "property") {
      rows.push({
        predicate: OWL_INVERSE_OF,
        title: "Inverse of",
        candidates: (propList || []).filter((p) => {
          const k = p.kind?.value;
          return k === "object" && p.iri?.value !== iri;
        }),
        emptyHint: `No other ${term("ObjectPropertyPlural").toLowerCase()} to choose from.`,
      });
    }
    rows.push({
      predicate: RDFS_SUB_PROPERTY_OF,
      title: "Sub-property of",
      candidates: (propList || []).filter((p) => {
        const k = p.kind?.value;
        const target =
          kind === "property"
            ? k === "object" || k === "datatype" || k === "annotation"
            : k === kind;
        return target && p.iri?.value !== iri;
      }),
      emptyHint: "No sibling properties to choose from.",
    });
  }

  // Build inherited axiom targets from ancestor classes.
  // For each ancestor, collect its equivalentClass and disjointWith targets
  // (from the classList data), excluding targets already shown directly.
  const inheritedAxiomRows = useMemo(() => {
    if (
      !isClassKind ||
      !ancestorClassIrisParam ||
      ancestorClassIrisParam.size === 0 ||
      !classListParam
    )
      return [];
    const classMap = new Map();
    for (const c of classListParam) {
      const ci = c.iri?.value;
      if (ci) classMap.set(ci, c);
    }
    const directEquiv = new Set(targets[OWL_EQUIVALENT_CLASS] || []);
    const directDisj = new Set(targets[OWL_DISJOINT_WITH] || []);
    const equivSet = new Set();
    const disjSet = new Set();
    for (const anc of ancestorClassIrisParam) {
      const c = classMap.get(anc);
      if (!c) continue;
      for (const e of c.equivalents || []) {
        if (!directEquiv.has(e) && e !== iri && !ancestorClassIrisParam.has(e)) equivSet.add(e);
      }
      for (const d of c.disjoints || []) {
        if (!directDisj.has(d) && d !== iri && !ancestorClassIrisParam.has(d)) disjSet.add(d);
      }
    }
    const rows = [];
    if (equivSet.size > 0)
      rows.push({
        title: `Inherited equivalent ${term("ClassPlural").toLowerCase()}`,
        items: [...equivSet],
      });
    if (disjSet.size > 0) rows.push({ title: "Inherited disjoint with", items: [...disjSet] });
    return rows;
  }, [isClassKind, ancestorClassIrisParam, classListParam, targets, iri]);

  if (rows.length === 0 && inheritedAxiomRows.length === 0) return null;

  return (
    <section className="panel">
      <header className="px-4 py-2 border-b border-ink-700 text-xs uppercase tracking-wider text-slate-400 flex items-center justify-between gap-2">
        <span>Axioms</span>
        <span className="flex items-center gap-2">
          <span className="text-[10px] normal-case tracking-normal text-slate-500">
            Semantic relationships between entities
          </span>
          {onInfo && <InfoIconButton onClick={onInfo} label="What do these axioms mean?" />}
        </span>
      </header>
      {rows.length > 0 && (
        <div className="divide-y divide-ink-700/60">
          {rows.map((row) => (
            <AxiomRow
              key={row.predicate}
              iri={iri}
              predicate={row.predicate}
              title={row.title}
              targets={targets[row.predicate] || []}
              candidates={row.candidates}
              emptyHint={row.emptyHint}
              onSetTargets={onSetTargets}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}

      {/* Inherited axioms from ancestor classes */}
      {inheritedAxiomRows.length > 0 && (
        <>
          <button
            type="button"
            className="w-full px-4 py-1 flex items-center justify-between border-t border-ink-700/40 bg-ink-900/30 hover:bg-ink-900/60 transition-colors"
            onClick={() => setInheritedAxiomsOpen((o) => !o)}
            title="Axioms inherited from ancestor classes (read-only)"
          >
            <span className="text-[10px] uppercase tracking-wider text-slate-500">
              Inherited ({inheritedAxiomRows.reduce((sum, row) => sum + row.items.length, 0)})
            </span>
            <ChevronDown
              size={12}
              className={`transition-transform text-slate-600 ${inheritedAxiomsOpen ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </button>
          {inheritedAxiomsOpen && (
            <div className="divide-y divide-ink-700/60">
              <div className="px-4 py-1.5 text-[10px] text-slate-600 italic">
                Read-only — inherited from ancestor {term("ClassPlural").toLowerCase()}. Edit on the
                source {term("Class").toLowerCase()} to modify.
              </div>
              {inheritedAxiomRows.map((row) => (
                <div key={row.title} className="px-4 py-3 space-y-2">
                  <div className="text-xs font-semibold text-slate-400">{row.title}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {row.items.map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-ink-800/60 border border-ink-700/40 text-slate-400 font-mono"
                        title={t}
                      >
                        {shortLabel(t)}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AxiomRow({
  iri,
  predicate,
  title,
  targets,
  candidates,
  emptyHint,
  onSetTargets,
  readOnly,
}) {
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const navigate = useNavigate();

  // Determine destination route from the predicate so chips are navigable.
  const routeForTarget = (targetIri) => {
    if (predicate === OWL_INVERSE_OF || predicate === RDFS_SUB_PROPERTY_OF)
      return `/properties/relationships#iri=${encodeURIComponent(targetIri)}`;
    return `/classes#iri=${encodeURIComponent(targetIri)}`;
  };

  const candidateMap = useMemo(() => {
    const m = new Map();
    for (const c of candidates || []) {
      const ci = c.iri?.value;
      const cl = c.prefLabel?.value || c.label?.value || shortLabel(ci);
      if (ci) m.set(ci, cl);
    }
    return m;
  }, [candidates]);

  // Filter out candidates already present in the targets set and the entity
  // itself so the dropdown only offers actionable additions.
  const available = useMemo(() => {
    if (!candidates) return [];
    const taken = new Set(targets);
    taken.add(iri);
    const list = candidates
      .map((c) => ({
        iri: c.iri?.value,
        label: c.prefLabel?.value || c.label?.value || shortLabel(c.iri?.value),
      }))
      .filter((c) => c.iri && !taken.has(c.iri));
    list.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    return list;
  }, [candidates, targets, iri]);

  const add = async () => {
    if (!pick) return;
    await onSetTargets(predicate, [...targets, pick]);
    setPick("");
    setAdding(false);
  };
  const remove = async (t) => {
    await onSetTargets(
      predicate,
      targets.filter((x) => x !== t),
    );
  };

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-200">{title}</div>
        {!adding && !readOnly && (
          <button
            type="button"
            className="btn-ghost text-[11px]"
            onClick={() => setAdding(true)}
            title={`Add ${title.toLowerCase()}`}
          >
            + Add
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {targets.length === 0 && !adding && (
          <span className="text-[11px] text-slate-500">None</span>
        )}
        {targets.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-ink-800 border border-ink-600 text-slate-200"
            title={t}
          >
            <button
              type="button"
              className="font-mono hover:text-brand-200 hover:underline transition-colors"
              onClick={() => navigate(routeForTarget(t))}
              title={`Open ${candidateMap.get(t) || shortLabel(t)}`}
            >
              {candidateMap.get(t) || shortLabel(t)}
            </button>
            {!readOnly && (
              <button
                type="button"
                onClick={() => remove(t)}
                className="text-slate-500 hover:text-red-300 transition"
                title="Remove"
                aria-label={`Remove ${shortLabel(t)}`}
              >
                <X size={10} strokeWidth={3} aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
      </div>
      {adding && (
        <div className="flex items-center gap-2 pt-1">
          {candidates == null ? (
            <span className="text-xs text-slate-500">Loading…</span>
          ) : available.length === 0 ? (
            <span className="text-xs text-slate-500">{emptyHint}</span>
          ) : (
            <select className="input flex-1" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Select…</option>
              {available.map((c) => (
                <option key={c.iri} value={c.iri}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn-primary text-xs" disabled={!pick} onClick={add}>
            Add
          </button>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => {
              setAdding(false);
              setPick("");
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// Shared modal shell used by the info panels below. Centralizes the overlay,
// backdrop-click-to-close behavior, header with close button, and footer.
function InfoModalShell({ title, onClose, children, footer }) {
  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-xs grid place-items-center z-50"
      role="presentation"
    >
      <div role="presentation" className="panel w-full max-w-xl p-5 max-h-[85vh] overflow-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">{title}</h3>
          <button type="button" className="btn-ghost p-1" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="space-y-3 text-sm text-slate-300 leading-relaxed">{children}</div>
        {footer && (
          <div className="mt-4 pt-3 border-t border-ink-700/60 text-[11px] text-slate-500 space-y-1">
            {footer}
          </div>
        )}
        <div className="flex justify-end pt-4">
          <button type="button" className="btn-primary text-xs" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// Describes what outgoing / incoming assertion lists mean in plain terms,
// with a worked example that swaps in the current entity kind's terminology
// (Relationship vs Object Property, Source vs Domain, etc.) so the prose
// matches the rest of the UI.
function AssertionInfoModal({ kind, direction, onClose }) {
  const subjectTerm =
    kind === "class"
      ? term("Class").toLowerCase()
      : kind === "object"
        ? term("ObjectProperty").toLowerCase()
        : kind === "datatype"
          ? term("DatatypeProperty").toLowerCase()
          : kind === "annotation"
            ? term("AnnotationProperty").toLowerCase()
            : kind === "individual"
              ? term("Individual").toLowerCase()
              : "entity";

  if (direction === "outgoing") {
    return (
      <InfoModalShell
        title="Outgoing assertions"
        onClose={onClose}
        footer={
          <>
            An <em>assertion</em> is an RDF triple:{" "}
            <code className="font-mono">&lt;subject&gt; &lt;predicate&gt; &lt;object&gt;</code>.
            Outgoing means this {subjectTerm} is the subject.
          </>
        }
      >
        <p>
          These are the facts this {subjectTerm} asserts about itself — everything where it appears
          as the subject of a triple.
        </p>
        <p>
          Typical examples: <code className="font-mono">rdfs:label</code> (the human-readable name),{" "}
          <code className="font-mono">rdfs:comment</code> (a description),{" "}
          <code className="font-mono">rdfs:subClassOf</code> /{" "}
          <code className="font-mono">rdfs:subPropertyOf</code> (hierarchy), and{" "}
          <code className="font-mono">rdfs:domain</code> /{" "}
          <code className="font-mono">rdfs:range</code> on properties.
        </p>
        <p>
          Some predicates get their own dedicated rows above (Characteristics, Axioms) and are
          hidden from this list so every fact only appears once. Everything else — plus any custom
          annotation you've added — shows up here. Hover a row and the trash icon lets you delete
          it.
        </p>
        <p>
          Use <strong>+ Add assertion</strong> in the top right to add an arbitrary triple with this{" "}
          {subjectTerm} as the subject.
        </p>
      </InfoModalShell>
    );
  }
  return (
    <InfoModalShell
      title="Incoming assertions"
      onClose={onClose}
      footer={
        <>
          Incoming means this {subjectTerm} appears as the <em>object</em> of some triple asserted
          elsewhere in the ontology.
        </>
      }
    >
      <p>
        These are facts other entities assert <em>about</em> this {subjectTerm} — triples where it's
        the object rather than the subject.
      </p>
      {kind === "class" && (
        <p>
          Common incoming assertions on a class: its <strong>subclasses</strong> (
          <code className="font-mono">?child rdfs:subClassOf &lt;this&gt;</code>
          ), any <strong>individuals</strong> typed as this class (
          <code className="font-mono">?i a &lt;this&gt;</code>
          ), and properties that declare this class as their{" "}
          <code className="font-mono">rdfs:domain</code> or{" "}
          <code className="font-mono">rdfs:range</code>.
        </p>
      )}
      {(kind === "object" ||
        kind === "datatype" ||
        kind === "annotation" ||
        kind === "property") && (
        <p>
          Common incoming assertions on a property: individuals that use it (
          <code className="font-mono">?i &lt;this&gt; ?v</code>) and any child properties that
          declare <code className="font-mono">rdfs:subPropertyOf &lt;this&gt;</code>.
        </p>
      )}
      {kind === "individual" && (
        <p>
          Common incoming assertions on an individual: other individuals that relate to it via some
          property, or type assertions referencing it.
        </p>
      )}
      <p>
        Entries here are read-only — to remove one, edit the source entity. Mirror-direction axioms
        (like equivalent-class or inverse-of) are shown in the Axioms row instead so each axiom only
        surfaces once.
      </p>
    </InfoModalShell>
  );
}

// Describes the four axiom predicates surfaced by the Axioms row. Shows only
// the axioms that apply to the current kind (classes vs properties; inverseOf
// is object-property-only), so the reference sheet stays scoped.
function AxiomsInfoModal({ kind, onClose }) {
  const isPropertyKind =
    kind === "object" || kind === "datatype" || kind === "annotation" || kind === "property";
  const isClassKind = kind === "class";
  const items = [];
  if (isClassKind) {
    items.push({
      label: "Equivalent classes",
      predicate: "owl:equivalentClass",
      text: "Asserts that two classes have exactly the same instances. Anything that is an instance of one is automatically an instance of the other. A reasoner uses this to merge inferred memberships from both sides.",
      note: "Symmetric: asserted from either side; the Axioms row shows the relation wherever it lives.",
    });
    items.push({
      label: "Disjoint with",
      predicate: "owl:disjointWith",
      text: "Asserts that the two classes share no instances — no individual can belong to both. Useful for keeping sibling categories from quietly overlapping.",
      note: "Symmetric: asserting A disjointWith B is the same as B disjointWith A.",
    });
  }
  if (isPropertyKind) {
    if (kind === "object" || kind === "property") {
      items.push({
        label: "Inverse of",
        predicate: "owl:inverseOf",
        text: "Declares that two object properties are mirrors: if x P1 y then y P2 x, and vice versa. Classic examples: hasParent / hasChild, or employs / worksFor.",
        note: "Object properties only. Symmetric: the UI reads both sides and the same relation shows up on either property.",
      });
    }
    items.push({
      label: "Sub-property of",
      predicate: "rdfs:subPropertyOf",
      text: "States that every use of this property also implies the parent property. If hasMother is a sub-property of hasParent, then x hasMother y entails x hasParent y.",
      note: "Directional (not symmetric). Parent properties list their children as incoming assertions.",
    });
  }
  return (
    <InfoModalShell
      title="Axioms"
      onClose={onClose}
      footer={
        <>
          <div>
            Stored as plain RDF triples (
            <code className="font-mono">&lt;this&gt; &lt;predicate&gt; &lt;other&gt;</code>
            ). Reasoners use these to infer new facts across the ontology.
          </div>
          <div>
            Reference:{" "}
            <a
              className="text-brand-300 hover:underline"
              href="https://www.w3.org/TR/owl2-primer/"
              target="_blank"
              rel="noopener noreferrer"
            >
              W3C OWL 2 Primer
            </a>
            {" · "}
            <a
              className="text-brand-300 hover:underline"
              href="https://protegeproject.github.io/protege/views/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Protégé views documentation
            </a>
            .
          </div>
        </>
      }
    >
      <p className="text-xs text-slate-400">
        Axioms capture semantic relationships between classes or between properties. They go beyond
        plain annotations — they let a reasoner draw conclusions.
      </p>
      <dl className="space-y-3">
        {items.map((it) => (
          <div key={it.label} className="bg-ink-900/60 border border-ink-700/60 rounded-md p-3">
            <dt className="flex items-center justify-between gap-2 mb-1">
              <span className="font-semibold text-slate-100">{it.label}</span>
              <code className="text-[10px] font-mono text-brand-300/80">{it.predicate}</code>
            </dt>
            <dd className="text-sm text-slate-300 leading-relaxed">{it.text}</dd>
            <dd className="text-[11px] text-slate-500 mt-1">{it.note}</dd>
          </div>
        ))}
      </dl>
    </InfoModalShell>
  );
}

// Annotations row: free-form IRI pickers for rdfs:seeAlso and
// rdfs:isDefinedBy (commonly URLs pointing at external docs / vocab sources)
// plus a single checkbox that flips owl:deprecated on or off. Annotations
// apply to every entity kind, so this section is always rendered.
function AnnotationsSection({
  kind,
  targets,
  deprecated,
  onSetTargets,
  onToggleDeprecated,
  onInfo,
  readOnly,
}) {
  const subjectTerm =
    kind === "class"
      ? term("Class").toLowerCase()
      : kind === "object"
        ? term("ObjectProperty").toLowerCase()
        : kind === "datatype"
          ? term("DatatypeProperty").toLowerCase()
          : kind === "annotation"
            ? term("AnnotationProperty").toLowerCase()
            : kind === "individual"
              ? term("Individual").toLowerCase()
              : "entity";

  return (
    <section className="panel">
      <header className="px-4 py-2 border-b border-ink-700 text-xs uppercase tracking-wider text-slate-400 flex items-center justify-between gap-2">
        <span>Annotations</span>
        <span className="flex items-center gap-2">
          <span className="text-[10px] normal-case tracking-normal text-slate-500">
            Supplementary metadata about this {subjectTerm}
          </span>
          {onInfo && <InfoIconButton onClick={onInfo} label="What do these annotations mean?" />}
        </span>
      </header>
      <div className="divide-y divide-ink-700/60">
        <AnnotationIriRow
          predicate={RDFS_SEE_ALSO}
          title="See also"
          hint="Point at a related resource, often an external URL."
          placeholder="https://example.com/related-page"
          targets={targets[RDFS_SEE_ALSO] || []}
          onSetTargets={onSetTargets}
          readOnly={readOnly}
        />
        <AnnotationIriRow
          predicate={RDFS_IS_DEFINED_BY}
          title="Is defined by"
          hint="Point at the authoritative source for this term (spec, schema, dataset, document)."
          placeholder="https://example.org/vocab/thing"
          targets={targets[RDFS_IS_DEFINED_BY] || []}
          onSetTargets={onSetTargets}
          readOnly={readOnly}
        />
        <DeprecatedRow
          deprecated={deprecated}
          onToggle={onToggleDeprecated}
          subjectTerm={subjectTerm}
          readOnly={readOnly}
        />
      </div>
    </section>
  );
}

// Free-form IRI chip picker used by seeAlso / isDefinedBy. Targets are almost
// always URLs, so unlike the axiom rows we don't try to build a dropdown of
// in-ontology candidates — a text input with basic URL/IRI sniffing is the
// cleaner UX.
function AnnotationIriRow({
  predicate,
  title,
  hint,
  placeholder,
  targets,
  onSetTargets,
  readOnly,
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState(null);

  const looksLikeIri = (s) => {
    // Permissive check: any absolute IRI-ish string. We keep it loose because
    // OWL allows any IRI here, including non-http schemes (urn:, mailto:).
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/.test((s || "").trim());
  };

  const add = async () => {
    const v = draft.trim();
    if (!v) return;
    if (!looksLikeIri(v)) {
      setErr("Enter an absolute IRI (e.g. https://example.com/…)");
      return;
    }
    if (targets.includes(v)) {
      setErr("Already listed.");
      return;
    }
    setErr(null);
    await onSetTargets(predicate, [...targets, v]);
    setDraft("");
    setAdding(false);
  };
  const remove = async (t) => {
    await onSetTargets(
      predicate,
      targets.filter((x) => x !== t),
    );
  };

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-slate-200">{title}</div>
          <div className="text-[10px] text-slate-500">{hint}</div>
        </div>
        {!adding && !readOnly && (
          <button
            type="button"
            className="btn-ghost text-[11px]"
            onClick={() => {
              setAdding(true);
              setErr(null);
            }}
            title={`Add ${title.toLowerCase()}`}
          >
            + Add
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {targets.length === 0 && !adding && (
          <span className="text-[11px] text-slate-500">None</span>
        )}
        {targets.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-ink-800 border border-ink-600 text-slate-200 max-w-full"
            title={t}
          >
            <a
              className="font-mono truncate max-w-md hover:text-brand-200"
              href={t}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t}
            </a>
            {!readOnly && (
              <button
                type="button"
                onClick={() => remove(t)}
                className="text-slate-500 hover:text-red-300 transition shrink-0"
                title="Remove"
                aria-label={`Remove ${t}`}
              >
                <X size={10} strokeWidth={3} aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
      </div>
      {adding && (
        <div className="pt-1 space-y-1">
          <div className="flex items-center gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              value={draft}
              placeholder={placeholder}
              onChange={(e) => {
                setDraft(e.target.value);
                if (err) setErr(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={!draft.trim()}
              onClick={add}
            >
              Add
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => {
                setAdding(false);
                setDraft("");
                setErr(null);
              }}
            >
              Cancel
            </button>
          </div>
          {err && <div className="text-[11px] text-red-300">{err}</div>}
        </div>
      )}
    </div>
  );
}

function DeprecatedRow({ deprecated, onToggle, subjectTerm, readOnly }) {
  const id = "deprecated-toggle";
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-3">
      <div>
        <div className="text-xs font-semibold text-slate-200">Deprecated</div>
        <div className="text-[10px] text-slate-500">
          Flag this {subjectTerm} as retired. It stays in the ontology but is rendered with a
          strike-through everywhere.
        </div>
      </div>
      <label htmlFor={id} className="inline-flex items-center gap-2 cursor-pointer select-none">
        <input
          id={id}
          type="checkbox"
          className="h-4 w-4 accent-brand-500"
          checked={!!deprecated}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={readOnly}
        />
        <span
          className={`text-xs ${deprecated ? "text-amber-300 font-semibold" : "text-slate-400"}`}
        >
          {deprecated ? "owl:deprecated = true" : "Active"}
        </span>
      </label>
    </div>
  );
}

// Describes the three annotation predicates surfaced by the Annotations row.
function AnnotationsInfoModal({ kind, onClose }) {
  const subjectTerm =
    kind === "class"
      ? term("Class").toLowerCase()
      : kind === "object"
        ? term("ObjectProperty").toLowerCase()
        : kind === "datatype"
          ? term("DatatypeProperty").toLowerCase()
          : kind === "annotation"
            ? term("AnnotationProperty").toLowerCase()
            : kind === "individual"
              ? term("Individual").toLowerCase()
              : "entity";
  const items = [
    {
      label: "See also",
      predicate: "rdfs:seeAlso",
      text: `A pointer at another resource that may be helpful when looking at this ${subjectTerm} — typically an external URL (docs, related vocabulary, a paper). Purely informational: no formal semantics are implied.`,
    },
    {
      label: "Is defined by",
      predicate: "rdfs:isDefinedBy",
      text: `Names the authoritative source for this ${subjectTerm} — the document, schema, or vocabulary where it's formally defined. Useful when importing terms from external ontologies.`,
    },
    {
      label: "Deprecated",
      predicate: "owl:deprecated",
      text: `Marks this ${subjectTerm} as retired. Tools (including this one) render deprecated entities with a strike-through so consumers know not to rely on them, but the triple stays in place so existing references keep resolving.`,
    },
  ];
  return (
    <InfoModalShell
      title="Annotations"
      onClose={onClose}
      footer={
        <>
          <div>
            Stored as plain RDF triples on this {subjectTerm}. Unlike axioms, annotations carry no
            reasoning semantics — a reasoner won't infer new facts from them.
          </div>
          <div>
            Reference:{" "}
            <a
              className="text-brand-300 hover:underline"
              href="https://www.w3.org/TR/owl2-primer/#Annotations"
              target="_blank"
              rel="noopener noreferrer"
            >
              W3C OWL 2 Primer — Annotations
            </a>
            .
          </div>
        </>
      }
    >
      <p className="text-xs text-slate-400">
        Annotations are the "metadata about the metadata" of your ontology: human-oriented links,
        provenance, lifecycle flags. They're safe to change without affecting the logical model.
      </p>
      <dl className="space-y-3">
        {items.map((it) => (
          <div key={it.label} className="bg-ink-900/60 border border-ink-700/60 rounded-md p-3">
            <dt className="flex items-center justify-between gap-2 mb-1">
              <span className="font-semibold text-slate-100">{it.label}</span>
              <code className="text-[10px] font-mono text-brand-300/80">{it.predicate}</code>
            </dt>
            <dd className="text-sm text-slate-300 leading-relaxed">{it.text}</dd>
          </div>
        ))}
      </dl>
    </InfoModalShell>
  );
}

function _Empty() {
  return <div className="px-4 py-3 text-xs text-slate-500">None</div>;
}

function TripleRow({ s, p, o, onDelete }) {
  return (
    <div className="px-4 py-2 flex items-start gap-3 group hover:bg-ink-800/50">
      <div className="flex-1 text-sm font-mono break-all">
        {s && (
          <>
            <span className="text-amber-300">{resourceLabel(s.value)}</span> ·{" "}
          </>
        )}
        <span className="text-brand-300">{predicateLabel(p.value).toLowerCase()}</span>
        {o && (
          <>
            {" "}
            →{" "}
            <span className={o.type === "literal" ? "text-emerald-300" : "text-slate-200"}>
              {o.type === "literal" ? `"${o.value}"` : resourceLabel(o.value)}
            </span>
          </>
        )}
      </div>
      {onDelete && (
        <button
          type="button"
          className="btn-ghost text-xs opacity-0 group-hover:opacity-100 transition"
          onClick={onDelete}
          title="Delete triple"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function AddTripleModal({ iri, onClose, onAdded }) {
  const [p, setP] = useState("http://www.w3.org/2000/01/rdf-schema#label");
  const [o, setO] = useState("");
  const [kind, setKind] = useState("literal");
  const [datatype, setDatatype] = useState("");
  const [language, setLanguage] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.addTriple({
        s: iri,
        p,
        o,
        objectKind: kind,
        datatype: datatype || undefined,
        language: language || undefined,
      });
      onAdded();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-xs grid place-items-center z-50"
      role="presentation"
    >
      <div role="presentation" className="panel w-full max-w-lg p-5">
        <h3 className="font-semibold mb-4">Add assertion</h3>
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="label">Predicate IRI</span>
            <input className="input" value={p} onChange={(e) => setP(e.target.value)} required />
          </label>
          <label className="block">
            <span className="label">Object kind</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="literal">Literal</option>
              <option value="uri">IRI</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Object value</span>
            <input className="input" value={o} onChange={(e) => setO(e.target.value)} required />
          </label>
          {kind === "literal" && (
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className="label">Datatype IRI (optional)</span>
                <input
                  className="input"
                  value={datatype}
                  onChange={(e) => setDatatype(e.target.value)}
                  placeholder="http://www.w3.org/2001/XMLSchema#integer"
                />
              </label>
              <label>
                <span className="label">Language tag (optional)</span>
                <input
                  className="input"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  placeholder="en"
                />
              </label>
            </div>
          )}
          {err && <div className="text-sm text-red-300">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "…" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// OWLExpressionsSection — read-only display of blank-node OWL expressions
// (owl:Restriction, anonymous class intersectionOf / unionOf / complementOf).
// Data comes from api.entityExpressions(iri) → { topLevel, bnodeMap }.
// ═══════════════════════════════════════════════════════════════════════════
const _E_RDF_FIRST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
const _E_RDF_REST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
const _E_OWL_RESTRICTION = "http://www.w3.org/2002/07/owl#Restriction";
const _E_OWL_ON_PROPERTY = "http://www.w3.org/2002/07/owl#onProperty";
const _E_OWL_SOME_VALUES_FROM = "http://www.w3.org/2002/07/owl#someValuesFrom";
const _E_OWL_ALL_VALUES_FROM = "http://www.w3.org/2002/07/owl#allValuesFrom";
const _E_OWL_HAS_VALUE = "http://www.w3.org/2002/07/owl#hasValue";
const _E_OWL_MIN_CARD = "http://www.w3.org/2002/07/owl#minCardinality";
const _E_OWL_MAX_CARD = "http://www.w3.org/2002/07/owl#maxCardinality";
const _E_OWL_CARD = "http://www.w3.org/2002/07/owl#cardinality";
const _E_OWL_MIN_QUAL = "http://www.w3.org/2002/07/owl#minQualifiedCardinality";
const _E_OWL_MAX_QUAL = "http://www.w3.org/2002/07/owl#maxQualifiedCardinality";
const _E_OWL_QUAL = "http://www.w3.org/2002/07/owl#qualifiedCardinality";
const _E_OWL_ON_CLASS = "http://www.w3.org/2002/07/owl#onClass";
const _E_OWL_INTERSECTION_OF = "http://www.w3.org/2002/07/owl#intersectionOf";
const _E_OWL_UNION_OF = "http://www.w3.org/2002/07/owl#unionOf";
const _E_OWL_COMPLEMENT_OF = "http://www.w3.org/2002/07/owl#complementOf";
const _E_OWL_ONE_OF = "http://www.w3.org/2002/07/owl#oneOf";
const _E_RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const _E_OWL_EQUIV_CLASS = "http://www.w3.org/2002/07/owl#equivalentClass";
const _E_RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** Format an RDF term {type, value, datatype?, language?} as a short human-readable string. */
function _fmtOwlTerm(t) {
  if (!t) return "?";
  if (t.type === "uri") return shortLabel(t.value);
  if (t.type === "literal") {
    const v = `"${t.value}"`;
    if (t.language) return `${v}@${t.language}`;
    if (t.datatype && t.datatype !== "http://www.w3.org/2001/XMLSchema#string")
      return `${v}^^${shortLabel(t.datatype)}`;
    return v;
  }
  return `_:${t.value}`;
}

/** Unwrap an rdf:List blank node into an ordered array of member terms. */
function _unwrapList(bnodeId, bnodeMap) {
  const members = [];
  const visited = new Set();
  let cur = bnodeId;
  while (cur) {
    if (visited.has(cur)) break;
    visited.add(cur);
    const triples = bnodeMap[cur] || [];
    const first = triples.find((t) => t.p === _E_RDF_FIRST)?.o;
    const rest = triples.find((t) => t.p === _E_RDF_REST)?.o;
    if (!first) break;
    members.push(first);
    if (!rest || rest.type === "uri") break; // rdf:nil or unexpected
    cur = rest.type === "bnode" ? rest.value : null;
  }
  return members;
}

/** Render a single RDF term; blank nodes are rendered recursively via ExprTree. */
function _ObjTerm({ term: t, bnodeMap, depth }) {
  if (!t) return null;
  if (t.type === "bnode" && bnodeMap[t.value]) {
    return (
      <span className="inline-block align-top border-l-2 border-ink-600 pl-2 ml-1 mt-0.5">
        <_ExprTree bnodeId={t.value} bnodeMap={bnodeMap} depth={(depth || 0) + 1} />
      </span>
    );
  }
  return (
    <span className={t.type === "literal" ? "text-emerald-300" : "text-slate-100"}>
      {_fmtOwlTerm(t)}
    </span>
  );
}

/** Render one blank-node expression as a compact indented tree. */
function _ExprTree({ bnodeId, bnodeMap, depth = 0 }) {
  if (depth > 8) return <span className="text-slate-600 text-xs">…</span>;
  const triples = bnodeMap[bnodeId] || [];
  const types = triples.filter((t) => t.p === _E_RDF_TYPE).map((t) => t.o?.value);
  const isRestriction = types.includes(_E_OWL_RESTRICTION);
  const findO = (p) => triples.find((t) => t.p === p)?.o;

  // ── owl:Restriction ──────────────────────────────────────────────────────
  if (isRestriction) {
    const onProp = findO(_E_OWL_ON_PROPERTY);
    const onClass = findO(_E_OWL_ON_CLASS);
    const pairs = [
      [_E_OWL_SOME_VALUES_FROM, "some values from"],
      [_E_OWL_ALL_VALUES_FROM, "all values from"],
      [_E_OWL_HAS_VALUE, "has value"],
      [_E_OWL_MIN_CARD, "min cardinality"],
      [_E_OWL_MAX_CARD, "max cardinality"],
      [_E_OWL_CARD, "exactly"],
      [_E_OWL_MIN_QUAL, "min qualified cardinality"],
      [_E_OWL_MAX_QUAL, "max qualified cardinality"],
      [_E_OWL_QUAL, "exactly (qualified)"],
    ];
    const qualPreds = new Set([_E_OWL_MIN_QUAL, _E_OWL_MAX_QUAL, _E_OWL_QUAL]);
    return (
      <div className="font-mono text-xs leading-relaxed">
        <span className="text-amber-300/90 font-semibold">Restriction</span>
        <div className="ml-3 space-y-0">
          {onProp && (
            <div>
              <span className="text-brand-400">on property </span>
              <_ObjTerm term={onProp} bnodeMap={bnodeMap} depth={depth} />
            </div>
          )}
          {pairs.map(([p, label]) => {
            const o = findO(p);
            if (!o) return null;
            return (
              <div key={p}>
                <span className="text-brand-400">{label} </span>
                <_ObjTerm term={o} bnodeMap={bnodeMap} depth={depth} />
                {onClass && qualPreds.has(p) && (
                  <>
                    <span className="text-brand-400"> on class </span>
                    <_ObjTerm term={onClass} bnodeMap={bnodeMap} depth={depth} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── intersectionOf / unionOf / complementOf / oneOf ─────────────────────
  const complement = findO(_E_OWL_COMPLEMENT_OF);
  if (complement) {
    return (
      <div className="font-mono text-xs leading-relaxed">
        <span className="text-amber-300/90 font-semibold">complement of </span>
        <_ObjTerm term={complement} bnodeMap={bnodeMap} depth={depth} />
      </div>
    );
  }

  const intersection = findO(_E_OWL_INTERSECTION_OF);
  const union = findO(_E_OWL_UNION_OF);
  const oneOf = findO(_E_OWL_ONE_OF);
  const listRoot = intersection || union || oneOf;

  if (listRoot) {
    const label = intersection ? "intersection of" : union ? "union of" : "one of";
    const members = listRoot.type === "bnode" ? _unwrapList(listRoot.value, bnodeMap) : [];
    return (
      <div className="font-mono text-xs leading-relaxed">
        <span className="text-amber-300/90 font-semibold">{label}</span>
        <div className="ml-3 space-y-1 mt-0.5">
          {members.length === 0 && <span className="text-slate-500 italic">empty list</span>}
          {members.map((m) => (
            <div key={`${m.type ?? ""}:${m.value ?? ""}`} className="flex items-start gap-1">
              <span className="text-slate-500 shrink-0 select-none">·</span>
              <_ObjTerm term={m} bnodeMap={bnodeMap} depth={depth + 1} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Generic fallback: show all predicate-object pairs ───────────────────
  const nonType = triples.filter((t) => t.p !== _E_RDF_TYPE);
  return (
    <div className="font-mono text-xs leading-relaxed">
      {types.length > 0 && (
        <span className="text-amber-300/90 font-semibold">
          {types.map((t) => shortLabel(t)).join(", ")}
        </span>
      )}
      <div className="ml-3 space-y-0 mt-0.5">
        {nonType.map((t, i) => (
          <div key={`${t.p}:${t.o?.value ?? i}`}>
            <span className="text-brand-400">{shortLabel(t.p)} </span>
            <_ObjTerm term={t.o} bnodeMap={bnodeMap} depth={depth} />
          </div>
        ))}
      </div>
    </div>
  );
}

function _ExprGroup({ title, bnodes, bnodeMap, onDelete }) {
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="text-xs font-semibold text-slate-300">{title}</div>
      <div className="space-y-2">
        {bnodes.map((bn) => (
          <div
            key={bn}
            className="group relative bg-ink-900/60 border border-ink-700/50 rounded-md px-3 py-2"
          >
            <_ExprTree bnodeId={bn} bnodeMap={bnodeMap} />
            {onDelete && (
              <button
                type="button"
                className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-300 transition-opacity"
                title="Remove this expression"
                onClick={() => onDelete(bn)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function OWLExpressionsSection({
  iri,
  topLevel,
  bnodeMap,
  loading,
  onDeleteExpression,
  onAdded,
  propList,
  classList,
  entityIsReadOnly,
}) {
  const [showAddModal, setShowAddModal] = useState(false);

  // Group by predicate
  const byPred = new Map();
  for (const { predicate, bnode } of topLevel) {
    if (!predicate || !bnode) continue;
    if (!byPred.has(predicate)) byPred.set(predicate, []);
    byPred.get(predicate).push(bnode);
  }

  const restrictions = byPred.get(_E_RDFS_SUB_CLASS_OF) || [];
  const equivalents = byPred.get(_E_OWL_EQUIV_CLASS) || [];
  const others = [];
  for (const [pred, bnodes] of byPred) {
    if (pred === _E_RDFS_SUB_CLASS_OF || pred === _E_OWL_EQUIV_CLASS) continue;
    others.push({ pred, bnodes });
  }

  const hasAny = restrictions.length > 0 || equivalents.length > 0 || others.length > 0;

  return (
    <>
      <section className="panel">
        <header className="px-4 py-2 border-b border-ink-700 text-xs uppercase tracking-wider text-slate-400 flex items-center justify-between gap-2">
          <span>OWL Expressions</span>
          <div className="flex items-center gap-2">
            {!entityIsReadOnly && (
              <button
                type="button"
                className="btn-ghost py-0 px-1 text-[10px] normal-case tracking-normal flex items-center gap-1"
                onClick={() => setShowAddModal(true)}
              >
                <Plus size={10} aria-hidden="true" />
                Add Restriction
              </button>
            )}
            {entityIsReadOnly && (
              <span className="text-[10px] normal-case tracking-normal text-slate-500">
                Anonymous class expressions · read-only
              </span>
            )}
          </div>
        </header>
        <div className="divide-y divide-ink-700/60">
          {loading && (
            <div className="px-4 py-3 text-xs text-slate-500 animate-pulse">Loading…</div>
          )}
          {!loading && !hasAny && (
            <div className="px-4 py-3 text-xs text-slate-500">No OWL expressions defined.</div>
          )}
          {restrictions.length > 0 && (
            <_ExprGroup
              title="Restrictions (rdfs:subClassOf)"
              bnodes={restrictions}
              bnodeMap={bnodeMap}
              onDelete={
                !entityIsReadOnly ? (bn) => onDeleteExpression?.(_E_RDFS_SUB_CLASS_OF, bn) : null
              }
            />
          )}
          {equivalents.length > 0 && (
            <_ExprGroup
              title="Equivalent Class Expressions (owl:equivalentClass)"
              bnodes={equivalents}
              bnodeMap={bnodeMap}
              onDelete={
                !entityIsReadOnly ? (bn) => onDeleteExpression?.(_E_OWL_EQUIV_CLASS, bn) : null
              }
            />
          )}
          {others.map(({ pred, bnodes }) => (
            <_ExprGroup
              key={pred}
              title={`${shortLabel(pred)} (anonymous)`}
              bnodes={bnodes}
              bnodeMap={bnodeMap}
              onDelete={!entityIsReadOnly ? (bn) => onDeleteExpression?.(pred, bn) : null}
            />
          ))}
        </div>
      </section>
      {showAddModal && (
        <AddRestrictionModal
          iri={iri}
          propList={propList}
          classList={classList}
          onAdded={() => {
            onAdded?.();
            setShowAddModal(false);
          }}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </>
  );
}

// ── AddRestrictionModal ──────────────────────────────────────────────────────
// Modal for adding a new owl:Restriction to a class via rdfs:subClassOf.
// Supports all common OWL 2 restriction patterns:
//   - Cardinality: min N, max N, exactly N
//   - Quantifier: some values from (∃), all values from (∀)
//   - Value: has value (=)
const _ADD_CONSTRAINT_TYPES = [
  { value: "minCardinality", label: "Min cardinality" },
  { value: "maxCardinality", label: "Max cardinality" },
  { value: "cardinality", label: "Exactly N" },
  { value: "someValuesFrom", label: "Some values from (∃)" },
  { value: "allValuesFrom", label: "All values from (∀)" },
  { value: "hasValue", label: "Has value (=)" },
];
const _CARD_TYPES = new Set(["minCardinality", "maxCardinality", "cardinality"]);
const _CLASS_TYPES = new Set(["someValuesFrom", "allValuesFrom"]);

function AddRestrictionModal({ iri, propList, classList, onAdded, onClose }) {
  const [predicate, setPredicate] = useState(_E_RDFS_SUB_CLASS_OF);
  const [onProperty, setOnProperty] = useState("");
  const [constraintType, setConstraintType] = useState("minCardinality");
  const [value, setValue] = useState("1");
  const [valueKind, setValueKind] = useState("literal");
  const [datatype, setDatatype] = useState("http://www.w3.org/2001/XMLSchema#string");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const isCardinality = _CARD_TYPES.has(constraintType);
  const isClass = _CLASS_TYPES.has(constraintType);
  const isHasValue = constraintType === "hasValue";

  const handleConstraintTypeChange = (ct) => {
    setConstraintType(ct);
    setErr(null);
    setValue(_CARD_TYPES.has(ct) ? "1" : "");
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!onProperty) {
      setErr("Property is required");
      return;
    }
    if (!value && !isCardinality) {
      setErr("Value is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.addRestriction({
        iri,
        predicate,
        onProperty,
        constraintType,
        value: isCardinality ? Number.parseInt(value, 10) : value,
        valueKind: isHasValue ? valueKind : isClass ? "uri" : "literal",
        datatype: isHasValue && valueKind === "literal" ? datatype : undefined,
      });
      onAdded();
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close modal"
        className="absolute inset-0 bg-black/60 backdrop-blur-xs"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        className="relative panel w-full max-w-sm p-5"
        role="dialog"
        aria-label="Add Restriction"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-sm">Add Restriction</h3>
          <button type="button" className="btn-ghost p-1" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="label">Via predicate</span>
            <select
              className="input"
              value={predicate}
              onChange={(e) => setPredicate(e.target.value)}
            >
              <option value={_E_RDFS_SUB_CLASS_OF}>rdfs:subClassOf (Restriction)</option>
            </select>
          </label>
          <label className="block">
            <span className="label">On property</span>
            <select
              className="input"
              value={onProperty}
              onChange={(e) => setOnProperty(e.target.value)}
              required
            >
              <option value="">Select a property…</option>
              {(propList || []).map((p) => {
                const pIri = p.iri?.value;
                if (!pIri) return null;
                return (
                  <option key={pIri} value={pIri}>
                    {p.prefLabel?.value || p.label?.value || shortLabel(pIri)}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="block">
            <span className="label">Constraint type</span>
            <select
              className="input"
              value={constraintType}
              onChange={(e) => handleConstraintTypeChange(e.target.value)}
            >
              {_ADD_CONSTRAINT_TYPES.map((ct) => (
                <option key={ct.value} value={ct.value}>
                  {ct.label}
                </option>
              ))}
            </select>
          </label>
          {isCardinality && (
            <label className="block">
              <span className="label">Cardinality (≥ 0)</span>
              <input
                className="input"
                type="number"
                min="0"
                step="1"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
              />
            </label>
          )}
          {isClass && (
            <label className="block">
              <span className="label">Class</span>
              <select
                className="input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
              >
                <option value="">Select a class…</option>
                {(classList || []).map((c) => {
                  const cIri = c.iri?.value;
                  if (!cIri) return null;
                  return (
                    <option key={cIri} value={cIri}>
                      {c.prefLabel?.value || c.label?.value || shortLabel(cIri)}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
          {isHasValue && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <span className="label">Value kind</span>
                  <select
                    className="input"
                    value={valueKind}
                    onChange={(e) => setValueKind(e.target.value)}
                  >
                    <option value="literal">Literal</option>
                    <option value="uri">IRI</option>
                  </select>
                </label>
                {valueKind === "literal" && (
                  <label>
                    <span className="label">Datatype</span>
                    <select
                      className="input"
                      value={datatype}
                      onChange={(e) => setDatatype(e.target.value)}
                    >
                      <option value="http://www.w3.org/2001/XMLSchema#string">xsd:string</option>
                      <option value="http://www.w3.org/2001/XMLSchema#integer">xsd:integer</option>
                      <option value="http://www.w3.org/2001/XMLSchema#boolean">xsd:boolean</option>
                      <option value="http://www.w3.org/2001/XMLSchema#anyURI">xsd:anyURI</option>
                    </select>
                  </label>
                )}
              </div>
              <label className="block">
                <span className="label">{valueKind === "uri" ? "IRI" : "Value"}</span>
                <input
                  className="input"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  required
                  placeholder={valueKind === "uri" ? "https://example.org/…" : "some value"}
                />
              </label>
            </>
          )}
          {err && <p className="text-xs text-red-300">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "…" : "Add Restriction"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── EntityKebabMenu ──────────────────────────────────────────────────────────
// Three-dot action menu shown in compact (graph panel) mode. Keeps dangerous
// actions (Delete) one click away without cluttering the panel header.
// Resolve the editor route for a given entity kind.
function routeForEntityKind(kind) {
  if (kind === "individual") return "/individuals";
  if (kind === "object" || kind === "datatype" || kind === "annotation" || kind === "property")
    return "/properties/relationships";
  return "/classes";
}

function EntityKebabMenu({ iri, kind, onDelete, deleteDisabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const openView = () => {
    setOpen(false);
    const route = routeForEntityKind(kind);
    navigate(`${route}#iri=${encodeURIComponent(iri)}`);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="btn-ghost p-1"
        onClick={() => setOpen((o) => !o)}
        title="Actions"
        aria-label="Actions menu"
      >
        <MoreVertical size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-ink-800 border border-ink-600 rounded-md shadow-2xl shadow-black/60 z-30 overflow-hidden">
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-ink-700/60 transition-colors flex items-center gap-2"
            onClick={openView}
          >
            View {term(kind)}
          </button>
          <div className="border-t border-ink-700/60" />
          <button
            type="button"
            className={`w-full text-left px-3 py-2 text-sm transition-colors ${deleteDisabled ? "text-slate-600 cursor-not-allowed" : "text-red-300 hover:bg-ink-700/60"}`}
            onClick={
              deleteDisabled
                ? undefined
                : () => {
                    setOpen(false);
                    onDelete();
                  }
            }
            disabled={deleteDisabled}
            title={deleteDisabled ? "This entity is defined in a read-only ontology" : undefined}
          >
            Delete entity…
          </button>
        </div>
      )}
    </div>
  );
}
