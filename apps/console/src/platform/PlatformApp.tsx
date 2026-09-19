import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { HashRouter, Navigate, NavLink, Route, Routes } from 'react-router';
import type { StatusResponse } from '../api/client';
import { Logo } from '../components/Logo';
import { ToastProvider } from '../components/Toast';
import { PlatformApiError, getPlatformToken, platformApi, setPlatformToken } from './api';
import type { Me } from './api';
import { SessionContext, useSession } from './session';
import type { PlatformSession } from './session';
import { LoginPage } from './LoginPage';
import { ClubsPage } from './ClubsPage';
import { ClubPage } from './ClubPage';
import { OperatorPage } from './OperatorPage';
import { HousePage } from './HousePage';

function PlatformAppBar() {
  const { status, me, signOut } = useSession();
  return (
    <header className="appbar">
      <NavLink to={me ? '/clubs' : '/'} className="brand" data-testid="brand">
        <Logo />
        <span>Platform console</span>
      </NavLink>
      {me && (
        <nav className="nav" aria-label="Primary">
          <NavLink to="/clubs" data-testid="nav-clubs">
            My clubs
          </NavLink>
          {me.operator && status?.house && (
            <NavLink to="/house" data-testid="nav-house">
              House
            </NavLink>
          )}
          {me.operator && (
            <NavLink to="/operator" data-testid="nav-operator">
              Operator
            </NavLink>
          )}
        </nav>
      )}
      <span className="spacer" />
      <span className="row small muted" data-testid="status-line">
        <span className={`dot ${me ? 'dot-live' : ''}`} />
        {status
          ? `${status.clubs ?? 0} club${status.clubs === 1 ? '' : 's'}${status.dev ? ' · dev' : ''}`
          : 'connecting…'}
        {me ? ` · ${me.name}` : ''}
      </span>
      {status?.appUrl && (
        <a className="btn btn-sm btn-ghost" href={status.appUrl} target="_blank" rel="noreferrer">
          Open app ↗
        </a>
      )}
      {me && (
        <button className="btn btn-sm" onClick={() => void signOut()} data-testid="sign-out">
          Sign out
        </button>
      )}
    </header>
  );
}

/** Pages behind a session; operator pages additionally need the operator flag. */
function Guard({ children, operator = false }: { children: ReactNode; operator?: boolean }) {
  const { me, loading } = useSession();
  if (loading)
    return (
      <main className="page" data-testid="session-loading">
        <p className="muted">Checking your session…</p>
      </main>
    );
  if (!me) return <Navigate to="/" replace />;
  if (operator && !me.operator) return <Navigate to="/clubs" replace />;
  return <>{children}</>;
}

function LoginRoute() {
  const { me, loading } = useSession();
  if (loading)
    return (
      <main className="page" data-testid="session-loading">
        <p className="muted">Checking your session…</p>
      </main>
    );
  if (me) return <Navigate to="/clubs" replace />;
  return <LoginPage />;
}

/** The hosted club platform's console: sign in with a player identity, manage clubs. */
export function PlatformApp({ status }: { status: StatusResponse | null }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(() => !!getPlatformToken());
  const refreshMe = useCallback(async () => {
    if (!getPlatformToken()) {
      setMe(null);
      setLoading(false);
      return null;
    }
    try {
      const next = await platformApi.me();
      setMe(next);
      return next;
    } catch (e) {
      if (e instanceof PlatformApiError && e.unauthorized) {
        setPlatformToken('');
        setMe(null);
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // The built index.html is shared with the dealer; name the tab for this mode.
    const title = document.title;
    document.title = 'Platform console';
    return () => {
      document.title = title;
    };
  }, []);
  useEffect(() => {
    // The first load is asynchronous, so no state is set synchronously inside the effect.
    const first = setTimeout(() => void refreshMe(), 0);
    const onUnauthorized = () => {
      setPlatformToken('');
      setMe(null);
    };
    window.addEventListener('platform:unauthorized', onUnauthorized);
    return () => {
      clearTimeout(first);
      window.removeEventListener('platform:unauthorized', onUnauthorized);
    };
  }, [refreshMe]);
  const signIn = useCallback(
    async (token: string) => {
      setPlatformToken(token);
      return refreshMe();
    },
    [refreshMe],
  );
  const signOut = useCallback(async () => {
    try {
      await platformApi.logout();
    } catch {
      /* the token is dropped either way */
    }
    setPlatformToken('');
    setMe(null);
  }, []);
  const session = useMemo<PlatformSession>(
    () => ({ status, me, loading, refreshMe, signIn, signOut }),
    [status, me, loading, refreshMe, signIn, signOut],
  );
  return (
    <HashRouter>
      <ToastProvider>
        <SessionContext.Provider value={session}>
          <div data-testid="platform-app" data-signed-in={me ? 'true' : 'false'}>
            <PlatformAppBar />
            <Routes>
              <Route path="/" element={<LoginRoute />} />
              <Route
                path="/clubs"
                element={
                  <Guard>
                    <ClubsPage />
                  </Guard>
                }
              />
              <Route
                path="/clubs/:id"
                element={
                  <Guard>
                    <ClubPage />
                  </Guard>
                }
              />
              <Route
                path="/house"
                element={
                  <Guard operator>
                    <HousePage />
                  </Guard>
                }
              />
              <Route
                path="/operator"
                element={
                  <Guard operator>
                    <OperatorPage />
                  </Guard>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </SessionContext.Provider>
      </ToastProvider>
    </HashRouter>
  );
}
