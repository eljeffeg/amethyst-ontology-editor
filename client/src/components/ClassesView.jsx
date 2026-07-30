import { Eye, GitBranch, ListOrdered, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { api, parseIriFromHash, shortLabel, term } from "../lib/api.js";
import EntityDetail from "./EntityDetail.jsx";
import { useProject } from "./OntologyPicker.jsx";

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 600;
const SIDEBAR_DEFAULT = 320; // px — matches original w-80

export default function ClassesView({ onChange }) {
  const [classes, setClasses] = useState([]);
  const [linkedClasses, setLinkedClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("");
  const [viewMode, setViewMode] = useState("alpha"); // 'alpha' | 'hierarchy'
  const [showNew, setShowNew] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const isDragging = useRef(false);

  const { writeOntologyId, linkedOntologyIds, ontologies } = useProject();

  const load = useCallback(() => {
    setLoading(true);
    api
      .classes()
      .then((r) => setClasses(r.classes))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Fetch linked context entities whenever the write target or linked set changes.
  useEffect(() => {
    if (!writeOntologyId || !linkedOntologyIds?.length) {
      setLinkedClasses([]);
      return;
    }
    api
      .linkedContext(writeOntologyId, linkedOntologyIds)
      .then((r) => setLinkedClasses(r.classes || []))
      .catch(() => setLinkedClasses([]));
  }, [writeOntologyId, linkedOntologyIds]);

  // If the URL ships an "#iri=..." fragment (from the graph's "Edit in Classes"
  // button or the Chat view's entity links), pre-select that row and clear the
  // hash so a subsequent back/forward doesn't re-trigger selection.
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
    setFilter(""); // make sure nothing filters the row out
  }, [location.hash]);

  // Normalize primary + linked classes into a merged item list.
  // Linked entities are tagged with `linked: true` and `sourceOntologyName`.
  const items = useMemo(() => {
    const primary = classes.map((c) => ({
      iri: c.iri.value,
      label: c.prefLabel?.value || c.label?.value || shortLabel(c.iri.value),
      parents: Array.isArray(c.parents) ? c.parents : [],
      deprecated: !!c.deprecated,
      linked: false,
      sourceOntologyName: null,
    }));

    const primaryIris = new Set(primary.map((p) => p.iri));

    // Deduplicate linked entries by IRI: the same IRI can appear once per linked
    // ontology in the server response (e.g. a class defined in STONEWORK, STONES
    // Vocabularies, SKOS Vocabulary, and STONES Object Properties all returned
    // separately). Keep only the first occurrence so each IRI appears at most once.
    const linkedIrisSeen = new Set();
    const linked = [];
    for (const c of linkedClasses) {
      if (!c.iri?.value) continue;
      if (primaryIris.has(c.iri.value)) continue;
      if (linkedIrisSeen.has(c.iri.value)) continue;
      linkedIrisSeen.add(c.iri.value);
      linked.push({
        iri: c.iri.value,
        label: c.prefLabel?.value || c.label?.value || shortLabel(c.iri?.value || ""),
        parents: Array.isArray(c.parents) ? c.parents : [],
        deprecated: !!c.deprecated,
        linked: true,
        sourceOntologyName: c.sourceOntologyName || null,
      });
    }

    return [...primary, ...linked];
  }, [classes, linkedClasses]);

  // Flat alphabetical view. Case-insensitive by label, IRI as tiebreaker.
  const flatRows = useMemo(() => {
    const q = filter.toLowerCase();
    const rows = items.filter(
      (it) => !filter || it.iri.toLowerCase().includes(q) || it.label.toLowerCase().includes(q),
    );
    rows.sort((a, b) => {
      const al = a.label.toLowerCase(),
        bl = b.label.toLowerCase();
      if (al < bl) return -1;
      if (al > bl) return 1;
      return a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0;
    });
    return rows.map((it) => ({ ...it, depth: 0, rowKey: it.iri }));
  }, [items, filter]);

  // Hierarchy view: build parent→children map, walk from roots. A class with
  // multiple parents appears once under each parent. Cycles are broken by
  // tracking the visited ancestry path.
  const treeRows = useMemo(() => {
    const byIri = new Map(items.map((it) => [it.iri, it]));
    const childrenOf = new Map();
    const roots = [];
    for (const it of items) {
      const realParents = it.parents.filter((p) => byIri.has(p) && p !== it.iri);
      if (realParents.length === 0) {
        roots.push(it);
      } else {
        for (const p of realParents) {
          if (!childrenOf.has(p)) childrenOf.set(p, []);
          childrenOf.get(p).push(it);
        }
      }
    }

    const cmp = (a, b) => {
      const al = a.label.toLowerCase(),
        bl = b.label.toLowerCase();
      if (al < bl) return -1;
      if (al > bl) return 1;
      return a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0;
    };
    roots.sort(cmp);
    for (const arr of childrenOf.values()) arr.sort(cmp);

    const out = [];
    const walk = (it, depth, path) => {
      if (path.has(it.iri)) return; // break cycles
      // rowKey includes position so the same IRI under multiple parents gets a
      // unique key (avoiding React duplicate-key bugs when switching view modes).
      out.push({ ...it, depth, rowKey: `${it.iri}:${out.length}` });
      const kids = childrenOf.get(it.iri) || [];
      const next = new Set(path);
      next.add(it.iri);
      for (const k of kids) walk(k, depth + 1, next);
    };
    for (const r of roots) walk(r, 0, new Set());

    // Filter: match on node text, but keep ancestors that lead to a match so
    // the structure reads naturally.
    const q = filter.toLowerCase();
    if (!filter) return out;
    const keep = new Array(out.length).fill(false);
    for (let i = 0; i < out.length; i++) {
      const row = out[i];
      const hit = row.iri.toLowerCase().includes(q) || row.label.toLowerCase().includes(q);
      if (hit) {
        keep[i] = true;
        // Keep ancestors (prior rows with strictly decreasing depth).
        let curDepth = row.depth;
        for (let j = i - 1; j >= 0 && curDepth > 0; j--) {
          if (out[j].depth < curDepth) {
            keep[j] = true;
            curDepth = out[j].depth;
          }
        }
      }
    }
    return out.filter((_, i) => keep[i]);
  }, [items, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Selected IRI may now be from a linked (read-only) entity.
  const selectedLinkedData = useMemo(() => {
    if (!selected) return null;
    return items.find((it) => it.iri === selected && it.linked) || null;
  }, [selected, items]);

  // Names of imported ontologies — banner is suppressed for these since the
  // EntityDetail already shows a read-only lock and the banner's guidance
  // ("switch to full visibility / write target") doesn't apply to imports.
  const importedOntologyNames = useMemo(() => {
    const names = new Set();
    for (const onto of ontologies || []) {
      if (onto.is_imported && !onto.branch_of) names.add(onto.name);
    }
    return names;
  }, [ontologies]);

  const showLinkedBanner =
    !!selectedLinkedData && !importedOntologyNames.has(selectedLinkedData.sourceOntologyName);

  const rows = viewMode === "hierarchy" ? treeRows : flatRows;

  // Default-select the first displayed row once, on initial load. Respects
  // the hash deep-link effect above (if it already set a selection, we skip)
  // and only fires a single time per mount so later deletions/filters don't
  // keep snapping the selection back to the top.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (loading) return;
    autoSelectedRef.current = true;
    if (selected) return;
    if (rows.length > 0) selectEntity(rows[0].iri);
  }, [loading, rows, selected, selectEntity]);

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
            <h2 className="text-sm font-semibold">{term("ClassPlural")}</h2>
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
          <div className="flex items-center gap-1 p-0.5 bg-ink-800 rounded-md border border-ink-600/50 text-xs">
            <button
              type="button"
              onClick={() => setViewMode("alpha")}
              title="Sort alphabetically"
              className={`flex-1 px-2 py-1 rounded flex items-center justify-center gap-1
                      ${viewMode === "alpha" ? "bg-brand-600 text-white" : "text-slate-300 hover:bg-ink-700"}`}
            >
              <ListOrdered size={12} aria-hidden="true" />
              Alpha
            </button>
            <button
              type="button"
              onClick={() => setViewMode("hierarchy")}
              title="Order by class hierarchy"
              className={`flex-1 px-2 py-1 rounded flex items-center justify-center gap-1
                      ${viewMode === "hierarchy" ? "bg-brand-600 text-white" : "text-slate-300 hover:bg-ink-700"}`}
            >
              <GitBranch size={12} aria-hidden="true" />
              Hierarchy
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {loading && <div className="text-xs text-slate-500 p-2">Loading…</div>}
          {!loading && rows.length === 0 && (
            <div className="text-xs text-slate-500 p-2">
              No {term("ClassPlural").toLowerCase()}.
            </div>
          )}
          {rows.map((it) => (
            <ClassRow
              key={`${viewMode}:${it.rowKey}`}
              item={it}
              depth={viewMode === "hierarchy" ? it.depth : 0}
              selected={selected === it.iri}
              onClick={() => selectEntity(it.iri)}
            />
          ))}
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
              kind="class"
              onDelete={() => {
                setSelected(null);
                load();
                onChange?.();
              }}
              onUpdate={() => {
                load();
                onChange?.();
              }}
            />
          </>
        ) : (
          <EmptyState
            text={`Select a ${term("Class").toLowerCase()} from the list, or create a new one.`}
          />
        )}
      </div>

      {showNew && (
        <NewClassModal
          onClose={() => setShowNew(false)}
          onCreated={(iri) => {
            setShowNew(false);
            load();
            selectEntity(iri);
            onChange?.();
          }}
        />
      )}
    </div>
  );
}

