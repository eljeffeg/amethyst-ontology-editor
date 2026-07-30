import { Bot, ChevronDown, CircleDot, Menu, MessageSquare, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { GitHubIcon, useAuth } from "../App.jsx";
import { api, term } from "../lib/api.js";
import AdminView from "./AdminView.jsx";
import AIChatPanel from "./AIChatPanel.jsx";
import ChatView from "./ChatView.jsx";
import ClassesView from "./ClassesView.jsx";
import DatatypesView from "./DatatypesView.jsx";
import GitHubIssuesView from "./GitHubIssuesView.jsx";
import GraphView from "./GraphView.jsx";
import ImportView from "./ImportView.jsx";
import IndividualsView from "./IndividualsView.jsx";
import ManageProjectsView from "./ManageProjectsView.jsx";
import { ProjectOntologyPicker, UserMenu, useProject } from "./OntologyPicker.jsx";
import PropertiesView from "./PropertiesView.jsx";
import RulesView from "./RulesView.jsx";
import SettingsView, { getShowWorkspaceBanner, WORKSPACE_BANNER_KEY } from "./SettingsView.jsx";
import SparqlView from "./SparqlView.jsx";

// Top-bar app shell.
//
//  ┌────────────────────────────────────────────────────────────────────────┐
//  │ [logo] Amethyst   [Graph][Classes][Properties ▾][…]   [Proj ▾][User ▾] │
//  └────────────────────────────────────────────────────────────────────────┘
//  │                              Main view                                 │
//
// The picker (right) also hides the old "go to Import/Export" and "Invites &
// Teams" nav items — they live inside the Project dropdown now. The user
// dropdown houses Settings, Manage Projects, Administration (admin-only), and
// Logout.
export default function AppShell() {
  const { user, setUser } = useAuth();
  const {
    currentProject,
    currentProjectId,
    currentOntology,
    visibleOntologyIds,
    writeOntologyId,
    workspaceMode,
    loaded: projectsLoaded,
    refresh: refreshProjects,
  } = useProject();

  // A stable string key that changes whenever the scope changes.
  // Includes the visible set so a workspace toggle also remounts views.
  const scopeKey = `${currentProjectId ?? "none"}:${writeOntologyId ?? "none"}:${visibleOntologyIds.join(",")}`;
  const [meta, setMeta] = useState(null);
  const [showAIChat, setShowAIChat] = useState(false);

  // Workspace banner preference (default off, toggled in Settings).
  const [showBanner, setShowBanner] = useState(getShowWorkspaceBanner);

  // Re-read when Settings updates it via a StorageEvent.
  useEffect(() => {
    const handler = (e) => {
      if (!e.key || e.key === WORKSPACE_BANNER_KEY) {
        setShowBanner(getShowWorkspaceBanner());
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const reloadMeta = useCallback(() => {
    if (!currentProject || !currentOntology) {
      setMeta(null);
      return Promise.resolve();
    }
    return api
      .meta()
      .then(setMeta)
      .catch(() => setMeta(null));
  }, [currentProject, currentOntology]);

  // Refresh whenever the scope changes.
  useEffect(() => {
    reloadMeta();
  }, [reloadMeta]);

  const onLogout = async () => {
    await api.logout();
    setUser(null);
  };

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <header className="relative z-50 shrink-0 border-b border-ink-700 bg-ink-950/95 backdrop-blur-sm">
        <div className="flex items-center gap-3 px-4 h-14">
          <div className="flex items-center gap-2 shrink-0">
            <img src="/logo.png" alt="Amethyst logo" className="h-13 -mb-1" />
          </div>

          <MobileNavMenu
            hasGithub={!!currentProject?.github_repo}
            onOpenAIChat={() => setShowAIChat(true)}
          />

          <nav className="hidden md:flex flex-1 items-center justify-center gap-0.5 min-w-0 flex-wrap">
            <TopNavItem to="/" label="Graph" end />
            <TopNavItem to="/classes" label={term("ClassPlural")} />
            <TopNavItem to="/properties/relationships" label={term("ObjectPropertyPlural")} />
            <TopNavItem to="/individuals" label={term("IndividualPlural")} />
            <ModelElementsMenu />
            <ToolsMenu />
          </nav>

          <div className="flex items-center gap-2 shrink-0 ml-auto md:ml-0">
            <ProjectOntologyPicker />
            <div className="hidden md:flex items-center gap-2">
              {currentProject?.github_repo && (
                <MessageItem to="/issues" label="Issues" icon={CircleDot} />
              )}
              <MessageItem to="/chat" label="Discussions" />
              {currentProject?.github_repo && (
                <button
                  type="button"
                  className={`flex items-center gap-2 px-3 py-2.25 rounded-md transition border cursor-pointer ${
                    showAIChat
                      ? "bg-brand-600/20 text-brand-100 border-brand-500/30"
                      : "text-slate-300 bg-ink-800/70 border-ink-600/60 hover:bg-ink-700/70"
                  }`}
                  onClick={() => setShowAIChat((s) => !s)}
                  title="AI chat"
                >
                  <Bot size={14} className="shrink-0" aria-hidden="true" />
                </button>
              )}
            </div>
            <UserMenu user={user} onLogout={onLogout} />
          </div>
        </div>

        {workspaceMode && showBanner && (
          <div className="px-4 py-1.5 text-[11px] bg-amber-500/8 border-t border-amber-500/20 text-amber-100/80 flex items-center justify-center gap-2 flex-wrap">
            <span className="text-amber-400/90 font-medium">Workspace:</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-200 border border-amber-500/30">
              ✏ {currentOntology?.name ?? "—"}
            </span>
            <span className="text-amber-600/80 text-[10px]">
              writing · {visibleOntologyIds.length} ontolog
              {visibleOntologyIds.length === 1 ? "y" : "ies"} visible
            </span>
          </div>
        )}
      </header>

      {/* Main */}
      <main className="flex-1 min-w-0 min-h-0 flex flex-col">
        {/* Gate all content on the provider having resolved project/ontology
            scope from localStorage. Without this guard, content views mount
            with null scope params and fetch data from the wrong ontology. */}
        {!projectsLoaded ? (
          <div className="flex-1 grid place-items-center text-slate-500 text-sm select-none">
            Loading…
          </div>
        ) : (
          <Routes key={scopeKey}>
            <Route path="/" element={<GraphView />} />
            <Route path="/classes" element={<ClassesView onChange={reloadMeta} />} />
            <Route
              path="/properties"
              element={<Navigate to="/properties/relationships" replace />}
            />
            <Route
              path="/properties/relationships"
              element={<PropertiesView onChange={reloadMeta} fixedKind="object" />}
            />
            <Route
              path="/properties/attributes"
              element={<PropertiesView onChange={reloadMeta} fixedKind="datatype" />}
            />
            <Route
              path="/properties/annotations"
              element={<PropertiesView onChange={reloadMeta} fixedKind="annotation" />}
            />
            <Route path="/properties/datatypes" element={<DatatypesView onChange={reloadMeta} />} />
            <Route path="/individuals" element={<IndividualsView onChange={reloadMeta} />} />
            <Route path="/sparql" element={<SparqlView onChange={reloadMeta} />} />
            <Route path="/rules" element={<RulesView onChange={reloadMeta} />} />
            <Route path="/import" element={<ImportView onChange={reloadMeta} />} />
            <Route path="/admin" element={<AdminView />} />
            <Route path="/chat" element={<ChatView />} />
            <Route path="/issues" element={<GitHubIssuesView />} />
            <Route
              path="/projects"
              element={<ManageProjectsView onOntologiesChanged={refreshProjects} />}
            />
            <Route
              path="/settings"
              element={
                <SettingsView
                  meta={meta}
                  onChange={reloadMeta}
                  onOntologiesChanged={refreshProjects}
                />
              }
            />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        )}

        {meta?.stats && (
          <footer className="shrink-0 border-t border-ink-700 bg-ink-950/50 px-4 py-1.5 hidden md:flex items-center gap-4 text-[11px] text-slate-400 overflow-x-auto">
            <Stat label={term("ClassPlural")} value={meta.stats.classes} />
            <Stat label={term("ObjectPropertyPlural")} value={meta.stats.objectProperties} />
            <Stat label={term("DatatypePropertyPlural")} value={meta.stats.datatypeProperties} />
            <Stat label={term("IndividualPlural")} value={meta.stats.individuals} />
            <Stat label="Triples" value={meta.stats.triples} />

            <a
              href="https://github.com/eljeffeg/amethyst-ontology-editor"
              target="_blank"
              rel="noreferrer"
              className="ml-auto shrink-0 flex items-center gap-1 text-slate-500 hover:text-slate-300 transition-colors"
            >
              <GitHubIcon size={16} aria-hidden="true" />
            </a>
          </footer>
        )}
      </main>
      {showAIChat && (
        <div className="fixed top-14 right-0 bottom-0 z-40 flex shadow-2xl shadow-black/60">
          <AIChatPanel ontologyId={currentOntology?.id} onClose={() => setShowAIChat(false)} />
        </div>
      )}
    </div>
  );
}

function MessageItem({ to, label, icon: Icon = MessageSquare }) {
  return (
    <NavLink
      to={to}
      end
      title={label}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-2.25 rounded-md transition
         ${
           isActive
             ? "bg-brand-600/20 text-brand-100 border border-brand-500/30"
             : "text-slate-300 bg-ink-800/70 border border-ink-600/60 hover:bg-ink-700/70"
}`
      }
    >
      <Icon size={14} className="shrink-0" aria-hidden="true" />
    </NavLink>
  );
}

function TopNavItem({ to, label, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `px-3 py-1.5 rounded-md text-sm font-medium transition
         ${
           isActive
             ? "bg-brand-600/20 text-brand-100 border border-brand-500/30"
             : "text-slate-300 hover:bg-ink-700/60 border border-transparent"
}`
      }
    >
      {label}
    </NavLink>
  );
}

// Mobile-only hamburger menu. Collapses the center nav + right-side action
// icons into a single dropdown panel below `md`. Hidden on desktop.
function MobileNavMenu({ hasGithub, onOpenAIChat }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const _location = useLocation();

  useEffect(() => {
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Close on route change.
  useEffect(() => {
    setOpen(false);
  }, []);

  const close = () => setOpen(false);

  return (
    <div className="md:hidden relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-center w-9 h-9 rounded-md bg-ink-800/70 border border-ink-600/60 text-slate-300 hover:bg-ink-700/70 transition"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
      >
        {open ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
      </button>
      {open && (
        <div
          className="fixed left-0 right-0 top-14 z-60 rounded-b-lg shadow-xl shadow-black/40
                     border-t border-b border-ink-600/80 bg-ink-900/95 backdrop-blur-xs py-2 max-h-[calc(100vh-3.5rem)] overflow-y-auto"
        >
          <MobileLink to="/" end label="Graph" onPick={close} />
          <MobileLink to="/classes" label={term("ClassPlural")} onPick={close} />
          <MobileLink
            to="/properties/relationships"
            label={term("ObjectPropertyPlural")}
            onPick={close}
          />

          <MobileSectionHeader label="Model Elements" />
          <MobileLink
            to="/properties/attributes"
            label={term("DatatypePropertyPlural")}
            onPick={close}
          />
          <MobileLink to="/properties/annotations" label="Annotations" onPick={close} />
          <MobileLink to="/individuals" label={term("IndividualPlural")} onPick={close} />
          <MobileLink to="/properties/datatypes" label="Datatypes" onPick={close} />

          <MobileSectionHeader label="Tools" />
          <MobileLink to="/import" label="Import / Export" onPick={close} />
          <MobileLink to="/rules" label="Rules (SWRL)" onPick={close} />
          <MobileLink to="/sparql" label="Console (SPARQL)" onPick={close} />

          <MobileSectionHeader label="More" />
          {hasGithub && <MobileLink to="/issues" label="Issues" onPick={close} />}
          <MobileLink to="/chat" label="Discussions" onPick={close} />
          {hasGithub && (
            <button
              type="button"
              onClick={() => {
                onOpenAIChat();
                close();
              }}
              className="w-full text-left block px-4 py-2.5 text-sm text-slate-200 hover:bg-ink-700/70"
            >
              AI Chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MobileLink({ to, label, end, onPick }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onPick}
      className={({ isActive }) =>
        `block px-4 py-2.5 text-sm
         ${isActive ? "bg-brand-600/20 text-brand-100" : "text-slate-200 hover:bg-ink-700/70"}`
      }
    >
      {label}
    </NavLink>
  );
}

function MobileSectionHeader({ label }) {
  return (
    <>
      <hr className="border-ink-700/60 my-1 mx-3" />
      <div className="px-4 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
        {label}
      </div>
    </>
  );
}

// Model Elements → small hover/click menu with the three property kinds.
function ModelElementsMenu() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const active =
    location.pathname.startsWith("/properties") &&
    location.pathname !== "/properties/relationships";

  useEffect(() => {
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium transition
          ${
            active
              ? "bg-brand-600/20 text-brand-100 border border-brand-500/30"
              : "text-slate-300 hover:bg-ink-700/60 border border-transparent"
          }`}
      >
        Model Elements
        <ChevronDown
          size={12}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          className="absolute z-60 left-1/2 -translate-x-1/2 mt-1 rounded-lg shadow-xl shadow-black/40
                        border border-ink-600/80 bg-ink-900/95 backdrop-blur-xs py-1 min-w-56"
        >
          <PropSubItem
            to="/properties/attributes"
            onPick={() => setOpen(false)}
            label={term("DatatypePropertyPlural")}
          />
          <PropSubItem
            to="/properties/annotations"
            onPick={() => setOpen(false)}
            label="Annotations"
          />
          <PropSubItem to="/properties/datatypes" onPick={() => setOpen(false)} label="Datatypes" />
        </div>
      )}
    </div>
  );
}

// Tools → dropdown menu for utility views (SPARQL console, Rules, Import/Export, etc.)
function ToolsMenu() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const active =
    location.pathname.startsWith("/sparql") ||
    location.pathname.startsWith("/rules") ||
    location.pathname.startsWith("/import");

  useEffect(() => {
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium transition
          ${
            active
              ? "bg-brand-600/20 text-brand-100 border border-brand-500/30"
              : "text-slate-300 hover:bg-ink-700/60 border border-transparent"
          }`}
      >
        Tools
        <ChevronDown
          size={12}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          className="absolute z-60 left-1/2 -translate-x-1/2 mt-1 rounded-lg shadow-xl shadow-black/40
                        border border-ink-600/80 bg-ink-900/95 backdrop-blur-xs py-1 min-w-48"
        >
          <PropSubItem to="/import" onPick={() => setOpen(false)} label="Import / Export" />
          <hr className="border-ink-700/60 my-1 mx-3" />
          <PropSubItem to="/rules" onPick={() => setOpen(false)} label="Rules (SWRL)" />
          <hr className="border-ink-700/60 my-1 mx-3" />
          <PropSubItem to="/sparql" onPick={() => setOpen(false)} label="Console (SPARQL)" />
        </div>
      )}
    </div>
  );
}

function PropSubItem({ to, label, onPick }) {
  return (
    <NavLink
      to={to}
      onClick={onPick}
      className={({ isActive }) =>
        `block px-3 py-1.5 text-sm
         ${isActive ? "bg-brand-600/20 text-brand-100" : "text-slate-200 hover:bg-ink-700/70"}`
      }
    >
      {label}
    </NavLink>
  );
}

function Stat({ label, value }) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-slate-500">{label}:</span>
      <span className="text-slate-200 font-mono">{value}</span>
    </div>
  );
}
