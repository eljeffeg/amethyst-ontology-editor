import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { api, parseIriFromHash, shortLabel } from "../lib/api.js";
import { BUILTIN_DATATYPE_IRI_SET, BUILTIN_DATATYPES } from "../lib/datatypes.js";
import { Field, Modal } from "./ClassesView.jsx";
import EntityDetail from "./EntityDetail.jsx";
import { useProject } from "./OntologyPicker.jsx";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL_DATATYPE = "http://www.w3.org/2002/07/owl#Datatype";
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const RDFS_COMMENT = "http://www.w3.org/2000/01/rdf-schema#comment";

const LIST_QUERY = `
  PREFIX owl:  <http://www.w3.org/2002/07/owl#>
  PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
  SELECT DISTINCT ?iri ?label ?comment WHERE {
    { ?iri a owl:Datatype } UNION { ?iri a rdfs:Datatype }
    OPTIONAL { ?iri rdfs:label ?label }
    OPTIONAL { ?iri rdfs:comment ?comment }
  }
  ORDER BY ?iri
`;

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 600;
const SIDEBAR_DEFAULT = 320;

export default function DatatypesView({ onChange }) {
  const [datatypes, setDatatypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const autoSelectedRef = useRef(false);
  const isDragging = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.sparqlQuery(LIST_QUERY);
      const bindings = res.results?.bindings || [];

      // Collect user-defined datatypes from the triplestore.
      const userDefined = new Map();
      for (const row of bindings) {
        const iri = row.iri?.value;
        if (!iri || userDefined.has(iri)) continue;
        userDefined.set(iri, {
          iri: { value: iri },
          label: row.label ? { value: row.label.value } : null,
          comment: row.comment ? { value: row.comment.value } : null,
          userDefined: !BUILTIN_DATATYPE_IRI_SET.has(iri),
        });
      }

      // Merge built-in datatypes, skipping any already captured above.
      const merged = [...userDefined.values()];
      for (const dt of BUILTIN_DATATYPES) {
        if (!userDefined.has(dt.iri)) {
          merged.push({
            iri: { value: dt.iri },
            label: { value: dt.label },
            comment: dt.description ? { value: dt.description } : null,
            userDefined: false,
          });
        }
      }

      // Sort: user-defined first (alphabetically), then built-ins alphabetically.
      merged.sort((a, b) => {
        if (a.userDefined !== b.userDefined) return a.userDefined ? -1 : 1;
        const al = (a.label?.value || a.iri.value).toLowerCase();
        const bl = (b.label?.value || b.iri.value).toLowerCase();
        return al < bl ? -1 : al > bl ? 1 : 0;
      });

      setDatatypes(merged);
    } catch {
      setDatatypes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Deep-link support: pick up #iri=… from the URL hash.
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

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    if (!q) return datatypes;
    return datatypes.filter(
      (d) =>
        d.iri.value.toLowerCase().includes(q) || (d.label?.value || "").toLowerCase().includes(q),
    );
  }, [datatypes, filter]);

  // Auto-select the first item once the list is loaded.
  useEffect(() => {
    if (autoSelectedRef.current || loading || selected) return;
    autoSelectedRef.current = true;
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
      {/* ── Left panel: datatype list ── */}
      <div className="shrink-0 flex flex-col overflow-hidden" style={{ width: sidebarWidth }}>
        <div className="p-3 border-b border-ink-700 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Datatypes</h2>
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
        </div>

        <div className="flex-1 overflow-auto p-2">
          {loading && <div className="text-xs text-slate-500 p-2">Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div className="text-xs text-slate-500 p-2">No matching datatypes.</div>
          )}
          {filtered.map((d) => {
            const label = d.label?.value || shortLabel(d.iri.value);
            const isSelected = selected === d.iri.value;
            return (
              <div key={d.iri.value}>
                <button
                  type="button"
                  onClick={() => selectEntity(d.iri.value)}
                  title={d.iri.value}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm border
                    ${
                      isSelected
                        ? "bg-brand-600/20 border-brand-500/40 text-brand-100"
                        : "border-transparent hover:bg-ink-700/60 text-slate-200"
                    }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium truncate flex-1">{label}</span>
                    {d.userDefined && (
                      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand-500/20 text-brand-300 border border-brand-500/30">
                        custom
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate font-mono mt-0.5">
                    {shortLabel(d.iri.value)}
                  </div>
                </button>
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

      {/* ── Right panel: detail ── */}
      <div className="flex-1 min-w-0 overflow-auto">
        {selected ? (
          <EntityDetail
            iri={selected}
            kind="owl-datatype"
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
        ) : (
          <div className="h-full grid place-items-center text-slate-500 text-sm">
            Select or create a datatype.
          </div>
        )}
      </div>

      {showNew && (
        <NewDatatypeModal
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

// ── Create a new owl:Datatype entity using raw triple inserts ─────────────
function _iriBase(ontologyIri) {
  const raw = ontologyIri || "http://example.org/ontology";
  return raw.endsWith("#") || raw.endsWith("/") ? raw : `${raw}#`;
}

function toCamelCase(str) {
  const words = str
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  return (
    words[0].toLowerCase() +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("")
  );
}

function NewDatatypeModal({ onClose, onCreated }) {
  const { currentOntology } = useProject();
  const [iri, setIri] = useState(() => `${_iriBase(currentOntology?.iri)}newDatatype`);
  const [iriUserEdited, setIriUserEdited] = useState(false);
  const [label, setLabel] = useState("");
  const [comment, setComment] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (iriUserEdited) return;
    const base = _iriBase(currentOntology?.iri);
    const slug = label.trim() ? toCamelCase(label) || "newDatatype" : "newDatatype";
    setIri(`${base}${slug}`);
  }, [label, iriUserEdited, currentOntology?.iri]);

  const submit = async (e) => {
    e.preventDefault();
    if (!iri.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      // Core type assertion
      await api.addTriple({
        s: iri.trim(),
        p: RDF_TYPE,
        o: OWL_DATATYPE,
        objectKind: "uri",
      });
      if (label.trim()) {
        await api.addTriple({
          s: iri.trim(),
          p: RDFS_LABEL,
          o: label.trim(),
          objectKind: "literal",
          language: "en",
        });
      }
      if (comment.trim()) {
        await api.addTriple({
          s: iri.trim(),
          p: RDFS_COMMENT,
          o: comment.trim(),
          objectKind: "literal",
          language: "en",
        });
      }
      onCreated(iri.trim());
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New Datatype" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Label">
          <input
            className="input"
            value={label}
            placeholder="e.g. TemperatureUnit"
            onChange={(e) => setLabel(e.target.value)}
          />
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
        <Field label="Description">
          <textarea
            className="input min-h-15"
            value={comment}
            placeholder="Optional description…"
            onChange={(e) => setComment(e.target.value)}
          />
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
