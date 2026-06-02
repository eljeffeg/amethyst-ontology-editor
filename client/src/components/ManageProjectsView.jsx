import {
  Check,
  ChevronRight,
  Copy,
  Crosshair,
  Download,
  Edit,
  Eye,
  FileText,
  GitBranch,
  GitCompare,
  GitMerge,
  GripVertical,
  Lock,
  MessageSquare,
  Pencil,
  RefreshCw,
  RotateCcw,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../App.jsx";
import { api } from "../lib/api.js";
import { getOntologyColor } from "../lib/ontologyColors.js";
import {
  EditOntologyModal,
  EditProjectModal,
  NewOntologyModal,
  NewProjectModal,
  useProject,
} from "./OntologyPicker.jsx";

export default function ManageProjectsView({ onOntologiesChanged }) {
  const { projects, refresh, switchProject, currentProjectId } = useProject();
  const { user } = useAuth();
  const scrollRef = useRef(null);

  const [showNewProject, setShowNewProject] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingProjectIds, setLoadingProjectIds] = useState(() => new Set());
  const [flash, setFlash] = useState(null);
  // ID of a newly created project to switch to once it appears in the list.
  const [pendingProjectSwitch, setPendingProjectSwitch] = useState(null);
  // Which project has its Users panel open (null = none)
  const [usersProjectId, setUsersProjectId] = useState(null);
  // Which project has its History panel open (null = none)
  const [historyProjectId, setHistoryProjectId] = useState(null);
  // Track expanded state per project ID so refreshes don't collapse cards.
  const [expandedProjects, setExpandedProjects] = useState(
    () => new Set(currentProjectId != null ? [String(currentProjectId)] : []),
  );

  const toggleExpanded = (id) =>
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(String(id))) next.delete(String(id));
      else next.add(String(id));
      return next;
    });

  // Once the project list is refreshed and contains the newly created project,
  // switch to it automatically.  We use a pending-ID + useEffect pattern because
  // switchProject reads from the `projects` state that hasn't been committed yet
  // at the point when onCreated fires — waiting for the next render guarantees
  // the new entry is present when switchProject does its find().
  // biome-ignore lint/correctness/useExhaustiveDependencies: switchProject is stable
  useEffect(() => {
    if (!pendingProjectSwitch) return;
    const found = projects.find((p) => String(p.id) === String(pendingProjectSwitch));
    if (found) {
      switchProject(found.id);
      setPendingProjectSwitch(null);
    }
  }, [projects, pendingProjectSwitch]);

  // Auto-open history panel when navigated to /projects?history=<id>
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const hid = searchParams.get("history");
    // Compare as strings — project IDs from the DB are integers but URL params
    // are always strings, so a strict === check would silently fail.
    if (hid && projects.find((p) => String(p.id) === hid)) {
      setHistoryProjectId(hid);
    }
  }, [searchParams, projects]);

  // When closing the history panel, also clear the ?history= URL param so that
  // clicking "View history…" from the project menu re-opens the panel reliably.
  // Without this, the URL stays as ?history=<id> after close and the link
  // produces no navigation change, so the useEffect above never re-fires.
  const closeHistory = () => {
    setHistoryProjectId(null);
    if (searchParams.has("history")) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("history");
          return next;
        },
        { replace: true },
      );
    }
  };

  const flashMsg = (msg) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 4000);
  };

  const handleRefresh = async () => {
    const savedScroll = scrollRef.current?.scrollTop ?? 0;
    setRefreshing(true);
    try {
      await refresh();
      onOntologiesChanged?.();
    } finally {
      setRefreshing(false);
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = savedScroll;
      });
    }
  };

  // Fire warm-up GET requests so the card spinner clears once the server's
  // event loop is free (after worker serialization finishes).
  const warmUp = useCallback((projectId) => {
    if (!projectId) return;
    setLoadingProjectIds((prev) => new Set([...prev, String(projectId)]));
    Promise.all([api.classes().catch(() => {}), api.graph("full").catch(() => {})]).finally(() => {
      setLoadingProjectIds((prev) => {
        const next = new Set(prev);
        next.delete(String(projectId));
        return next;
      });
    });
  }, []);

  return (
    <div ref={scrollRef} className="flex-1 flex flex-col min-h-0 overflow-auto">
      <div className="border-b border-ink-700 bg-ink-900/70 px-5 py-3 flex items-center gap-3">
        <h1 className="text-base font-semibold flex-1">Manage Projects</h1>
        {refreshing && (
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <svg
              aria-hidden="true"
              className="animate-spin h-3.5 w-3.5 text-brand-400 shrink-0"
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
            Loading…
          </span>
        )}
        <button
          type="button"
          className="btn-primary text-xs"
          onClick={() => setShowNewProject(true)}
        >
          + New project
        </button>
      </div>

      {flash && (
        <div className="px-5 pt-3">
          <div className="panel px-3 py-2 text-sm text-brand-200 border-brand-500/40">{flash}</div>
        </div>
      )}

      <div className="flex-1 p-5 space-y-4">
        {projects.length === 0 && (
          <div className="panel p-6 text-center text-slate-400 text-sm">
            No projects yet. Click &quot;+ New project&quot; to create one.
          </div>
        )}

        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            isActiveProject={String(p.id) === String(currentProjectId)}
            currentUserId={user?.id}
            onFlash={flashMsg}
            onRefresh={handleRefresh}
            onWarmUp={warmUp}
            isLoadingOntology={loadingProjectIds.has(String(p.id))}
            onSwitchProject={() => switchProject(p.id)}
            onOpenUsers={() => setUsersProjectId(usersProjectId === p.id ? null : p.id)}
            usersOpen={usersProjectId === p.id}
            onOpenHistory={() =>
              setHistoryProjectId((prev) => (String(prev) === String(p.id) ? null : String(p.id)))
            }
            historyOpen={String(historyProjectId) === String(p.id)}
            expanded={expandedProjects.has(String(p.id))}
            onToggleExpanded={() => toggleExpanded(p.id)}
          />
        ))}
      </div>

      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={async (r) => {
            setShowNewProject(false);
            flashMsg("Project created.");
            // Queue the switch; the useEffect above will call switchProject
            // once handleRefresh() has committed the new project to context state.
            const newId = r?.project?.id;
            if (newId) {
              setPendingProjectSwitch(newId);
              setExpandedProjects((prev) => new Set([...prev, String(newId)]));
            }
            await handleRefresh();
            if (newId) warmUp(newId);
          }}
        />
      )}

      {/* Users panel — slides in when a manager clicks "Users" */}
      {usersProjectId && (
        <ProjectUsersPanel
          projectId={usersProjectId}
          project={projects.find((p) => p.id === usersProjectId)}
          onClose={() => setUsersProjectId(null)}
          onFlash={flashMsg}
        />
      )}

      {/* History panel — slides in when any member clicks "History" */}
      {historyProjectId && (
        <ProjectHistoryPanel
          projectId={historyProjectId}
          project={projects.find((p) => String(p.id) === String(historyProjectId))}
          onClose={closeHistory}
        />
      )}
    </div>
  );
}

// ── Project card ──────────────────────────────────────────────────────────────

