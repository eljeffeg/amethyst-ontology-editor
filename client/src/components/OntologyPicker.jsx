import {
  AlignLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  Edit,
  Eye,
  EyeOff,
  FolderOpen,
  GitBranch,
  Link,
  Lock,
  LogOut,
  RotateCcw,
  Settings,
  Shield,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { NavLink } from "react-router";
import { useAuth } from "../App.jsx";
import {
  api,
  getCurrentProject,
  setCurrentOntology,
  setCurrentProject,
  setWriteOntology,
} from "../lib/api.js";

import { getOntologyColor } from "../lib/ontologyColors.js";

// ---------------------------------------------------------------------------
// Project / Ontology context  — Workspace edition
// ---------------------------------------------------------------------------
// The app always has exactly one project selected.  Within it the user builds
// a "workspace": one or more ontologies are made visible (read scope) and
// exactly one is the write target (all mutations go there).
//
// Single-ontology mode = 1 visible + same one as write target (the default,
// and backward-compatible with old behaviour).
//
// Workspace mode = 2+ ontologies visible.  The read scope is a union of all
// visible ontologies; writes always go to the designated write target.
//
// Linked context mode = a sibling ontology is NOT in the full-visibility
// scope but its entities that are referenced by the writable ontology are
// surfaced (read-only) in the class/property lists and the graph.
//
// State is persisted in localStorage so a page-refresh restores the same
// workspace.

const ProjectContext = createContext(null);
export const useProject = () => useContext(ProjectContext);
// Back-compat alias
export const useOntology = useProject;

const PROJECT_STORAGE_KEY = "ontology-editor:current-project";
const VISIBLE_ONTOLOGIES_KEY = "ontology-editor:visible-ontologies"; // JSON [id,…]
const WRITE_ONTOLOGY_KEY = "ontology-editor:write-ontology"; // single id
const LINKED_ONTOLOGIES_KEY = "ontology-editor:linked-ontologies"; // JSON [id,…]
// Legacy key — read on first load for smooth migration, then replaced.
const ONTOLOGY_STORAGE_KEY = "ontology-editor:current-ontology";

export const isUnion = (id) => id === "all" || id === "*";

// Collapse a list of visible IDs into the string the API expects.
// 1 → single id,  N → comma-separated,  0 → null
function computeReadScope(ids) {
  if (!ids || ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  return ids.join(",");
}

export function OntologyProvider({ children }) {
  const [projects, setProjects] = useState([]);
  const [currentProjectId, setCurrentProjectId] = useState(null);
  // Workspace state
  const [visibleOntologyIds, _setVisibleOntologyIds] = useState([]);
  const [writeOntologyId, _setWriteOntologyId] = useState(null);
  const [linkedOntologyIds, _setLinkedOntologyIds] = useState([]);
  const [loaded, setLoaded] = useState(false);

  // Refs mirror state so event-handler closures always see the latest values.
  const visibleIdsRef = useRef([]);
  const writeIdRef = useRef(null);
  const linkedIdsRef = useRef([]);
  // currentProjectIdRef lets _commitLinked write to the correct per-project
  // storage key even inside the same synchronous call frame where setCurrentProjectId
  // hasn't had a chance to flush its async state update yet.
  const currentProjectIdRef = useRef(null);
  visibleIdsRef.current = visibleOntologyIds;
  writeIdRef.current = writeOntologyId;
  linkedIdsRef.current = linkedOntologyIds;
  currentProjectIdRef.current = currentProjectId;

  const currentProject = useMemo(
    () => projects.find((p) => p.id === currentProjectId) || null,
    [projects, currentProjectId],
  );
  const ontologies = currentProject?.ontologies || [];

  // The "current ontology" for callers that only care about the write target.
  const currentOntology = useMemo(
    () => ontologies.find((o) => o.id === writeOntologyId) || null,
    [ontologies, writeOntologyId],
  );

  // Visible ontology objects (in order).
  const visibleOntologies = useMemo(
    () => visibleOntologyIds.map((id) => ontologies.find((o) => o.id === id)).filter(Boolean),
    [ontologies, visibleOntologyIds],
  );

  const workspaceMode = visibleOntologyIds.length > 1;
  // Back-compat: unionMode === workspaceMode
  const unionMode = workspaceMode;
  // Back-compat: currentOntologyId === writeOntologyId in the context
  const currentOntologyId = writeOntologyId;

  // ---- Internal commit helpers ----------------------------------------
  // These update React state, the mutable refs, the api.js module globals,
  // and localStorage all in one shot to keep everything in sync.
  //
  // Wrapped in useCallback with stable (empty) deps so their references never
  // change across renders — this is what makes `refresh` below also stable.
  // All values they close over are either React state-setters (guaranteed stable
  // by React) or module-level api.js functions (stable imports).

  const _commitVisible = useCallback((ids) => {
    visibleIdsRef.current = ids;
    _setVisibleOntologyIds(ids);
    setCurrentOntology(computeReadScope(ids));
    try {
      const pid = currentProjectIdRef.current;
      const key = pid ? `${VISIBLE_ONTOLOGIES_KEY}:${pid}` : VISIBLE_ONTOLOGIES_KEY;
      if (ids.length > 0) localStorage.setItem(key, JSON.stringify(ids));
      else localStorage.removeItem(key);
    } catch {}
  }, []);

  const _commitWrite = useCallback((id) => {
    writeIdRef.current = id;
    _setWriteOntologyId(id);
    setWriteOntology(id);
    try {
      const pid = currentProjectIdRef.current;
      const key = pid ? `${WRITE_ONTOLOGY_KEY}:${pid}` : WRITE_ONTOLOGY_KEY;
      if (id) localStorage.setItem(key, id);
      else localStorage.removeItem(key);
    } catch {}
  }, []);

  const _commitLinked = useCallback((ids) => {
    linkedIdsRef.current = ids;
    _setLinkedOntologyIds(ids);
    try {
      const pid = currentProjectIdRef.current;
      // Store linked state per-project so "first visit" is detectable per project.
      const key = pid ? `${LINKED_ONTOLOGIES_KEY}:${pid}` : LINKED_ONTOLOGIES_KEY;
      localStorage.setItem(key, JSON.stringify(ids));
    } catch {}
  }, []);

  // ---- refresh -----------------------------------------------------------
  const refresh = useCallback(
    async (target = {}) => {
      const r = await api.projects();
      const list = r.projects || [];
      setProjects(list);

      // ── Project pick: explicit target > localStorage > list[0] ──
      let pickProjectId = target.projectId || null;
      if (!pickProjectId) {
        try {
          pickProjectId = localStorage.getItem(PROJECT_STORAGE_KEY);
        } catch {}
      }
      if (!pickProjectId || !list.find((p) => p.id === pickProjectId)) {
        pickProjectId = list[0]?.id || null;
      }
      setCurrentProjectId(pickProjectId);
      setCurrentProject(pickProjectId);
      try {
        if (pickProjectId) localStorage.setItem(PROJECT_STORAGE_KEY, pickProjectId);
      } catch {}

      const pickProject = list.find((p) => p.id === pickProjectId);
      const projOntos = pickProject?.ontologies || [];
      const projIdSet = new Set(projOntos.map((o) => o.id));

      // ── If an explicit ontology target was given → single-ontology mode ──
      if (target.ontologyId && projIdSet.has(target.ontologyId)) {
        const oid = target.ontologyId;
        _commitVisible([oid]);
        _commitWrite(oid);

        // Apply the same auto-link logic as the general path so that a newly
        // created project with owl:imports siblings gets them linked by default.
        let savedLinkedForTarget = null;
        try {
          const rawL = localStorage.getItem(`${LINKED_ONTOLOGIES_KEY}:${pickProjectId}`);
          if (rawL) savedLinkedForTarget = JSON.parse(rawL);
        } catch {}
        const targetVisibleSet = new Set([oid]);
        let targetLinked;
        if (savedLinkedForTarget !== null) {
          targetLinked = savedLinkedForTarget.filter(
            (id) => projIdSet.has(id) && !targetVisibleSet.has(id),
          );
        } else {
          // First visit — auto-link all non-visible root ontologies.
          const branchIds = new Set(projOntos.filter((o) => o.branch_of).map((o) => o.id));
          targetLinked = projOntos
            .filter((o) => !targetVisibleSet.has(o.id) && !branchIds.has(o.id))
            .map((o) => o.id);
        }
        currentProjectIdRef.current = pickProjectId;
        _commitLinked(targetLinked);

        setLoaded(true);
        return list;
      }

      // ── Otherwise restore from localStorage (per-project keys first, then legacy) ──
      let savedVisible = null;
      let savedWrite = null;
      try {
        const rawV = localStorage.getItem(`${VISIBLE_ONTOLOGIES_KEY}:${pickProjectId}`);
        if (rawV) savedVisible = JSON.parse(rawV);
        savedWrite = localStorage.getItem(`${WRITE_ONTOLOGY_KEY}:${pickProjectId}`);
      } catch {}

      // Fall back to global keys (migration path for existing sessions).
      if (!savedVisible && !savedWrite) {
        try {
          const raw = localStorage.getItem(VISIBLE_ONTOLOGIES_KEY);
          if (raw) savedVisible = JSON.parse(raw);
          savedWrite = localStorage.getItem(WRITE_ONTOLOGY_KEY);
        } catch {}
      }

      // Migrate from the old single-ontology key if all else is absent.
      if (!savedVisible && !savedWrite) {
        try {
          const old = localStorage.getItem(ONTOLOGY_STORAGE_KEY);
          if (old && !isUnion(old)) {
            savedWrite = old;
            savedVisible = [old];
          }
        } catch {}
      }

      // Filter to only IDs that exist in this project.
      // Use String() to match against savedVisible values that may be strings after JSON.parse.
      let pickVisible = (savedVisible || []).filter((id) =>
        projOntos.some((o) => String(o.id) === String(id)),
      ).map((id) => {
        // Normalize back to the server's actual ID type (integer).
        const match = projOntos.find((o) => String(o.id) === String(id));
        return match ? match.id : id;
      });
      const noSavedWorkspace = pickVisible.length === 0;
      if (noSavedWorkspace) pickVisible = projOntos.slice(0, 1).map((o) => o.id);

      const importedIds = new Set(projOntos.filter((o) => o.is_imported).map((o) => o.id));
      // savedWrite is always a string from localStorage.getItem; match against server IDs.
      const savedWriteOnto = savedWrite
        ? projOntos.find((o) => String(o.id) === String(savedWrite))
        : null;
      let pickWrite =
        savedWriteOnto && !importedIds.has(savedWriteOnto.id) ? savedWriteOnto.id : null;
      if (!pickWrite) pickWrite = pickVisible.find((id) => !importedIds.has(id)) || null;

      // Restore per-project linked ontology IDs.
      // Key is per-project so switching projects never clobbers another project's state.
      let savedLinked = null;
      try {
        const rawLinked = localStorage.getItem(`${LINKED_ONTOLOGIES_KEY}:${pickProjectId}`);
        if (rawLinked) savedLinked = JSON.parse(rawLinked);
      } catch {}

      const pickVisibleSet = new Set(pickVisible);
      const branchIds = new Set(projOntos.filter((o) => o.branch_of).map((o) => o.id));
      let pickLinked;
      if (noSavedWorkspace || savedLinked === null) {
        // No saved workspace state — auto-link all non-visible non-branch ontologies.
        pickLinked = projOntos
          .filter((o) => !pickVisibleSet.has(o.id) && !branchIds.has(o.id))
          .map((o) => o.id);
      } else {
        // User has previous linking choices for this project — restore them.
        pickLinked = savedLinked.filter((id) => projIdSet.has(id) && !pickVisibleSet.has(id));
      }

      // Sync the ref so _commitLinked writes to the correct per-project key.
      currentProjectIdRef.current = pickProjectId;
      _commitVisible(pickVisible);
      _commitWrite(pickWrite);
      _commitLinked(pickLinked);
      setLoaded(true);
      return list;
    },
    [_commitVisible, _commitWrite, _commitLinked],
  );

  useEffect(() => {
    refresh().catch(() => setLoaded(true));
  }, [refresh]);

  // ---- switchProject / switchOntology / switchScope ----------------------

  const _applyProject = (id, ontologies_) => {
    setCurrentProjectId(id);
    setCurrentProject(id);
    try {
      localStorage.setItem(PROJECT_STORAGE_KEY, id);
    } catch {}

    // Sync the ref FIRST so _commitVisible/_commitWrite write to the per-project key.
    currentProjectIdRef.current = id;

    const projIdSet_ = new Set((ontologies_ || []).map((o) => o.id));
    const importedIds = new Set((ontologies_ || []).filter((o) => o.is_imported).map((o) => o.id));

    // Restore saved visible/write state for this project.
    let savedVisible = null;
    let savedWrite = null;
    try {
      const rawV = localStorage.getItem(`${VISIBLE_ONTOLOGIES_KEY}:${id}`);
      if (rawV) savedVisible = JSON.parse(rawV);
      savedWrite = localStorage.getItem(`${WRITE_ONTOLOGY_KEY}:${id}`);
    } catch {}

    let pickVisible = (savedVisible || [])
      .filter((oid) => (ontologies_ || []).some((o) => String(o.id) === String(oid)))
      .map((oid) => {
        const match = (ontologies_ || []).find((o) => String(o.id) === String(oid));
        return match ? match.id : oid;
      });
    const noSavedWorkspace = pickVisible.length === 0;
    if (noSavedWorkspace) pickVisible = ontologies_?.slice(0, 1).map((o) => o.id) || [];

    const savedWriteOnto_ = savedWrite
      ? (ontologies_ || []).find((o) => String(o.id) === String(savedWrite))
      : null;
    let pickWrite =
      savedWriteOnto_ && !importedIds.has(savedWriteOnto_.id) ? savedWriteOnto_.id : null;
    if (!pickWrite) pickWrite = pickVisible.find((oid) => !importedIds.has(oid)) || null;

    _commitVisible(pickVisible);
    _commitWrite(pickWrite);

    // Check for a previously-saved linked state for this project.
    let savedLinked = null;
    try {
      const rawLinked = localStorage.getItem(`${LINKED_ONTOLOGIES_KEY}:${id}`);
      if (rawLinked) savedLinked = JSON.parse(rawLinked);
    } catch {}

    const visibleSet = new Set(pickVisible);
    const branchIds_ = new Set((ontologies_ || []).filter((o) => o.branch_of).map((o) => o.id));
    let pickLinked;
    if (noSavedWorkspace || savedLinked === null) {
      // No saved workspace state — auto-link all non-visible non-branch ontologies.
      pickLinked = (ontologies_ || [])
        .filter((o) => !visibleSet.has(o.id) && !branchIds_.has(o.id))
        .map((o) => o.id);
    } else {
      pickLinked = savedLinked.filter((lid) => projIdSet_.has(lid) && !visibleSet.has(lid));
    }
    _commitLinked(pickLinked);
  };

  const switchProject = (id) => {
    const pick = projects.find((p) => p.id === id);
    if (!pick) return;
    _applyProject(id, pick.ontologies);
  };

  const switchOntology = (id) => {
    _commitVisible(id ? [id] : []);
    _commitWrite(id);
  };

  const switchScope = (projectId, ontologyId) => {
    const pick = projects.find((p) => p.id === projectId);
    if (!pick) return;
    // Without a specific ontology target, use full state restoration (visible + linked).
    if (!ontologyId) {
      _applyProject(projectId, pick.ontologies);
      return;
    }
    setCurrentProjectId(projectId);
    setCurrentProject(projectId);
    try {
      localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
    } catch {}
    let oid = ontologyId;
    if (!pick.ontologies?.find((o) => o.id === oid)) oid = pick.ontologies?.[0]?.id || null;
    _commitVisible(oid ? [oid] : []);
    _commitWrite(oid);
  };

  // ---- Workspace actions -------------------------------------------------

  const toggleOntologyVisibility = (id) => {
    const prev = visibleIdsRef.current;
    const currentWrite = writeIdRef.current;

    if (prev.includes(id)) {
      if (prev.length <= 1) return;
      const next = prev.filter((x) => x !== id);
      _commitVisible(next);
      if (id === currentWrite) _commitWrite(next[0]);
    } else {
      _commitVisible([...prev, id]);
      if (linkedIdsRef.current.includes(id)) {
        _commitLinked(linkedIdsRef.current.filter((x) => x !== id));
      }
    }
  };

  const setWriteTarget = (id) => {
    // Find the target in all projects' ontologies to determine branch status.
    // Use String() on both sides to handle integer DB IDs vs localStorage strings.
    const allOntos = projects.flatMap((p) => p.ontologies || []);
    const target = allOntos.find((o) => String(o.id) === String(id));

    // Imported ontologies (owl:imports dependencies) are read-only.
    if (target?.is_imported) return;

    if (target?.branch_of) {
      // Switching to a branch:
      // - Ensure the branch is visible.
      // - Remove only its parent and sibling branches from visible/linked.
      // - Leave ALL other unrelated ontologies in the workspace untouched.
      const parentId = target.branch_of;
      const siblingIds = new Set(
        allOntos
          .filter((o) => String(o.branch_of) === String(parentId) && String(o.id) !== String(id))
          .map((o) => o.id),
      );
      const exclude = new Set([parentId, ...siblingIds]);
      const prev = visibleIdsRef.current;
      const kept = prev.filter((x) => String(x) !== String(id) && !exclude.has(x));
      _commitVisible([id, ...kept]);
      _commitLinked(linkedIdsRef.current.filter((x) => !exclude.has(x)));
      _commitWrite(id);
    } else if (target) {
      // Switching to a root ontology:
      // - Ensure the root is visible.
      // - Remove all branches of this root from visible (parent/branch mutually exclusive).
      // - Remove this root and its child branches from linked.
      // - Leave ALL other unrelated ontologies untouched.
      const sid = String(id);
      const branchIds = new Set(
        allOntos.filter((o) => String(o.branch_of) === sid).map((o) => String(o.id)),
      );
      const prev = visibleIdsRef.current;
      // Use .some() + String() to guard against integer vs string ID type mismatch.
      let next = prev.some((x) => String(x) === sid) ? prev : [id, ...prev];
      // Remove branches of this root — parent and branch are mutually exclusive in visible.
      next = next.filter((x) => !branchIds.has(String(x)));
      _commitVisible(next);
      _commitLinked(
        linkedIdsRef.current.filter(
          (x) => !branchIds.has(String(x)) && String(x) !== sid,
        ),
      );
      _commitWrite(id);
    } else {
      // Fallback (ontology not yet loaded in projects list).
      const prev = visibleIdsRef.current;
      if (!prev.includes(id)) _commitVisible([...prev, id]);
      if (linkedIdsRef.current.includes(id))
        _commitLinked(linkedIdsRef.current.filter((x) => x !== id));
      _commitWrite(id);
    }
  };

  const toggleLinkedContext = (id) => {
    // Branches are binary on/off — they cannot be in linked context.
    const allOntos = projects.flatMap((p) => p.ontologies || []);
    const isBranch = allOntos.some((o) => String(o.id) === String(id) && o.branch_of != null);
    if (isBranch) return;

    const prev = linkedIdsRef.current;
    if (prev.includes(id)) {
      _commitLinked(prev.filter((x) => x !== id));
    } else {
      if (!visibleIdsRef.current.includes(id)) {
        _commitLinked([...prev, id]);
      }
    }
  };

  // Cycle an ontology through its visibility states.
  // Root ontologies:   hidden → linked → full → hidden
  // Branch ontologies: hidden → full → hidden  (no linked-context intermediate)
  // The write target is pinned to full visibility and cannot be cycled.
  const cycleOntologyState = (id) => {
    if (id === writeIdRef.current) return;

    // Determine branch status so we can apply the correct cycle.
    const allOntos = projects.flatMap((p) => p.ontologies || []);
    const isBranch = allOntos.some((o) => String(o.id) === String(id) && o.branch_of != null);

    const isVisible = visibleIdsRef.current.includes(id);
    const isLinked = linkedIdsRef.current.includes(id);

    if (isBranch) {
      // Binary toggle: no linked state.
      if (isVisible) {
        // full → hidden (guard: must keep at least 1 visible)
        if (visibleIdsRef.current.length <= 1) return;
        _commitVisible(visibleIdsRef.current.filter((x) => x !== id));
      } else {
        // hidden → full; also remove parent (parent/branch mutually exclusive in visible)
        if (isLinked) _commitLinked(linkedIdsRef.current.filter((x) => x !== id));
        const parentId = allOntos.find((o) => String(o.id) === String(id))?.branch_of;
        const withoutParent = parentId
          ? visibleIdsRef.current.filter((x) => String(x) !== String(parentId))
          : visibleIdsRef.current;
        _commitVisible([...withoutParent, id]);
      }
    } else {
      if (!isVisible && !isLinked) {
        // hidden → linked
        _commitLinked([...linkedIdsRef.current, id]);
      } else if (isLinked) {
        // linked → full; also remove any branches (parent/branch mutually exclusive in visible)
        const branchIds = new Set(
          allOntos.filter((o) => String(o.branch_of) === String(id)).map((o) => String(o.id)),
        );
        _commitLinked(linkedIdsRef.current.filter((x) => x !== id));
        _commitVisible([
          ...visibleIdsRef.current.filter((x) => !branchIds.has(String(x))),
          id,
        ]);
      } else {
        // full → hidden (guard: must keep at least 1 visible)
        if (visibleIdsRef.current.length <= 1) return;
        _commitVisible(visibleIdsRef.current.filter((x) => x !== id));
      }
    }
  };

  // Persist a user-defined sort order for root ontologies in the current project.
  // orderedIds: root ontology UUIDs in the desired display order (branches excluded).
  const reorderOntologies = useCallback(
    async (orderedIds) => {
      if (!currentProjectId) return;
      try {
        await api.reorderOntologies(currentProjectId, orderedIds);
        await refresh();
      } catch (err) {
        console.error("[OntologyProvider] reorderOntologies failed:", err);
      }
    },
    [currentProjectId, refresh],
  );

  const value = {
    projects,
    ontologies,
    visibleOntologies,
    visibleOntologyIds,
    writeOntologyId,
    linkedOntologyIds,
    loaded,
    currentProject,
    currentProjectId,
    currentOntology,
    currentOntologyId,
    workspaceMode,
    unionMode,
    current: currentOntology,
    refresh,
    switchProject,
    switchOntology,
    switchScope,
    toggleOntologyVisibility,
    setWriteTarget,
    toggleLinkedContext,
    cycleOntologyState,
    reorderOntologies,
  };

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

// ---------------------------------------------------------------------------
// Dropdown shell
// ---------------------------------------------------------------------------
function Dropdown({ trigger, children, className = "", panelClass = "left-0", onOpenChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const update = useCallback(
    (next) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useEffect(() => {
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) update(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [update]);

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        className="contents"
        onClick={() => update(!open)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && update(!open)}
      >
        {trigger(open)}
      </button>
      {open && (
        <div
          className={`absolute z-60 ${panelClass} mt-1 rounded-lg shadow-xl shadow-black/40
                         border border-ink-600/80 bg-ink-900/95 backdrop-blur-xs
                         max-h-[70vh] overflow-auto pt-1 min-w-[18rem]`}
        >
          {typeof children === "function" ? children(() => update(false)) : children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Combined Project / Ontology picker
// ---------------------------------------------------------------------------
export function ProjectOntologyPicker() {
  const {
    projects,
    currentProject,
    currentOntology,
    visibleOntologyIds,
    linkedOntologyIds,
    writeOntologyId,
    workspaceMode,
    switchScope,
    cycleOntologyState,
    setWriteTarget,
    reorderOntologies,
  } = useProject();

  const [view, setView] = useState("current");

  const projectName = currentProject?.name || "Project";
  const linkedCount = linkedOntologyIds?.length || 0;
  const label = workspaceMode
    ? linkedCount > 0
      ? `${projectName} · Workspace (${visibleOntologyIds.length}+${linkedCount})`
      : `${projectName} · Workspace (${visibleOntologyIds.length})`
    : linkedCount > 0
      ? `${projectName} · ${currentOntology?.name || "—"} +${linkedCount} linked`
      : `${projectName} · ${currentOntology?.name || "—"}`;

  return (
    <Dropdown
      className="min-w-0"
      panelClass="right-0"
      onOpenChange={(o) => {
        if (!o) setView("current");
      }}
      trigger={(open) => (
        <button
          type="button"
          className="max-w-88 flex items-center gap-2 px-3 py-1.5 rounded-md bg-ink-800/70 border border-ink-600/60 hover:bg-ink-700/70 transition"
          title={currentOntology?.iri || currentProject?.description || ""}
        >
          <FolderOpen size={14} className="text-brand-300 shrink-0" aria-hidden="true" />
          <span className="text-sm font-medium truncate md:hidden">{projectName}</span>
          <span className="text-sm font-medium truncate hidden md:inline">{label}</span>
          <ChevronDown
            size={14}
            className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      )}
    >
      {(close) => (
        <div className="min-w-88 max-w-sm">
          {view === "current" ? (
            <CurrentProjectPanel
              project={currentProject}
              visibleOntologyIds={visibleOntologyIds}
              linkedOntologyIds={linkedOntologyIds}
              writeOntologyId={writeOntologyId}
              canSwitch={projects.length > 1}
              onCycleState={cycleOntologyState}
              onSetWrite={(id) => {
                setWriteTarget(id);
                close();
              }}
              onRequestSwitch={() => setView("switch")}
              onLinkSelect={close}
              onReorder={reorderOntologies}
            />
          ) : (
            <SwitchProjectPanel
              projects={projects}
              activeProjectId={currentProject?.id}
              onPickProject={(pid) => {
                if (pid !== currentProject?.id) switchScope(pid, null);
                setView("current");
                close();
              }}
              onBack={() => setView("current")}
            />
          )}
        </div>
      )}
    </Dropdown>
  );
}

// CurrentProjectPanel — lists ontologies with per-position colour swatches and
// drag-to-reorder handles (only shown when ≥2 root ontologies exist).
function CurrentProjectPanel({
  project,
  visibleOntologyIds,
  linkedOntologyIds,
  writeOntologyId,
  canSwitch,
  onCycleState,
  onSetWrite,
  onRequestSwitch,
  onLinkSelect,
  onReorder,
}) {
  const ontologies = project?.ontologies || [];
  const visibleSet = new Set(visibleOntologyIds);
  const linkedSet = new Set(linkedOntologyIds || []);

  // Build parent → [branches] map so we can nest branches under their root.
  const roots = ontologies.filter((o) => !o.branch_of);
  const branchesOf = {};
  for (const o of ontologies) {
    if (o.branch_of) {
      if (!branchesOf[o.branch_of]) branchesOf[o.branch_of] = [];
      branchesOf[o.branch_of].push(o);
    }
  }
  // Orphan branches: parent not present in this project (shouldn't happen, but guard).
  const rootIds = new Set(roots.map((o) => o.id));
  const orphans = ontologies.filter((o) => o.branch_of && !rootIds.has(o.branch_of));

  // If the current write target is a branch, its parent's eye should
  // also be disabled (only one of parent / branch visible at a time).
  // Use String() throughout to handle integer vs string ID type mismatches.
  const sWriteId = String(writeOntologyId);
  const writeOnto = ontologies.find((o) => String(o.id) === sWriteId);
  const writeBranchParentId = writeOnto?.branch_of ?? null;

  const mkRow = (o, isBranch, colorIdx) => {
    const sid = String(o.id);
    const isVisible = visibleSet.has(o.id) || visibleSet.has(sid);
    const isLinked = linkedSet.has(o.id) || linkedSet.has(sid);
    const isWrite = sid === sWriteId;
    const isParentOfWriteBranch =
      !isBranch && writeBranchParentId != null && String(writeBranchParentId) === sid;
    // Branch whose parent is the current write target — must be hidden (eye disabled).
    const isChildOfWriteRoot = isBranch && String(o.branch_of) === sWriteId;
    return (
      <OntologyWorkspaceRow
        key={o.id}
        ontology={o}
        isVisible={isVisible}
        isLinked={isLinked}
        isWriteTarget={isWrite}
        isBranch={isBranch}
        isImported={!!o.is_imported}
        isParentOfWriteBranch={isParentOfWriteBranch}
        isChildOfWriteRoot={isChildOfWriteRoot}
        colorIndex={colorIdx}
        onCycleState={() => onCycleState(o.id)}
        onSetWrite={() => onSetWrite(o.id)}
      />
    );
  };

  return (
    <>
      {/* Header */}
      <div className="px-3 pt-2 pb-1 flex items-center gap-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 min-w-0 flex-1 truncate">
          Current project
        </div>
        <button
          type="button"
          disabled={!canSwitch}
          onClick={onRequestSwitch}
          title={canSwitch ? "Pick a different project" : "No other projects"}
          className={`text-[11px] px-2 py-0.5 rounded-md border transition
            ${
              canSwitch
                ? "border-ink-600/60 text-brand-200 hover:bg-ink-700/70"
                : "border-ink-700/60 text-slate-600 cursor-not-allowed"
            }`}
        >
          Switch project →
        </button>
      </div>

      <div className="px-3 pb-1.5 text-sm font-medium text-slate-100 truncate">
        {project?.name || "—"}
      </div>

      {/* Workspace ontologies — cycle eye: hidden ➜ linked ➜ full ➜ hidden */}
      {ontologies.length > 0 && (
        <div className="px-3 pb-0.5 flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 flex-1">
            Workspace ontologies
          </span>
          <span className="text-[10px] text-slate-500">
            click
            <Eye size={10} className="inline mx-1" aria-hidden="true" />
            to cycle views
          </span>
        </div>
      )}

      {roots.map((root, rootIdx) => (
        <div key={root.id}>
          {mkRow(root, false, rootIdx)}
          {(branchesOf[root.id] || []).map((branch) => mkRow(branch, true, rootIdx))}
        </div>
      ))}
      {orphans.map((branch) => mkRow(branch, true, 0))}

      {ontologies.length === 0 && (
        <div className="px-3 py-1.5 text-xs text-slate-500">(no ontologies yet)</div>
      )}

      {/* Bottom links */}
      <div className="mt-1">
        {project?.id && (
          <PickerLinkItem
            to={`/projects?history=${project.id}`}
            onSelect={onLinkSelect}
            icon={<HistoryPickerIcon />}
            label="View history…"
          />
        )}
        <PickerLinkItem
          to="/projects"
          onSelect={onLinkSelect}
          icon={<ManageIcon />}
          label="Manage projects…"
        />
      </div>
    </>
  );
}

// One ontology row — single eye button cycles: hidden → linked → full → hidden.
// Branch ontologies are indented with a GitBranch icon on the left.
// Root ontologies show a position-colour swatch.
function OntologyWorkspaceRow({
  ontology,
  isVisible,
  isLinked,
  isWriteTarget,
  isBranch = false,
  isImported = false,
  isParentOfWriteBranch = false,
  isChildOfWriteRoot = false,
  colorIndex = 0,
  onCycleState,
  onSetWrite,
}) {
  // Determine display state
  const state = isWriteTarget ? "write" : isVisible ? "full" : isLinked ? "linked" : "hidden";

  // Eye button is disabled for:
  //  1. The write target (pinned to fully visible).
  //  2. The parent of a write-target branch — only one of parent/branch visible at a time.
  //  3. A branch whose parent is the write target — must stay hidden while parent is writable.
  const eyeDisabled = state === "write" || isParentOfWriteBranch || isChildOfWriteRoot;

  const eyeTitle = isChildOfWriteRoot
    ? "Disabled — this branch's parent is currently the write target"
    : isParentOfWriteBranch
      ? "Disabled — a branch of this ontology is currently the write target"
      : state === "write"
        ? "Write target — always fully visible"
        : state === "full"
          ? isBranch
            ? "Fully visible — click to hide"
            : "Fully visible — click to make linked-context only"
          : state === "linked"
            ? "Linked context (referenced entities only) — click to make fully visible"
            : isBranch
              ? "Hidden — click to show"
              : "Hidden — click to enable as linked context";

  const eyeColor =
    state === "write"
      ? "text-emerald-400 cursor-default"
      : isParentOfWriteBranch || isChildOfWriteRoot
        ? "text-slate-700 cursor-not-allowed opacity-40"
        : state === "full"
          ? "text-slate-300 hover:text-amber-300"
          : state === "linked"
            ? "text-violet-400 hover:text-slate-200"
            : "text-slate-600 hover:text-slate-400";

  return (
    <div
      className={`flex items-center gap-1 py-1 group
        ${isBranch ? "pl-7.5 pr-2" : "px-2"}
        ${state === "write" ? "bg-emerald-500/10 border-l-2 border-emerald-500/30" : state === "linked" ? "bg-violet-500/5 border-l-2 border-violet-500/30" : "border-l-2 border-slate-600/30"}`}
    >
      {/* Position colour swatch — root ontologies only, shows which colour slot
          this ontology occupies (changes when user reorders). */}
      {!isBranch && (
        <span
          className="shrink-0 w-2 h-2 rounded-sm opacity-80"
          style={{ backgroundColor: getOntologyColor(colorIndex) }}
          aria-hidden="true"
        />
      )}

      {/* Branch indent connector */}
      {isBranch && (
        <span className="shrink-0 text-slate-400/70 mr-0.5" aria-hidden="true">
          <GitBranch size={11} />
        </span>
      )}

      {/* Eye toggle — disabled for write target and ALL branches (branches are
          activated only by clicking the row name to set write target). */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCycleState();
        }}
        disabled={eyeDisabled}
        title={eyeTitle}
        className={`shrink-0 p-0.5 rounded transition ${eyeColor}`}
      >
        {state === "full" || state === "write" ? (
          <EyeOnIcon />
        ) : state === "linked" ? (
          <EyeLinkedIcon />
        ) : (
          <EyeOffIcon />
        )}
      </button>

      {/* Main area — imported ontologies show a read-only badge; others are
          clickable to set as write target */}
      {isImported ? (
        <div
          className={`flex-1 min-w-0 flex items-center gap-1.5 py-0.5
            ${isVisible || isLinked ? "opacity-100" : "opacity-40"}`}
          title="Read-only — pulled in via owl:imports"
        >
          {!isBranch && (
            <span className="shrink-0 text-slate-500">
              <OntoIcon />
            </span>
          )}
          <span className="flex-1 min-w-0 text-sm font-medium truncate text-slate-400">
            {ontology.name}
          </span>
          <span className="shrink-0 flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded bg-slate-700/60 text-slate-500">
            <span className="inline md:hidden">
              <LockIcon />
            </span>
            <span className="hidden md:inline">read-only</span>
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={onSetWrite}
          className={`flex-1 min-w-0 text-left flex items-center gap-1.5 py-0.5 rounded transition
            ${isVisible || isLinked ? "opacity-100" : "opacity-40"}`}
          title={isWriteTarget ? "Currently writing here" : "Click to make write target"}
        >
          {!isBranch && (
            <span className="shrink-0 text-slate-500">
              <OntoIcon />
            </span>
          )}
          <span
            className={`flex-1 min-w-0 text-sm font-medium truncate
            ${state === "write" ? "text-emerald-200" : state === "linked" ? "text-violet-300" : isBranch ? "text-brand-200/90" : "text-slate-200"}`}
          >
            {ontology.name}
          </span>
          {state === "write" ? (
            <span className="shrink-0 flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded bg-emerald-500/25 text-emerald-300">
              <span className="inline md:hidden">
                <WriteIcon />
              </span>{" "}
              <span className="hidden md:inline">write</span>
            </span>
          ) : state === "linked" ? (
            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded bg-violet-500/25 text-violet-400">
              linked
            </span>
          ) : state === "full" ? (
            <span className="shrink-0 text-[9px] text-slate-600 uppercase tracking-wide opacity-0 group-hover:opacity-100 transition">
              make writable
            </span>
          ) : null}
        </button>
      )}
    </div>
  );
}

function SwitchProjectPanel({ projects, activeProjectId, onPickProject, onBack }) {
  return (
    <>
      <div className="px-3 pt-2 pb-1 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-[11px] text-slate-400 hover:text-brand-200 flex items-center gap-1"
        >
          <ChevronLeft size={10} aria-hidden="true" />
          Back
        </button>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 flex-1 truncate">
          Switch project
        </div>
      </div>

      <div className="py-1">
        {projects.map((p) => {
          const count = p.ontologies?.length || 0;
          const isActive = p.id === activeProjectId;
          return (
            <PickerItem
              key={p.id}
              icon={<ProjectIcon />}
              label={p.name}
              sub={`${count} ontolog${count === 1 ? "y" : "ies"}`}
              selected={isActive}
              onClick={() => onPickProject(p.id)}
            />
          );
        })}
        {projects.length === 0 && (
          <div className="px-3 py-1.5 text-xs text-slate-500">No projects.</div>
        )}
      </div>

      <div className="border-t border-ink-700 mt-1 pt-1">
        <PickerLinkItem
          to="/projects"
          onSelect={onBack}
          icon={<ManageIcon />}
          label="Manage projects…"
        />
      </div>
    </>
  );
}

function PickerItem({ icon, label, sub, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-sm flex items-start gap-2
        ${selected ? "bg-brand-600/20 text-brand-100" : "text-slate-200 hover:bg-ink-700/70"}`}
    >
      <span className="mt-0.5 shrink-0 text-slate-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium truncate">{label}</span>
        {sub && <span className="block text-[10px] text-slate-500 truncate">{sub}</span>}
      </span>
      {selected && <Check size={14} className="mt-1 text-brand-300 shrink-0" aria-hidden="true" />}
    </button>
  );
}

function PickerLinkItem({ to, onSelect, icon, label }) {
  return (
    <NavLink
      to={to}
      onClick={onSelect}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-1.5 text-sm border-t border-ink-600/80
         ${isActive ? "text-brand-200 bg-brand-600/15" : "text-slate-300 hover:bg-ink-700/70"}`
      }
    >
      <span className="text-slate-400">{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
function OntoIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M8 7l8 0" />
      <path d="M7 7l5 9" />
      <path d="M17 7l-5 9" />
    </svg>
  );
}
function HistoryPickerIcon() {
  return <RotateCcw size={12} aria-hidden="true" />;
}
function ManageIcon() {
  return <AlignLeft size={12} aria-hidden="true" />;
}
function ProjectIcon() {
  return <FolderOpen size={12} aria-hidden="true" />;
}
function EyeOnIcon() {
  return <Eye size={13} aria-hidden="true" />;
}
// Linked state: chain-link icon = "partially visible / linked context"
function EyeLinkedIcon() {
  return <Link size={13} aria-hidden="true" />;
}
function EyeOffIcon() {
  return <EyeOff size={13} aria-hidden="true" />;
}
function WriteIcon() {
  return <Edit size={9} strokeWidth={2.5} aria-hidden="true" />;
}
function LockIcon() {
  return <Lock size={9} strokeWidth={2.5} aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// User menu (top-right)
// ---------------------------------------------------------------------------
export function UserMenu({ user, onLogout }) {
  const initials = (user?.username || "?").slice(0, 2).toUpperCase();
  return (
    <Dropdown
      panelClass="right-0"
      trigger={(open) => (
        <button
          type="button"
          className="flex items-center gap-2 pl-1.5 pr-2 py-1 rounded-md bg-ink-800/70 border border-ink-600/60 hover:bg-ink-700/70 transition"
        >
          <span className="w-7 h-7 rounded-full bg-brand-600/40 text-brand-100 grid place-items-center text-[11px] font-semibold">
            {initials}
          </span>
          <span className="text-sm min-w-0 hidden sm:block text-left">
            <span className="block text-slate-200 truncate">{user?.username || "—"}</span>
          </span>
          <ChevronDown
            size={12}
            className={`transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      )}
    >
      {(close) => (
        <div className="min-w-56">
          <div className="px-3 py-2 border-b border-ink-700">
            <div className="text-sm font-medium text-slate-200 truncate">
              {user?.username}
              <span className="float-right text-[10px] text-slate-500 uppercase mt-0.5">
                {user?.role || ""}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {user?.email || "No email set"}
            </div>
          </div>
          <PickerLinkItem to="/settings" onSelect={close} icon={<GearIcon />} label="Settings" />
          <PickerLinkItem
            to="/projects"
            onSelect={close}
            icon={<ManageIcon />}
            label="Manage projects"
          />
          {user?.role === "admin" && (
            <PickerLinkItem
              to="/admin"
              onSelect={close}
              icon={<ShieldIcon />}
              label="Administration"
            />
          )}
          <div className="border-t border-ink-700 mt-1 pt-1">
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 text-sm text-slate-300 hover:bg-ink-700/70 flex items-center gap-2"
              onClick={() => {
                close();
                onLogout?.();
              }}
            >
              <LogoutIcon /> <span>Sign out</span>
            </button>
          </div>
        </div>
      )}
    </Dropdown>
  );
}

function GearIcon() {
  return <Settings size={12} aria-hidden="true" />;
}
function ShieldIcon() {
  return <Shield size={12} aria-hidden="true" />;
}
function LogoutIcon() {
  return <LogOut size={12} aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// Modals (blank vs import, both reused by ManageProjectsView)
// ---------------------------------------------------------------------------
function ModalShell({ title, onClose, children, maxWidth = "max-w-xl" }) {
  return createPortal(
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-xs grid place-items-center z-9999"
      role="presentation"
    >
      <div role="presentation" className={`panel w-full ${maxWidth} p-5`}>
        <h3 className="font-semibold mb-4">{title}</h3>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ChoiceRadio({ value, current, setValue, label, hint }) {
  const active = value === current;
  return (
    <button
      type="button"
      className={`flex-1 text-left px-3 py-2.5 rounded-md border transition
        ${
          active
            ? "bg-brand-600/15 border-brand-500/50 text-brand-100"
            : "bg-ink-900/40 border-ink-700 text-slate-300 hover:bg-ink-800/60"
        }`}
      onClick={() => setValue(value)}
    >
      <div className="font-medium text-sm">{label}</div>
      <div className="text-xs text-slate-400 mt-0.5">{hint}</div>
    </button>
  );
}

// Converts a human-readable string to kebab-case for use in an ontology IRI.
function toKebabCase(str) {
  return str
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join("-");
}

// Returns a unique default IRI that doesn't clash with any existing ontology IRI
// in the current project list. Increments a numeric suffix until it's free.
function computeUniqueDefaultIri(projects) {
  const existing = new Set(
    (projects || []).flatMap((p) => (p.ontologies || []).map((o) => o.iri).filter(Boolean)),
  );
  const base = "http://example.org/new-ontology";
  let i = 1;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export function NewProjectModal({ onClose, onCreated }) {
  const { projects, refresh } = useProject();
  const { githubEnabled, githubConnection } = useAuth();
  // Show GitHub mode if user has connected their account OR if GitHub is enabled
  const canUseGitHub = githubEnabled || !!githubConnection;
  const defaultIri = useMemo(() => computeUniqueDefaultIri(projects), [projects]);
  const [mode, setMode] = useState("blank");
  const [source, setSource] = useState("file"); // "file" | "url"
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ontologyName, setOntologyName] = useState("");
  const [iri, setIri] = useState(defaultIri);
  const [iriUserEdited, setIriUserEdited] = useState(false);
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, _setGithubBranch] = useState("");
  const [fetchImports, setFetchImports] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  // Set to true when the project was created but sync had errors — switches
  // "Cancel" to "Close" and hides the submit button so the user doesn't retry.
  const [createdWithErrors, setCreatedWithErrors] = useState(false);

  // Auto-update the ontology IRI from the ontology name (or project name) in
  // kebab-case. Falls back to the unique default when both name fields are empty.
  useEffect(() => {
    if (iriUserEdited) return;
    const nameForIri = (ontologyName || name).trim();
    if (!nameForIri) {
      setIri(defaultIri);
      return;
    }
    setIri(`http://example.org/${toKebabCase(nameForIri)}`);
  }, [ontologyName, name, iriUserEdited, defaultIri]);

  // Spinner message shown below the form while busy (blank mode is fast, skip it).
  const busyMsg =
    mode === "github"
      ? "Creating project and syncing from GitHub…"
      : source === "url"
        ? "Fetching URL and resolving owl:imports — this may take a moment…"
        : mode === "import"
          ? "Loading RDF data — large files may take a minute…"
          : null;

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setErr("Project name is required");
      return;
    }
    flushSync(() => {
      setErr(null);
      setBusy(true);
    });
    try {
      if (mode === "github") {
        const repoVal = githubRepo.trim().replace(/\/$/, "");
        if (!repoVal) {
          setErr("GitHub repository is required (owner/repo)");
          setBusy(false);
          return;
        }
        if (!/^[\w.-]+\/[\w.-]+$/.test(repoVal)) {
          setErr("Repository must be in 'owner/repo' format");
          setBusy(false);
          return;
        }
        // 1. Create project without a starter ontology — GitHub sync will populate it
        const created = await api.createProject({
          name: name.trim(),
          description: description.trim() || null,
          skipOntology: true,
        });
        const pid = created.project?.id;
        if (!pid) {
          onCreated?.(created);
          return;
        }
        // 2. Link the GitHub repo
        await api.setProjectGitHub(pid, {
          github_repo: repoVal,
          github_branch: githubBranch.trim() || undefined,
        });
        // 3. Sync files from the repo
        try {
          const syncResult = await api.syncProjectFromGitHub(pid);
          if (syncResult.synced === 0 && syncResult.errors?.length > 0) {
            // Zero files synced — keep modal open so user sees the error.
            // Refresh and activate the new project so it appears in the picker.
            refresh({ projectId: pid }).catch(() => {});
            const firstErr = syncResult.errors[0];
            setErr(
              `Project created but sync found 0 files (${syncResult.errors.length} error${syncResult.errors.length !== 1 ? "s" : ""}${firstErr.path ? `: ${firstErr.path}` : ""}: ${firstErr.error}). Retry sync from the project card.`,
            );
            setCreatedWithErrors(true);
            setBusy(false);
            return;
          }
          if (syncResult.errors?.length > 0) {
            // Partial failure — keep modal open so user sees which imports failed.
            refresh({ projectId: pid }).catch(() => {});
            const firstErr = syncResult.errors[0];
            setErr(
              `Synced ${syncResult.synced} file${syncResult.synced !== 1 ? "s" : ""} but ${syncResult.errors.length} import${syncResult.errors.length !== 1 ? "s" : ""} failed${firstErr.path ? ` (${firstErr.path})` : ""}: ${firstErr.error}. Retry sync from the project card to resolve.`,
            );
            setCreatedWithErrors(true);
            setBusy(false);
            return;
          }
        } catch (e) {
          // Sync threw entirely — keep modal open so user sees the error.
          refresh({ projectId: pid }).catch(() => {});
          setErr(
            `Project created but sync failed: ${e.message}. Retry sync from the project card.`,
          );
          setCreatedWithErrors(true);
          setBusy(false);
          return;
        }
        // Clean success — close the modal.
        onCreated?.(created);
        return;
      }

      if (mode === "blank") {
        const r = await api.createProject({
          name: name.trim(),
          description: description.trim() || null,
          ontology: {
            name: ontologyName.trim() || name.trim(),
            iri: iri.trim() || null,
          },
        });
        onCreated?.(r);
      } else if (source === "url") {
        const trimmed = url.trim();
        if (!trimmed) {
          setErr("Enter a URL");
          setBusy(false);
          return;
        }
        const r = await api.importFromUrl(trimmed, {
          mode: "new-project",
          name: name.trim(),
          description: description.trim() || null,
          fetchImports,
        });
        onCreated?.(r);
      } else {
        if (!file) {
          setErr("Select a file to import");
          setBusy(false);
          return;
        }
        const r = await api.importTtl(file, {
          mode: "new-project",
          name: name.trim(),
          description: description.trim() || null,
          fetchImports,
        });
        onCreated?.(r);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Create a new project" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          <ChoiceRadio
            value="blank"
            current={mode}
            setValue={setMode}
            label="Blank project"
            hint="Start with one empty ontology"
          />
          <ChoiceRadio
            value="import"
            current={mode}
            setValue={setMode}
            label="Import"
            hint="File or URL — Turtle, RDF/XML, JSON-LD…"
          />
          {canUseGitHub && (
            <ChoiceRadio
              value="github"
              current={mode}
              setValue={setMode}
              label="GitHub Repo"
              hint="Pull ontology files from a GitHub repository"
            />
          )}
        </div>

        <label className="block">
          <span className="label">Project name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="My Project"
          />
        </label>
        <label className="block">
          <span className="label">Description (optional)</span>
          <textarea
            className="input min-h-15"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        {mode === "blank" && (
          <>
            <label className="block">
              <span className="label">First ontology name (optional)</span>
              <input
                className="input"
                value={ontologyName}
                onChange={(e) => setOntologyName(e.target.value)}
                placeholder="defaults to the project name"
              />
            </label>
            <label className="block">
              <span className="label">Base IRI</span>
              <input
                className="input font-mono"
                value={iri}
                onChange={(e) => {
                  setIriUserEdited(true);
                  setIri(e.target.value);
                }}
              />
            </label>
          </>
        )}

        {mode === "import" && (
          <>
            {/* Source toggle */}
            <div className="flex items-center gap-1 p-1 bg-ink-900/60 rounded-md w-fit">
              <button
                type="button"
                onClick={() => setSource("file")}
                className={`px-3 py-1 text-xs rounded transition font-medium ${source === "file" ? "bg-brand-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}
              >
                File upload
              </button>
              <button
                type="button"
                onClick={() => setSource("url")}
                className={`px-3 py-1 text-xs rounded transition font-medium ${source === "url" ? "bg-brand-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}
              >
                From URL
              </button>
            </div>

            {source === "file" ? (
              <label className="block">
                <span className="label">File</span>
                <input
                  type="file"
                  className="input"
                  accept=".ttl,.nt,.nq,.trig,.rdf,.xml,.jsonld,.json,.n3"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>
            ) : (
              <label className="block">
                <span className="label">URL</span>
                <input
                  type="url"
                  className="input"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.org/ontology.ttl"
                  spellCheck={false}
                />
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={fetchImports}
                onChange={(e) => setFetchImports(e.target.checked)}
              />
              <span className="text-slate-400">
                Fetch <code className="font-mono text-xs">owl:imports</code> as separate ontologies
              </span>
            </label>
          </>
        )}

        {mode === "github" && (
          <div className="space-y-3">
            <label className="block">
              <span className="label">
                GitHub Repository <span className="text-slate-500">(owner/repo)</span>
              </span>
              <input
                className="input font-mono"
                placeholder="e.g. my-org/my-ontologies"
                value={githubRepo}
                onChange={(e) => {
                  const val = e.target.value.replace(/^https?:\/\/github\.com\//, "");
                  setGithubRepo(val);
                }}
                required
              />
            </label>
            {!githubConnection && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2.5 text-xs text-amber-200">
                <GitBranch size={12} aria-hidden="true" />
                Connect your GitHub account in{" "}
                <a href="/settings#github" className="underline">
                  Settings
                </a>{" "}
                to sync ontology files.
              </div>
            )}
          </div>
        )}

        {err && <div className="text-sm text-red-300">{err}</div>}
        {busy && busyMsg && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <svg
              aria-hidden="true"
              className="animate-spin h-4 w-4 text-brand-400 shrink-0"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            {busyMsg}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            {createdWithErrors ? "Close" : "Cancel"}
          </button>
          {!createdWithErrors && (
            <button
              type="submit"
              className="btn-primary flex items-center gap-2"
              disabled={busy || (mode === "github" && !githubConnection)}
              title={
                mode === "github" && !githubConnection
                  ? "Connect your GitHub account in Settings first"
                  : undefined
              }
            >
              {busy && (
                <svg
                  aria-hidden="true"
                  className="animate-spin h-4 w-4 shrink-0"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              )}
              {busy ? "Creating…" : "Create project"}
            </button>
          )}
        </div>
      </form>
    </ModalShell>
  );
}

export function NewOntologyModal({ onClose, onCreated, projectId, projectName }) {
  const { projects } = useProject();
  const defaultIri = useMemo(() => computeUniqueDefaultIri(projects), [projects]);
  const [mode, setMode] = useState("blank");
  const [source, setSource] = useState("file"); // "file" | "url"
  const [name, setName] = useState("");
  const [iri, setIri] = useState(defaultIri);
  const [iriUserEdited, setIriUserEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState("");
  const [fetchImports, setFetchImports] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  // Auto-update the ontology IRI from the name in kebab-case.
  // Falls back to the unique default when the name field is empty.
  useEffect(() => {
    if (iriUserEdited) return;
    if (!name.trim()) {
      setIri(defaultIri);
      return;
    }
    setIri(`http://example.org/${toKebabCase(name.trim())}`);
  }, [name, iriUserEdited, defaultIri]);

  const busyMsg =
    source === "url"
      ? "Fetching URL and resolving owl:imports — this may take a moment…"
      : mode === "import"
        ? "Loading RDF data — large files may take a minute…"
        : null;

  const submit = async (e) => {
    e.preventDefault();
    flushSync(() => {
      setErr(null);
      setBusy(true);
    });
    try {
      if (mode === "blank") {
        if (!name.trim()) {
          setErr("Ontology name is required");
          setBusy(false);
          return;
        }
        const r = await api.createOntology({
          name: name.trim(),
          iri: iri.trim() || null,
          description: description.trim() || null,
          project_id: projectId || getCurrentProject(),
        });
        onCreated?.(r);
      } else if (source === "url") {
        const trimmed = url.trim();
        if (!trimmed) {
          setErr("Enter a URL");
          setBusy(false);
          return;
        }
        const r = await api.importFromUrl(trimmed, {
          mode: "new-ontology",
          projectId: projectId || getCurrentProject(),
          name: name.trim() || undefined,
          description: description.trim() || undefined,
          fetchImports,
        });
        onCreated?.(r);
      } else {
        if (!file) {
          setErr("Select a file to import");
          setBusy(false);
          return;
        }
        const r = await api.importTtl(file, {
          mode: "new-ontology",
          projectId: projectId || getCurrentProject(),
          name: name.trim() || undefined,
          description: description.trim() || undefined,
          fetchImports,
        });
        onCreated?.(r);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title={`Add ontology to ${projectName || "current project"}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex gap-2">
          <ChoiceRadio
            value="blank"
            current={mode}
            setValue={setMode}
            label="Blank ontology"
            hint="Empty — add entities from scratch"
          />
          <ChoiceRadio
            value="import"
            current={mode}
            setValue={setMode}
            label="Import"
            hint="File or URL — Turtle, RDF/XML, JSON-LD…"
          />
        </div>

        <label className="block">
          <span className="label">
            Name
            {mode === "import" && (
              <span className="text-slate-500">
                {" "}
                (optional — defaults to filename or RDF title)
              </span>
            )}
          </span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required={mode === "blank"}
            placeholder="My Ontology"
          />
        </label>

        {mode === "blank" && (
          <label className="block">
            <span className="label">Base IRI</span>
            <input
              className="input font-mono"
              value={iri}
              onChange={(e) => {
                setIriUserEdited(true);
                setIri(e.target.value);
              }}
            />
          </label>
        )}

        <label className="block">
          <span className="label">Description (optional)</span>
          <textarea
            className="input min-h-15"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        {mode === "import" && (
          <>
            {/* Source toggle */}
            <div className="flex items-center gap-1 p-1 bg-ink-900/60 rounded-md w-fit">
              <button
                type="button"
                onClick={() => setSource("file")}
                className={`px-3 py-1 text-xs rounded transition font-medium ${source === "file" ? "bg-brand-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}
              >
                File upload
              </button>
              <button
                type="button"
                onClick={() => setSource("url")}
                className={`px-3 py-1 text-xs rounded transition font-medium ${source === "url" ? "bg-brand-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}
              >
                From URL
              </button>
            </div>

            {source === "file" ? (
              <label className="block">
                <span className="label">File</span>
                <input
                  type="file"
                  className="input"
                  accept=".ttl,.nt,.nq,.trig,.rdf,.xml,.jsonld,.json,.n3"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>
            ) : (
              <label className="block">
                <span className="label">URL</span>
                <input
                  type="url"
                  className="input"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.org/ontology.ttl"
                  spellCheck={false}
                />
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={fetchImports}
                onChange={(e) => setFetchImports(e.target.checked)}
              />
              <span className="text-slate-400">
                Fetch <code className="font-mono text-xs">owl:imports</code> as separate ontologies
              </span>
            </label>
          </>
        )}

        {err && <div className="text-sm text-red-300">{err}</div>}
        {busy && busyMsg && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <svg
              aria-hidden="true"
              className="animate-spin h-4 w-4 text-brand-400 shrink-0"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            {busyMsg}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary flex items-center gap-2" disabled={busy}>
            {busy && (
              <svg
                aria-hidden="true"
                className="animate-spin h-4 w-4 shrink-0"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {busy ? "Adding…" : "Add ontology"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

export function EditOntologyModal({ onClose, onSaved, onDelete, ontology, readOnly = false }) {
  const [name, setName] = useState(ontology?.name || "");
  const [iri, setIri] = useState(ontology?.iri || "");
  const [description, setDescription] = useState(
    ontology?.rdfDescription || ontology?.description || "",
  );
  const [title, setTitle] = useState(ontology?.rdfTitle || "");
  const [versionInfo, setVersionInfo] = useState(ontology?.rdfVersion || "");
  const [creator, setCreator] = useState(ontology?.rdfCreator || "");
  const [license, setLicense] = useState(ontology?.rdfLicense || "");
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setErr("Ontology name is required");
      return;
    }
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api.updateOntology(ontology.id, {
        name: name.trim(),
        iri: iri.trim() || null,
        description: description.trim() || null,
        title: title.trim() || null,
        versionInfo: versionInfo.trim() || null,
        creator: creator.trim() || null,
        license: license.trim() || null,
      });
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        onSaved?.();
        onClose?.();
      }, 1000);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={readOnly ? "Ontology metadata" : "Edit ontology"}
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <form onSubmit={readOnly ? (e) => e.preventDefault() : submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Internal name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              readOnly={readOnly}
              required={!readOnly}
            />
            <div className="text-[11px] text-slate-500 mt-1">
              Used internally when no RDF title is set.
            </div>
          </label>
          <label className="block">
            <span className="label">
              Title <span className="text-slate-500 font-normal">(dcterms:title)</span>
            </span>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Human-readable display title"
              readOnly={readOnly}
            />
          </label>
        </div>
        <label className="block">
          <span className="label">Base IRI</span>
          <input
            className="input font-mono"
            value={iri}
            onChange={(e) => setIri(e.target.value)}
            readOnly={readOnly}
          />
        </label>
        <label className="block">
          <span className="label">
            Description <span className="text-slate-500 font-normal">(dcterms:description)</span>
          </span>
          <textarea
            className="input min-h-18"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            readOnly={readOnly}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">
              Version <span className="text-slate-500 font-normal">(owl:versionInfo)</span>
            </span>
            <input
              className="input font-mono"
              value={versionInfo}
              onChange={(e) => setVersionInfo(e.target.value)}
              placeholder="e.g. 1.2.0"
              readOnly={readOnly}
            />
          </label>
          <label className="block">
            <span className="label">
              Creator <span className="text-slate-500 font-normal">(dcterms:creator)</span>
            </span>
            <input
              className="input"
              value={creator}
              onChange={(e) => setCreator(e.target.value)}
              placeholder="Author or organization"
              readOnly={readOnly}
            />
          </label>
        </div>
        <label className="block">
          <span className="label">
            License <span className="text-slate-500 font-normal">(dcterms:license — IRI)</span>
          </span>
          <input
            className="input font-mono"
            value={license}
            onChange={(e) => setLicense(e.target.value)}
            placeholder="https://creativecommons.org/licenses/by/4.0/"
            readOnly={readOnly}
          />
        </label>
        {err && <div className="text-sm text-red-300">{err}</div>}
        {saved && <div className="text-sm text-emerald-300">Saved.</div>}
        <div className="flex items-center justify-end gap-2 pt-2">
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              {readOnly ? "Close" : "Cancel"}
            </button>
            {!readOnly && (
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? "…" : "Save ontology"}
              </button>
            )}
          </div>
        </div>
      </form>
    </ModalShell>
  );
}

export function EditProjectModal({ onClose, onSaved, project }) {
  const [name, setName] = useState(project?.name || "");
  const [description, setDescription] = useState(project?.description || "");
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setErr("Project name is required");
      return;
    }
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api.updateProject(project.id, {
        name: name.trim(),
        description: description.trim() || null,
      });
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        onSaved?.();
        onClose?.();
      }, 1000);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Edit project" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="label">Project name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="label">Description (optional)</span>
          <textarea
            className="input min-h-15"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {err && <div className="text-sm text-red-300">{err}</div>}
        {saved && <div className="text-sm text-emerald-300">Saved.</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "…" : "Save project"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// Default export kept for back-compat — renders the combined picker.
export default ProjectOntologyPicker;
