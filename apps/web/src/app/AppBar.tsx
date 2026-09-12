import { NavLink } from 'react-router';
import { useOptionalProfile } from '../session/ProfileProvider';
import { routesFor, useRouteGameId } from '../games/GameProvider';
import { DEFAULT_GAME } from '../games/ids';
import { getGame } from '../games/registry';
import { useTheme } from './ThemeProvider';
import styles from './AppBar.module.css';

function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="var(--ui-surface-raised)" />
      <polygon points="8,8 20,8 14,40" fill="var(--ui-accent)" />
      <polygon points="22,8 34,8 28,40" fill="var(--ui-text-muted)" />
      <polygon points="36,8 48,8 42,40" fill="var(--ui-accent)" />
      <circle cx="14" cy="50" r="6" fill="#f3ecd8" />
      <circle cx="28" cy="50" r="6" fill="#2a2d38" stroke="#f3ecd8" strokeWidth="1.5" />
      <circle cx="42" cy="50" r="6" fill="#f3ecd8" />
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
  const cls = ({ isActive }: { isActive: boolean }) =>
    `${styles.link} ${isActive ? styles.active : ''}`;
  return (
    <header
      className={styles.bar}
      data-testid="app-bar"
      data-profile={ctx?.slug ?? ''}
      data-game={game?.id ?? ''}
    >
      <NavLink to={ctx ? ctx.path('/') : '/'} className={styles.logo}>
        <Logo />
        <span>P2P Gaming</span>
      </NavLink>
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
            <NavLink to={ctx.path('/settings')} className={cls} data-testid="nav-settings">
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
          </NavLink>
          <NavLink
            to="/"
            className="btn btn-ghost btn-sm"
            data-testid="switch-player"
            title="Switch player"
          >
            Switch
          </NavLink>
        </>
      ) : null}
    </header>
  );
}
