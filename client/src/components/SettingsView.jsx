import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { GitHubIcon, useAuth } from "../App.jsx";
import { api, getTerminology, setTerminology } from "../lib/api.js";
import { useProject } from "./OntologyPicker.jsx";

// localStorage key for the workspace banner visibility preference.
export const WORKSPACE_BANNER_KEY = "ontology-editor:show-workspace-banner";
export function getShowWorkspaceBanner() {
  try {
    return localStorage.getItem(WORKSPACE_BANNER_KEY) === "true";
  } catch {
    return false; // default off
  }
}
export function setShowWorkspaceBanner(val) {
  try {
    localStorage.setItem(WORKSPACE_BANNER_KEY, val ? "true" : "false");
  } catch {}
}

// Settings page — scoped to "things about my account + this ontology".
//
// Project- and ontology-collection management (create / delete projects and
// ontologies across the install) lives on /projects — the Manage Projects
// page. This page only has:
//   • Account (email, password)
//   • Terminology preference
//   • Current project metadata (name, description)
//   • Current ontology metadata (name, IRI, description, version info)
//   • Recent activity log
export default function SettingsView({ meta, onChange, onOntologiesChanged }) {
  const location = useLocation();
  const { user, setUser, githubOAuthEnabled, githubConnection, setGithubConnection } = useAuth();
  const { currentProject, unionMode, refresh: refreshProjects } = useProject();

  // Ontology metadata
  const [name, setName] = useState("");
  const [iri, setIri] = useState("");
  const [description, setDescription] = useState("");
  const [versionInfo, setVersionInfo] = useState("");
  const [_saved, setSaved] = useState(false);
  const [_err, setErr] = useState(null);

  // Project metadata
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [_projectSaved, setProjectSaved] = useState(false);
  const [_projectErr, setProjectErr] = useState(null);

  // Terminology
  const [terminology, setTerm] = useState(getTerminology());

  // Interface preferences
  const [showWorkspaceBanner, setShowWorkspaceBannerState] = useState(getShowWorkspaceBanner());

  // Activity
  const [changes, setChanges] = useState([]);

  useEffect(() => {
    if (meta?.meta && !unionMode) {
      setName(meta.meta.name || "");
      setIri(meta.meta.iri || "");
      setDescription(meta.meta.description || "");
      setVersionInfo(meta.meta.versionInfo || "");
    }
    api
      .changes(50)
      .then((r) => setChanges(r.changes))
      .catch(() => {});
  }, [meta, unionMode]);

  useEffect(() => {
    setProjectName(currentProject?.name || "");
    setProjectDescription(currentProject?.description || "");
  }, [currentProject?.description, currentProject?.name]);

  useEffect(() => {
    const target = location.hash?.replace("#", "");
    if (!target) return;
    const el = document.getElementById(target);
    if (!el) return;
    const t = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(t);
  }, [location.hash]);

  const _save = async (e) => {
    e.preventDefault();
    setErr(null);
    setSaved(false);
    try {
      await api.saveMeta({ name, iri, description, versionInfo });
      setSaved(true);
      onChange?.();
      await refreshProjects();
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.message);
    }
  };

  const _saveProject = async (e) => {
    e.preventDefault();
    setProjectErr(null);
    setProjectSaved(false);
    if (!currentProject) return;
    try {
      await api.updateProject(currentProject.id, {
        name: projectName.trim() || currentProject.name,
        description: projectDescription,
      });
      setProjectSaved(true);
      await refreshProjects();
      setTimeout(() => setProjectSaved(false), 2000);
    } catch (e) {
      setProjectErr(e.message);
    }
  };

  const updateTerminology = (t) => {
    setTerm(t);
    setTerminology(t);
    window.dispatchEvent(new Event("storage"));
    setTimeout(() => window.location.reload(), 100);
  };

  const toggleWorkspaceBanner = () => {
    const next = !showWorkspaceBanner;
    setShowWorkspaceBannerState(next);
    setShowWorkspaceBanner(next);
    // Dispatch a storage event so AppShell picks up the change without reload.
    window.dispatchEvent(new StorageEvent("storage", { key: WORKSPACE_BANNER_KEY }));
  };

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="p-6 space-y-6 max-w-4xl mx-auto">
        <h2 className="text-xl font-semibold">Settings</h2>

        {/* Terminology */}
        <section className="panel p-5 space-y-4">
          <h3 className="font-semibold">Terminology</h3>
          <div className="text-xs text-slate-400">
            Choose whether to use RDF/OWL terminology ("Object Property", "Domain", "Range") or
            friendlier business terms ("Relationship", "Attribute", "Source", "Target"). Switching
            reloads the page so all views update.
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <TermOption
              selected={terminology === "friendly"}
              onSelect={() => updateTerminology("friendly")}
              title="LPG Friendly"
              items={[
                ["Object Property", "→ Relationship"],
                ["Datatype Property", "→ Attribute"],
                ["Domain", "→ Source"],
                ["Range", "→ Target"],
              ]}
            />
            <TermOption
              selected={terminology === "rdf"}
              onSelect={() => updateTerminology("rdf")}
              title="RDF / OWL (standard)"
              items={[["Object Property"], ["Datatype Property"], ["Domain"], ["Range"]]}
            />
          </div>
        </section>

        {/* Interface */}
        <section className="panel p-5 space-y-4">
          <h3 className="font-semibold">Interface</h3>
          <div className="space-y-3">
            <label className="flex items-start gap-3 cursor-pointer group">
              <div className="relative mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={showWorkspaceBanner}
                  onChange={toggleWorkspaceBanner}
                />
                <div className="w-9 h-5 rounded-full border border-ink-500/60 bg-ink-700 peer-checked:bg-brand-600 peer-checked:border-brand-500 transition-colors" />
                <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-slate-300 peer-checked:bg-white peer-checked:translate-x-4 transition-all shadow-sm" />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-200 group-hover:text-white transition-colors">
                  Show workspace banner
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Display a status bar when multiple ontologies are active in the workspace, listing
                  which are visible and which is the write target.
                </div>
              </div>
            </label>
          </div>
        </section>

        {/* Account */}
        <AccountSection user={user} setUser={setUser} />

        {/* GitHub connection — always shown; PAT path available even without OAuth env vars */}
        <GitHubSection
          githubConnection={githubConnection}
          setGithubConnection={setGithubConnection}
          oauthEnabled={githubOAuthEnabled}
        />

        <section className="panel p-5 space-y-3">
          <h3 className="font-semibold">Recent activity</h3>
          <div className="divide-y divide-ink-700 text-sm">
            {changes.length === 0 && <div className="text-xs text-slate-500">No activity yet.</div>}
            {changes.map((c) => (
              <div key={c.id} className="py-2 flex items-start gap-3">
                <div className="text-xs text-slate-500 w-36 shrink-0">
                  {new Date(c.created_at).toLocaleString()}
                </div>
                <div className="text-xs text-brand-300 w-28 shrink-0">{c.action}</div>
                <div className="text-xs text-slate-400 w-28 shrink-0">{c.username || "—"}</div>
                <div className="text-xs text-slate-400 font-mono break-all">
                  {JSON.stringify(c.details)}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account — change email and password
// ---------------------------------------------------------------------------
function AccountSection({ user, setUser }) {
  // Email
  const [email, setEmail] = useState(user?.email || "");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailErr, setEmailErr] = useState(null);
  const [emailSaved, setEmailSaved] = useState(false);

  // Password
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState(null);
  const [pwSaved, setPwSaved] = useState(false);

  useEffect(() => {
    setEmail(user?.email || "");
  }, [user?.email]);

  const saveEmail = async (e) => {
    e.preventDefault();
    setEmailErr(null);
    setEmailSaved(false);
    setEmailBusy(true);
    try {
      const r = await api.updateEmail(email.trim() || null);
      setUser(r.user);
      setEmailSaved(true);
      setTimeout(() => setEmailSaved(false), 2000);
    } catch (e) {
      setEmailErr(e.message);
    } finally {
      setEmailBusy(false);
    }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    setPwErr(null);
    setPwSaved(false);
    if (!curPw || !newPw) {
      setPwErr("Both fields are required");
      return;
    }
    if (newPw.length < 6) {
      setPwErr("New password must be at least 6 characters");
      return;
    }
    if (newPw !== confirmPw) {
      setPwErr("Passwords do not match");
      return;
    }
    setPwBusy(true);
    try {
      await api.updatePassword(curPw, newPw);
      setCurPw("");
      setNewPw("");
      setConfirmPw("");
      setPwSaved(true);
      setTimeout(() => setPwSaved(false), 2000);
    } catch (e) {
      setPwErr(e.message);
    } finally {
      setPwBusy(false);
    }
  };

  const isGoogleUser = user?.auth_provider === "google";

  return (
    <section id="account" className="panel p-5 space-y-5 scroll-mt-4">
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold">Account</h3>
        <div className="text-xs text-slate-500">
          Signed in as <span className="text-slate-300">{user?.username}</span>
          {user?.role && <span className="ml-1 text-slate-500">({user.role})</span>}
        </div>
      </div>

      {isGoogleUser ? (
        <div className="flex items-center gap-2.5 rounded-md border border-ink-600/50 bg-ink-800/50 px-4 py-3 text-sm text-slate-400">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 48 48"
            width="16"
            height="16"
            aria-hidden="true"
            className="shrink-0"
          >
            <path
              fill="#EA4335"
              d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
            />
            <path
              fill="#4285F4"
              d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
            />
            <path
              fill="#FBBC05"
              d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
            />
            <path
              fill="#34A853"
              d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
            />
            <path fill="none" d="M0 0h48v48H0z" />
          </svg>
          Signed in with Google. Email and password are managed by your Google account.
        </div>
      ) : (
        <>
          {/* Email */}
          <form onSubmit={saveEmail} className="space-y-2">
            <label className="block">
              <span className="label">Email address</span>
              <input
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
              <span className="text-[11px] text-slate-500 mt-1 block">
                Used for invite notifications. Leave blank to remove.
              </span>
            </label>
            {emailErr && <div className="text-sm text-red-300">{emailErr}</div>}
            {emailSaved && <div className="text-sm text-emerald-300">Email updated.</div>}
            <div>
              <button
                type="submit"
                className="btn-primary text-sm"
                disabled={emailBusy || email === (user?.email || "")}
              >
                {emailBusy ? "…" : "Save email"}
              </button>
            </div>
          </form>

          <div className="border-t border-ink-700" />

          {/* Password */}
          <form onSubmit={savePassword} className="space-y-2">
            <div className="text-sm font-medium text-slate-200">Change password</div>
            <label className="block">
              <span className="label">Current password</span>
              <input
                type="password"
                className="input"
                value={curPw}
                onChange={(e) => setCurPw(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block">
                <span className="label">New password</span>
                <input
                  type="password"
                  className="input"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label className="block">
                <span className="label">Confirm new password</span>
                <input
                  type="password"
                  className="input"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
            </div>
            {pwErr && <div className="text-sm text-red-300">{pwErr}</div>}
            {pwSaved && <div className="text-sm text-emerald-300">Password updated.</div>}
            <div>
              <button type="submit" className="btn-primary text-sm" disabled={pwBusy}>
                {pwBusy ? "…" : "Change password"}
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// GitHub connection
// ---------------------------------------------------------------------------

const PAT_TYPES = {
  classic: {
    label: "Classic",
    url: "https://github.com/settings/tokens/new",
    urlLabel: "github.com/settings/tokens/new",
    intro: "Generate a token with these scopes checked:",
    items: [
      { name: "repo", desc: "Push changes and sync private repos" },
      { name: "write:discussion", desc: "Sync GitHub Discussions (includes read)" },
      { name: "read:user", desc: "Read your GitHub profile" },
    ],
  },
  "fine-grained": {
    label: "Fine-grained",
    url: "https://github.com/settings/personal-access-tokens/new",
    urlLabel: "github.com/settings/personal-access-tokens/new",
    intro: "Select your repositories, then enable these permissions:",
    items: [
      { name: "Account: Models", desc: "Read (GithHub repo AI)" },
      { name: "Repositiory: Contents", desc: "Read and write" },
      { name: "Repositiory: Issues", desc: "Read and write" },
      { name: "Repositiory: Pull requests", desc: "Read and write" },
      { name: "Repositiory: Discussions", desc: "Read and write" },
      { name: "Repositiory: Metadata", desc: "Read (required automatically)" },
    ],
  },
};

function GitHubSection({ githubConnection, setGithubConnection, oauthEnabled }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [patType, setPatType] = useState("fine-grained");
  const [patValue, setPatValue] = useState("");
  const [patBusy, setPatBusy] = useState(false);
  const [patErr, setPatErr] = useState(null);

  // Surface errors forwarded from the OAuth callback redirect.
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes("error=")) {
      const params = new URLSearchParams(hash.replace(/^[^?]*\??/, ""));
      const e = params.get("error");
      if (e) {
        const msgs = {
          connect_failed: "GitHub authorization failed. Please try again.",
          invalid_state: "Session expired during authorization. Please try again.",
          access_denied: "GitHub authorization was cancelled.",
        };
        setErr(msgs[e] ?? `GitHub error: ${e}`);
        window.history.replaceState({}, "", `${window.location.pathname}#github`);
      }
    }
  }, []);

  const handleOAuthConnect = (scopeKey) => {
    const url = `/api/auth/github/connect?scope=${scopeKey}&returnTo=${encodeURIComponent("/settings#github")}`;
    window.location.href = url;
  };

  const handlePATConnect = async (e) => {
    e.preventDefault();
    const token = patValue.trim();
    if (!token) return;
    setPatBusy(true);
    setPatErr(null);
    try {
      const result = await api.connectGitHubPAT(token);
      setGithubConnection({ login: result.login, scope: result.scope });
      setPatValue("");
    } catch (ex) {
      setPatErr(ex.message);
    } finally {
      setPatBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.disconnectGitHub();
      setGithubConnection(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const isFineGrained = githubConnection?.scope === "fine-grained";
  const hasRepo = isFineGrained || githubConnection?.scope?.includes("repo");
  const hasWriteDiscussion = isFineGrained || githubConnection?.scope?.includes("write:discussion");
  const pt = PAT_TYPES[patType];

  return (
    <section id="github" className="panel p-5 space-y-4 scroll-mt-4">
      <div className="flex items-center gap-2">
        <GitHubIcon size={16} className="text-slate-400" aria-hidden="true" />
        <h3 className="font-semibold">GitHub</h3>
      </div>

      {err && <div className="text-sm text-red-300">{err}</div>}

      {githubConnection ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-md border border-emerald-500/30 bg-emerald-950/30 px-4 py-3">
            <GitHubIcon size={15} className="text-emerald-400 shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <span className="text-sm text-slate-200">
                Connected as{" "}
                <a
                  href={`https://github.com/${githubConnection.login}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-emerald-300 hover:underline"
                >
                  @{githubConnection.login}
                </a>
              </span>
              {githubConnection.scope && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {githubConnection.scope
                    .split(/[, ]+/)
                    .filter(Boolean)
                    .map((s) => (
                      <span
                        key={s}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-ink-700 text-slate-400 border border-ink-600/60"
                      >
                        {s}
                      </span>
                    ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn text-xs shrink-0"
              onClick={handleDisconnect}
              disabled={busy}
            >
              {busy ? "…" : "Disconnect"}
            </button>
          </div>

          {!isFineGrained && (!hasRepo || !hasWriteDiscussion) && oauthEnabled && (
            <div className="space-y-2">
              {!hasRepo && (
                <div className="flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2.5">
                  <div>
                    <div className="text-xs font-medium text-amber-200">
                      Push &amp; PR access needed
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Required to push ontology changes and open pull requests.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn text-xs shrink-0 ml-3"
                    onClick={() => handleOAuthConnect("push")}
                  >
                    Upgrade
                  </button>
                </div>
              )}
              {!hasWriteDiscussion && (
                <div className="flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2.5">
                  <div>
                    <div className="text-xs font-medium text-amber-200">
                      Discussion write access needed
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Required to post comments to GitHub Discussions.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn text-xs shrink-0 ml-3"
                    onClick={() => handleOAuthConnect("discussions")}
                  >
                    Upgrade
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-slate-400">
            Connect your GitHub account to sync ontology files from repositories, push changes, open
            pull requests, sync GitHub Discussions, and use AI chat powered by GitHub Models.
          </p>

          {/* PAT form with Classic / Fine-grained tabs */}
          <div className="rounded-md border border-ink-600/60 bg-ink-800/40 overflow-hidden">
            <div className="flex border-b border-ink-600/60">
              {Object.entries(PAT_TYPES).map(([key, { label }]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPatType(key)}
                  className={`flex-1 py-2 text-xs font-medium transition ${
                    patType === key
                      ? "bg-ink-700 text-slate-100 border-b-2 border-brand-400"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label} Token
                </button>
              ))}
            </div>

            <div className="p-3 space-y-3">
              <div>
                <div className="text-xs text-slate-300 mb-1.5">
                  {pt.intro}{" "}
                  <a
                    href={pt.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-300 hover:underline font-mono text-[10px]"
                  >
                    {pt.urlLabel} ↗
                  </a>
                </div>
                <ul className="space-y-0.5">
                  {pt.items.map(({ name, desc }) => (
                    <li key={name} className="flex items-baseline gap-2 text-xs">
                      <code className="text-[10px] px-1 py-0.5 rounded bg-ink-700 text-emerald-300 font-mono shrink-0">
                        {name}
                      </code>
                      <span className="text-slate-500">{desc}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <form onSubmit={handlePATConnect} className="flex gap-2">
                <input
                  type="password"
                  className="input flex-1 font-mono text-xs"
                  placeholder={patType === "classic" ? "ghp_…" : "github_pat_…"}
                  value={patValue}
                  onChange={(e) => setPatValue(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="submit"
                  className="btn-primary text-xs shrink-0"
                  disabled={patBusy || !patValue.trim()}
                >
                  {patBusy ? "…" : "Connect"}
                </button>
              </form>
              {patErr && <div className="text-xs text-red-300">{patErr}</div>}
            </div>
          </div>

          {oauthEnabled && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-px bg-ink-600/60" />
                <span className="text-[10px] text-slate-500">or use OAuth</span>
                <div className="flex-1 h-px bg-ink-600/60" />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn flex items-center gap-2 text-xs"
                  onClick={() => handleOAuthConnect("sync")}
                >
                  <GitBranch size={13} aria-hidden="true" />
                  Read access
                </button>
                <button
                  type="button"
                  className="btn-primary flex items-center gap-2 text-xs"
                  onClick={() => handleOAuthConnect("push")}
                >
                  <GitBranch size={13} aria-hidden="true" />
                  Full access
                </button>
              </div>
              <p className="text-[10px] text-slate-500">
                <em>Read</em>: file sync + read Discussions. <em>Full</em>: also push, open PRs,
                write Discussions.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function TermOption({ selected, onSelect, title, items }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left rounded-md border p-4 space-y-2 transition
        ${selected ? "bg-brand-600/20 border-brand-500/60" : "bg-ink-800/50 border-ink-600/50 hover:bg-ink-700/60"}`}
    >
      <div className="flex items-center justify-between">
        <div className="font-semibold">{title}</div>
        {selected && <Check size={16} className="text-brand-200" aria-hidden="true" />}
      </div>
      <ul className="text-xs text-slate-300 space-y-0.5">
        {items.map(([a, b]) => (
          <li key={a}>
            <span className="text-slate-400">{a}</span>
            {b ? <span className="ml-1 text-brand-200">{b}</span> : null}
          </li>
        ))}
      </ul>
    </button>
  );
}