function ClassRow({ item, depth, selected, onClick }) {
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        title={
          item.linked
            ? `From: ${item.sourceOntologyName || "linked ontology"} (read-only)`
            : item.deprecated
              ? "Deprecated (owl:deprecated = true)"
              : undefined
        }
        className={`w-full text-left px-3 py-2 rounded-md text-sm border flex items-center gap-2
          ${
            selected
              ? item.linked
                ? "bg-violet-600/20 border-violet-500/40 text-violet-100"
                : "bg-brand-600/20 border-brand-500/40 text-brand-100"
              : item.linked
                ? "border-transparent hover:bg-violet-900/20 text-slate-400"
                : "border-transparent hover:bg-ink-700/60 text-slate-200"
          }`}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
      >
        {depth > 0 && (
          <span className="text-slate-600 shrink-0 select-none" aria-hidden="true">
            └
          </span>
        )}
        <span
          className={`font-medium truncate ${item.deprecated ? "line-through text-slate-400" : ""} ${item.linked ? "italic text-slate-400" : ""}`}
        >
          {item.label}
        </span>
        {item.linked && item.sourceOntologyName && (
          <span className="shrink-0 ml-auto text-[9px] px-1 py-0.5 rounded bg-violet-500/20 text-violet-400 truncate max-w-24">
            {item.sourceOntologyName}
          </span>
        )}
      </button>
      <hr className="border-ink-700/75" />
    </>
  );
}

