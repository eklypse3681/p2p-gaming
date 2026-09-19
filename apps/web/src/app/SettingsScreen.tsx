import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSettings, resetSettings, DEFAULT_SETTINGS } from '../session/settings';
import { RandomnessControls } from '../hud/RandomnessControls';
import { randomnessFromSettings } from '../session/entropy';
import type { HomeSidePreference, ReducedMotionSetting } from '../session/settings';
import { useProfile } from '../session/ProfileProvider';
import { changePassword, lockProfile, removePassword } from '../session/profiles';
import { SecretsError } from '../session/secrets';
import { deleteProfile, listProfiles, rotateSyncKey } from '../session/profiles';
import { downloadJson, exportFileName, exportProfile, transferCodeFor } from '../session/transfer';
import { restartSync, syncSupported, useSyncStatus } from '../session/sync/registry';
import type { SyncStatus } from '../session/sync/SyncManager';
import { relativeTime } from '../session/time';
import { useTheme } from './ThemeProvider';
import type { BoardSet, PieceSet } from '../themes/theme';
import type { Look } from '../themes';
import type { HomeSide } from '../board/contract';
import styles from './SettingsScreen.module.css';

/** Tiny schematic board: two felts, a bar, and the tray on the chosen side, with the 1-point marked. */
function HomeSidePreview({ side }: { side: HomeSide }) {
  const mirror = side === 'left';
  const x = (v: number) => (mirror ? 120 - v : v);
  const rect = (rx: number, w: number) => (mirror ? 120 - rx - w : rx);
  const tri = (cx: number, top: boolean, dark: boolean) => (
    <path
      key={`${cx}-${top}`}
      d={
        top
          ? `M ${x(cx) - 5} 6 L ${x(cx) + 5} 6 L ${x(cx)} 26 Z`
          : `M ${x(cx) - 5} 54 L ${x(cx) + 5} 54 L ${x(cx)} 34 Z`
      }
      fill={dark ? 'var(--ui-text-muted)' : 'var(--ui-accent)'}
      opacity={dark ? 0.45 : 0.8}
    />
  );
  const cols = [15, 26, 37, 48, 59, 70].map((c) => c - 4); // outer felt columns (canonical left)
  const home = [79, 90, 101, 112, 123, 134].map((c) => c - 22); // home felt columns (canonical right)
  return (
    <svg viewBox="0 0 120 60" className={styles.sidePreview} aria-hidden="true">
      <rect x={0} y={0} width={120} height={60} rx={5} fill="var(--ui-surface-raised)" />
      <rect x={rect(6, 60)} y={4} width={60} height={52} fill="var(--ui-bg)" opacity={0.7} />
      <rect x={rect(66, 7)} y={4} width={7} height={52} fill="var(--ui-border)" />
      <rect x={rect(73, 36)} y={4} width={36} height={52} fill="var(--ui-bg)" opacity={0.7} />
      <rect x={rect(111, 6)} y={4} width={6} height={52} fill="var(--ui-border)" opacity={0.7} />
      {cols.map((c, i) => tri(c, false, i % 2 === 0))}
      {cols.map((c, i) => tri(c, true, i % 2 === 1))}
      {home.map((c, i) => tri(c, false, i % 2 === 1))}
      {home.map((c, i) => tri(c, true, i % 2 === 0))}
      <circle cx={x(106)} cy={49} r={4.5} fill="var(--ui-accent)" />
      <text
        x={x(106)}
        y={49}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={6.5}
        fontWeight={800}
        fill="var(--ui-accent-text)"
      >
        1
      </text>
    </svg>
  );
}

