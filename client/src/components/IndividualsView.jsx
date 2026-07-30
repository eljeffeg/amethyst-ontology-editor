import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { api, parseIriFromHash, shortLabel, term } from "../lib/api.js";
import { Field, Modal } from "./ClassesView.jsx";
import EntityDetail from "./EntityDetail.jsx";
import { useProject } from "./OntologyPicker.jsx";

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 600;
const SIDEBAR_DEFAULT = 320; // px — matches original w-80

export default function IndividualsView({ onChange }) {
  const [items, setItems] = useState([]);
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const isDragging = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [i, c] = await Promise.all([api.individuals(), api.classesAll()]);
      setItems(i.individuals);
      setClasses(c.classes);
    } catch (_err) {
      setItems([]);
      setClasses([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Pick up "#iri=..." from deep-links (graph "Edit in Individuals", etc.).
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

  const filtered = items.filter((i) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      i.iri.value.toLowerCase().includes(q) ||
      (i.prefLabel?.value || i.label?.value || "").toLowerCase().includes(q)
    );
  });

  // Default-select the first individual once, on initial load. Skips if the
  // hash effect already picked one, and only fires once so later deletions
  // or filters don't snap the selection back.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (loading) return;
    autoSelectedRef.current = true;
    if (selected) return;
    if (items.length > 0) selectEntity(items[0].iri.value);
  }, [loading, items, selected, selectEntity]);

  // ── Drag-to-resize sidebar ──────────────────────────────────────────────
  const startDrag = useCallback(
    (e) => {
      e.preventDefault();
      isDragging.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const onMove = (ev) => {
        if (!isDragging.current) return;
        const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + ev.clientX - startX));
        setSidebarWidth(next);
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
      {/* Sidebar — width controlled by drag handle */}
      <div className="shrink-0 flex flex-col overflow-hidden" style={{ width: sidebarWidth }}>
        <div className="p-3 border-b border-ink-700 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{term("IndividualPlural")}</h2>
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
            <div className="text-xs text-slate-500 p-2">
              No {term("IndividualPlural").toLowerCase()}.
            </div>
          )}
          {Object.values(
            filtered.reduce((acc, i) => {
              const key = i.iri.value;
              if (!acc[key]) acc[key] = { ...i, typeCount: i.type ? 1 : 0 };
              else if (i.type) acc[key].typeCount += 1;
              return acc;
            }, {}),
          ).map((i) => {
            const deprecated = !!i.deprecated;
            return (
              <div key={i.iri.value}>
                <button
                  type="button"
                  onClick={() => selectEntity(i.iri.value)}
                  title={deprecated ? "Deprecated (owl:deprecated = true)" : undefined}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm border
                  ${
                    selected === i.iri.value
                      ? "bg-brand-600/20 border-brand-500/40 text-brand-100"
                      : "border-transparent hover:bg-ink-700/60 text-slate-200"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`font-medium truncate flex-1 ${deprecated ? "line-through text-slate-400" : ""}`}
                    >
                      {i.prefLabel?.value || i.label?.value || shortLabel(i.iri.value)}
                    </span>
                    {i.typeCount > 0 && <span className="chip-ind">{i.typeCount}</span>}
                  </div>
                  {/* <div className="text-[11px] text-slate-500 truncate">{i.iri.value}</div> */}
                </button>
                <hr className="border-ink-800" />
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Drag handle — visual/mouse only, hidden from assistive tech ── */}
      <div
        onMouseDown={startDrag}
        aria-hidden="true"
        title="Drag to resize"
        className="group w-0.75 shrink-0 cursor-col-resize relative
                   bg-ink-700/60 hover:bg-brand-500/50 transition-colors
                   active:bg-brand-500/70 select-none"
      >
        {/* Grip dots */}
        <div
          className="absolute inset-y-0 left-1/2 -translate-x-1/2 flex flex-col
                        items-center justify-center gap-0.75 pointer-events-none opacity-0
                        group-hover:opacity-100 transition-opacity"
        >
          {[0, 1, 2, 3, 4].map((n) => (
            <span key={n} className="w-0.75 h-0.75 rounded-full bg-brand-300/80" />
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-auto">
        {selected ? (
          <EntityDetail
            iri={selected}
            kind="individual"
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
            Select {article(term("Individual"))} {term("Individual").toLowerCase()}.
          </div>
        )}
      </div>

      {showNew && (
        <NewIndModal
          classes={classes}
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

function article(word) {
  return /^[aeiouAEIOU]/.test(word) ? "an" : "a";
}

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

function NewIndModal({ classes, onClose, onCreated }) {
  const { currentOntology } = useProject();
  const [iri, setIri] = useState(() => `${_iriBase(currentOntology?.iri)}newIndividual`);
  const [iriUserEdited, setIriUserEdited] = useState(false);
  const [label, setLabel] = useState("");
  const [type, setType] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (iriUserEdited) return;
    const base = _iriBase(currentOntology?.iri);
    const slug = label.trim() ? toCamelCase(label) || "newIndividual" : "newIndividual";
    setIri(`${base}${slug}`);
  }, [label, iriUserEdited, currentOntology?.iri]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createIndividual({
        iri,
        label: label || undefined,
        types: type ? [type] : undefined,
      });
      onCreated(iri);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`New ${term("Individual").toLowerCase()}`} onClose={onClose}>
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
        <Field label={`Type (${term("Class").toLowerCase()})`}>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">(none)</option>
            {classes.map((c) => (
              <option key={c.iri.value} value={c.iri.value}>
                {c.prefLabel?.value || c.label?.value || shortLabel(c.iri.value)}
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
