import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  Ban,
  ChevronDown,
  ChevronsRight,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { allowedCharacteristics, api, parseIriFromHash, shortLabel, term } from "../lib/api.js";
import { BUILTIN_DATATYPES } from "../lib/datatypes.js";
import { Field, LinkedEntityBanner, Modal } from "./ClassesView.jsx";
import EntityDetail from "./EntityDetail.jsx";
import { useProject } from "./OntologyPicker.jsx";

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 600;
const SIDEBAR_DEFAULT = 320;

// ── Characteristic icon metadata ─────────────────────────────────────────────
// Maps the OWL characteristic name (as stored in p.characteristics[]) to a
// lucide-react icon component and tooltip text for the inline indicator.
const CHAR_META = {
  Functional: { Icon: ArrowRightToLine, title: "Functional – at most one value per subject" },
  InverseFunctional: {
    Icon: ArrowLeftToLine,
    title: "Inverse Functional – at most one subject per value",
  },
  Transitive: { Icon: ChevronsRight, title: "Transitive – if A→B and B→C then A→C" },
  Symmetric: { Icon: ArrowLeftRight, title: "Symmetric – if A→B then B→A" },
  Asymmetric: { Icon: ArrowRight, title: "Asymmetric – if A→B then NOT B→A" },
  Reflexive: { Icon: RotateCcw, title: "Reflexive – every individual relates to itself" },
  Irreflexive: { Icon: Ban, title: "Irreflexive – no individual relates to itself" },
};