// Banner shown above EntityDetail when a linked (external) entity is selected.
// Exported so PropertiesView can reuse it.
export function LinkedEntityBanner() {
  return (
    <div className="px-4 py-2.5 border-b border-amber-900/30 bg-amber-950/20 flex items-start gap-1.5">
      <Eye size={13} className="shrink-0 mt-0.5 text-amber-400" aria-hidden="true" />
      <p className="text-xs text-amber-400 leading-relaxed">
        This entity is defined in a linked ontology. Switch it to full visibility in the workspace
        picker to edit it, or enable it as a write target.
      </p>
    </div>
  );
}

function EmptyState({ text }) {
  return <div className="h-full grid place-items-center text-slate-500 text-sm">{text}</div>;
}

// Derive the base IRI prefix from the ontology's declared IRI.
// Appends '#' when the IRI has no trailing separator so term IRIs are valid.
function _iriBase(ontologyIri) {
  const raw = ontologyIri || "http://example.org/ontology";
  return raw.endsWith("#") || raw.endsWith("/") ? raw : `${raw}#`;
}

// Converts a human-readable label to PascalCase for use in a class IRI fragment.
function toPascalCase(str) {
  return str
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function NewClassModal({ onClose, onCreated }) {
  const { currentOntology } = useProject();
  const [iri, setIri] = useState(() => `${_iriBase(currentOntology?.iri)}NewClass`);
  const [iriUserEdited, setIriUserEdited] = useState(false);
  const [label, setLabel] = useState("");
  const [definition, setDefinition] = useState("");
  const [parent, setParent] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [allClasses, setAllClasses] = useState([]);

  // Auto-update the IRI fragment whenever the label changes, unless the user
  // has manually edited the IRI field. Uses PascalCase (no spaces).
  useEffect(() => {
    if (iriUserEdited) return;
    const base = _iriBase(currentOntology?.iri);
    const slug = label.trim() ? toPascalCase(label) || "NewClass" : "NewClass";
    setIri(`${base}${slug}`);
  }, [label, iriUserEdited, currentOntology?.iri]);

  // Load ALL project classes (ignores visibility) so hidden-ontology classes
  // are always available as parent options.
  useEffect(() => {
    api
      .classesAll()
      .then((r) => setAllClasses(r.classes || []))
      .catch(() => {});
  }, []);

  // Present parent-picker options alphabetically.
  const parentOptions = useMemo(() => {
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
      await api.createClass({
        iri,
        label: label || undefined,
        definition: definition || undefined,
        subClassOf: parent ? [parent] : undefined,
      });
      onCreated(iri);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`New ${term("Class").toLowerCase()}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Label">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
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
        <Field label={`Parent ${term("Class").toLowerCase()} (subClassOf)`}>
          <select className="input" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">(none)</option>
            {parentOptions.map((c) => (
              <option key={c.iri} value={c.iri}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
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

export function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs grid place-items-center z-50">
      <div className="panel w-full max-w-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{title}</h3>
          <button type="button" className="btn-ghost p-1" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div className="block">
      <span className="label block mb-1">{label}</span>
      {children}
    </div>
  );
}
