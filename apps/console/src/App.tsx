import { useCallback, useEffect, useState } from 'react';
import { HashRouter, NavLink, Route, Routes } from 'react-router';
import { api, getToken, setToken } from './api/client';
import type { StatusResponse } from './api/client';
import { Logo } from './components/Logo';
import { ToastProvider } from './components/Toast';
import { TablesPage } from './pages/TablesPage';
import { NewTablePage } from './pages/NewTablePage';
import { TablePage } from './pages/TablePage';
import { SettingsPage } from './pages/SettingsPage';
import { PlatformApp } from './platform/PlatformApp';

/** Which console the API served last time, so a reload renders the right shell before `/api/status` answers. */
const MODE_KEY = 'console-mode';
type ConsoleMode = 'dealer' | 'platform';

function rememberedMode(): ConsoleMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'platform' ? 'platform' : 'dealer';
  } catch {
    return 'dealer';
  }
}

function rememberMode(mode: ConsoleMode): void {
  try {
    if (mode === 'platform') localStorage.setItem(MODE_KEY, 'platform');
    else localStorage.removeItem(MODE_KEY);
  } catch {
    /* private mode */
  }
}

/** Asks for the console token when the API says 401 (remote access). */
function TokenGate({ onDone }: { onDone: () => void }) {
  const [token, setTokenState] = useState(getToken());
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setToken(token.trim());
    try {
      await api.status();
      setError(null);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That token was not accepted');
    }
  };
  return (
    <div className="page">
      <form className="card gate stack" onSubmit={submit} data-testid="token-gate">
        <span className="eyebrow">Dealer console</span>
        <h1>Console token</h1>
        <p className="muted">
          This dealer is reachable from other machines, so it asks for the token you started it with
          (<code>--token</code> or Settings).
        </p>
        <input
          className="input"
          type="password"
          value={token}
          onChange={(e) => setTokenState(e.target.value)}
          placeholder="token"
          data-testid="token-input"
          autoFocus
        />
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary" type="submit" data-testid="token-submit">
          Continue
        </button>
      </form>
    </div>
  );
}

function AppBar({ status }: { status: StatusResponse | null }) {
  const running = status?.running ?? 0;
  return (
    <header className="appbar">
      <NavLink to="/" className="brand" data-testid="brand">
        <Logo />
        <span>Dealer console</span>
      </NavLink>
      <nav className="nav" aria-label="Primary">
        <NavLink to="/" end data-testid="nav-tables">
          Tables
        </NavLink>
        <NavLink to="/new" data-testid="nav-new">
          New table
        </NavLink>
        <NavLink to="/settings" data-testid="nav-settings">
          Settings
        </NavLink>
      </nav>
      <span className="spacer" />
      <span className="row small muted" data-testid="status-line">
        <span className={`dot ${running > 0 ? 'dot-live' : ''}`} />
        {status ? `${running} running · ${status.dealer.name}` : 'connecting…'}
      </span>
      {status && (
        <a
          className="btn btn-sm btn-ghost"
          href={status.settings.appUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open app ↗
        </a>
      )}
    </header>
  );
}

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [gate, setGate] = useState(false);
  const [hint] = useState(rememberedMode);
  const load = useCallback(async () => {
    try {
      const next = await api.status();
      setStatus(next);
      rememberMode(next.mode === 'platform' ? 'platform' : 'dealer');
      setGate(false);
    } catch (e) {
      if ((e as { unauthorized?: boolean }).unauthorized) setGate(true);
    }
  }, []);
  useEffect(() => {
    const onUnauthorized = () => setGate(true);
    window.addEventListener('console:unauthorized', onUnauthorized);
    const timer = setInterval(() => void load(), 15_000);
    // The first load is asynchronous, so no state is set synchronously inside the effect.
    const first = setTimeout(() => void load(), 0);
    return () => {
      window.removeEventListener('console:unauthorized', onUnauthorized);
      clearInterval(timer);
      clearTimeout(first);
    };
  }, [load]);
  if (gate) return <TokenGate onDone={() => void load()} />;
  // The platform server says `mode: 'platform'`; the dealer's status has no mode field.
  const platform = status ? status.mode === 'platform' : hint === 'platform';
  if (platform) return <PlatformApp status={status} />;
  return (
    <HashRouter>
      <ToastProvider>
        <AppBar status={status} />
        <Routes>
          <Route path="/" element={<TablesPage />} />
          <Route path="/new" element={<NewTablePage />} />
          <Route path="/tables/:id" element={<TablePage />} />
          <Route
            path="/settings"
            element={<SettingsPage status={status} onSaved={() => void load()} />}
          />
          <Route path="*" element={<TablesPage />} />
        </Routes>
      </ToastProvider>
    </HashRouter>
  );
}