function ProjectCard({
  project,
  isActiveProject,
  currentUserId,
  onFlash,
  onRefresh,
  onWarmUp,
  isLoadingOntology,
  onSwitchProject,
  onOpenUsers,
  usersOpen,
  onOpenHistory,
  historyOpen,
  expanded,
  onToggleExpanded,
}) {
  const { setWriteTarget, refresh: ctxRefresh, reorderOntologies } = useProject();
  const [showAddOntology, setShowAddOntology] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncErrors, setSyncErrors] = useState([]);

  const handleGitHubSync = async () => {
    setSyncing(true);
    try {
      const result = await api.syncProjectFromGitHub(project.id);
      const n = result.synced ?? 0;
      const errCount = result.errors?.length ?? 0;
      onFlash(
        n > 0
          ? `Synced ${n} file${n !== 1 ? "s" : ""} from ${project.github_repo}${errCount ? ` (${errCount} error${errCount !== 1 ? "s" : ""})` : ""}.`
          : errCount > 0
            ? `Sync found 0 files — ${errCount} error${errCount !== 1 ? "s" : ""}: ${result.errors[0].error}`
            : `All files up to date from ${project.github_repo}.`,
      );
      setSyncErrors(errCount > 0 ? result.errors : []);
      await onRefresh();
    } catch (e) {
      const msg = e.message.includes("github_not_connected")
        ? "Connect your GitHub account in Settings first."
        : e.message;
      onFlash(`GitHub sync failed: ${msg}`);
      setSyncErrors([]);
    } finally {
      setSyncing(false);
    }
  };

  // ── Drag-to-reorder state ────────────────────────────────────────────────
  // Only root ontologies (no branch_of) are reorderable; branches follow their parent.
  const allOntos = project.ontologies || [];
  const roots = allOntos.filter((o) => !o.branch_of);
  const branchesOf = {};
  for (const o of allOntos) {
    if (o.branch_of) {
      if (!branchesOf[o.branch_of]) branchesOf[o.branch_of] = [];
      branchesOf[o.branch_of].push(o);
    }
  }
  const shownIds = new Set(roots.map((o) => o.id));
  const orphanBranches = allOntos.filter((o) => o.branch_of && !shownIds.has(o.branch_of));

  // canDrag: need ≥2 root ontologies and editor permission.
  const isManager = project.userRole === "manager";
  const isEditor = isManager || project.userRole === "editor";
  const canDrag = roots.length > 1 && isEditor;

  const [dragSrcIdx, setDragSrcIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  const handleDrop = (targetIdx) => {
    if (dragSrcIdx === null || dragSrcIdx === targetIdx) {
      setDragSrcIdx(null);
      setDragOverIdx(null);
      return;
    }
    const arr = [...roots];
    const [moved] = arr.splice(dragSrcIdx, 1);
    arr.splice(targetIdx > dragSrcIdx ? targetIdx - 1 : targetIdx, 0, moved);
    reorderOntologies?.(arr.map((o) => o.id));
    setDragSrcIdx(null);
    setDragOverIdx(null);
  };

  const deleteProject = async () => {
    if (!confirm(`Delete project "${project.name}" and ALL its ontologies? This cannot be undone.`))
      return;
    setBusy(true);
    try {
      await api.deleteProject(project.id);
      onFlash(`Deleted project "${project.name}".`);
      await onRefresh();
    } catch (e) {
      onFlash(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      {/* Header row */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-700/60">
        <button
          type="button"
          onClick={onToggleExpanded}
          className="text-slate-400 hover:text-slate-200 transition"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <ChevronRight
            size={14}
            className={`transition-transform ${expanded ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm truncate">{project.name}</span>
            <RoleBadge role={project.userRole} />
            {/* GitHub repo badge */}
            {project.github_repo && (
              <a
                href={`https://github.com/${project.github_repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden sm:flex items-center gap-1 text-[10px] font-mono text-slate-500 hover:text-slate-300 px-1.5 py-1 rounded border border-ink-600/60 bg-ink-800/40 truncate transition-colors"
                title={`GitHub: ${project.github_repo}`}
              >
                <GitBranch size={9} aria-hidden="true" />
                {project.github_repo}
              </a>
            )}
          </div>
          {project.description && (
            <div className="text-xs text-slate-500 truncate mt-0.5">{project.description}</div>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Active indicator or switch button — always visible in the header */}
          {isActiveProject ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300 px-2.5 py-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10">
              <Check size={11} aria-hidden="true" />
              <span className="hidden md:inline">Active Project</span>
            </span>
          ) : (
            <button
              type="button"
              className="btn text-xs flex items-center gap-2 px-3.25"
              onClick={onSwitchProject}
              title="Make this the active project in the workspace"
            >
              <Crosshair size={11} aria-hidden="true" />
              <span className="hidden md:inline">Make Active</span>
            </button>
          )}
          {/* GitHub repo badge + Sync button */}
          {project.github_repo && isEditor && (
            <button
              type="button"
              className="btn text-xs flex items-center gap-1"
              onClick={handleGitHubSync}
              disabled={syncing}
              title="Pull latest ontology files from GitHub"
            >
              <RefreshCw size={11} className={syncing ? "animate-spin" : ""} aria-hidden="true" />
              <span className="hidden md:inline">{syncing ? "Syncing…" : "Sync"}</span>
            </button>
          )}
          {/* Edit button — editor+ */}
          {isEditor && (
            <button type="button" className="btn text-xs" onClick={() => setShowEdit(true)}>
              <EditIcon />
              <span className="hidden md:inline">Edit</span>
            </button>
          )}
          {/* History button — all users */}
          <button
            type="button"
            onClick={onOpenHistory}
            className={`btn text-xs flex items-center gap-1 ${historyOpen ? "bg-brand-600/30 border-brand-500/50" : ""}`}
            title="View edit history for this project"
          >
            <HistoryIcon />
            <span className="hidden md:inline">History</span>
          </button>
          {/* Users button — manager only */}
          {isManager && (
            <button
              type="button"
              onClick={onOpenUsers}
              className={`btn text-xs flex items-center gap-1 ${usersOpen ? "bg-brand-600/30 border-brand-500/50" : ""}`}
              title="Manage project users and invites"
            >
              <UsersIcon />
              <span className="hidden md:inline">Users</span>
            </button>
          )}
          {/* Loading ontology spinner */}
          {isLoadingOntology && (
            <span className="flex items-center gap-1.5 text-xs text-slate-400 ml-1">
              <svg
                aria-hidden="true"
                className="animate-spin h-3 w-3 text-brand-400 shrink-0"
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
              <span className="hidden sm:inline">Loading…</span>
            </span>
          )}
        </div>
      </div>

      {/* Per-file sync failure list — persistent, dismissable */}
      {syncErrors.length > 0 && (
        <div className="mx-4 mt-2 mb-1 rounded border border-red-500/30 bg-red-900/20 p-3 text-xs">
          <div className="flex items-start justify-between gap-2">
            <span className="font-medium text-red-300">
              {syncErrors.length} import{syncErrors.length !== 1 ? "s" : ""} failed during last sync
            </span>
            <button
              type="button"
              onClick={() => setSyncErrors([])}
              className="text-slate-400 hover:text-slate-200 shrink-0 leading-none"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
          <ul className="mt-2 space-y-1">
            {syncErrors.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable error list
              <li key={i} className="text-slate-300">
                <span className="font-mono text-red-400">{e.path}</span>
                {e.error && <span className="text-slate-400"> — {e.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Ontologies list — roots first, branches nested below their parent */}
      {expanded && (
        <div className="px-4">
          {/* Drag hint — only shown to editors with ≥2 root ontologies */}
          {canDrag && (
            <div className="flex items-center gap-1.5 py-1.5 text-[10px] text-slate-600 select-none">
              <GripVertical size={10} aria-hidden="true" />
              Drag rows to reorder ontologies
            </div>
          )}

          <ul className="list-none m-0 p-0">
            {roots.map((root, rootIdx) => {
              const isDragging = dragSrcIdx === rootIdx;
              const isDropTarget =
                dragOverIdx === rootIdx && dragSrcIdx !== null && dragSrcIdx !== rootIdx;
              return (
                <li
                  key={root.id}
                  draggable={canDrag}
                  onDragStart={(e) => {
                    setDragSrcIdx(rootIdx);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    setDragSrcIdx(null);
                    setDragOverIdx(null);
                  }}
                  onDragOver={(e) => {
                    if (!canDrag) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverIdx !== rootIdx) setDragOverIdx(rootIdx);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) setDragOverIdx(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(rootIdx);
                  }}
                  style={isDropTarget ? { boxShadow: "inset 0 2px 0 0 #818cf8" } : undefined}
                  className={isDragging ? "opacity-40" : undefined}
                >
                  <OntologyRow
                    ontology={root}
                    project={project}
                    projectId={project.id}
                    isEditor={isEditor}
                    onFlash={onFlash}
                    onRefresh={onRefresh}
                    branchCount={branchesOf[root.id]?.length || 0}
                    colorIndex={rootIdx}
                    showDragHandle={canDrag}
                  />
                  {(branchesOf[root.id] || []).map((branch) => {
                    const isStale =
                      branch.branched_from_version != null &&
                      root.updated_at > branch.branched_from_version;
                    return (
                      <OntologyRow
                        key={branch.id}
                        ontology={branch}
                        project={project}
                        projectId={project.id}
                        isEditor={isEditor}
                        onFlash={onFlash}
                        onRefresh={onRefresh}
                        isBranch
                        parentOntology={root}
                        parentName={root.name}
                        isStale={isStale}
                        colorIndex={rootIdx}
                      />
                    );
                  })}
                </li>
              );
            })}
          </ul>

          {orphanBranches.map((branch) => (
            <OntologyRow
              key={branch.id}
              ontology={branch}
              project={project}
              projectId={project.id}
              isEditor={isEditor}
              onFlash={onFlash}
              onRefresh={onRefresh}
              isBranch
              parentName="(unknown parent)"
              isStale={false}
              colorIndex={0}
            />
          ))}

          {allOntos.length === 0 && (
            <div className="px-4 py-3 text-xs text-slate-500">No ontologies in this project.</div>
          )}

          {/* Footer bar — always visible when expanded */}
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-ink-700/60">
            {/* Add ontology — editor+ */}
            {isEditor ? (
              <button
                type="button"
                className="btn text-xs"
                onClick={() => setShowAddOntology(true)}
              >
                + Add ontology
              </button>
            ) : (
              <span />
            )}
            {/* Delete button — manager only, now in footer */}
            {isManager ? (
              <button
                type="button"
                className="btn-danger text-xs"
                disabled={busy}
                onClick={deleteProject}
              >
                Delete Project
              </button>
            ) : (
              <span />
            )}
          </div>
        </div>
      )}

      {showAddOntology && (
        <NewOntologyModal
          projectId={project.id}
          projectName={project.name}
          onClose={() => setShowAddOntology(false)}
          onCreated={async (r) => {
            setShowAddOntology(false);
            onFlash("Ontology added.");
            // Refresh first, then set write target to avoid refresh() overwriting
            // the target due to localStorage string vs integer ID type mismatch.
            await ctxRefresh();
            onRefresh?.();
            const newId = r?.ontology?.id || r?.id;
            if (newId) setWriteTarget(newId);
            if (newId) onWarmUp?.(project.id);
          }}
        />
      )}

      {showEdit && (
        <EditProjectModal
          project={project}
          onClose={() => setShowEdit(false)}
          onSaved={async () => {
            setShowEdit(false);
            onFlash("Project updated.");
            await onRefresh();
          }}
        />
      )}
    </div>
  );
}

// ── Ontology row ──────────────────────────────────────────────────────────────

function TtlViewerModal({ ontology, projectId, isEditor, onClose, onSaved }) {
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);
  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    const url = api.exportOntologyUrl(ontology.id, "text/turtle");
    fetch(url, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(setContent)
      .catch((e) => setError(e.message));
  }, [ontology.id]);

  // Focus textarea when edit mode opens
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const enterEdit = () => {
    setDraft(content ?? "");
    setSaveError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setSaveError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.refreshOntologyText(ontology.id, projectId, {
        text: draft,
        replace: true,
      });
      onSaved?.();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Close on Escape — but only when not in edit mode (avoid losing work accidentally)
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape" && !editing) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, editing]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-14">
      {/* Backdrop — disabled while editing to prevent accidental dismissal */}
      {!editing && (
        <button
          type="button"
          className="absolute inset-0 bg-black/60 cursor-default"
          onClick={onClose}
          aria-label="Close viewer"
        />
      )}
      {editing && <div className="absolute inset-0 bg-black/60" />}

      {/* Panel — rendered via portal so it escapes any ancestor overflow constraints */}
      <div className="relative z-10 flex flex-col w-full max-w-4xl max-h-full rounded-xl border border-ink-600/80 bg-ink-950 shadow-2xl shadow-black/60">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-ink-700 shrink-0">
          <FileText size={14} className="text-brand-300 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-sm font-semibold truncate">
            {ontology.name}
            <span className="ml-2 text-xs font-normal text-slate-500 font-mono">.ttl</span>
          </span>

          {editing ? (
            /* ── Edit mode header actions ── */
            <>
              {saveError && (
                <span className="text-xs text-red-300 truncate max-w-xs">{saveError}</span>
              )}
              <button type="button" className="btn text-xs" onClick={cancelEdit} disabled={saving}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary text-xs flex items-center gap-1"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            /* ── View mode header actions ── */
            <>
              {content && (
                <button
                  type="button"
                  className="btn-ghost text-xs flex items-center gap-1"
                  onClick={() => navigator.clipboard?.writeText(content)}
                  title="Copy to clipboard"
                >
                  <Copy size={11} aria-hidden="true" />
                  Copy
                </button>
              )}
              {isEditor && content && !ontology.is_imported && (
                <button
                  type="button"
                  className="btn-ghost text-xs flex items-center gap-1"
                  onClick={enterEdit}
                  title="Edit Turtle source"
                >
                  <Edit size={11} aria-hidden="true" />
                  Edit
                </button>
              )}
              <button
                type="button"
                className="text-slate-400 hover:text-slate-200 p-1 ml-1"
                onClick={onClose}
                aria-label="Close"
              >
                <CloseIcon />
              </button>
            </>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {error && <div className="p-6 text-sm text-red-300">Error: {error}</div>}
          {!content && !error && (
            <div className="p-6 text-sm text-slate-500 animate-pulse">Loading…</div>
          )}
          {content && !editing && <TtlHighlighter source={content} />}
          {editing && (
            <textarea
              ref={textareaRef}
              className="w-full h-full min-h-[60vh] p-5 bg-transparent text-[12px] leading-relaxed font-mono text-slate-200 resize-none outline-none border-none focus:ring-0"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Files larger than this skip highlighting entirely — plain <pre> is instant.
const TTL_LARGE_FILE_THRESHOLD = 500_000; // 500 KB
// Lines rendered per animation frame for medium-sized files.
const TTL_CHUNK_SIZE = 300;

/**
 * Renders Turtle source with token-level syntax highlighting.
 *
 * Two rendering modes:
 *  - Large files (> 500 KB): plain <pre>, no tokenisation — instant.
 *  - Smaller files: chunked rendering via requestAnimationFrame so the page
 *    stays responsive while tokens are computed progressively.
 */
function TtlHighlighter({ source }) {
  const lines = useMemo(() => source.split("\n"), [source]);
  const isLarge = source.length > TTL_LARGE_FILE_THRESHOLD;
  // Start by showing the first chunk immediately on mount.
  const [visibleCount, setVisibleCount] = useState(() =>
    isLarge ? 0 : Math.min(TTL_CHUNK_SIZE, lines.length),
  );

  // Reset when source changes (e.g. modal reopened with a different ontology).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on source identity change
  useEffect(() => {
    setVisibleCount(isLarge ? 0 : Math.min(TTL_CHUNK_SIZE, lines.length));
  }, [source]);

  // Progressively render more chunks without blocking the main thread.
  useEffect(() => {
    if (isLarge || visibleCount >= lines.length) return;
    const id = requestAnimationFrame(() => {
      setVisibleCount((c) => Math.min(c + TTL_CHUNK_SIZE, lines.length));
    });
    return () => cancelAnimationFrame(id);
  }, [visibleCount, lines.length, isLarge]);

  const preClass =
    "px-5 text-[12px] font-mono text-slate-200 whitespace-pre-wrap wrap-break-word leading-5";

  // Large-file fallback: chunked plain text with content-visibility:auto so the
  // browser skips layout/paint/event-handling for off-screen chunks.
  // A single giant <pre> forces the browser to walk the entire text layout tree
  // on every interaction (selection, right-click, DevTools) causing severe lag.
  if (isLarge) {
    // Split into chunks of 400 lines each; each chunk is an independent <pre>
    // that the browser can skip when off-screen.
    const PLAIN_CHUNK = 400;
    const chunks = [];
    for (let i = 0; i < lines.length; i += PLAIN_CHUNK) {
      chunks.push({ startLine: i, text: lines.slice(i, i + PLAIN_CHUNK).join("\n") });
    }
    // Estimated height per chunk for contain-intrinsic-block-size (prevents
    // scroll-bar jump when chunks pop in/out of layout).
    const chunkEstimatedPx = PLAIN_CHUNK * 20;
    return (
      <>
        <div className="sticky top-0 z-10 px-5 py-1.5 mb-1 text-[10px] text-yellow-500 bg-ink-950 border-b border-ink-700/60 shrink-0">
          File too large for syntax highlighting ({Math.round(source.length / 1024)} KB ·{" "}
          {lines.length.toLocaleString()} lines) — showing plain text
        </div>
        {chunks.map(({ startLine, text }) => (
          <pre
            key={startLine}
            className={`${preClass} py-0`}
            style={{
              contentVisibility: "auto",
              containIntrinsicBlockSize: `${chunkEstimatedPx}px`,
            }}
          >
            {startLine === 0 ? text : `\n${text}`}
          </pre>
        ))}
      </>
    );
  }

  return (
    <pre className={preClass}>
      {lines.slice(0, visibleCount).map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable static list
        <TtlLine key={i} line={line} />
      ))}
      {visibleCount < lines.length && (
        <span className="text-slate-500 text-[11px] animate-pulse">
          {"\n"}Highlighting {(lines.length - visibleCount).toLocaleString()} more lines…
        </span>
      )}
    </pre>
  );
}

// Token regex — must use the `g` flag so matchAll works correctly.
const TTL_TOKEN_RE =
  /(@prefix|@base|PREFIX|BASE|a\b)|(<[^>]*>)|("""[\s\S]*?"""|"(?:[^"\\]|\\.)*"|'[^']*')|(#.*)|((?:true|false|\d[\d.eE+-]*(?:\^\^<[^>]*>)?)[^\s,;.]*)|(\^\^<[^>]*>)|([\w-]+:[\w\-/.#%]+)|([\w-]+:)|([\s,;.()[\]])/g;

function TtlLine({ line }) {
  const tokens = [];
  let last = 0;
  for (const m of line.matchAll(TTL_TOKEN_RE)) {
    if (m.index > last) {
      tokens.push({ text: line.slice(last, m.index), cls: "" });
    }
    const [full, kw, iri, str, comment, literal, datatype, prefixed, prefix, punct] = m;
    let cls = "";
    if (kw) cls = "text-purple-300";
    else if (iri) cls = "text-sky-300";
    else if (str) cls = "text-amber-200";
    else if (comment) cls = "text-slate-500 italic";
    else if (literal) cls = "text-emerald-300";
    else if (datatype) cls = "text-sky-400/70";
    else if (prefixed) cls = "text-cyan-300";
    else if (prefix) cls = "text-cyan-400/80";
    else if (punct) cls = "text-slate-400";
    tokens.push({ text: full, cls });
    last = m.index + full.length;
  }
  if (last < line.length) tokens.push({ text: line.slice(last), cls: "" });
  tokens.push({ text: "\n", cls: "" });
  return (
    <>
      {tokens.map((t, i) =>
        t.cls ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable per-line list
          <span key={i} className={t.cls}>
            {t.text}
          </span>
        ) : (
          t.text
        ),
      )}
    </>
  );
}

// ── Branch-name modal ─────────────────────────────────────────────────────────

function BranchModal({
  ontology,
  project,
  onClose,
  onCreated,
  onFlash,
  onRefresh,
  initialTab = "new",
}) {
  const hasGitHub = !!(project?.github_repo && ontology.github_path);
  // "new" = create in-app branch; "github" = switch project's tracked GitHub branch
  const [tab, setTab] = useState(initialTab);
  const [name, setName] = useState(`${ontology.name} (branch)`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // GitHub branch picker state
  const [ghBranches, setGhBranches] = useState(null); // null = not loaded
  const [ghLoading, setGhLoading] = useState(false);
  const [ghError, setGhError] = useState(null);

  // Load GitHub branches when switching to that tab
  useEffect(() => {
    if (tab !== "github" || !hasGitHub || ghBranches !== null) return;
    setGhLoading(true);
    setGhError(null);
    api
      .listGitHubBranches(project.id)
      .then((data) => {
        const branches = data.branches || [];
        // Always include "main" so the user can switch back to it regardless of
        // which branch is currently active.
        if (!branches.some((b) => b.name === "main")) {
          branches.unshift({ name: "main" });
        }
        setGhBranches(branches);
      })
      .catch((e) => setGhError(e.message))
      .finally(() => setGhLoading(false));
  }, [tab, hasGitHub, project?.id, ghBranches]);

  // Close on Escape
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const submitNew = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.branchOntology(ontology.id, { name: name.trim() });
      onCreated(result.ontology);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const switchGhBranch = async (branchName) => {
    setBusy(true);
    setError(null);
    try {
      await api.setProjectGitHub(project.id, {
        github_repo: project.github_repo,
        github_branch: branchName,
      });
      // Immediately sync so the ontology content reflects the new branch.
      await api.syncProjectFromGitHub(project.id);
      onFlash?.(`Switched to "${branchName}" and synced content.`);
      await onRefresh?.();
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 cursor-default"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative z-10 w-full max-w-sm rounded-xl border border-ink-600/80 bg-ink-950 shadow-2xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <GitBranch size={16} className="text-brand-300 shrink-0" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Branch</h2>
        </div>

        {/* Tab switcher — only shown when project has GitHub */}
        {hasGitHub && (
          <div className="flex gap-1 text-xs border border-ink-600/60 rounded-lg p-0.5">
            <button
              type="button"
              className={`flex-1 rounded-md py-1 transition-colors ${tab === "new" ? "bg-ink-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
              onClick={() => setTab("new")}
            >
              New branch
            </button>
            <button
              type="button"
              className={`flex-1 rounded-md py-1 transition-colors ${tab === "github" ? "bg-ink-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
              onClick={() => setTab("github")}
            >
              Switch GitHub Branch
            </button>
          </div>
        )}

        {tab === "new" ? (
          <>
            <p className="text-xs text-slate-400">
              A branch is a full copy of <strong className="text-slate-200">{ontology.name}</strong>
              . You can edit it independently and merge it back later.
            </p>
            <form onSubmit={submitNew} className="space-y-3">
              <label className="block">
                <span className="label">Branch name</span>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </label>
              {error && <div className="text-sm text-red-300">{error}</div>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" className="btn text-sm" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary text-sm"
                  disabled={busy || !name.trim()}
                >
                  {busy ? "Creating…" : "Create Branch"}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">
              Switch which GitHub branch this project syncs from. After switching you can create a
              new in-app branch from the updated content.
            </p>
            {ghLoading && <div className="text-xs text-slate-500 py-2">Loading branches…</div>}
            {ghError && <div className="text-sm text-red-300">{ghError}</div>}
            {ghBranches && ghBranches.length === 0 && (
              <div className="text-xs text-slate-500 py-2">No branches found.</div>
            )}
            {ghBranches && ghBranches.length > 0 && (
              <ul className="space-y-1 max-h-64 overflow-y-auto">
                {ghBranches.map((b) => {
                  const isCurrent = b.name === (project?.github_branch || "main");
                  return (
                    <li
                      key={b.name}
                      className="flex items-center justify-between gap-2 rounded-lg border border-ink-600/60 px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-mono text-slate-200 truncate flex items-center gap-1.5">
                          {b.name}
                          {isCurrent && (
                            <span className="text-[10px] text-emerald-400 font-sans font-semibold">
                              current
                            </span>
                          )}
                        </div>
                        {b.prUrl && (
                          <a
                            href={b.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-brand-300 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            PR #{b.prNumber}: {b.prTitle}
                          </a>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn text-xs shrink-0"
                        disabled={busy || isCurrent}
                        onClick={() => switchGhBranch(b.name)}
                      >
                        Switch
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {error && <div className="text-sm text-red-300">{error}</div>}
            <div className="flex justify-end pt-1">
              <button type="button" className="btn text-sm" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── Merge-confirm modal ───────────────────────────────────────────────────────

function MergeConfirmModal({ branch, parentName, isStale, onClose, onMerged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // null while showing the normal confirm screen; populated when a git conflict
  // is detected and the user must choose which version to keep.
  const [conflict, setConflict] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.mergeOntology(branch.id);
      if (result.conflict) {
        // Git detected a conflict — switch to the resolution view.
        setConflict(result);
        setBusy(false);
        return;
      }
      onMerged(result);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const applyResolution = async (choice) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.resolveConflict(branch.id, choice);
      onMerged(result);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 cursor-default"
        onClick={onClose}
        aria-label="Close"
      />

      {/* ── Conflict resolution view ── */}
      {conflict ? (
        <div className="relative z-10 w-full max-w-3xl rounded-xl border border-amber-500/40 bg-ink-950 shadow-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <GitMerge size={16} className="text-amber-300 shrink-0" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Merge Conflict — Choose a Version</h2>
          </div>

          <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2.5 text-xs text-amber-200 space-y-1">
            <div className="font-semibold">⚠ Both versions have incompatible changes</div>
            <div>
              <strong>{conflict.parentName}</strong> and <strong>{conflict.branchName}</strong> were
              modified in conflicting ways. Pick which version to keep — the other will be
              discarded.
            </div>
            <div className="text-red-300 font-semibold pt-1">This cannot be undone.</div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-slate-300">
                Parent — <span className="text-emerald-400 font-mono">{conflict.parentName}</span>
              </div>
              <pre className="h-52 overflow-auto text-[10px] leading-relaxed bg-ink-900 border border-ink-700/60 rounded p-2 text-slate-300 whitespace-pre-wrap font-mono">
                {conflict.ours || "(empty)"}
              </pre>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-slate-300">
                Branch — <span className="text-brand-300 font-mono">{conflict.branchName}</span>
              </div>
              <pre className="h-52 overflow-auto text-[10px] leading-relaxed bg-ink-900 border border-ink-700/60 rounded p-2 text-slate-300 whitespace-pre-wrap font-mono">
                {conflict.theirs || "(empty)"}
              </pre>
            </div>
          </div>

          {error && <div className="text-sm text-red-300">{error}</div>}

          <div className="flex justify-end gap-2 pt-1 flex-wrap">
            <button type="button" className="btn text-sm" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn text-sm border-slate-500/50 hover:bg-slate-800/60 text-slate-200"
              onClick={() => applyResolution("ours")}
              disabled={busy}
            >
              {busy ? "Applying…" : `Keep Parent (${conflict.parentName})`}
            </button>
            <button
              type="button"
              className="btn-primary text-sm flex items-center gap-1.5 whitespace-nowrap"
              onClick={() => applyResolution("theirs")}
              disabled={busy}
            >
              <GitMerge size={13} aria-hidden="true" />
              {busy ? "Applying…" : `Use Branch (${conflict.branchName})`}
            </button>
          </div>
        </div>
      ) : (
        /* ── Normal merge confirmation view ── */
        <div className="relative z-10 w-full max-w-sm rounded-xl border border-ink-600/80 bg-ink-950 shadow-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <GitMerge size={16} className="text-amber-300 shrink-0" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Merge into Parent</h2>
          </div>

          {isStale && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2.5 text-xs text-amber-200 space-y-1">
              <div className="font-semibold">
                ⚠ Parent has changed since this branch was created
              </div>
              <div>
                <strong>{parentName}</strong> was modified after this branch was taken. A 3-way git
                merge will be attempted — if there are conflicts you will be prompted to choose
                which version to keep.
              </div>
            </div>
          )}

          <div className="text-xs text-slate-300 space-y-2">
            <p>
              This will <strong className="text-white">merge all changes</strong> from{" "}
              <strong className="text-white">{branch.name}</strong> into{" "}
              <strong className="text-white">{parentName}</strong> using a 3-way git merge.
            </p>
            <p className="text-red-300 font-semibold">This cannot be undone.</p>
          </div>

          {error && <div className="text-sm text-red-300">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn text-sm" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger text-sm flex items-center gap-1.5 whitespace-nowrap"
              onClick={submit}
              disabled={busy}
            >
              <GitMerge size={13} aria-hidden="true" />
              {busy ? "Merging…" : "Merge — This Cannot Be Undone"}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ── Ontology row ──────────────────────────────────────────────────────────────

function OntologyRow({
  ontology,
  project = null,
  projectId = null,
  isEditor,
  onFlash,
  onRefresh,
  isBranch = false,
  parentOntology = null,
  parentName = "",
  isStale = false,
  branchCount = 0,
  colorIndex = 0,
  showDragHandle = false,
}) {
  const { writeOntologyId, setWriteTarget, refresh: ctxRefresh } = useProject();
  const [showEdit, setShowEdit] = useState(false);
  const [showViewer, setShowViewer] = useState(false);
  const [showBranch, setShowBranch] = useState(false);
  const [showBranchTab, setShowBranchTab] = useState("new");
  const [showMerge, setShowMerge] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [showGitHubCompare, setShowGitHubCompare] = useState(false);
  const [showRefresh, setShowRefresh] = useState(false);
  const [showGitHubPush, setShowGitHubPush] = useState(false);
  const [_busy, setBusy] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });

  // Close dropdown on outside click — must exclude both the trigger button
  // (actionsRef) AND the portal menu (menuRef) since the portal lives outside
  // the DOM subtree of actionsRef.
  useEffect(() => {
    const handler = (e) => {
      if (actionsRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setActionsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Reliable refresh: call the stable context function directly, then also
  // propagate upward (for onOntologiesChanged notifications in the parent).
  const doRefresh = async () => {
    await ctxRefresh();
    onRefresh?.();
  };

  const deleteOntology = async () => {
    if (!confirm(`Delete ontology "${ontology.name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.deleteOntology(ontology.id);
      onFlash(`Deleted ontology "${ontology.name}".`);
      await doRefresh();
    } catch (e) {
      onFlash(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const exportFormats = [
    { label: "Turtle (.ttl)", mime: "text/turtle", ext: "ttl" },
    { label: "N-Triples (.nt)", mime: "application/n-triples", ext: "nt" },
    { label: "RDF/XML (.rdf)", mime: "application/rdf+xml", ext: "rdf" },
    { label: "JSON-LD (.jsonld)", mime: "application/ld+json", ext: "jsonld" },
  ];

  const gitMenuLabel = ontology.github_path || parentOntology?.github_path ? "GitHub" : "Git";

  return (
    <div
      className={`flex items-center gap-2 py-2 border-t border-ink-700/40 group ${isBranch ? "pl-8 pr-4" : "px-4"}`}
    >
      {/* Position colour swatch — root ontologies only */}
      {!isBranch && (
        <span
          className="shrink-0 w-2.5 h-2.5 rounded-sm opacity-80"
          style={{ backgroundColor: getOntologyColor(colorIndex) }}
          title={`Ontology #${colorIndex + 1}`}
          aria-hidden="true"
        />
      )}
      {/* Drag handle — shown to editors when ≥2 roots exist */}
      {!isBranch && showDragHandle && (
        <span
          className="hidden md:inline shrink-0 text-slate-600 group-hover:text-slate-400 transition cursor-grab active:cursor-grabbing"
          aria-hidden="true"
        >
          <GripVertical size={14} />
        </span>
      )}

      {/* Branch indent indicator */}
      {isBranch ? (
        <GitBranch size={16} className="text-slate-500 shrink-0" aria-hidden="true" />
      ) : (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="hidden md:inline text-slate-500 shrink-0"
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="12" cy="18" r="2" />
          <path d="M8 7l8 0" />
          <path d="M7 7l5 9" />
          <path d="M17 7l-5 9" />
        </svg>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium truncate">{ontology.name}</span>
          {!isBranch && project?.github_repo && ontology.github_path && isEditor && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[10px] font-mono text-slate-500 hover:text-slate-200 hover:border-ink-500 px-1 py-px rounded border border-ink-600/60 bg-ink-800/40 shrink-0 transition-colors"
              title="Switch GitHub branch"
              onClick={() => {
                setActionsOpen(false);
                setShowBranchTab("github");
                setShowBranch(true);
              }}
            >
              <GitBranch size={9} aria-hidden="true" />
              {project.github_branch || "main"}
            </button>
          )}
          {!isBranch && project?.github_repo && ontology.github_path && !isEditor && (
            <span className="inline-flex items-center gap-1 text-[10px] font-mono text-slate-500 px-1 py-px rounded border border-ink-600/60 bg-ink-800/40 shrink-0">
              <GitBranch size={9} aria-hidden="true" />
              {project.github_branch || "main"}
            </span>
          )}
          {isBranch && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1 py-px rounded border bg-brand-500/15 text-brand-300 border-brand-500/30">
              <GitBranch size={9} aria-hidden="true" /> branch of {parentName}
            </span>
          )}
          {isStale && (
            <span className="text-[10px] font-semibold px-1 py-px rounded border bg-amber-500/15 text-amber-300 border-amber-500/30">
              ⚠ parent changed
            </span>
          )}
        </div>
        {ontology.iri && (
          <span className="text-[11px] text-slate-500 font-mono block">{ontology.iri}</span>
        )}
        {ontology.github_path && isBranch && (
          <span className="inline-flex items-center gap-1 text-[10px] text-slate-500 font-mono mt-0.5">
            <GitBranch size={9} aria-hidden="true" />
            {ontology.github_path}
            {ontology.github_pr_url && (
              <a
                href={ontology.github_pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 text-brand-300 hover:text-brand-200 hover:underline"
                title="View open Pull Request on GitHub"
                onClick={(e) => e.stopPropagation()}
              >
                PR open ↗
              </a>
            )}
          </span>
        )}
      </div>

      {/* Set as write target — leftmost standalone button */}
      {isEditor && ontology.id !== writeOntologyId && (!ontology.is_imported || isBranch) && (
        <button
          type="button"
          className="btn text-xs flex items-center gap-1"
          onClick={() => setWriteTarget(ontology.id)}
          title="Set as the write target for this workspace"
        >
          <Pencil size={11} aria-hidden="true" />
          <span className="hidden md:inline">Set Writable</span>
        </button>
      )}
      {ontology.id === writeOntologyId && (
        <span className="flex items-center gap-1 text-xs py-1.5 px-3 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
          <Edit size={11} aria-hidden="true" />
          <span className="hidden md:inline">Writable</span>
        </span>
      )}
      {!isBranch && !!ontology.is_imported && (
        <span className="flex items-center gap-1 text-xs py-1.5 px-3 rounded-md bg-slate-700/50 text-slate-400 border border-slate-600/50">
          <Lock size={11} aria-hidden="true" />
          Read-Only
        </span>
      )}

      {/* Actions dropdown */}
      <div className="relative" ref={actionsRef}>
        <button
          type="button"
          className="btn text-xs flex items-center gap-1"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const flip = window.innerHeight - rect.bottom < 320;
            setMenuPos({
              top: flip ? undefined : rect.bottom + 4,
              bottom: flip ? window.innerHeight - rect.top + 4 : undefined,
              right: window.innerWidth - rect.right,
            });
            setActionsOpen((v) => !v);
          }}
        >
          <span>Actions</span>
          <ChevronRight
            size={10}
            className={`transition-transform ${actionsOpen ? "rotate-90" : "rotate-0"}`}
            aria-hidden="true"
            style={{ transform: actionsOpen ? "rotate(90deg)" : "rotate(-90deg)" }}
          />
        </button>
        {actionsOpen &&
          createPortal(
            <div
              ref={menuRef}
              className="fixed z-9999 rounded-lg shadow-xl shadow-black/40 border border-ink-600/80 bg-ink-900/95 backdrop-blur-xs py-1 min-w-40"
              style={{ top: menuPos.top, bottom: menuPos.bottom, right: menuPos.right }}
            >
              {/* View */}
              <button
                type="button"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-200 hover:bg-ink-700/70 text-left"
                onClick={() => {
                  setActionsOpen(false);
                  setShowViewer(true);
                }}
              >
                <Eye size={11} aria-hidden="true" />
                View {isBranch ? "Branch" : "Ontology"}
              </button>
              <button
                type="button"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-200 hover:bg-ink-700/70 text-left"
                onClick={() => {
                  setActionsOpen(false);
                  setShowEdit(true);
                }}
              >
                <EditIcon />
                Edit Metadata
              </button>

              {/* Editor-only actions */}
              {isEditor && (
                <div className="border-t border-ink-700/40 mt-1 pt-1">
                  <div className="px-3 py-0.5 text-[10px] text-slate-500 uppercase tracking-wide">
                    {gitMenuLabel}
                  </div>
                  {!isBranch && (
                    <button
                      type="button"
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-200 hover:bg-ink-700/70 text-left"
                      onClick={() => {
                        setActionsOpen(false);
                        setShowBranch(true);
                      }}
                    >
                      <GitBranch size={11} aria-hidden="true" />
                      Branch
                    </button>
                  )}
                  {isBranch && (
                    <button
                      type="button"
                      className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-ink-700/70 text-left ${isStale ? "text-amber-300" : "text-slate-200"}`}
                      onClick={() => {
                        setActionsOpen(false);
                        setShowMerge(true);
                      }}
                    >
                      <GitMerge size={11} aria-hidden="true" />
                      Merge ↑
                    </button>
                  )}
                  {/* In-app branch compare */}
                  {!ontology.github_path && isBranch && (
                    <button
                      type="button"
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-200 hover:bg-ink-700/70 text-left"
                      onClick={() => {
                        setActionsOpen(false);
                        setShowCompare(true);
                      }}
                    >
                      <GitCompare size={11} aria-hidden="true" />
                      Compare
                    </button>
                  )}
                  {/* GitHub compare */}
                  {ontology.github_path &&
                    !ontology.is_imported &&
                    (!isBranch || ontology.github_branch_name) && (
                      <button
                        type="button"
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-200 hover:bg-ink-700/70 text-left"
                        onClick={() => {
                          setActionsOpen(false);
                          setShowGitHubCompare(true);
                        }}
                      >
                        <GitCompare size={11} aria-hidden="true" />
                        Compare
                      </button>
                    )}
                  {/* Push */}
                  {(ontology.github_path || parentOntology?.github_path) && (
                    <button
                      type="button"
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-200 hover:bg-ink-700/70 text-left"
                      onClick={() => {
                        setActionsOpen(false);
                        setShowGitHubPush(true);
                      }}
                    >
                      <Upload size={11} aria-hidden="true" />
                      Push
                    </button>
                  )}
                  {(!isBranch || ontology.github_branch_name) && (
                    <button
                      type="button"
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-200 hover:bg-ink-700/70 text-left"
                      onClick={() => {
                        setActionsOpen(false);
                        setShowRefresh(true);
                      }}
                    >
                      <RefreshCw size={11} aria-hidden="true" />
                      Reload
                    </button>
                  )}
                  {/* Delete ontology — editor+ */}
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-xs text-red-400 hover:bg-red-950/30 text-left"
                    onClick={() => {
                      setActionsOpen(false);
                      deleteOntology();
                    }}
                  >
                    <X size={15} aria-hidden="true" className="-mr-0.5 ml-0.5" />
                    Delete {isBranch ? "Branch" : "Ontology"}
                  </button>
                </div>
              )}

              {/* Export submenu items */}
              <div className="border-t border-ink-700/40 mt-1 pt-1">
                <div className="px-3 py-0.5 text-[10px] text-slate-500 uppercase tracking-wide">
                  Export
                </div>
                {exportFormats.map((f) => (
                  <a
                    key={f.mime}
                    href={api.exportOntologyUrl(ontology.id, f.mime)}
                    download={`${ontology.name}.${f.ext}`}
                    className="block px-3 py-1.5 text-xs text-slate-200 hover:bg-ink-700/70"
                    onClick={() => setActionsOpen(false)}
                  >
                    {f.label}
                  </a>
                ))}
              </div>
            </div>,
            document.body,
          )}
      </div>

      {showEdit && (
        <EditOntologyModal
          ontology={ontology}
          readOnly={!!ontology.is_imported}
          onClose={() => setShowEdit(false)}
          onSaved={async () => {
            setShowEdit(false);
            onFlash("Ontology updated.");
            await onRefresh();
          }}
          onDelete={async () => {
            setShowEdit(false);
            await deleteOntology();
          }}
        />
      )}

      {showViewer && (
        <TtlViewerModal
          ontology={ontology}
          projectId={projectId}
          isEditor={isEditor}
          onClose={() => setShowViewer(false)}
          onSaved={async () => {
            setShowViewer(false);
            onFlash(`Ontology "${ontology.name}" updated.`);
            await doRefresh();
          }}
        />
      )}

      {showBranch && (
        <BranchModal
          ontology={ontology}
          project={project}
          initialTab={showBranchTab}
          onClose={() => {
            setShowBranch(false);
            setShowBranchTab("new");
          }}
          onFlash={onFlash}
          onRefresh={doRefresh}
          onCreated={async (branch) => {
            setShowBranch(false);
            onFlash(`Branch "${branch.name}" created.`);
            await doRefresh();
            if (branch?.id) setWriteTarget(branch.id);
          }}
        />
      )}

      {showMerge && (
        <MergeConfirmModal
          branch={ontology}
          parentName={parentName}
          isStale={isStale}
          onClose={() => setShowMerge(false)}
          onMerged={async () => {
            setShowMerge(false);
            onFlash(`Branch "${ontology.name}" merged into "${parentName}".`);
            // Refresh first, then switch write to the parent — same ordering
            // rule: setWriteTarget after refresh to avoid the string/int
            // localStorage type-mismatch overwrite.
            await doRefresh();
            if (ontology.branch_of) setWriteTarget(ontology.branch_of);
          }}
        />
      )}

      {showCompare && (
        <BranchCompareModal
          branch={ontology}
          parentName={parentName}
          onClose={() => setShowCompare(false)}
        />
      )}

      {showGitHubCompare && (
        <GitHubCompareModal
          ontology={ontology}
          projectId={projectId}
          project={project}
          onClose={() => setShowGitHubCompare(false)}
        />
      )}

      {showRefresh && (
        <RefreshOntologyModal
          ontology={ontology}
          projectId={projectId}
          project={project}
          onClose={() => setShowRefresh(false)}
          onRefreshed={async () => {
            setShowRefresh(false);
            onFlash(`Ontology "${ontology.name}" refreshed.`);
            await doRefresh();
          }}
        />
      )}

      {showGitHubPush && (
        <GitHubPushModal
          ontology={ontology}
          parentOntology={parentOntology}
          projectId={projectId}
          onClose={() => setShowGitHubPush(false)}
          onFlash={onFlash}
          onRefresh={doRefresh}
          isUpdate={!!(ontology.branch_of && ontology.github_branch_name)}
        />
      )}
    </div>
  );
}

// ── Branch compare modal ──────────────────────────────────────────────────────

/**
 * Full-screen modal that fetches a unified git diff between a branch ontology
 * and its parent, then renders it with line-level syntax colouring.
 *
 * - Green lines (starting with +) = lines added in the branch
 * - Red lines (starting with -)   = lines removed from the parent
 * - Blue lines (starting with @@) = hunk headers
 * - Dim lines                     = context / file headers
 *
 * Available to all project roles (viewer+).
 */
function BranchCompareModal({ branch, parentName, onClose }) {
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .compareOntology(branch.id)
      .then((data) => {
        setDiff(data.diff ?? "");
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [branch.id]);

  // Close on Escape
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // Count added/removed lines for the summary badge
  const stats = diff
    ? diff.split("\n").reduce(
        (acc, line) => {
          if (line.startsWith("+") && !line.startsWith("+++")) acc.added++;
          else if (line.startsWith("-") && !line.startsWith("---")) acc.removed++;
          return acc;
        },
        { added: 0, removed: 0 },
      )
    : null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-14">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 cursor-default"
        onClick={onClose}
        aria-label="Close compare view"
      />

      <div className="relative z-10 flex flex-col w-full max-w-5xl max-h-full rounded-xl border border-ink-600/80 bg-ink-950 shadow-2xl shadow-black/60">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-ink-700 shrink-0">
          <GitCompare size={14} className="text-brand-300 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-sm font-semibold truncate">
            <span className="text-brand-300">{branch.name}</span>
            <span className="mx-2 text-slate-500">vs</span>
            <span className="text-slate-200">{parentName}</span>
          </span>

          {/* Diff stats */}
          {stats && (stats.added > 0 || stats.removed > 0) && (
            <div className="flex items-center gap-2 text-[11px] font-mono shrink-0">
              {stats.added > 0 && <span className="text-emerald-400">+{stats.added}</span>}
              {stats.removed > 0 && <span className="text-red-400">−{stats.removed}</span>}
            </div>
          )}

          <button
            type="button"
            className="text-slate-400 hover:text-slate-200 p-1 ml-1"
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Legend */}
        {!loading && !error && diff && diff.trim() !== "" && (
          <div className="flex items-center gap-4 px-5 py-2 border-b border-ink-700/60 text-[10px] text-slate-500 shrink-0">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-emerald-950/70 border border-emerald-700/50" />
              Added in branch
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-rose-950/70 border border-rose-700/50" />
              Removed from parent
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-sky-900/40 border border-sky-700/30" />
              Hunk header
            </span>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {loading && <div className="p-6 text-sm text-slate-500 animate-pulse">Loading diff…</div>}
          {error && <div className="p-6 text-sm text-red-300">Error: {error}</div>}
          {!loading && !error && (!diff || diff.trim() === "") && (
            <div className="p-8 text-sm text-slate-400 text-center">
              <GitCompare size={32} className="mx-auto mb-3 text-slate-600" aria-hidden="true" />
              <p className="font-medium">No differences</p>
              <p className="text-xs text-slate-500 mt-1">
                This branch is identical to <strong className="text-slate-400">{parentName}</strong>
                .
              </p>
            </div>
          )}
          {!loading && !error && diff && diff.trim() !== "" && <UnifiedDiffView diff={diff} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Compares the current in-app Turtle version of a GitHub-linked ontology
 * against the file on GitHub main, showing a unified diff.
 */
function GitHubCompareModal({ ontology, projectId, project, onClose }) {
  const isBranch = !!ontology.github_branch_name;
  const defaultBranch = project?.github_branch || "main";
  const [vsMain, setVsMain] = useState(false);
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const targetBranch = vsMain || !isBranch ? defaultBranch : ontology.github_branch_name;

  useEffect(() => {
    setLoading(true);
    setDiff(null);
    setError(null);
    api
      .compareOntologyWithGitHub(projectId, ontology.id, { vsMain })
      .then((data) => {
        setDiff(data.diff ?? "");
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [projectId, ontology.id, vsMain]);

  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const stats = diff
    ? diff.split("\n").reduce(
        (acc, line) => {
          if (line.startsWith("+") && !line.startsWith("+++")) acc.added++;
          else if (line.startsWith("-") && !line.startsWith("---")) acc.removed++;
          return acc;
        },
        { added: 0, removed: 0 },
      )
    : null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-14">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 cursor-default"
        onClick={onClose}
        aria-label="Close compare view"
      />

      <div className="relative z-10 flex flex-col w-full max-w-5xl max-h-full rounded-xl border border-ink-600/80 bg-ink-950 shadow-2xl shadow-black/60">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-ink-700 shrink-0">
          <GitCompare size={14} className="text-brand-300 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-sm font-semibold truncate">
            <span className="text-brand-300">{ontology.name}</span>
            <span className="mx-2 text-slate-500">vs</span>
            <span className="text-slate-200">GitHub {targetBranch}</span>
          </span>

          {isBranch && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setVsMain(false)}
                className={`px-2 py-0.5 rounded text-[11px] border transition-colors ${!vsMain ? "bg-brand-600/30 border-brand-500/50 text-brand-200" : "border-ink-600 text-slate-400 hover:text-slate-200"}`}
              >
                vs branch
              </button>
              <button
                type="button"
                onClick={() => setVsMain(true)}
                className={`px-2 py-0.5 rounded text-[11px] border transition-colors ${vsMain ? "bg-brand-600/30 border-brand-500/50 text-brand-200" : "border-ink-600 text-slate-400 hover:text-slate-200"}`}
                title={`Compare against ${defaultBranch} (full PR diff)`}
              >
                vs {defaultBranch}
              </button>
            </div>
          )}

          {stats && (stats.added > 0 || stats.removed > 0) && (
            <div className="flex items-center gap-2 text-[11px] font-mono shrink-0">
              {stats.added > 0 && <span className="text-emerald-400">+{stats.added}</span>}
              {stats.removed > 0 && <span className="text-red-400">−{stats.removed}</span>}
            </div>
          )}

          <button
            type="button"
            className="text-slate-400 hover:text-slate-200 p-1 ml-1"
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {!loading && !error && diff && diff.trim() !== "" && (
          <div className="flex items-center gap-4 px-5 py-2 border-b border-ink-700/60 text-[10px] text-slate-500 shrink-0">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-emerald-950/70 border border-emerald-700/50" />
              Added locally
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-rose-950/70 border border-rose-700/50" />
              Removed from GitHub
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-sky-900/40 border border-sky-700/30" />
              Hunk header
            </span>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {loading && <div className="p-6 text-sm text-slate-500 animate-pulse">Loading diff…</div>}
          {error && <div className="p-6 text-sm text-red-300">Error: {error}</div>}
          {!loading && !error && (!diff || diff.trim() === "") && (
            <div className="p-8 text-sm text-slate-400 text-center">
              <GitCompare size={32} className="mx-auto mb-3 text-slate-600" aria-hidden="true" />
              <p className="font-medium">No differences</p>
              <p className="text-xs text-slate-500 mt-1">
                Local version matches{" "}
                <strong className="text-slate-400">GitHub {targetBranch}</strong>.
              </p>
            </div>
          )}
          {!loading && !error && diff && diff.trim() !== "" && <UnifiedDiffView diff={diff} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Renders a raw unified diff string with line-level colouring.
 * Each line is rendered as a block `<div>` so backgrounds fill the full width.
 */
function UnifiedDiffView({ diff }) {
  const lines = diff.split("\n");
  // Drop trailing empty line that git appends
  if (lines.at(-1) === "") lines.pop();

  return (
    <div className="p-4 text-[12px] leading-relaxed font-mono overflow-x-auto">
      {lines.map((line, i) => {
        let bg = "";
        let fg = "text-slate-400";

        if (line.startsWith("+") && !line.startsWith("+++")) {
          bg = "bg-emerald-950/40";
          fg = "text-emerald-300";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          bg = "bg-rose-950/40";
          fg = "text-red-300";
        } else if (line.startsWith("@@")) {
          bg = "bg-sky-900/25";
          fg = "text-sky-300";
        } else if (line.startsWith("---") || line.startsWith("+++")) {
          fg = "text-slate-400 font-semibold";
        }

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable static list
          <div key={i} className={`block px-2 py-px whitespace-pre ${bg} ${fg}`}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

// ── Refresh-ontology modal ────────────────────────────────────────────────────

/**
 * Modal for updating/refreshing an existing ontology's content from either a
 * local file upload or a remote URL (defaulting to the ontology's own IRI).
 *
 * Uses the existing POST /api/import/ttl endpoint with the ontology and project
 * IDs specified explicitly in the query string so it always targets the right
 * named graph regardless of the current write scope.
 */
function RefreshOntologyModal({ ontology, projectId, project, onClose, onRefreshed }) {
  const ghRawUrl = (() => {
    if (!ontology.github_path || !project?.github_repo) return null;
    const [owner, repo] = project.github_repo.split("/");
    const branch = ontology.github_branch_name || project.github_branch || "main";
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${ontology.github_path}`;
  })();
  const [source, setSource] = useState("url");
  const [url, setUrl] = useState(ghRawUrl || ontology.iri || "");
  const [file, setFile] = useState(null);
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // Close on Escape
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.refreshOntology(ontology.id, projectId, {
        file: source === "file" ? file : undefined,
        url: source === "url" ? url.trim() : undefined,
        replace,
      });
      setResult(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Success screen
  if (result) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
        <button
          type="button"
          className="absolute inset-0 bg-black/60 cursor-default"
          onClick={onClose}
          aria-label="Close"
        />
        <div className="relative z-10 w-full max-w-sm rounded-xl border border-ink-600/80 bg-ink-950 shadow-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <RefreshCw size={16} className="text-brand-300 shrink-0" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Ontology Refreshed</h2>
          </div>
          <div className="text-xs text-slate-300 space-y-1">
            <p>
              ✓ <strong className="text-slate-100">{ontology.name}</strong> was refreshed
              successfully.
            </p>
            {result.totalTriples != null && (
              <p className="text-slate-400">Total triples after refresh: {result.totalTriples}</p>
            )}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              className="btn-primary text-sm"
              onClick={() => onRefreshed(result)}
            >
              Done
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 cursor-default"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-ink-600/80 bg-ink-950 shadow-2xl p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <RefreshCw size={16} className="text-brand-300 shrink-0" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Refresh Ontology</h2>
        </div>

        <p className="text-xs text-slate-400">
          Reload <strong className="text-slate-200">{ontology.name}</strong> from a file or URL.
        </p>

        {/* Source toggle */}
        <div className="flex gap-2">
          <button
            type="button"
            className={`btn text-xs flex-1 ${source === "url" ? "bg-brand-600/30 border-brand-500/50 text-brand-200" : ""}`}
            onClick={() => setSource("url")}
          >
            URL
          </button>
          <button
            type="button"
            className={`btn text-xs flex-1 ${source === "file" ? "bg-brand-600/30 border-brand-500/50 text-brand-200" : ""}`}
            onClick={() => setSource("file")}
          >
            File Upload
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          {source === "url" ? (
            <label className="block">
              <span className="label">URL</span>
              <input
                className="input"
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.org/ontology.ttl"
              />
              {(ghRawUrl || ontology.iri) && (
                <span className="block mt-1 text-[10px] text-slate-500">
                  {ghRawUrl
                    ? "Defaults to the raw GitHub file URL."
                    : "Defaults to the ontology's base IRI."}
                </span>
              )}
            </label>
          ) : (
            <label className="block">
              <span className="label">File (.ttl, .rdf, .jsonld, …)</span>
              <input
                className="input"
                type="file"
                accept=".ttl,.nt,.nq,.trig,.rdf,.xml,.jsonld,.json,.n3"
                required
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          )}

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="rounded border-ink-600"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
            />
            <span className="text-xs text-slate-300">
              Replace all existing triples{" "}
              <span className="text-slate-500">(recommended — keeps the ontology clean)</span>
            </span>
          </label>

          {replace && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
              ⚠ Existing ontology data will be cleared before loading the new content.
            </div>
          )}

          {error && <div className="text-sm text-red-300">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn text-sm" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary text-sm flex items-center gap-1.5"
              disabled={busy || (source === "url" && !url.trim()) || (source === "file" && !file)}
            >
              <RefreshCw size={12} aria-hidden="true" />
              {busy ? "Refreshing…" : "Refresh Ontology"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// ── Project Users side panel ──────────────────────────────────────────────────

function ProjectUsersPanel({ projectId, project, onClose, onFlash }) {
  const [tab, setTab] = useState("members");
  const [members, setMembers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [mailerConfigured, setMailerConfigured] = useState(false);
  const [busy, setBusy] = useState(false);

  // Add existing user form
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState("editor");

  // Invite form
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("editor");
  const [inviteErr, setInviteErr] = useState(null);
  const [latestInviteLink, setLatestInviteLink] = useState(null);

  const load = useCallback(async () => {
    try {
      const [mRes, uRes, iRes] = await Promise.all([
        api.projectMembers(projectId),
        api.projectUsers(projectId),
        api.projectInvites(projectId),
      ]);
      setMembers(mRes.members || []);
      setAllUsers(uRes.users || []);
      setInvites(iRes.invites || []);
      setMailerConfigured(iRes.mailerConfigured || false);
    } catch (e) {
      onFlash(`Failed to load users: ${e.message}`);
    }
  }, [projectId, onFlash]);

  useEffect(() => {
    load();
  }, [load]);

  // Users not yet members
  const memberIds = new Set(members.map((m) => m.user_id));
  const nonMembers = allUsers.filter((u) => !memberIds.has(u.id));

  const changeRole = async (userId, role) => {
    try {
      await api.setProjectMemberRole(projectId, userId, role);
      await load();
    } catch (e) {
      onFlash(`Failed: ${e.message}`);
    }
  };

  const removeMember = async (userId, username) => {
    if (!confirm(`Remove ${username} from this project?`)) return;
    try {
      await api.removeProjectMember(projectId, userId);
      onFlash(`Removed ${username}.`);
      await load();
    } catch (e) {
      onFlash(`Failed: ${e.message}`);
    }
  };

  const addMember = async (e) => {
    e.preventDefault();
    if (!addUserId) return;
    setBusy(true);
    try {
      await api.setProjectMemberRole(projectId, addUserId, addRole);
      const u = allUsers.find((x) => x.id === addUserId);
      onFlash(`Added ${u?.username || "user"} as ${addRole}.`);
      setAddUserId("");
      await load();
    } catch (err) {
      onFlash(`Failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const sendInvite = async (e) => {
    e.preventDefault();
    setInviteErr(null);
    setBusy(true);
    try {
      const r = await api.createProjectInvite(projectId, {
        email: inviteEmail.trim() || undefined,
        projectRole: inviteRole,
      });
      setLatestInviteLink({ url: r.invite.inviteUrl, sent: r.invite.email_sent, copied: false });
      if (r.invite.email_sent) onFlash(`Invite sent to ${inviteEmail}.`);
      setInviteEmail("");
      await load();
    } catch (err) {
      setInviteErr(err.message);
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async (token, email) => {
    if (!confirm(`Revoke invite for ${email}?`)) return;
    try {
      await api.revokeProjectInvite(projectId, token);
      onFlash(`Invite for ${email} revoked.`);
      await load();
    } catch (e) {
      onFlash(`Failed: ${e.message}`);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop — full-screen button so clicking outside the panel closes it */}
      <button
        type="button"
        className="absolute inset-0 bg-black/40 cursor-default"
        onClick={onClose}
        aria-label="Close panel"
      />

      {/* Panel */}
      <div className="relative z-50 w-full max-w-lg h-full bg-ink-950 border-l border-ink-700 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-ink-700">
          <UsersIcon className="text-brand-300" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">Users</div>
            <div className="text-xs text-slate-500 truncate">{project?.name}</div>
          </div>
          <button
            type="button"
            className="text-slate-400 hover:text-slate-200 p-1"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-ink-700 px-5 gap-0.5 pt-2">
          {[
            ["members", `Members (${members.length})`],
            ["invite", "Invite"],
            ["pending", `Pending (${invites.filter((i) => !i.accepted_at).length})`],
          ].map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`px-3 py-1.5 text-xs font-medium rounded-t transition
                ${tab === k ? "bg-ink-800 text-brand-200 border-t border-x border-ink-600/80" : "text-slate-400 hover:text-slate-200"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5">
          {tab === "members" && (
            <div className="space-y-4">
              {/* Current members */}
              <div className="space-y-1">
                {members.map((m) => (
                  <div
                    key={m.user_id}
                    className="flex items-center gap-2 px-3 py-2 rounded-md bg-ink-900/60 border border-ink-700/60"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{m.username}</div>
                      {m.email && (
                        <div className="text-[11px] text-slate-500 truncate">{m.email}</div>
                      )}
                    </div>
                    <select
                      className="input py-0.5 px-1.5 text-xs w-24"
                      value={m.role}
                      onChange={(e) => changeRole(m.user_id, e.target.value)}
                    >
                      <option value="manager">manager</option>
                      <option value="editor">editor</option>
                      <option value="viewer">viewer</option>
                    </select>
                    <button
                      type="button"
                      className="btn-danger text-xs py-0.5 px-2"
                      onClick={() => removeMember(m.user_id, m.username)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {members.length === 0 && (
                  <div className="text-xs text-slate-500 text-center py-4">No members yet.</div>
                )}
              </div>

              {/* Add existing user — always visible so managers know the feature exists */}
              <div className="pt-2 border-t border-ink-700/60 space-y-2">
                <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                  Add existing user
                </div>
                {nonMembers.length === 0 ? (
                  <p className="text-xs text-slate-500 italic">
                    All registered users are already members of this project. Use the{" "}
                    <strong className="text-slate-400">Invite</strong> tab to bring in new users by
                    email.
                  </p>
                ) : (
                  <form onSubmit={addMember} className="flex gap-2">
                    <select
                      className="input flex-1 text-sm"
                      value={addUserId}
                      onChange={(e) => setAddUserId(e.target.value)}
                      required
                    >
                      <option value="">— Select user —</option>
                      {nonMembers.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.username}
                          {/* {u.email ? ` (${u.email})` : ""} */}
                        </option>
                      ))}
                    </select>
                    <select
                      className="input w-28 text-sm"
                      value={addRole}
                      onChange={(e) => setAddRole(e.target.value)}
                    >
                      <option value="manager">manager</option>
                      <option value="editor">editor</option>
                      <option value="viewer">viewer</option>
                    </select>
                    <button
                      type="submit"
                      className="btn-primary text-xs"
                      disabled={busy || !addUserId}
                    >
                      Add
                    </button>
                  </form>
                )}
              </div>
            </div>
          )}

          {tab === "invite" && (
            <div className="space-y-3">
              {latestInviteLink && (
                <div className="text-xs bg-brand-900/30 border border-brand-500/40 rounded-md p-3 space-y-1.5">
                  {latestInviteLink.sent ? (
                    <div className="text-brand-200">
                      Invite email sent. Share this link too if needed:
                    </div>
                  ) : (
                    <div className="text-amber-200">
                      Invite created — share this link with the recipient:
                    </div>
                  )}
                  <input
                    className="input font-mono text-xs"
                    value={latestInviteLink.url}
                    readOnly
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    className="btn text-xs"
                    onClick={() => {
                      navigator.clipboard?.writeText(latestInviteLink.url);
                      setLatestInviteLink((l) => ({ ...l, copied: true }));
                    }}
                  >
                    {latestInviteLink.copied ? "✓ Copied" : "Copy link"}
                  </button>
                </div>
              )}
              <form onSubmit={sendInvite} className="space-y-3">
                <p className="text-xs text-slate-400">
                  Invite someone to this project. Email is optional — if omitted, copy and share the
                  invite link manually.
                </p>
                {!mailerConfigured && (
                  <div className="panel px-3 py-2 text-xs text-amber-300/90 border-amber-500/30">
                    ⚠ SMTP is not configured — the invite link will be shown here but no email will
                    be sent.
                  </div>
                )}
                <label className="block">
                  <span className="label">
                    Email address <span className="text-slate-500 font-normal">(optional)</span>
                  </span>
                  <input
                    className="input"
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="colleague@example.com"
                  />
                </label>
                <label className="block">
                  <span className="label">Project role</span>
                  <select
                    className="input"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                  >
                    <option value="manager">manager — full control of project</option>
                    <option value="editor">editor — edit ontologies</option>
                    <option value="viewer">viewer — read-only access</option>
                  </select>
                </label>
                {inviteErr && <div className="text-sm text-red-300">{inviteErr}</div>}
                <div className="flex justify-end">
                  <button type="submit" className="btn-primary" disabled={busy}>
                    {busy ? "Creating…" : "Create invite"}
                  </button>
                </div>
              </form>
            </div>
          )}

          {tab === "pending" && (
            <div className="space-y-2">
              {invites
                .filter((i) => !i.accepted_at)
                .map((i) => {
                  const inviteUrl = `${window.location.origin}/invite/${i.token}`;
                  return (
                    <div
                      key={i.token}
                      className="flex items-start gap-2 px-3 py-2 rounded-md bg-ink-900/60 border border-ink-700/60"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {i.email || (
                            <span className="text-slate-500 italic">no email — link only</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <RoleBadge role={i.project_role || i.role} />
                          <span className="text-[10px] text-slate-500">
                            invited by {i.invited_by_username || "—"}
                          </span>
                          <span className="text-[10px] text-slate-500">
                            expires {new Date(i.expires_at).toLocaleDateString()}
                          </span>
                          {i.email ? (
                            i.email_sent ? (
                              <span className="text-[10px] text-emerald-400">email sent</span>
                            ) : (
                              <span className="text-[10px] text-amber-400">no email</span>
                            )
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="btn-ghost text-[10px] px-1.5 py-0.5 mt-1 font-mono"
                          onClick={() => navigator.clipboard?.writeText(inviteUrl)}
                          title="Copy invite link"
                        >
                          Copy link
                        </button>
                      </div>
                      <button
                        type="button"
                        className="btn-ghost text-xs py-0.5"
                        onClick={() => revokeInvite(i.token, i.email || i.token.slice(0, 8))}
                      >
                        Revoke
                      </button>
                    </div>
                  );
                })}
              {invites.filter((i) => !i.accepted_at).length === 0 && (
                <div className="text-xs text-slate-500 text-center py-4">No pending invites.</div>
              )}

              {/* Accepted invites */}
              {invites.filter((i) => i.accepted_at).length > 0 && (
                <>
                  <div className="text-xs font-medium text-slate-500 uppercase tracking-wider pt-2">
                    Accepted
                  </div>
                  {invites
                    .filter((i) => i.accepted_at)
                    .map((i) => (
                      <div
                        key={i.token}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-ink-900/40 border border-ink-700/40"
                      >
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-slate-400 truncate block">
                            {i.email || "—"}
                          </span>
                        </div>
                        <span className="text-[10px] text-emerald-400">accepted</span>
                      </div>
                    ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Project History side panel ────────────────────────────────────────────────

/** Map a full predicate IRI to a short human-readable name. */
function predicateLabel(pIri) {
  if (!pIri) return "property";
  const known = {
    "http://www.w3.org/2000/01/rdf-schema#label": "label",
    "http://www.w3.org/2000/01/rdf-schema#comment": "comment",
    "http://www.w3.org/2000/01/rdf-schema#subClassOf": "subclass of",
    "http://www.w3.org/2000/01/rdf-schema#domain": "domain",
    "http://www.w3.org/2000/01/rdf-schema#range": "range",
    "http://www.w3.org/2000/01/rdf-schema#seeAlso": "see also",
    "http://www.w3.org/2000/01/rdf-schema#isDefinedBy": "defined by",
    "http://www.w3.org/2000/01/rdf-schema#subPropertyOf": "sub-property of",
    "http://www.w3.org/2004/02/skos/core#definition": "definition",
    "http://www.w3.org/2004/02/skos/core#prefLabel": "pref. label",
    "http://www.w3.org/2004/02/skos/core#altLabel": "alt. label",
    "http://www.w3.org/2004/02/skos/core#example": "example",
    "http://www.w3.org/2004/02/skos/core#note": "note",
    "http://purl.org/dc/terms/description": "description",
    "http://purl.org/dc/terms/title": "title",
    "http://purl.org/dc/terms/creator": "creator",
    "http://purl.org/dc/terms/license": "license",
    "http://www.w3.org/2002/07/owl#versionInfo": "version",
    "http://www.w3.org/2002/07/owl#deprecated": "deprecated",
    "http://www.w3.org/2002/07/owl#equivalentClass": "equivalent class",
    "http://www.w3.org/2002/07/owl#disjointWith": "disjoint with",
    "http://www.w3.org/2002/07/owl#inverseOf": "inverse of",
  };
  return known[pIri] || pIri.split(/[#/]/).pop() || pIri;
}

/** Extract the local name from an IRI (after the last # or /). */
function localName(iri) {
  if (!iri) return "";
  return iri.split(/[#/]/).pop() || iri;
}

/**
 * Merge add-triple + delete-triple pairs that share the same subject, predicate,
 * and user into a synthetic "_edit-triple" entry.
 *
 * History is returned ORDER BY id DESC (newest first).  A description edit
 * produces two DB rows: delete-triple (id N) then add-triple (id N+1).  In the
 * sorted array the add-triple therefore appears BEFORE the delete-triple, so we
 * look forward from each add-triple for its matching delete-triple.
 */
function collapseTripleEdits(changes) {
  const merged = new Set();
  const result = [];
  for (let i = 0; i < changes.length; i++) {
    if (merged.has(i)) continue;
    const c = changes[i];
    if (c.action === "add-triple") {
      // Look forward for the matching delete-triple (comes later in the
      // newest-first list because it has a smaller id).
      const j = changes.findIndex(
        (other, idx) =>
          idx > i &&
          !merged.has(idx) &&
          other.action === "delete-triple" &&
          other.details?.s === c.details?.s &&
          other.details?.p === c.details?.p &&
          other.username === c.username,
      );
      if (j !== -1) {
        merged.add(j);
        // Carry the old value AND the delete-triple id so Undo can reverse both.
        result.push({
          ...c,
          action: "_edit-triple",
          oldDetails: changes[j].details,
          oldId: changes[j].id,
        });
        continue;
      }
    }
    result.push(c);
  }
  return result;
}

/** Human-readable label for each change action type. */
function actionLabel(action, details) {
  const p = details?.p;
  if (action === "_edit-triple") return `Edited ${predicateLabel(p)}`;
  if (action === "add-triple") return `Added ${predicateLabel(p)}`;
  if (action === "delete-triple") return `Removed ${predicateLabel(p)}`;
  if (action === "update-deprecated")
    return details?.deprecated ? "Marked deprecated" : "Removed deprecated flag";
  if (action === "project-member-set")
    return details?.role ? `Added member as ${details.role}` : "Added member";
  if (action === "accept-invite" && details?.projectId)
    return details?.projectRole ? `Joined project as ${details.projectRole}` : "Joined project";

  const map = {
    "create-class": "Created class",
    "update-class": "Updated class",
    "delete-class": "Deleted class",
    "create-property": "Created property",
    "update-property": "Updated property",
    "delete-property": "Deleted property",
    "create-individual": "Created individual",
    "update-individual": "Updated individual",
    "delete-individual": "Deleted individual",
    "delete-entity": "Deleted entity",
    import: "Imported ontology",
    "create-ontology": "Created ontology",
    "update-ontology": "Updated ontology",
    "delete-ontology": "Deleted ontology",
    "meta-update": "Updated metadata",
    "update-meta": "Updated metadata",
    "update-version-info": "Updated version info",
    deprecate: "Deprecated entity",
    "update-property-chars": "Updated characteristics",
    "update-inverses": "Updated inverses",
    "update-super-properties": "Updated super-properties",
    "update-equivalents": "Updated equivalent classes",
    "update-disjoints": "Updated disjoint classes",
    "update-see-also": "Updated see-also links",
    "update-is-defined-by": "Updated defined-by",
  };
  return (
    map[action] || action?.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "—"
  );
}

function ProjectHistoryPanel({ projectId, project, onClose }) {
  const [changes, setChanges] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = () => setReloadKey((k) => k + 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an intentional re-fetch trigger with no direct usage in the body
  useEffect(() => {
    setLoading(true);
    fetch(`/api/ontology/changes?project=${encodeURIComponent(projectId)}&ontology=all&limit=200`, {
      credentials: "include",
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setChanges(d.changes || []);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [projectId, reloadKey]);

  // Build an ontology id→name lookup from the project data
  const ontoName = (id) =>
    project?.ontologies?.find((o) => o.id === id)?.name || id?.slice(0, 8) || "—";

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <button
        type="button"
        className="absolute inset-0 bg-black/40 cursor-default"
        onClick={onClose}
        aria-label="Close panel"
      />

      {/* Panel */}
      <div className="relative z-50 w-full max-w-lg h-full bg-ink-950 border-l border-ink-700 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-ink-700">
          <HistoryIcon className="text-brand-300" size={14} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">Edit History</div>
            <div className="text-xs text-slate-500 truncate">{project?.name}</div>
          </div>
          <button
            type="button"
            className="btn text-xs flex items-center gap-1.5 shrink-0"
            onClick={onClose}
            aria-label="Close history panel"
          >
            <CloseIcon />
            Close
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {loading && <div className="p-6 text-sm text-slate-500 animate-pulse">Loading…</div>}
          {error && <div className="p-6 text-sm text-red-300">Error: {error}</div>}
          {!loading && !error && changes.length === 0 && (
            <div className="p-6 text-sm text-slate-500 text-center">No edit history yet.</div>
          )}
          {!loading && !error && changes.length > 0 && (
            <div className="divide-y divide-ink-700/50">
              {collapseTripleEdits(changes).map((c) => (
                <HistoryRow
                  key={c.id}
                  c={c}
                  ontoName={ontoName}
                  projectId={projectId}
                  onReload={reload}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── History row (expandable) ─────────────────────────────────────────────────

/**
 * Single history entry that can be clicked to expand a detail section.
 * For _edit-triple entries a red/green diff is shown.
 * For everything else the raw `details` JSON is pretty-printed.
 *
 * Reversible actions (add-triple, delete-triple, _edit-triple) show an Undo
 * button. All entries show a Comment button for attaching a free-text note.
 */
function HistoryRow({ c, ontoName, projectId, onReload }) {
  const [expanded, setExpanded] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState(null);
  const [undoDone, setUndoDone] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(c.note || "");
  const [noteBusy, setNoteBusy] = useState(false);
  const noteRef = useRef(null);

  // Focus the textarea when the note editor opens.
  useEffect(() => {
    if (noteOpen) noteRef.current?.focus();
  }, [noteOpen]);

  const canUndo =
    !undoDone &&
    (c.action === "add-triple" || c.action === "delete-triple" || c.action === "_edit-triple");

  const label =
    c.details?.label ||
    c.details?.name ||
    (c.details?.iri ? localName(c.details.iri) : "") ||
    (c.details?.s ? localName(c.details.s) : "");

  const ts = c.created_at
    ? new Date(c.created_at).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";

  const hasDetail = c.action === "_edit-triple" || (c.details && Object.keys(c.details).length > 0);

  // Call the undo endpoint with the correct project scope.
  const callUndo = async (id) => {
    const url = `/api/ontology/changes/${encodeURIComponent(id)}/undo?project=${encodeURIComponent(projectId)}`;
    const r = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: "{}",
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
  };

  const handleUndo = async (e) => {
    e.stopPropagation();
    if (!confirm("Undo this change? This will reverse the triple operation.")) return;
    setUndoBusy(true);
    setUndoError(null);
    try {
      if (c.action === "_edit-triple") {
        // Undo the add-triple (delete the new value) then undo the delete-triple (restore old value).
        await callUndo(c.id);
        if (c.oldId) await callUndo(c.oldId);
      } else {
        await callUndo(c.id);
      }
      setUndoDone(true);
      onReload?.();
    } catch (e) {
      setUndoError(e.message);
    } finally {
      setUndoBusy(false);
    }
  };

  const handleNoteSave = async (e) => {
    e.stopPropagation();
    setNoteBusy(true);
    try {
      const url = `/api/ontology/changes/${encodeURIComponent(c.id)}/note?project=${encodeURIComponent(projectId)}`;
      const r = await fetch(url, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
        body: JSON.stringify({ note: note || null }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setNoteOpen(false);
    } catch (_e) {
      // silently keep open on error
    } finally {
      setNoteBusy(false);
    }
  };

  return (
    <div className={undoDone ? "opacity-50" : ""}>
      <button
        type="button"
        className="w-full text-left px-5 py-3 flex items-start gap-3 hover:bg-ink-900/40 transition group"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {/* Timeline dot */}
        <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-brand-400/70 shrink-0" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-slate-200">
              {actionLabel(c.action, c.details)}
            </span>
            {label && (
              <span className="text-[11px] text-slate-400 font-mono truncate max-w-40">
                {label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-500 flex-wrap">
            <span className="font-medium text-slate-400">{c.username || "unknown"}</span>
            <span>·</span>
            <span>{ontoName(c.ontology_id)}</span>
            <span>·</span>
            <span>{ts}</span>
          </div>
          {/* Existing note preview */}
          {c.note && !noteOpen && (
            <div className="mt-1 text-[10px] text-slate-400 italic truncate flex items-center gap-1">
              <MessageSquare size={9} aria-hidden="true" />
              {c.note}
            </div>
          )}
        </div>

        {/* Action buttons (prevent row expand/collapse) */}
        <div className="flex items-center gap-1 shrink-0 ml-1">
          {canUndo && (
            <button
              type="button"
              className="btn text-[10px] px-1.5 py-0.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition"
              onClick={handleUndo}
              disabled={undoBusy}
              title="Undo this change"
            >
              {undoBusy ? "…" : "↩ Undo"}
            </button>
          )}
          <button
            type="button"
            className={`btn text-[10px] px-1.5 py-0.5 flex items-center gap-1 transition ${noteOpen ? "" : "opacity-0 group-hover:opacity-100"}`}
            onClick={(e) => {
              e.stopPropagation();
              setNoteOpen((v) => !v);
            }}
            title={c.note ? "Edit note" : "Add note"}
          >
            <MessageSquare size={9} aria-hidden="true" />
            {c.note ? "Edit" : "Note"}
          </button>
        </div>

        {/* Expand chevron — only when there's something to show */}
        {hasDetail && (
          <ChevronRight
            size={12}
            className={`shrink-0 mt-1 text-slate-500 transition-transform ${expanded ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
        )}
      </button>

      {/* Undo error */}
      {undoError && (
        <div className="px-8 pb-2 text-[11px] text-red-300">Undo failed: {undoError}</div>
      )}

      {/* Note editor */}
      {noteOpen && (
        <div className="px-8 pb-3">
          <textarea
            ref={noteRef}
            className="input w-full text-xs resize-none h-16"
            placeholder="Add a note to this history entry…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2 mt-1.5 justify-end">
            <button
              type="button"
              className="btn text-xs"
              onClick={(e) => {
                e.stopPropagation();
                setNote(c.note || "");
                setNoteOpen(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={handleNoteSave}
              disabled={noteBusy}
            >
              {noteBusy ? "Saving…" : "Save note"}
            </button>
          </div>
        </div>
      )}

      {/* Detail section */}
      {expanded && hasDetail && (
        <div className="px-8 pb-3">
          {c.action === "_edit-triple" ? (
            <EditTripleDiff newDetails={c.details} oldDetails={c.oldDetails} />
          ) : (
            <pre className="text-[11px] leading-relaxed font-mono text-slate-300 bg-ink-900/60 border border-ink-700/60 rounded-lg p-3 overflow-auto max-h-60 whitespace-pre-wrap">
              {JSON.stringify(c.details, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Shows a simple before/after diff for an edited triple value.
 * `newDetails` comes from the add-triple, `oldDetails` from the delete-triple.
 */
function EditTripleDiff({ newDetails, oldDetails }) {
  const oldVal = oldDetails?.o ?? "—";
  const newVal = newDetails?.o ?? "—";
  const predIri = newDetails?.p || oldDetails?.p;

  return (
    <div className="space-y-1 font-mono text-[11px]">
      {predIri && (
        <div className="text-[10px] text-slate-500 mb-1.5 truncate">Annotation: {predIri}</div>
      )}
      <div className="flex gap-1.5 items-start">
        <span className="shrink-0 mt-0.5 text-red-400 font-bold select-none pt-1">−</span>
        <span className="flex-1 bg-pink-950/50 border border-rose-700/50 rounded px-2 py-1 text-red-200 break-all">
          {oldVal}
        </span>
      </div>
      <div className="flex gap-1.5 items-start">
        <span className="shrink-0 mt-0.5 text-emerald-400 font-bold select-none pt-1">+</span>
        <span className="flex-1 bg-emerald-950/50 border border-emerald-700/50 rounded px-2 py-1 text-emerald-200 break-all">
          {newVal}
        </span>
      </div>
    </div>
  );
}

// ── Helpers & icons ───────────────────────────────────────────────────────────

function RoleBadge({ role }) {
  const colors = {
    manager: "bg-purple-500/20 text-purple-200 border-purple-500/30",
    editor: "bg-brand-500/20 text-brand-200 border-brand-500/30",
    viewer: "bg-slate-500/20 text-slate-300 border-slate-500/30",
    admin: "bg-amber-500/20 text-amber-200 border-amber-500/30",
    user: "bg-slate-500/20 text-slate-300 border-slate-500/30",
  };
  return (
    <span
      className={`hidden md:inline text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${colors[role] || colors.viewer}`}
    >
      {role}
    </span>
  );
}

function UsersIcon({ className = "" }) {
  return <Users size={13} className={className} aria-hidden="true" />;
}

function EditIcon() {
  return <Edit size={12} aria-hidden="true" />;
}

function _ExportIcon() {
  return <Download size={11} aria-hidden="true" />;
}

function HistoryIcon({ className = "", size = 13 }) {
  return <RotateCcw width={size} height={size} className={className} aria-hidden="true" />;
}

function CloseIcon() {
  return <X size={14} aria-hidden="true" />;
}

// ── GitHub Push + PR Modal ────────────────────────────────────────────────────

// `isUpdate` = true when pushing to an already-open GitHub branch (no new branch created).
function GitHubPushModal({
  ontology,
  parentOntology = null,
  projectId,
  onClose,
  onFlash,
  onRefresh,
  isUpdate = false,
}) {
  const { setWriteTarget } = useProject();
  const effectivePath = ontology.github_path || parentOntology?.github_path || ontology.name;
  // step: "push" → "pr" (only for root pushes); update pushes close after success.
  const [step, setStep] = useState("push");
  const [branchName, setBranchName] = useState(
    isUpdate
      ? ontology.github_branch_name
      : `amethyst/edit-${ontology.id.slice(0, 8)}-${Date.now()}`,
  );
  const [commitMessage, setCommitMessage] = useState(`Amethyst: update ${effectivePath}`);
  const [prTitle, setPrTitle] = useState(`Amethyst: update ${effectivePath}`);
  const [prBody, setPrBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // ID of the newly-created in-app branch ontology (root pushes only)
  const [branchOntologyId, setBranchOntologyId] = useState(null);

  const handlePush = async () => {
    if (!isUpdate && !branchName.trim()) {
      setErr("Branch name is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const result = await api.pushOntologyToGitHub(projectId, ontology.id, {
        branch_name: isUpdate ? undefined : branchName.trim(),
        commit_message: commitMessage.trim(),
      });

      if (isUpdate) {
        // Follow-up push to existing branch — just refresh and close.
        onFlash("Changes pushed to GitHub branch.");
        await onRefresh();
        onClose();
      } else {
        // Root push created an in-app branch; switch writable to it and offer PR step.
        if (result.branchOntologyId) {
          setBranchOntologyId(result.branchOntologyId);
          setWriteTarget(result.branchOntologyId);
          await onRefresh();
        }
        setStep("pr");
      }
    } catch (e) {
      const needsScope = e.message.includes("github_needs_repo_scope");
      setErr(
        needsScope
          ? "Repository write access required. Go to Settings → GitHub to upgrade your access."
          : e.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCreatePR = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Create PR against the branch ontology (not the parent) so pr_url is stored there.
      const prOntologyId = branchOntologyId || ontology.id;
      const result = await api.createGitHubPR(projectId, prOntologyId, {
        branch_name: branchName.trim(),
        title: prTitle.trim(),
        body: prBody,
      });
      onFlash(`Pull Request opened: ${result.pr_url}`);
      await onRefresh();
      onClose();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const title = isUpdate
    ? "Push Update to GitHub"
    : step === "push"
      ? "Push to GitHub"
      : "Create Pull Request";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md panel p-5 space-y-4 mx-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch size={15} className="text-slate-400" aria-hidden="true" />
            <h2 className="font-semibold text-sm">{title}</h2>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <CloseIcon />
          </button>
        </div>

        {step === "push" ? (
          <div className="space-y-3">
            {isUpdate ? (
              <div className="text-xs text-slate-400">
                Pushing an update to{" "}
                <span className="font-mono text-slate-300">{ontology.github_branch_name}</span>.
                This adds a commit to the existing branch and PR.
              </div>
            ) : (
              <div className="text-xs text-slate-400">
                Pushing <span className="font-mono text-slate-300">{ontology.github_path}</span> to
                a new branch. An in-app branch will be created as the write target.
              </div>
            )}
            {!isUpdate && (
              <label className="block">
                <span className="label">Branch name</span>
                <input
                  className="input font-mono text-xs"
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  required
                />
              </label>
            )}
            {isUpdate && (
              <div className="text-xs">
                <span className="label">Branch</span>
                <span className="font-mono text-slate-300 ml-2">{branchName}</span>
              </div>
            )}
            <label className="block">
              <span className="label">Commit message</span>
              <input
                className="input text-xs"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
              />
            </label>
            {err && <div className="text-sm text-red-300">{err}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost text-xs" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary text-xs flex items-center gap-1"
                onClick={handlePush}
                disabled={busy}
              >
                <Upload size={11} aria-hidden="true" />
                {busy ? "Pushing…" : "Push to GitHub"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-slate-400">
              Branch <span className="font-mono text-slate-300">{branchName}</span> pushed and set
              as write target. Open a pull request to merge your changes.
            </div>
            <label className="block">
              <span className="label">PR title</span>
              <input
                className="input text-xs"
                value={prTitle}
                onChange={(e) => setPrTitle(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="label">Description (optional)</span>
              <textarea
                className="input text-xs min-h-16"
                value={prBody}
                onChange={(e) => setPrBody(e.target.value)}
                placeholder="Describe your changes…"
              />
            </label>
            {err && <div className="text-sm text-red-300">{err}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost text-xs" onClick={onClose}>
                Skip for now
              </button>
              <button
                type="button"
                className="btn-primary text-xs flex items-center gap-1"
                onClick={handleCreatePR}
                disabled={busy}
              >
                <GitBranch size={11} aria-hidden="true" />
                {busy ? "Creating PR…" : "Open Pull Request"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
