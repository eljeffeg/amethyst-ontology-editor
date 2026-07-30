import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useAuth } from "../App.jsx";
import { api } from "../lib/api.js";

export default function InviteAcceptView() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [infoErr, setInfoErr] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { refresh, googleEnabled } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    api
      .inviteInfo(token)
      .then((r) => setInfo(r.invite))
      .catch((e) => setInfoErr(e.message));
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (password !== confirmPassword) {
      setErr("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api.acceptInvite(token, { username, password });
      await refresh();
      nav("/");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen grid place-items-center px-6">
      <div className="w-full max-w-md panel p-8">
        <h1 className="text-xl font-semibold tracking-tight mb-1">You're invited</h1>
        <p className="text-xs text-slate-400 mb-6">
          Create an account to join the Ontology Editor.
        </p>

        {infoErr && (
          <div className="mb-4 text-sm text-red-300 bg-rose-900/30 border border-rose-500/40 rounded-md p-3">
            {infoErr}
          </div>
        )}

        {info && (
          <div className="mb-4 text-xs text-brand-200 bg-brand-900/40 border border-brand-500/40 rounded-md p-3">
            {info.email && (
              <div>
                <b>Email:</b> {info.email}
              </div>
            )}
            <div>
              <b>Role:</b> {info.role}
            </div>
            <div>
              <b>Invited by:</b> {info.invited_by_username || "—"}
            </div>
          </div>
        )}

        {info && googleEnabled && (
          <div className="mb-5">
            <button
              type="button"
              onClick={() => {
                window.location.href = `/api/auth/google?invite=${token}`;
              }}
              className="w-full flex items-center justify-center gap-3 rounded-md border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-700 active:bg-slate-600 transition-colors"
            >
              <GoogleIcon />
              Continue with Google
            </button>
            <div className="relative flex items-center mt-5">
              <div className="flex-1 border-t border-slate-700" />
              <span className="px-3 text-xs text-slate-500">or create an account</span>
              <div className="flex-1 border-t border-slate-700" />
            </div>
          </div>
        )}

        {info && (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label" htmlFor="invite-username">
                Username
              </label>
              <input
                id="invite-username"
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="invite-password">
                Password
              </label>
              <input
                id="invite-password"
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </div>
            <div>
              <label className="label" htmlFor="invite-confirm-password">
                Confirm password
              </label>
              <input
                id="invite-confirm-password"
                className={`input ${confirmPassword && confirmPassword !== password ? "border-red-500/60 focus:border-red-400" : ""}`}
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={6}
              />
              {confirmPassword && confirmPassword !== password && (
                <p className="mt-1 text-xs text-red-400">Passwords do not match.</p>
              )}
            </div>
            {err && <div className="text-sm text-red-300">{err}</div>}
            <button type="submit" className="btn-primary w-full justify-center" disabled={busy}>
              {busy ? "…" : "Accept invite"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// Official Google "G" logo mark (single-colour simplified version).
function GoogleIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width="18"
      height="18"
      aria-hidden="true"
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
  );
}
