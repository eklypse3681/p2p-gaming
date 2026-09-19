import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useParams } from 'react-router';
import { ProfileProvider } from '../session/ProfileProvider';
import { SessionRegistryProvider } from '../session/SessionRegistry';
import { ClubRegistryProvider } from '../clubs/ClubRegistry';
import type { ClubSession } from '../clubs/session';
import type { BaseSession } from '../session/SessionRegistry';
import { ThemeProvider } from '../app/ThemeProvider';
import { ensureProfile } from '../session/profiles';
import { GameProvider } from '../games/GameProvider';
import type { GameId } from '../games/ids';
import { requireGame } from '../games/registry';

function Shell() {
  const { profile } = useParams();
  return (
    <ProfileProvider slug={profile ?? ''} fallback={<div data-testid="invalid-profile" />}>
      <ThemeProvider>
        <Outlet />
      </ThemeProvider>
    </ProfileProvider>
  );
}

function GameShell({ game }: { game: GameId }) {
  return (
    <GameProvider def={requireGame(game)}>
      <Outlet />
    </GameProvider>
  );
}

function RouteMarker({ id }: { id: string }) {
  const params = useParams();
  return <div data-testid={id} data-params={JSON.stringify(params)} />;
}

/**
 * Render `ui` the way the app does (ProfileProvider + ThemeProvider + session registry), either
 * at a profile-level route (`#/:profile<route>`) or, when `game` is given, inside that game's
 * shell (`#/:profile/:game<route>`). The profile is created if unknown. `markers` are extra
 * sub-routes (relative to the game when `game` is given) rendered as `<div data-testid="<id>">`
 * so navigation can be asserted, e.g. `{ host: 'host-route' }`.
 */
export function renderWithProfile(
  slug: string,
  ui: ReactNode,
  opts: {
    route?: string;
    markers?: Record<string, string>;
    game?: GameId;
    /** Mount `ui` at this sub-route pattern (e.g. `game/:matchId`) instead of the catch-all. */
    uiPath?: string;
    /** Sessions the registry starts with (`[slug, game, session]`). */
    sessions?: [string, GameId, BaseSession][];
    /** Club sessions the club registry starts with (`[slug, session]`). */
    clubSessions?: [string, ClubSession][];
  } = {},
): RenderResult {
  ensureProfile(slug);
  const { route = '/', markers = {}, game, uiPath, sessions, clubSessions } = opts;
  const entry = game ? `/${slug}/${game}${route === '/' ? '/' : route}` : `/${slug}${route}`;
  const markerRoutes = Object.entries(markers).map(([path, id]) => (
    <Route key={path} path={path} element={<RouteMarker id={id} />} />
  ));
  const uiRoutes = uiPath ? (
    <Route path={uiPath} element={ui} />
  ) : (
    <>
      <Route path="*" element={ui} />
      <Route index element={ui} />
    </>
  );
  return render(
    <SessionRegistryProvider initialSessions={sessions}>
      <ClubRegistryProvider initialSessions={clubSessions}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/" element={<RouteMarker id="picker-route" />} />
            <Route path="/join/:code" element={<RouteMarker id="invite-route" />} />
            <Route path="/backgammon/join/:code" element={<RouteMarker id="invite-route" />} />
            <Route path=":profile" element={<Shell />}>
              {game ? (
                <>
                  <Route index element={<RouteMarker id="hub-route" />} />
                  <Route path="settings" element={<RouteMarker id="settings-route" />} />
                  <Route path={game} element={<GameShell game={game} />}>
                    {markerRoutes}
                    {uiRoutes}
                  </Route>
                </>
              ) : (
                <>
                  {markerRoutes}
                  {uiRoutes}
                </>
              )}
            </Route>
          </Routes>
        </MemoryRouter>
      </ClubRegistryProvider>
    </SessionRegistryProvider>,
  );
}
