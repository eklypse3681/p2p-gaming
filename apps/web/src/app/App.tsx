import { useEffect } from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router';
import { ThemeProvider } from './ThemeProvider';
import { ErrorBoundary } from './ErrorBoundary';
import { AppBar } from './AppBar';
import { SessionRegistryProvider } from '../session/SessionRegistry';
import { ProfileProvider, useProfile } from '../session/ProfileProvider';
import { runPendingDbMigrations } from '../session/migrate';
import { ToastProvider } from '../hud/Toast';
import { PickerScreen } from './PickerScreen';
import { HubScreen } from './HubScreen';
import { SettingsScreen } from './SettingsScreen';
import { GameProvider } from '../games/GameProvider';
import type { GameDefinition } from '../games/GameProvider';
import { GAMES } from '../games/registry';
import { DEFAULT_GAME } from '../games/ids';

/** Routes with no player in scope: the picker, invite links, game demos. */
function GlobalShell() {
  return (
    <ThemeProvider>
      <AppBar />
      <ErrorBoundary>
        <Outlet />
      </ErrorBoundary>
    </ThemeProvider>
  );
}

/**
 * Everything under `#/:profile/`. The segment names the player this tab is; settings, saved
 * matches and live sessions are all keyed by it, so two tabs are simply two players.
 */
function ProfileShell() {
  const { profile } = useParams();
  return (
    <ProfileProvider slug={profile ?? ''} fallback={<Navigate to="/" replace />}>
      <ThemeProvider>
        <AppBar />
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </ThemeProvider>
    </ProfileProvider>
  );
}

/** Everything under `#/:profile/:game/`: the game's screens learn which game they are from here. */
function GameShell({ def }: { def: GameDefinition }) {
  return (
    <GameProvider def={def}>
      <Outlet />
    </GameProvider>
  );
}

function ProfileHomeRedirect() {
  const { path } = useProfile();
  return <Navigate to={path('/')} replace />;
}

function GameHomeRedirect({ def }: { def: GameDefinition }) {
  const { slug } = useProfile();
  return <Navigate to={def.routes(slug).home} replace />;
}

/**
 * Addresses from before games were a route segment (`#/steve/host`, `#/steve/game/<id>`, …)
 * redirect to the backgammon equivalents, keeping the query string (`?match=`).
 */
function LegacyGameRedirect({ sub }: { sub: 'host' | 'join' | 'game' | 'history' }) {
  const { slug } = useProfile();
  const params = useParams();
  const { search } = useLocation();
  const routes = GAMES.find((g) => g.id === DEFAULT_GAME)!.routes(slug);
  let to: string;
  switch (sub) {
    case 'host':
      to = routes.host;
      break;
    case 'join':
      to = routes.join(params.code);
      break;
    case 'game':
      to = routes.game(params.matchId ?? '');
      break;
    case 'history':
      to = routes.history;
      break;
  }
  return <Navigate to={`${to}${search}`} replace />;
}

/** The route table, separated from the router so tests can mount it in a MemoryRouter. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<GlobalShell />}>
        <Route index element={<PickerScreen />} />
        {/* Invite links: `#/<game>/join/CODE`; the profile-less legacy form means backgammon. */}
        <Route path="join/:code" element={<PickerScreen />} />
        {GAMES.map((g) => (
          <Route
            key={`${g.id}-join`}
            path={`${g.id}/join/:code`}
            element={<PickerScreen game={g.id} />}
          />
        ))}
        {GAMES.flatMap((g) => {
          const Demo = g.Demo;
          return Demo
            ? [<Route key={`${g.id}-demo`} path={`${g.id}/demo`} element={<Demo />} />]
            : [];
        })}
        <Route path="demo" element={<Navigate to={`/${DEFAULT_GAME}/demo`} replace />} />
      </Route>
      <Route path=":profile" element={<ProfileShell />}>
        <Route index element={<HubScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        {GAMES.map((g) => (
          <Route key={g.id} path={g.id} element={<GameShell def={g} />}>
            <Route index element={<g.screens.Home />} />
            <Route path="host" element={<g.screens.Host />} />
            <Route path="join/:code?" element={<g.screens.Join />} />
            <Route path="game/:matchId" element={<g.screens.Game />} />
            <Route path="history" element={<g.screens.History />} />
            <Route path="*" element={<GameHomeRedirect def={g} />} />
          </Route>
        ))}
        <Route path="host" element={<LegacyGameRedirect sub="host" />} />
        <Route path="join/:code?" element={<LegacyGameRedirect sub="join" />} />
        <Route path="game/:matchId" element={<LegacyGameRedirect sub="game" />} />
        <Route path="history" element={<LegacyGameRedirect sub="history" />} />
        <Route path="*" element={<ProfileHomeRedirect />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  useEffect(() => {
    void runPendingDbMigrations();
  }, []);
  return (
    <ToastProvider>
      <SessionRegistryProvider>
        <HashRouter>
          <AppRoutes />
        </HashRouter>
      </SessionRegistryProvider>
    </ToastProvider>
  );
}
