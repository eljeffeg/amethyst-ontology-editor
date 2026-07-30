import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import AppShell from "./components/AppShell.jsx";
import AuthView from "./components/AuthView.jsx";
import InviteAcceptView from "./components/InviteAcceptView.jsx";
import { OntologyProvider } from "./components/OntologyPicker.jsx";
import TerminologyOnboardModal from "./components/TerminologyOnboardModal.jsx";
import { api } from "./lib/api.js";

export const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);
export const GitHubIcon = ({ size = 15, className, "aria-hidden": ariaHidden }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 1024 1024"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-label={ariaHidden ? undefined : "GitHub repository"}
    aria-hidden={ariaHidden}
    className={className}
  >
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"
      transform="scale(64)"
      fill="currentColor"
    />
  </svg>
);

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hasUsers, setHasUsers] = useState(true);
  const [registrationDisabled, setRegistrationDisabled] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [showTermModal, setShowTermModal] = useState(false);
  const [githubEnabled, setGithubEnabled] = useState(false);
  const [githubOAuthEnabled, setGithubOAuthEnabled] = useState(false);
  const [githubConnection, setGithubConnection] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setUser(s.user);
      setHasUsers(s.hasUsers);
      setRegistrationDisabled(!!s.registrationDisabled);
      setGoogleEnabled(!!s.googleEnabled);
      setGithubEnabled(!!s.githubEnabled);
      setGithubOAuthEnabled(!!s.githubOAuthEnabled);
      setGithubConnection(s.githubConnection || null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Show terminology picker when user has no saved preference.
  // Key is per-user so a new account always triggers it even if another
  // user previously set a preference on the same browser.
  useEffect(() => {
    if (!user) return;
    try {
      const key = `ontology-editor:terminology-onboarded:${user.id}`;
      if (!localStorage.getItem(key)) {
        setShowTermModal(true);
      }
    } catch {}
  }, [user]);

  if (loading) {
    return <div className="h-screen grid place-items-center text-slate-400">Loading…</div>;
  }

  return (
    <>
      {showTermModal && (
        <TerminologyOnboardModal
          onDone={() => {
            try {
              localStorage.setItem(`ontology-editor:terminology-onboarded:${user.id}`, "1");
            } catch {}
            setShowTermModal(false);
          }}
        />
      )}
      <AuthContext.Provider
        value={{
          user,
          setUser,
          hasUsers,
          registrationDisabled,
          googleEnabled,
          githubEnabled,
          githubOAuthEnabled,
          githubConnection,
          setGithubConnection,
          refresh,
        }}
      >
        <Routes>
          <Route path="/invite/:token" element={<InviteAcceptView />} />
          <Route path="/login" element={user ? <Navigate to="/" /> : <AuthView />} />
          <Route
            path="/*"
            element={
              user ? (
                <OntologyProvider>
                  <AppShell />
                </OntologyProvider>
              ) : (
                <Navigate to="/login" />
              )
            }
          />
        </Routes>
      </AuthContext.Provider>
    </>
  );
}
