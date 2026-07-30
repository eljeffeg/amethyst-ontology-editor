import { Disc, MessageSquare, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../App.jsx";
import { api, shortLabel } from "../lib/api.js";
import { Thread } from "./Comments.jsx";
import { useOntology } from "./OntologyPicker.jsx";

// Full-page feed of every comment in the current ontology, grouped by the
// entity they were posted on. Lets users browse every conversation in one
// place rather than drilling into each class / property / individual.
export default function ChatView() {
  const { user } = useAuth();
  const { currentProject, currentOntology, currentOntologyId, unionMode } = useOntology();
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState("open"); // open | resolved | all
  const [newBody, setNewBody] = useState("");
  const [busy, setBusy] = useState(false);

  // In union mode we show every thread in the project; in single mode just the
  // current ontology's threads.
  const load = useCallback(async () => {
    if (!currentOntologyId) {
      setComments([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await api.allComments(currentOntologyId);
      setComments(r.comments || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [currentOntologyId]);
  useEffect(() => {
    load();
  }, [load]);

  // Group by target_iri: null == general discussion.
  const groups = useMemo(() => {
    const by = new Map();
    for (const c of comments) {
      const key = c.target_iri || "__general__";
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(c);
    }
    // Build per-target thread lists (roots + their replies).
    const q = filter.trim().toLowerCase();
    const out = [];
    for (const [target, items] of by) {
      const roots = items.filter((c) => !c.parent_id);
      const repliesOf = (id) => items.filter((c) => c.parent_id === id);
      const threads = roots.map((root) => ({
        root,
        replies: repliesOf(root.id),
      }));

      // Scope filter (based on whether the root thread is resolved).
      const filteredByScope = threads.filter((t) => {
        if (scope === "open") return !t.root.resolved;
        if (scope === "resolved") return !!t.root.resolved;
        return true;
      });

      // Text filter across any comment in the thread or the target label.
      const matches = (text) => !q || (text || "").toLowerCase().includes(q);
      const labelText =
        target === "__general__" ? "general discussion" : `${target} ${shortLabel(target)}`;
      const filteredThreads = filteredByScope.filter((t) => {
        if (matches(labelText)) return true;
        if (matches(t.root.body)) return true;
        return t.replies.some((r) => matches(r.body));
      });

      if (filteredThreads.length === 0) continue;

      // Most recently touched thread sorts the group.
      const lastActivity = Math.max(
        ...filteredThreads.map((t) =>
          Math.max(
            t.root.updated_at || t.root.created_at,
            ...t.replies.map((r) => r.updated_at || r.created_at),
            0,
          ),
        ),
      );
      const openCount = filteredThreads.filter((t) => !t.root.resolved).length;

      out.push({
        target,
        threads: filteredThreads,
        lastActivity,
        openCount,
        totalCount: filteredThreads.length,
      });
    }
    out.sort((a, b) => b.lastActivity - a.lastActivity);
    return out;
  }, [comments, filter, scope]);

  const submitGeneral = async (e) => {
    e.preventDefault();
    if (!newBody.trim()) return;
    setBusy(true);
    try {
      await api.createComment({ target_iri: null, body: newBody });
      setNewBody("");
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const totalThreads = comments.filter((c) => !c.parent_id).length;
  const openThreads = comments.filter((c) => !c.parent_id && !c.resolved).length;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-ink-700 bg-ink-900/70 backdrop-blur-sm px-5 py-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <MessageSquare size={18} className="text-brand-300" aria-hidden="true" />
          <h1 className="text-base font-semibold">Discussions</h1>
          <span className="text-xs text-slate-500">
            ·{" "}
            {unionMode
              ? `${currentProject?.name || "project"} (all ontologies)`
              : currentOntology?.name || "no ontology"}
          </span>
        </div>

        <div className="flex items-center gap-1 p-0.5 bg-ink-800 rounded-md border border-ink-600/50">
          {[
            ["open", `Open (${openThreads})`],
            ["resolved", "Resolved"],
            ["all", `All (${totalThreads})`],
          ].map(([k, label]) => (
            <button
              type="button"
              key={k}
              onClick={() => setScope(k)}
              className={`px-3 py-1 text-xs rounded-sm ${scope === k ? "bg-brand-600 text-white" : "text-slate-300 hover:bg-ink-700"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="input max-w-xs"
          placeholder="Search comments & entities…"
        />

        <button type="button" className="btn-ghost text-xs ml-auto" onClick={load} title="Refresh">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-5 space-y-6 max-w-3xl w-full mx-auto">
        {err && <div className="panel px-3 py-2 text-sm text-red-300 border-red-500/60">{err}</div>}
        {loading && <div className="text-xs text-slate-500">Loading comments…</div>}
        {!loading && !groups.length && (
          <div className="panel p-8 text-center text-sm text-slate-400">
            {filter || scope !== "all"
              ? "No threads match the current filter."
              : "No conversations yet. Start one below or comment on an entity from its detail page."}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.target} className="space-y-2">
            <GroupHeader target={g.target} openCount={g.openCount} totalCount={g.totalCount} />
            <div className="space-y-2">
              {g.threads.map((t) => (
                <Thread
                  key={t.root.id}
                  root={t.root}
                  replies={t.replies}
                  currentUser={user}
                  onChanged={load}
                />
              ))}
            </div>
          </section>
        ))}

        <section className="panel p-4 mt-6">
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">
            Start a general thread
          </div>
          {unionMode ? (
            <div className="text-sm text-slate-400">
              Pick a specific ontology from the sidebar to post a new thread. Comments are always
              attached to a single ontology.
            </div>
          ) : (
            <form onSubmit={submitGeneral} className="space-y-2">
              <textarea
                className="input min-h-17.5 text-sm"
                placeholder="Something to discuss with the whole team…"
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
              />
              <div className="flex items-center justify-end">
                <button
                  type="submit"
                  className="btn-primary text-xs"
                  disabled={busy || !newBody.trim()}
                >
                  {busy ? "…" : "Post"}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}

function GroupHeader({ target, openCount, totalCount }) {
  const isGeneral = target === "__general__";
  const label = isGeneral ? "General discussion" : shortLabel(target);
  const entityHref = entityRoute(target);

  return (
    <header className="flex items-baseline gap-2 border-b border-ink-700 pb-1">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {isGeneral ? (
          <MessageSquare size={14} className="text-slate-400 shrink-0" aria-hidden="true" />
        ) : (
          <Disc size={14} className="text-brand-300 shrink-0" aria-hidden="true" />
        )}
        <div className="font-semibold truncate text-slate-100">{label}</div>
        {!isGeneral && (
          <div className="text-[11px] text-slate-500 font-mono truncate">{target}</div>
        )}
      </div>
      <div className="text-xs text-slate-400 shrink-0 flex items-center gap-2">
        <span>
          {openCount} open · {totalCount} total
        </span>
        {entityHref && (
          <Link to={entityHref} className="text-brand-300 hover:underline">
            Open →
          </Link>
        )}
      </div>
    </header>
  );
}

// Best-effort guess at which list page an entity is reachable from. We don't
// know its kind here, so we point at Classes, which will filter on selection.
function entityRoute(target) {
  if (!target || target === "__general__") return null;
  return `/classes#iri=${encodeURIComponent(target)}`;
}