export default function PropertiesView({ onChange, fixedKind }) {
  const [props, setProps] = useState([]);
  const [linkedProps, setLinkedProps] = useState([]);
  const [allClasses, setAllClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("");
  const [kindFilter, setKindFilter] = useState(fixedKind || "all");
  const [showNew, setShowNew] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);

  // Reset internal state when route-scoped kind changes
  // (e.g. /properties/relationships -> /properties/attributes)
  const autoSelectedRef = useRef(false);
  const listScrollRef = useRef(null);
  const isDragging = useRef(false);
  useEffect(() => {
    setKindFilter(fixedKind || "all");
    setSelected(null);
    // Re-arm auto-select so the new sub-route picks its own first item.
    autoSelectedRef.current = false;
  }, [fixedKind]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await api.properties();
      setProps(p.properties);
    } catch (_err) {
      setProps([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .classesAll()
      .then((r) => setAllClasses(r.classes || []))
      .catch(() => {});
  }, []);

  const { writeOntologyId, linkedOntologyIds, ontologies } = useProject();

  // Fetch linked context properties when write target or linked set changes.
  useEffect(() => {
    if (!writeOntologyId || !linkedOntologyIds?.length) {
      setLinkedProps([]);
      return;
    }
    api
      .linkedContext(writeOntologyId, linkedOntologyIds)
      .then((r) => setLinkedProps(r.properties || []))
      .catch(() => setLinkedProps([]));
  }, [writeOntologyId, linkedOntologyIds]);

  // Pick up "#iri=..." from deep-links (graph "Edit in …" button, etc.).
  const location = useLocation();
  const navigate = useNavigate();

  // selectEntity: update both React state and URL hash so the selection
  // survives a page refresh and supports browser back/forward navigation.
  const selectEntity = useCallback(
    (iri) => {
      setSelected(iri);
      navigate(`${location.pathname}#iri=${encodeURIComponent(iri)}`, {
        replace: true,
      });
    },
    [navigate, location.pathname],
  );

  useEffect(() => {
    const target = parseIriFromHash(location.hash);
    if (!target) return;
    setSelected(target);
    setFilter("");
  }, [location.hash]);

  // Merge primary + linked properties; linked ones tagged accordingly.
  const allProps = useMemo(() => {
    const primaryIris = new Set(props.map((p) => p.iri?.value).filter(Boolean));
    // Deduplicate linked entries by IRI: the same IRI can appear once per linked
    // ontology in the server response. Keep only the first occurrence.
    const linkedIrisSeen = new Set();
    const linked = [];
    for (const p of linkedProps) {
      if (!p.iri?.value) continue;
      if (primaryIris.has(p.iri.value)) continue;
      if (linkedIrisSeen.has(p.iri.value)) continue;
      linkedIrisSeen.add(p.iri.value);
      linked.push({ ...p, linked: true });
    }
    return [...props, ...linked];
  }, [props, linkedProps]);

  // Selected IRI may be from a linked (read-only) property.
  const selectedLinkedProp = useMemo(() => {
    if (!selected) return null;
    return allProps.find((p) => p.iri.value === selected && p.linked) || null;
  }, [selected, allProps]);

  const importedOntologyNames = useMemo(() => {
    const names = new Set();
    for (const onto of ontologies || []) {
      if (onto.is_imported && !onto.branch_of) names.add(onto.name);
    }
    return names;
  }, [ontologies]);

  const showLinkedBanner =
    !!selectedLinkedProp && !importedOntologyNames.has(selectedLinkedProp.sourceOntologyName);

  // Filter by kind + free text, then sort alphabetically by label (case-insensitive;
  // IRI as tiebreaker so duplicate labels stay stable).
  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    const out = allProps.filter((p) => {
      if (kindFilter !== "all" && p.kind?.value !== kindFilter) return false;
      if (!filter) return true;
      return (
        p.iri.value.toLowerCase().includes(q) ||
        (p.prefLabel?.value || p.label?.value || "").toLowerCase().includes(q)
      );
    });
    out.sort((a, b) => {
      const al = (a.prefLabel?.value || a.label?.value || shortLabel(a.iri.value)).toLowerCase();
      const bl = (b.prefLabel?.value || b.label?.value || shortLabel(b.iri.value)).toLowerCase();
      if (al < bl) return -1;
      if (al > bl) return 1;
      return a.iri.value < b.iri.value ? -1 : a.iri.value > b.iri.value ? 1 : 0;
    });
    return out;
  }, [allProps, filter, kindFilter]);

  // Build a transitive ancestor map: classIri → Set<ancestorIri>.
  // Derived from the `parents` arrays returned by classesAll().
  const ancestorMap = useMemo(() => {
    const directParents = new Map();
    for (const c of allClasses) {
      if (c.iri?.value) directParents.set(c.iri.value, c.parents || []);
    }
    const cache = new Map();
    function ancestors(iri) {
      if (cache.has(iri)) return cache.get(iri);
      const set = new Set();
      cache.set(iri, set); // early set to break cycles
      for (const p of directParents.get(iri) || []) {
        set.add(p);
        for (const a of ancestors(p)) set.add(a);
      }
      return set;
    }
    for (const iri of directParents.keys()) ancestors(iri);
    return cache;
  }, [allClasses]);

  // Build a parent-child ordered list: properties that explicitly declare
  // owl:inverseOf are inserted immediately after their referenced parent and
  // flagged as `_isInverseChild`. Mutual declarations (both sides declare the
  // other) are treated as siblings at the top level to avoid circular nesting.
  //
  // Parents are also tagged `_invMismatch: true` when the inverse child's
  // domain/range is not the proper reversal of the parent's domain/range.
  // Specifically: if parent has domain X → range Y, the child should have
  // domain Y → range X. Mismatches are only flagged when both sides have at
  // least one of domain/range declared (so unset values are not penalised).
  const orderedFiltered = useMemo(() => {
    const filteredIriSet = new Set(filtered.map((p) => p.iri.value));
    const propByIri = new Map(filtered.map((p) => [p.iri.value, p]));
    const isChild = new Set();
    const childrenOf = new Map(); // parentIri → childIri[]

    for (const p of filtered) {
      const parentIri = p.explicitInvOf?.[0];
      if (!parentIri || !filteredIriSet.has(parentIri)) continue;
      // Skip mutual: if the parent also declares THIS property as its inverse,
      // treat both as top-level siblings.
      const parent = propByIri.get(parentIri);
      if (parent?.explicitInvOf?.[0] === p.iri.value) continue;
      isChild.add(p.iri.value);
      if (!childrenOf.has(parentIri)) childrenOf.set(parentIri, []);
      childrenOf.get(parentIri).push(p.iri.value);
    }

    // Helper: true when two Sets contain exactly the same string values.
    const setsEqual = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));

    // Returns a human-readable mismatch reason string when the parent/child pair
    // declare domain/range that are NOT the proper reversal of each other, or
    // null when everything is consistent (or when too little is declared to judge).
    //
    // Uses the full `domains` / `ranges` arrays from the server (which capture
    // every rdfs:domain / rdfs:range triple for a property) rather than the
    // single first-row values in `domain?.value` / `range?.value`, so multi-
    // class domain/range declarations (e.g. domain = [ThreatActor, Malware,
    // Campaign]) are compared as sets and don't generate false positives.
    const getMismatchReason = (parentIri, childIri) => {
      const par = propByIri.get(parentIri);
      const chi = propByIri.get(childIri);
      if (!par || !chi) return null;

      // Prefer the full arrays; fall back to the single-value field if the
      // server is running an older version that doesn't yet send the arrays.
      const pDoms = par.domains?.length ? par.domains : par.domain?.value ? [par.domain.value] : [];
      const pRngs = par.ranges?.length ? par.ranges : par.range?.value ? [par.range.value] : [];
      const cDoms = chi.domains?.length ? chi.domains : chi.domain?.value ? [chi.domain.value] : [];
      const cRngs = chi.ranges?.length ? chi.ranges : chi.range?.value ? [chi.range.value] : [];

      // Only warn when both sides have declared at least one domain or range.
      if ((!pDoms.length && !pRngs.length) || (!cDoms.length && !cRngs.length)) return null;

      // parent.domains should equal child.ranges (and vice versa).
      // If either side hasn't declared that endpoint at all we skip the check —
      // an undeclared domain/range is intentionally unconstrained, not wrong.
      const domRngOk =
        pDoms.length === 0 || cRngs.length === 0 || setsEqual(new Set(pDoms), new Set(cRngs));
      const rngDomOk =
        pRngs.length === 0 || cDoms.length === 0 || setsEqual(new Set(pRngs), new Set(cDoms));

      if (domRngOk && rngDomOk) return null;

      // Build a concise reason string for the tooltip.
      const reasons = [];
      if (!domRngOk) {
        reasons.push(
          `domain [${pDoms.map(shortLabel).join(", ")}] ≠ inverse range [${cRngs.map(shortLabel).join(", ")}]`,
        );
      }
      if (!rngDomOk) {
        reasons.push(
          `range [${pRngs.map(shortLabel).join(", ")}] ≠ inverse domain [${cDoms.map(shortLabel).join(", ")}]`,
        );
      }
      return reasons.join("; ");
    };

    // Check if a property has domain or range entries where one is a
    // descendant of another in the same list (making the child redundant).
    const getRedundantDomainRange = (p) => {
      const doms = p.domains?.length ? p.domains : p.domain?.value ? [p.domain.value] : [];
      const rngs = p.ranges?.length ? p.ranges : p.range?.value ? [p.range.value] : [];

      const redundantDoms = doms.filter((d) =>
        doms.some((other) => other !== d && ancestorMap.get(d)?.has(other)),
      );
      const redundantRngs = rngs.filter((r) =>
        rngs.some((other) => other !== r && ancestorMap.get(r)?.has(other)),
      );

      if (!redundantDoms.length && !redundantRngs.length) return null;
      const parts = [];
      if (redundantDoms.length)
        parts.push(
          `${term("domain")} [${redundantDoms.map(shortLabel).join(", ")}] already implied by ancestor`,
        );
      if (redundantRngs.length)
        parts.push(
          `${term("range")} [${redundantRngs.map(shortLabel).join(", ")}] already implied by ancestor`,
        );
      return parts.join("; ");
    };

    const result = [];
    for (const p of filtered) {
      if (isChild.has(p.iri.value)) continue; // will be inserted after parent
      const childIris = childrenOf.get(p.iri.value) || [];
      // Collect the first non-null reason across all inverse children.
      const invMismatch = childIris.reduce(
        (acc, ci) => acc || getMismatchReason(p.iri.value, ci),
        null,
      );
      const redundantDomainRange = getRedundantDomainRange(p);
      const tagged = invMismatch || redundantDomainRange ? { ...p } : p;
      if (invMismatch) tagged._invMismatch = invMismatch;
      if (redundantDomainRange) tagged._redundantDomainRange = redundantDomainRange;
      result.push(tagged);
      for (const childIri of childIris) {
        const child = propByIri.get(childIri);
        if (child) result.push({ ...child, _isInverseChild: true });
      }
    }
    return result;
  }, [filtered, ancestorMap]);

  // Default-select the first property once per sub-route. Skips if the hash
  // effect already set one. Re-arms above when fixedKind changes so each
  // /properties/<kind> route picks its own first item.
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (loading) return;
    autoSelectedRef.current = true;
    if (selected) return;
    if (filtered.length > 0) selectEntity(filtered[0].iri.value);
  }, [loading, filtered, selected, selectEntity]);

  // ── Drag-to-resize sidebar ──────────────────────────────────────────────
  const startDrag = useCallback(
    (e) => {
      e.preventDefault();
      isDragging.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      const onMove = (ev) => {
        if (!isDragging.current) return;
        setSidebarWidth(
          Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + ev.clientX - startX)),
        );
      };
      const onUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  return (
    <div className="flex-1 flex min-h-0">
      <div className="shrink-0 flex flex-col overflow-hidden" style={{ width: sidebarWidth }}>
        <div className="p-3 border-b border-ink-700 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{sectionTitle(fixedKind)}</h2>
            <button type="button" className="btn-primary text-xs" onClick={() => setShowNew(true)}>
              + New
            </button>
          </div>
          <input
            className="input"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {!fixedKind && (
            <div className="flex gap-1 text-xs">
              {[
                { k: "all", label: "all" },
                { k: "object", label: term("ObjectProperty").toLowerCase() },
                {
                  k: "datatype",
                  label: term("DatatypeProperty").toLowerCase(),
                },
                { k: "annotation", label: "annotation" },
              ].map(({ k, label }) => (
                <button
                  type="button"
                  key={k}
                  onClick={() => setKindFilter(k)}
                  className={`px-2 py-0.5 rounded-sm border ${kindFilter === k ? "bg-brand-600 text-white border-brand-500" : "border-ink-600 text-slate-400 hover:bg-ink-700"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-auto p-2" ref={listScrollRef}>
          {loading && <div className="text-xs text-slate-500 p-2">Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div className="text-xs text-slate-500 p-2">
              No {term("PropertiesPlural").toLowerCase()}.
            </div>
          )}
          {orderedFiltered.map((p) => {
            const deprecated = !!p.deprecated;
            const isLinked = !!p.linked;
            const isInverse = !!p._isInverseChild;
            // _invMismatch is either null/undefined (no mismatch) or a
            // human-readable reason string produced by getMismatchReason().
            const invMismatch = p._invMismatch || null;
            return (
              <div key={`${p.iri.value}:${p.kind?.value}:${isInverse}`}>
                {isInverse && (
                  <div className="ml-4 pl-1.5 pr-1">
                    <button
                      type="button"
                      onClick={() => selectEntity(p.iri.value)}
                      title={
                        isLinked
                          ? `From: ${p.sourceOntologyName || "linked ontology"} (read-only)`
                          : deprecated
                            ? "Deprecated (owl:deprecated = true)"
                            : `Inverse of: ${p.explicitInvOf?.map((i) => shortLabel(i)).join(", ")}`
                      }
                      className={`w-full text-left px-2 py-1.5 rounded-md text-sm border
                      ${
                        selected === p.iri.value
                          ? isLinked
                            ? "bg-violet-600/20 border-violet-500/40 text-violet-100"
                            : "bg-yellow-400/20 border-yellow-300/40 text-yellow-100"
                          : isLinked
                            ? "border-transparent hover:bg-violet-900/20 text-slate-400"
                            : "border-transparent hover:bg-orange-900/20 text-slate-300"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`font-medium truncate flex-1 text-[0.8125rem] ${deprecated ? "line-through text-slate-400" : ""} ${isLinked ? "italic text-slate-400" : ""}`}
                        >
                          {p.prefLabel?.value || p.label?.value || shortLabel(p.iri.value)}
                        </span>
                        {p.characteristics?.length > 0 && (
                          <span className="shrink-0 flex items-center gap-0.5">
                            {p.characteristics.map((c) => {
                              const m = CHAR_META[c];
                              if (!m) return null;
                              const CharIcon = m.Icon;
                              return (
                                <span key={c} title={m.title} className="flex items-center">
                                  <CharIcon
                                    size={c === "Transitive" ? 15 : 11}
                                    className="text-slate-400 shrink-0"
                                    aria-label={m.title}
                                  />
                                </span>
                              );
                            })}
                          </span>
                        )}
                        {isLinked && p.sourceOntologyName ? (
                          <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-violet-500/20 text-violet-400 truncate max-w-20">
                            {p.sourceOntologyName}
                          </span>
                        ) : (
                          <span className="chip-inv" title="Inverse relationship (owl:inverseOf)">
                            inv
                          </span>
                        )}
                      </div>
                    </button>
                  </div>
                )}
                {!isInverse && (
                  <button
                    type="button"
                    onClick={() => selectEntity(p.iri.value)}
                    title={
                      isLinked
                        ? `From: ${p.sourceOntologyName || "linked ontology"} (read-only)`
                        : deprecated
                          ? "Deprecated (owl:deprecated = true)"
                          : undefined
                    }
                    className={`w-full text-left px-3 py-2 rounded-md text-sm border
                    ${
                      selected === p.iri.value
                        ? isLinked
                          ? "bg-violet-600/20 border-violet-500/40 text-violet-100"
                          : "bg-brand-600/20 border-brand-500/40 text-brand-100"
                        : isLinked
                          ? "border-transparent hover:bg-violet-900/20 text-slate-400"
                          : "border-transparent hover:bg-ink-700/60 text-slate-200"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`font-medium truncate flex-1 ${deprecated ? "line-through text-slate-400" : ""} ${isLinked ? "italic text-slate-400" : ""}`}
                      >
                        {p.prefLabel?.value || p.label?.value || shortLabel(p.iri.value)}
                      </span>
                      {p.characteristics?.length > 0 && (
                        <span className="shrink-0 flex items-center gap-0.5">
                          {p.characteristics.map((c) => {
                            const m = CHAR_META[c];
                            if (!m) return null;
                            const CharIcon = m.Icon;
                            return (
                              <span key={c} title={m.title} className="flex items-center">
                                <CharIcon
                                  size={c === "Transitive" ? 15 : 11}
                                  className="text-slate-400 shrink-0"
                                  aria-label={m.title}
                                />
                              </span>
                            );
                          })}
                        </span>
                      )}
                      {isLinked && p.sourceOntologyName ? (
                        <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-violet-500/20 text-violet-400 truncate max-w-20">
                          {p.sourceOntologyName}
                        </span>
                      ) : (
                        <KindChip kind={p.kind?.value} />
                      )}
                      {invMismatch && (
                        <span
                          title={`Inverse domain/range mismatch: ${invMismatch}`}
                          className="shrink-0 flex items-center"
                        >
                          <AlertTriangle
                            size={12}
                            className="text-red-400"
                            aria-label="Inverse domain/range mismatch"
                          />
                        </span>
                      )}
                      {p._redundantDomainRange && (
                        <span
                          title={`Redundant domain/range: ${p._redundantDomainRange}`}
                          className="shrink-0 flex items-center"
                        >
                          <AlertTriangle
                            size={12}
                            className="text-amber-400"
                            aria-label="Redundant domain/range entry"
                          />
                        </span>
                      )}
                    </div>
                  </button>
                )}
                <hr className="border-ink-800" />
              </div>
            );
          })}
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        aria-hidden="true"
        title="Drag to resize"
        className="group w-0.75 shrink-0 cursor-col-resize relative bg-ink-700/60 hover:bg-brand-500/50 active:bg-brand-500/70 transition-colors select-none"
      >
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center gap-0.75 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
          {[0, 1, 2, 3, 4].map((n) => (
            <span key={n} className="w-0.75 h-0.75 rounded-full bg-brand-300/80" />
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-auto">
        {selected ? (
          <>
            {showLinkedBanner && <LinkedEntityBanner />}
            <EntityDetail
              iri={selected}
              kind={allProps.find((p) => p.iri.value === selected)?.kind?.value || "property"}
              onClose={() => setSelected(null)}
              onDelete={() => {
                setSelected(null);
                const _sv = listScrollRef.current?.scrollTop ?? 0;
                load();
                requestAnimationFrame(() => {
                  if (listScrollRef.current) listScrollRef.current.scrollTop = _sv;
                });
                onChange?.();
              }}
              onUpdate={() => {
                const _sv = listScrollRef.current?.scrollTop ?? 0;
                load();
                requestAnimationFrame(() => {
                  if (listScrollRef.current) listScrollRef.current.scrollTop = _sv;
                });
                onChange?.();
              }}
            />
          </>
        ) : (
          <div className="h-full grid place-items-center text-slate-500 text-sm">
            Select or create a {term("Property").toLowerCase()}.
          </div>
        )}
      </div>

      {showNew && (
        <NewPropertyModal
          initialKind={fixedKind || "object"}
          onClose={() => setShowNew(false)}
          onCreated={(iri) => {
            setShowNew(false);
            const _sv = listScrollRef.current?.scrollTop ?? 0;
            load();
            requestAnimationFrame(() => {
              if (listScrollRef.current) listScrollRef.current.scrollTop = _sv;
            });
            selectEntity(iri);
            onChange?.();
          }}
        />
      )}
    </div>
  );
}

function sectionTitle(fixedKind) {
  if (fixedKind === "object") return term("ObjectPropertyPlural");
  if (fixedKind === "datatype") return term("DatatypePropertyPlural");
  if (fixedKind === "annotation") return "Annotations";
  return term("PropertiesPlural");
}

function KindChip({ kind }) {
  if (!kind) return null;
  const cls = kind === "object" ? "chip-prop" : kind === "datatype" ? "chip-datatype" : "chip";
  const shorts = {
    object: term("ObjectProperty") === "Relationship" ? "rel" : "obj",
    datatype: term("DatatypeProperty") === "Attribute" ? "attr" : "data",
    annotation: "ann",
  };
  const label = shorts[kind] || kind;
  return (
    <span
      className={cls}
      title={term(
        kind === "object"
          ? "ObjectProperty"
          : kind === "datatype"
            ? "DatatypeProperty"
            : "AnnotationProperty",
      )}
    >
      {label}
    </span>
  );
}

// Derive the base IRI prefix from the ontology's declared IRI.
function _iriBase(ontologyIri) {
  const raw = ontologyIri || "http://example.org/ontology";
  return raw.endsWith("#") || raw.endsWith("/") ? raw : `${raw}#`;
}

// Converts a human-readable label to lowerCamelCase for use in a property IRI fragment.
// - Multi-word input: "Has Stone Type" → "hasStoneType"
// - Single-word input already in camelCase: "hasStoneType" → "hasStoneType" (preserved as-is)
function toCamelCase(str) {
  const trimmed = str.trim();
  if (!trimmed) return "";
  // If there are no spaces, the user typed a single token (possibly already camelCase).
  // Strip any non-identifier chars but otherwise preserve the casing they typed.
  if (!/\s/.test(trimmed)) {
    return trimmed.replace(/[^a-zA-Z0-9]/g, "");
  }
  const words = trimmed
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  return (
    words[0].toLowerCase() +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join("")
  );
}

// ── Multi-class selector ────────────────────────────────────────────────────
// A collapsible, searchable checkbox list for selecting one or more ontology classes.
// The picker is collapsed by default to save vertical space.
function MultiClassSelect({ options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef(null);
  const q = search.toLowerCase();
  const visible = q
    ? options.filter((c) => c.label.toLowerCase().includes(q) || c.iri.toLowerCase().includes(q))
    : options;

  const toggle = (iri) =>
    onChange(value.includes(iri) ? value.filter((v) => v !== iri) : [...value, iri]);

  const handleOpen = () => {
    setOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const handleClose = () => {
    setOpen(false);
    setSearch("");
  };

  // Summary label shown on the collapsed trigger button.
  const summary =
    value.length === 0
      ? "None selected"
      : value.length === 1
        ? (options.find((c) => c.iri === value[0])?.label ?? "1 selected")
        : `${value.length} selected`;

  return (
    <div className="border border-ink-600 rounded-md overflow-hidden">
      {/* Collapsed trigger */}
      <button
        type="button"
        onClick={open ? handleClose : handleOpen}
        className="w-full flex items-center justify-between px-2 py-1.5 bg-ink-800 hover:bg-ink-700 transition-colors text-xs"
      >
        <span className={value.length > 0 ? "text-brand-300" : "text-slate-500"}>{summary}</span>
        <ChevronDown
          size={12}
          className={`text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {/* Expanded picker */}
      {open && (
        <>
          <div className="px-2 py-1 border-t border-ink-600 bg-ink-800/60 flex items-center gap-1">
            <input
              ref={searchRef}
              className="flex-1 bg-transparent text-xs text-slate-200 placeholder-slate-500 outline-none"
              placeholder="Search classes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && handleClose()}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="shrink-0 text-slate-500 hover:text-slate-300 text-[10px] leading-none"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          <div className="max-h-36 overflow-auto border-t border-ink-600">
            {visible.length === 0 && (
              <div className="text-xs text-slate-500 px-2 py-1.5">No classes found.</div>
            )}
            {visible.map((c) => {
              const checked = value.includes(c.iri);
              return (
                <label
                  key={c.iri}
                  className={`flex items-center gap-2 px-2 py-1 cursor-pointer text-xs select-none transition
                    ${checked ? "bg-brand-600/15 text-brand-100" : "hover:bg-ink-700 text-slate-300"}`}
                >
                  <input
                    type="checkbox"
                    className="accent-brand-500 shrink-0"
                    checked={checked}
                    onChange={() => toggle(c.iri)}
                  />
                  <span className="truncate">{c.label}</span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function NewPropertyModal({ onClose, onCreated, initialKind = "object" }) {
  const { currentOntology } = useProject();
  const [iri, setIri] = useState(() => `${_iriBase(currentOntology?.iri)}newProperty`);
  const [iriUserEdited, setIriUserEdited] = useState(false);
  const [kind, setKind] = useState(initialKind);
  const [label, setLabel] = useState("");
  const [definition, setDefinition] = useState("");
  // domain is always an array of class IRIs (multi-select for object + datatype)
  const [domains, setDomains] = useState([]);
  // ranges: array of class IRIs for object, single string for datatype, unused for annotation
  const [ranges, setRanges] = useState([]);
  const [rangeDatatype, setRangeDatatype] = useState("");
  const [characteristics, setCharacteristics] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [allClasses, setAllClasses] = useState([]);

  // Load visible-scope classes for domain/range pickers.
  useEffect(() => {
    api
      .classes()
      .then((r) => setAllClasses(r.classes || []))
      .catch(() => {});
  }, []);

  // Reset domain/range when kind changes so stale selections don't carry over.
  useEffect(() => {
    setDomains([]);
    setRanges([]);
    setRangeDatatype("");
    const allowed = new Set(allowedCharacteristics(kind).map((c) => c.name));
    setCharacteristics((prev) => prev.filter((n) => allowed.has(n)));
  }, [kind]);

  // Auto-update the IRI fragment whenever the label changes, unless the user
  // has manually edited the IRI field. Uses camelCase (no spaces).
  useEffect(() => {
    if (iriUserEdited) return;
    const base = _iriBase(currentOntology?.iri);
    const slug = label.trim() ? toCamelCase(label) || "newProperty" : "newProperty";
    setIri(`${base}${slug}`);
  }, [label, iriUserEdited, currentOntology?.iri]);

  const toggleChar = (name) =>
    setCharacteristics((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );

  // Pre-sort class options so pickers are alphabetical.
  const classOptions = useMemo(() => {
    const list = allClasses.map((c) => ({
      iri: c.iri.value,
      label: c.prefLabel?.value || c.label?.value || shortLabel(c.iri.value),
    }));
    list.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    return list;
  }, [allClasses]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // Normalise domain/range to single values or arrays as the API expects.
      const domainVal =
        domains.length === 1 ? domains[0] : domains.length > 1 ? domains : undefined;
      let rangeVal;
      if (kind === "object") {
        rangeVal = ranges.length === 1 ? ranges[0] : ranges.length > 1 ? ranges : undefined;
      } else if (kind === "datatype") {
        rangeVal = rangeDatatype || undefined;
      }
      await api.createProperty({
        iri,
        kind,
        label: label || undefined,
        definition: definition || undefined,
        domain: domainVal,
        range: rangeVal,
        characteristics: characteristics.length ? characteristics : undefined,
      });
      onCreated(iri);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const advancedOptions = allowedCharacteristics(kind);

  return (
    <Modal title={`New ${term("Property").toLowerCase()}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Label">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Kind">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="object">{term("ObjectProperty")}</option>
            <option value="datatype">{term("DatatypeProperty")}</option>
            <option value="annotation">{term("AnnotationProperty")}</option>
          </select>
        </Field>
        <Field label="IRI">
          <input
            className="input"
            value={iri}
            onChange={(e) => {
              setIriUserEdited(true);
              setIri(e.target.value);
            }}
            required
          />
        </Field>
        <Field label="Definition">
          <textarea
            className="input min-h-15"
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
          />
        </Field>

        {/* Domain — shown for object + datatype; hidden for annotation */}
        {kind !== "annotation" && (
          <Field
            label={
              kind === "object"
                ? `${term("domain")} (${term("ClassPlural").toLowerCase()})`
                : `${term("domain")} (${term("ClassPlural").toLowerCase()})`
            }
          >
            <MultiClassSelect options={classOptions} value={domains} onChange={setDomains} />
          </Field>
        )}

        {/* Range — object: multi-class; datatype: single datatype; annotation: hidden */}
        {kind === "object" && (
          <Field label={`${term("range")} (${term("ClassPlural").toLowerCase()})`}>
            <MultiClassSelect options={classOptions} value={ranges} onChange={setRanges} />
          </Field>
        )}
        {kind === "datatype" && (
          <Field label={`${term("Datatype").toLowerCase()}`}>
            <select
              className="input"
              value={rangeDatatype}
              onChange={(e) => setRangeDatatype(e.target.value)}
            >
              <option value="">(none)</option>
              {BUILTIN_DATATYPES.map((dt) => (
                <option key={dt.iri} value={dt.iri}>
                  {dt.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        {advancedOptions.length > 0 && (
          <div className="border-t border-ink-700/80 pt-2">
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="w-full flex items-center justify-between text-xs text-slate-400 hover:text-slate-200"
            >
              <span className="uppercase tracking-wider">
                Advanced · characteristics
                {characteristics.length ? ` (${characteristics.length})` : ""}
              </span>
              <ChevronDown
                size={12}
                className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
            {showAdvanced && (
              <div className="mt-2 flex flex-wrap gap-2">
                {advancedOptions.map((c) => {
                  const on = characteristics.includes(c.name);
                  return (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => toggleChar(c.name)}
                      title={c.tip}
                      className={`px-2.5 py-1 rounded-full border text-xs transition ${
                        on
                          ? "bg-brand-600 border-brand-400 text-white"
                          : "bg-ink-800 border-ink-600 text-slate-300 hover:bg-ink-700"
                      }`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {err && <div className="text-sm text-red-300">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