/** Two chairs at one table: the same board seen from both sides. */
function TablePreview() {
  return (
    <svg viewBox="0 0 120 60" className={styles.sidePreview} aria-hidden="true">
      <rect x={0} y={0} width={120} height={60} rx={5} fill="var(--ui-surface-raised)" />
      <rect x={14} y={12} width={92} height={36} rx={3} fill="var(--ui-bg)" opacity={0.7} />
      <rect x={57} y={12} width={6} height={36} fill="var(--ui-border)" />
      <circle cx={22} cy={42} r={4.5} fill="var(--ui-accent)" />
      <text
        x={22}
        y={42}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={6.5}
        fontWeight={800}
        fill="var(--ui-accent-text)"
      >
        1
      </text>
      <circle cx={98} cy={18} r={4.5} fill="var(--ui-text-muted)" />
      <text
        x={98}
        y={18}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={6.5}
        fontWeight={800}
        fill="var(--ui-bg)"
      >
        1
      </text>
      <text x={60} y={55} textAnchor="middle" fontSize={6} fill="var(--ui-text-muted)">
        you
      </text>
      <text x={60} y={8} textAnchor="middle" fontSize={6} fill="var(--ui-text-muted)">
        opponent
      </text>
    </svg>
  );
}

function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`${styles.switch} ${on ? styles.switchOn : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

/** App chrome in miniature: background, a surface card, text lines and the accent button. */
function LookSwatch({ look }: { look: Look }) {
  const u = look.ui;
  return (
    <svg viewBox="0 0 120 64" className={styles.previewSvg} aria-hidden="true">
      <rect x={0} y={0} width={120} height={64} rx={6} fill={u.bg} />
      <rect x={0} y={0} width={120} height={14} fill={u.surface} />
      <rect x={8} y={4} width={22} height={6} rx={3} fill={u.text} opacity={0.85} />
      <rect x={96} y={3} width={16} height={8} rx={4} fill={u.accent} />
      <rect x={8} y={22} width={104} height={34} rx={5} fill={u.surfaceRaised} stroke={u.border} />
      <rect x={16} y={30} width={48} height={5} rx={2.5} fill={u.text} />
      <rect x={16} y={39} width={72} height={4} rx={2} fill={u.textMuted} />
      <rect x={72} y={46} width={32} height={8} rx={4} fill={u.accent} />
      <rect x={16} y={47} width={14} height={6} rx={3} fill={u.success} opacity={0.9} />
      <rect x={34} y={47} width={14} height={6} rx={3} fill={u.danger} opacity={0.9} />
    </svg>
  );
}

/** Frame, felt, a few points on each side of the bar, and a die. */
function BoardSwatch({ board }: { board: BoardSet }) {
  const cols = [10, 24, 38, 66, 80, 94];
  return (
    <svg viewBox="0 0 120 64" className={styles.previewSvg} aria-hidden="true">
      <rect x={0} y={0} width={120} height={64} rx={6} fill={board.frame} />
      <rect x={0} y={0} width={120} height={64} rx={6} fill="none" stroke={board.frameEdge} />
      <rect x={6} y={6} width={44} height={52} fill={board.felt} />
      <rect x={50} y={6} width={8} height={52} fill={board.bar} />
      <rect x={58} y={6} width={44} height={52} fill={board.felt} />
      <rect x={106} y={6} width={8} height={52} fill={board.tray} />
      {cols.map((cx, i) => (
        <path
          key={`t${cx}`}
          d={`M ${cx} 6 L ${cx + 12} 6 L ${cx + 6} 30 Z`}
          fill={i % 2 === 0 ? board.pointA : board.pointB}
          stroke={board.pointEdge}
          strokeWidth={0.5}
        />
      ))}
      {cols.map((cx, i) => (
        <path
          key={`b${cx}`}
          d={`M ${cx} 58 L ${cx + 12} 58 L ${cx + 6} 34 Z`}
          fill={i % 2 === 1 ? board.pointA : board.pointB}
          stroke={board.pointEdge}
          strokeWidth={0.5}
        />
      ))}
      <rect x={74} y={26} width={12} height={12} rx={2.5} fill={board.diceFace} />
      <circle cx={80} cy={32} r={1.6} fill={board.dicePip} />
      <rect x={52} y={27} width={4} height={10} rx={1} fill={board.cubeFace} opacity={0.9} />
    </svg>
  );
}

/** One checker of each colour with rim and sheen, on a neutral ground. */
function PiecesSwatch({ pieces }: { pieces: PieceSet }) {
  const checker = (cx: number, c: PieceSet['white']) => (
    <g key={cx}>
      <circle cx={cx} cy={34} r={19} fill="rgba(0,0,0,0.25)" transform="translate(1.5 2)" />
      <circle cx={cx} cy={32} r={19} fill={c.edge} />
      <circle cx={cx} cy={32} r={16} fill={c.fill} />
      <ellipse cx={cx - 5} cy={25} rx={6} ry={3.5} fill={c.sheen} opacity={0.75} />
      <text
        x={cx}
        y={33}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={11}
        fontWeight={800}
        fill={c.label}
      >
        5
      </text>
    </g>
  );
  return (
    <svg viewBox="0 0 120 64" className={styles.previewSvg} aria-hidden="true">
      <rect x={0} y={0} width={120} height={64} rx={6} fill="var(--board-felt, #2b3a4a)" />
      {checker(38, pieces.white)}
      {checker(82, pieces.black)}
    </svg>
  );
}

/** One line about the sync state, for the Devices section. */
export function describeSyncStatus(status: SyncStatus, enabled: boolean): string {
  if (!enabled) return 'Off — this player only lives in this browser.';
  const n = status.devices.length;
  const names = status.devices.map((d) => d.label).join(', ');
  switch (status.state) {
    case 'off':
      return status.reason ? `Unavailable: ${status.reason}` : 'Off';
    case 'searching':
      return 'Looking for your other devices…';
    case 'error':
      return `Trouble connecting${status.lastError ? `: ${status.lastError}` : ''} — retrying`;
    case 'hub':
      return n
        ? `This device is the hub for ${n} device${n === 1 ? '' : 's'}: ${names}`
        : 'Ready — this device is the hub; nothing else is online right now.';
    case 'connected':
      return n ? `Connected to ${n} device${n === 1 ? '' : 's'}: ${names}` : 'Connected';
  }
}

function DevicesSection({ slug }: { slug: string }) {
  const [settings, update] = useSettings(slug);
  const status = useSyncStatus(slug);
  const support = syncSupported();
  const { locked } = useProfile();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotatePassword, setRotatePassword] = useState('');
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotated, setRotated] = useState(false);
  const enabled = settings.sync !== false;
  return (
    <section className={`card ${styles.section}`} data-testid="sync-section">
      <h2>Devices</h2>
      <div className={styles.rowField}>
        <div className={styles.rowText}>
          Sync between my devices
          <small>
            Settings and saved matches follow you to every browser that holds this player.
          </small>
        </div>
        <Switch
          on={enabled}
          onChange={(v) => update({ sync: v })}
          label="Sync between my devices"
        />
      </div>
      <p className="small" role="status" data-testid="sync-status" data-state={status.state}>
        {describeSyncStatus(status, enabled)}
        {enabled && status.lastSyncAt ? ` · last change ${relativeTime(status.lastSyncAt)}` : ''}
      </p>
      {!support.ok && enabled && <p className="muted small">{support.reason}</p>}
      <p className="muted small">
        Sync happens whenever the app is open on this player on both devices, directly between them
        over WebRTC — nothing is uploaded anywhere. Devices recognise each other with a secret sync
        key that travels only inside your export file, transfer code and hand-off QR; opponents
        never see it.
      </p>
      <div className="row">
        {!confirmRotate ? (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setConfirmRotate(true)}
            data-testid="rotate-sync-key"
          >
            Rotate sync key
          </button>
        ) : (
          <>
            <span className="small">
              Your other devices stop syncing until they import a fresh code from this one. Do it if
              a QR or transfer code was seen by someone else.
            </span>
            {locked && (
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                placeholder="Password"
                aria-label="Password"
                value={rotatePassword}
                onChange={(e) => setRotatePassword(e.target.value)}
                data-testid="rotate-password"
              />
            )}
            <button
              className="btn btn-danger btn-sm"
              disabled={locked && !rotatePassword}
              onClick={() => {
                setRotateError(null);
                rotateSyncKey(slug, locked ? { password: rotatePassword } : {})
                  .then(() => {
                    restartSync(slug);
                    setConfirmRotate(false);
                    setRotatePassword('');
                    setRotated(true);
                  })
                  .catch((e: unknown) => {
                    setRotateError(
                      e instanceof SecretsError ? e.message : 'Could not rotate the sync key',
                    );
                  });
              }}
              data-testid="rotate-sync-key-confirm"
            >
              Yes, rotate
            </button>
            {rotateError && (
              <span className="error-text" role="alert" data-testid="rotate-error">
                {rotateError}
              </span>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRotate(false)}>
              Cancel
            </button>
          </>
        )}
        {rotated && (
          <span className="small" role="status" data-testid="rotate-note">
            New sync key in use. Re-export or re-share a code to reconnect other devices.
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * Optional password lock. When set, the player's private key and sync key are stored encrypted
 * and every tab must enter the password before playing as them.
 */
function PasswordSection({
  slug,
  locked,
  onLockNow,
}: {
  slug: string;
  locked: boolean;
  onLockNow: () => void;
}) {
  const [mode, setMode] = useState<'idle' | 'set' | 'change' | 'remove'>('idle');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode('idle');
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
  };

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      setNote(await work());
      reset();
    } catch (e) {
      setError(e instanceof SecretsError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const passwordsMatch = next.length > 0 && next === confirm;

  return (
    <div className="field" data-testid="password-section">
      <span className="label">Password</span>
      <span className="help">
        {locked
          ? 'This player is password protected: every tab must unlock it before playing, and exports carry the encrypted keys.'
          : 'Optional. Encrypts this player’s keys in the browser so nobody at this computer can play as you, export you, or hand you off without the password.'}
      </span>
      {mode === 'idle' && (
        <div className="row">
          {locked ? (
            <>
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={() => setMode('change')}
                data-testid="change-password"
              >
                Change password
              </button>
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={() => setMode('remove')}
                data-testid="remove-password"
              >
                Remove password
              </button>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={onLockNow}
                data-testid="lock-now"
              >
                Lock now
              </button>
            </>
          ) : (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => setMode('set')}
              data-testid="set-password"
            >
              Set a password…
            </button>
          )}
        </div>
      )}
      {mode !== 'idle' && (
        <form
          className="stack"
          data-testid="password-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === 'set') {
              if (!passwordsMatch) {
                setError('The passwords do not match');
                return;
              }
              void run(async () => {
                await lockProfile(slug, next);
                return 'Password set. Other tabs and devices will ask for it.';
              });
            } else if (mode === 'change') {
              if (!passwordsMatch) {
                setError('The new passwords do not match');
                return;
              }
              void run(async () => {
                await changePassword(slug, current, next);
                return 'Password changed.';
              });
            } else {
              void run(async () => {
                await removePassword(slug, current);
                return 'Password removed; keys are stored in the clear again.';
              });
            }
          }}
        >
          {mode !== 'set' && (
            <label className="field">
              <span className="label">Current password</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                data-testid="password-current"
              />
            </label>
          )}
          {mode !== 'remove' && (
            <>
              <label className="field">
                <span className="label">{mode === 'change' ? 'New password' : 'Password'}</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  data-testid="password-input"
                />
              </label>
              <label className="field">
                <span className="label">Repeat it</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  data-testid="password-confirm"
                />
              </label>
            </>
          )}
          <div className="row">
            <button
              className={`btn btn-sm ${mode === 'remove' ? 'btn-danger' : 'btn-primary'}`}
              type="submit"
              disabled={busy}
              data-testid="password-submit"
            >
              {mode === 'set'
                ? 'Set password'
                : mode === 'change'
                  ? 'Change password'
                  : 'Remove password'}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={reset}>
              Cancel
            </button>
          </div>
          {error && (
            <span className="error-text" role="alert" data-testid="password-error">
              {error}
            </span>
          )}
        </form>
      )}
      {note && (
        <span className="small" role="status" data-testid="password-note">
          {note}
        </span>
      )}
    </div>
  );
}

export function SettingsScreen() {
  const [settings, update] = useSettings();
  const { theme, presets, looks, boardSets, pieceSets, applyPreset } = useTheme();
  const { profile, slug, setName, setAvatar, avatars, locked, lockNow } = useProfile();
  const navigate = useNavigate();
  const [confirmRemove, setConfirmRemove] = useState(false);
  // The stored name is never empty, so edit through a draft that may be.
  const [nameDraft, setNameDraft] = useState(profile.name);
  const [transferCode, setTransferCode] = useState<string | null>(null);
  const [transferNote, setTransferNote] = useState<string | null>(null);

  const exportPlayer = async () => {
    try {
      downloadJson(exportFileName(slug), await exportProfile(slug));
      setTransferNote(`Downloaded ${exportFileName(slug)}`);
    } catch {
      setTransferNote('Could not export this player');
    }
  };

  const copyTransferCode = async () => {
    let code: string;
    try {
      code = transferCodeFor(slug);
    } catch {
      setTransferNote('Unlock this player first');
      return;
    }
    setTransferCode(code);
    try {
      await navigator.clipboard.writeText(code);
      setTransferNote('Transfer code copied to the clipboard');
    } catch {
      setTransferNote('Copy the code below');
    }
  };

  return (
    <div className="page page-narrow" data-testid="settings-screen">
      <div className="stack">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Make it yours</h1>
        </div>

        <section className={`card ${styles.section}`} data-testid="appearance">
          <h2>Appearance</h2>
          <div className={styles.rowText}>
            Presets
            <small>Named combinations to start from; mix and match below.</small>
          </div>
          <div className={styles.presets} data-testid="theme-picker">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`${styles.presetChip} ${p.id === theme.id ? styles.presetActive : ''}`}
                onClick={() => applyPreset(p.id)}
                data-testid={`preset-${p.id}`}
                aria-pressed={p.id === theme.id}
              >
                {p.name}
              </button>
            ))}
          </div>

          <div className={styles.rowText}>
            Look
            <small>The app around the board: light or dark, and its accent.</small>
          </div>
          <div className={styles.themes} role="radiogroup" aria-label="Look">
            {looks.map((l) => (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={settings.look === l.id}
                className={`${styles.themeCard} ${settings.look === l.id ? styles.themeActive : ''}`}
                onClick={() => update({ look: l.id })}
                data-testid={`look-${l.id}`}
              >
                <LookSwatch look={l} />
                <span className={styles.themeName}>
                  {l.name}
                  <span className="badge">{l.mode}</span>
                </span>
              </button>
            ))}
          </div>

          <div className={styles.rowText}>
            Board
            <small>Frame, felt and points.</small>
          </div>
          <div className={styles.themes} role="radiogroup" aria-label="Board set">
            {boardSets.map((b) => (
              <button
                key={b.id}
                type="button"
                role="radio"
                aria-checked={settings.boardSet === b.id}
                className={`${styles.themeCard} ${settings.boardSet === b.id ? styles.themeActive : ''}`}
                onClick={() => update({ boardSet: b.id })}
                data-testid={`board-${b.id}`}
              >
                <BoardSwatch board={b} />
                <span className={styles.themeName}>{b.name}</span>
              </button>
            ))}
          </div>

          <div className={styles.rowText}>
            Pieces
            <small>The two checker styles, shown on your current felt.</small>
          </div>
          <div className={styles.themes} role="radiogroup" aria-label="Piece set">
            {pieceSets.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={settings.pieceSet === p.id}
                className={`${styles.themeCard} ${settings.pieceSet === p.id ? styles.themeActive : ''}`}
                onClick={() => update({ pieceSet: p.id })}
                data-testid={`pieces-${p.id}`}
              >
                <PiecesSwatch pieces={p} />
                <span className={styles.themeName}>{p.name}</span>
              </button>
            ))}
          </div>
        </section>

        <section className={`card ${styles.section}`}>
          <h2>Board</h2>
          <div className={styles.rowText}>
            Home board side
            <small>
              Each match has one table layout, chosen by the host; the player across the table sees
              the mirror image, like a real board. "Follow the table" shows it that way. Force a
              side if you always want your home board on the same side.
            </small>
          </div>
          <div className={styles.sides} role="radiogroup" aria-label="Home board side">
            {(
              [
                ['table', 'Follow the table', 'as the host laid it out'],
                ['left', 'Always left', '1 bottom-left · 24 top-left'],
                ['right', 'Always right', '1 bottom-right · 24 top-right'],
              ] as const
            ).map(([pref, label, hint]) => (
              <button
                key={pref}
                type="button"
                role="radio"
                aria-checked={settings.homeSidePreference === pref}
                className={`${styles.sideCard} ${settings.homeSidePreference === pref ? styles.sideActive : ''}`}
                onClick={() => update({ homeSidePreference: pref as HomeSidePreference })}
                data-testid={`home-side-${pref}`}
              >
                {pref === 'table' ? <TablePreview /> : <HomeSidePreview side={pref} />}
                <span className={styles.sideLabel}>
                  {label}
                  <small>{hint}</small>
                </span>
              </button>
            ))}
          </div>
          <div>
            <div className={styles.rowField}>
              <div className={styles.rowText}>
                Renderer
                <small>3D is on the roadmap; the same board model will drive it.</small>
              </div>
              <select
                className="select"
                style={{ width: 'auto' }}
                value={settings.rendererId}
                onChange={(e) => update({ rendererId: e.target.value as 'svg2d' | '3d' })}
                data-testid="renderer-select"
              >
                <option value="svg2d">2D (SVG)</option>
                <option value="3d" disabled>
                  3D — coming soon
                </option>
              </select>
            </div>
            <div className={styles.rowField}>
              <div className={styles.rowText}>
                Flip board
                <small>View the table from the opponent's side.</small>
              </div>
              <Switch
                on={settings.flipBoard}
                onChange={(v) => update({ flipBoard: v })}
                label="Flip board"
              />
            </div>
            <div className={styles.rowField}>
              <div className={styles.rowText}>
                Reduced motion
                <small>Skip checker and dice animations.</small>
              </div>
              <select
                className="select"
                style={{ width: 'auto' }}
                value={settings.reducedMotion}
                onChange={(e) => update({ reducedMotion: e.target.value as ReducedMotionSetting })}
                data-testid="reduced-motion-select"
              >
                <option value="system">Follow system</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
            <div className={styles.rowField}>
              <div className={styles.rowText}>
                Sound
                <small>Dice and checker sounds (not yet implemented).</small>
              </div>
              <Switch on={settings.sound} onChange={(v) => update({ sound: v })} label="Sound" />
            </div>
          </div>
        </section>

        <section className={`card ${styles.section}`} data-testid="profile-section">
          <h2>Player</h2>
          <p className="muted small">
            This tab plays as <code>#/{slug}/</code>. Settings and saved matches on this page belong
            to this player only. <Link to="/">Switch player</Link>
          </p>
          <div className="field">
            <label className="label" htmlFor="settings-name">
              Display name
            </label>
            <input
              id="settings-name"
              className="input"
              data-testid="player-name-input"
              value={nameDraft}
              onChange={(e) => {
                setNameDraft(e.target.value);
                setName(e.target.value);
              }}
              onBlur={() => {
                if (!nameDraft.trim()) setNameDraft(profile.name);
              }}
              maxLength={24}
            />
            <span className="help">
              Your id: <code>{profile.id.slice(0, 8)}…</code> — opponents recognise you by it when
              resuming.
            </span>
          </div>
          <div className="field">
            <span className="label">Avatar</span>
            <div className="row" role="radiogroup" aria-label="Avatar" data-testid="avatar-picker">
              {avatars.map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={profile.avatar === a}
                  className={`btn btn-icon ${profile.avatar === a ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setAvatar(a)}
                  data-testid={`avatar-${a}`}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
          <div className="field" data-testid="transfer-section">
            <span className="label">Move to another browser</span>
            <span className="help">
              Export downloads this player with their settings and saved matches; a transfer code
              carries just the identity and settings and is short enough to paste. Import it from
              the player picker on the other browser. From then on the two copies keep separate
              histories.
            </span>
            <div className="row">
              <button
                className="btn btn-secondary btn-sm"
                onClick={exportPlayer}
                data-testid="export-profile"
              >
                Export player…
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={copyTransferCode}
                data-testid="copy-transfer-code"
              >
                Copy transfer code
              </button>
            </div>
            {transferNote && (
              <span className="small" role="status" data-testid="transfer-note">
                {transferNote}
              </span>
            )}
            {transferCode && (
              <textarea
                className="input"
                readOnly
                rows={3}
                value={transferCode}
                aria-label="Transfer code"
                data-testid="transfer-code"
                onFocus={(e) => e.currentTarget.select()}
              />
            )}
          </div>
          <PasswordSection slug={slug} locked={locked} onLockNow={lockNow} />
          <div className="row">
            {!confirmRemove ? (
              <button
                className="btn btn-danger btn-sm"
                onClick={() => setConfirmRemove(true)}
                data-testid="remove-profile"
              >
                Remove this player from this browser
              </button>
            ) : (
              <>
                <span className="small">
                  Removes {profile.name}'s settings from the player list. Saved matches are kept in
                  the browser but no longer shown.
                </span>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => {
                    deleteProfile(slug);
                    setConfirmRemove(false);
                    navigate('/');
                  }}
                  data-testid="remove-profile-confirm"
                  disabled={listProfiles().length === 0}
                >
                  Yes, remove
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRemove(false)}>
                  Cancel
                </button>
              </>
            )}
          </div>
        </section>

        <DevicesSection slug={slug} />

        <section className={`card ${styles.section}`} data-testid="randomness-section">
          <h2>Randomness</h2>
          <p className="muted small">
            Defaults for the tables you host: where dice and shuffles come from, and how each draw
            is tied to the action so every seat can check it later. The host screen lets you change
            them for one table. Guests see the table’s choice in the Fairness panel.
          </p>
          <RandomnessControls
            value={randomnessFromSettings(settings)}
            onChange={(c) =>
              update({
                entropySource: c.source,
                randomnessMode: c.mode,
                randomOrgKey: c.randomOrgKey,
                entropyFallback: c.fallback,
              })
            }
          />
        </section>

        <section className={`card ${styles.section}`}>
          <h2>Networking</h2>
          <p className="muted small">
            By default signalling uses the free PeerJS cloud and Google STUN. Fill these in to use
            your own PeerServer, or add TURN servers if connections fail behind strict NATs.
          </p>
          <div className={styles.peerGrid}>
            <div className="field">
              <label className="label" htmlFor="peer-host">
                PeerServer host
              </label>
              <input
                id="peer-host"
                className="input"
                placeholder="(free cloud)"
                value={settings.peer.host}
                onChange={(e) => update({ peer: { ...settings.peer, host: e.target.value } })}
                data-testid="peer-host"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="peer-port">
                Port
              </label>
              <input
                id="peer-port"
                className="input"
                placeholder="443"
                value={settings.peer.port}
                onChange={(e) => update({ peer: { ...settings.peer, port: e.target.value } })}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="peer-path">
                Path
              </label>
              <input
                id="peer-path"
                className="input"
                placeholder="/"
                value={settings.peer.path}
                onChange={(e) => update({ peer: { ...settings.peer, path: e.target.value } })}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="peer-key">
                Key
              </label>
              <input
                id="peer-key"
                className="input"
                placeholder="peerjs"
                value={settings.peer.key}
                onChange={(e) => update({ peer: { ...settings.peer, key: e.target.value } })}
              />
            </div>
          </div>
          <div className={styles.rowField}>
            <div className={styles.rowText}>
              Secure (wss)
              <small>Use TLS for the signalling connection.</small>
            </div>
            <Switch
              on={settings.peer.secure}
              onChange={(v) => update({ peer: { ...settings.peer, secure: v } })}
              label="Secure signalling"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="ice-servers">
              Extra ICE servers
            </label>
            <textarea
              id="ice-servers"
              className="textarea"
              placeholder={
                'stun:stun.example.com:3478\nturn:turn.example.com:3478|username|credential'
              }
              value={settings.iceServers}
              onChange={(e) => update({ iceServers: e.target.value })}
              data-testid="ice-servers"
            />
            <span className="help">One per line. TURN entries: url|username|credential.</span>
          </div>
          <div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => update({ peer: DEFAULT_SETTINGS.peer, iceServers: '' })}
            >
              Use free cloud defaults
            </button>
          </div>
        </section>

        <div className="row">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => resetSettings(slug)}
            data-testid="reset-settings"
          >
            Reset all settings
          </button>
          <a className="btn btn-ghost btn-sm" href="#/demo">
            Board demo
          </a>
        </div>
      </div>
    </div>
  );
}
