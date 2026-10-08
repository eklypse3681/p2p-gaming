import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useOptionalProfile } from '../session/ProfileProvider';
import { routesFor, useRouteGameId } from '../games/GameProvider';
import { DEFAULT_GAME } from '../games/ids';
import { getGame } from '../games/registry';
import { useTheme } from './ThemeProvider';
import { useSyncStatus } from '../session/sync/registry';
import styles from './AppBar.module.css';

/** Small dot on the player chip: green while this player's other devices are connected. */
function SyncDot({ slug }: { slug: string }) {
  const status = useSyncStatus(slug);
  const live = status.state === 'hub' || status.state === 'connected';
  const n = status.devices.length;
  const title =
    status.state === 'off'
      ? `Device sync off${status.reason ? `: ${status.reason}` : ''}`
      : n
        ? `Synced with ${n} other device${n === 1 ? '' : 's'}`
        : status.state === 'error'
          ? `Device sync: ${status.lastError ?? 'error'}`
          : 'Looking for your other devices';
  return (
    <span
      className={`${styles.syncDot} ${live && n ? styles.syncLive : ''}`}
      data-testid="sync-dot"
      data-state={status.state}
      data-devices={n}
      title={title}
      aria-label={title}
    />
  );
}

/** A table seen from above with four friends around it: the brand, whatever the game. */
function Logo() {
  const seats = [
    [13, 13],
    [51, 13],
    [13, 51],
    [51, 51],
  ];
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="var(--ui-surface-raised)" />
      {seats.map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="7" fill="var(--ui-text)" />
      ))}
      <circle cx="32" cy="32" r="16" fill="var(--ui-accent)" />
      <circle
        cx="32"
        cy="32"
        r="9"
        fill="none"
        stroke="var(--ui-surface-raised)"
        strokeWidth="2.5"
      />
    </svg>
  );
}

export function AppBar() {
  const ctx = useOptionalProfile();
  const gameId = useRouteGameId();
  const gameDef = gameId ? getGame(gameId) : undefined;
  const game =
    ctx && gameId && gameDef
      ? { id: gameId, def: gameDef, routes: routesFor(ctx.slug, gameId) }
      : null;
  const { theme, toggleMode } = useTheme();
  // Phones: the links, theme and player live in a side panel behind a menu button.
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const [seenPath, setSeenPath] = useState(location.pathname);
  if (seenPath !== location.pathname) {
    // Navigating (from the panel or anywhere) closes it.
    setSeenPath(location.pathname);
    setMenuOpen(false);
  }
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  const cls = ({ isActive }: { isActive: boolean }) =>
    `${styles.link} ${isActive ? styles.active : ''}`;
  return (
    <header
      className={styles.bar}
      data-appbar
      data-testid="app-bar"
      data-profile={ctx?.slug ?? ''}
      data-game={game?.id ?? ''}
      data-menu-open={menuOpen ? 'true' : 'false'}
    >
      <button
        className={`btn btn-ghost btn-icon btn-sm ${styles.menuButton}`}
        onClick={() => setMenuOpen((v) => !v)}
        aria-label={menuOpen ? 'Close menu' : 'Menu'}
        aria-expanded={menuOpen}
        aria-controls="app-menu"
        data-testid="menu-button"
      >
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
          <path
            d={menuOpen ? 'M5 5l10 10M15 5 5 15' : 'M3 5.5h14M3 10h14M3 14.5h14'}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <NavLink to={ctx ? ctx.path('/') : '/'} className={styles.logo}>
        <Logo />
        <span>Among Friends</span>
      </NavLink>
      {menuOpen && (
        <div
          className={styles.scrim}
          onClick={() => setMenuOpen(false)}
          data-testid="menu-scrim"
          aria-hidden="true"
        />
      )}
      {/* On wide screens this is just the rest of the bar; on phones, the side panel. */}
      <div
        className={`${styles.panel} ${menuOpen ? styles.panelOpen : ''}`}
        id="app-menu"
        data-testid="app-menu"
      >
        <nav className={styles.nav} aria-label="Primary">
          {ctx ? (
            <>
              <NavLink to={ctx.path('/')} end className={cls} data-testid="nav-games">
                Games
              </NavLink>
              {game && (
                <>
                  <NavLink
                    to={game.routes.home}
                    end
                    className={`${styles.link} ${styles.crumb}`}
                    data-testid="nav-game"
                    title={`${game.def.name} home`}
                  >
                    <span aria-hidden="true">{game.def.icon}</span> {game.def.name}
                  </NavLink>
                  <NavLink to={game.routes.history} className={cls} data-testid="nav-history">
                    History
                  </NavLink>
                </>
              )}
              <NavLink to={ctx.path('/clubs')} className={cls} data-testid="nav-clubs">
                Clubs
              </NavLink>
              <NavLink
                to={ctx.path(game?.def.Settings ? `/settings/${game.id}` : '/settings')}
                className={cls}
                data-testid="nav-settings"
              >
                Settings
              </NavLink>
            </>
          ) : (
            <NavLink to={`/${DEFAULT_GAME}/demo`} className={cls}>
              Board demo
            </NavLink>
          )}
        </nav>
        <span className={styles.spacer} />
        <button
          className="btn btn-ghost btn-icon btn-sm"
          onClick={toggleMode}
          title={`${theme.name} — switch to ${theme.mode === 'dark' ? 'light' : 'dark'} look`}
          aria-label="Switch theme"
          data-testid="theme-toggle"
        >
          {theme.mode === 'dark' ? '🌙' : '☀️'}
          <span className={styles.panelOnly}>
            {theme.mode === 'dark' ? 'Light look' : 'Dark look'}
          </span>
        </button>
        {ctx ? (
          <>
            <NavLink
              to={ctx.path('/settings')}
              className={styles.chip}
              data-testid="profile-chip"
              title={`Playing as ${ctx.profile.name} (#/${ctx.slug}/) — profile & settings`}
            >
              <span className={styles.chipAvatar} aria-hidden="true">
                {ctx.profile.avatar ?? '🎲'}
              </span>
              <span className={styles.chipName}>{ctx.profile.name}</span>
              <SyncDot slug={ctx.slug} />
            </NavLink>
            <NavLink
              to="/"
              className="btn btn-ghost btn-sm"
              data-testid="switch-player"
              title="Switch player"
            >
              Switch<span className={styles.panelOnly}>&nbsp;player</span>
            </NavLink>
          </>
        ) : null}
      </div>
    </header>
  );
}
