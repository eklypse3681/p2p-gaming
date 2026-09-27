import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router';
import { useSettings, resetSettings, DEFAULT_SETTINGS } from '../session/settings';
import { RandomnessControls } from '../hud/RandomnessControls';
import { randomnessFromSettings } from '../session/entropy';
import type { ReducedMotionSetting } from '../session/settings';
import { useProfile } from '../session/ProfileProvider';
import { changePassword, lockProfile, removePassword } from '../session/profiles';
import { SecretsError } from '../session/secrets';
import {
  deleteProfile,
  isPairedDevice,
  listProfiles,
  revocationsUnpublished,
  rotateSyncKey,
} from '../session/profiles';
import { publishRevocations, signOutDevice } from '../session/revocations';
import { canPairDevices } from '../session/pairing';
import { decodeGrant } from '@bgf/wallet';
import { PairOffer } from '../hud/PairOffer';
import { SafetySection } from './SafetySection';
import { downloadJson, exportFileName, exportProfile } from '../session/transfer';
import { restartSync, syncSupported, useSyncStatus } from '../session/sync/registry';
import type { SyncStatus } from '../session/sync/SyncManager';
import { relativeTime } from '../session/time';
import { useTheme } from './ThemeProvider';
import type { Look } from '../themes';
import { GAMES, getGame } from '../games/registry';
import { Switch } from './settingsParts';
import styles from './SettingsScreen.module.css';

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

/**
 * Pairing: on a device holding the player's own key, add another device (it gets its own key and
 * a grant) and see the ones already added. On a paired device, say what it is.
 */
function PairingBlock({ slug }: { slug: string }) {
  const { record } = useProfile();
  const [adding, setAdding] = useState(false);
  if (isPairedDevice(record)) {
    const decoded = record.grant ? decodeGrant(record.grant) : null;
    return (
      <p className="small" data-testid="paired-device-note">
        This device plays as {record.name} with its own key, paired from another of their devices.
        {decoded ? ` It can play and sync until ${formatDate(decoded.grant.expiresAt)}.` : ''}
      </p>
    );
  }
  if (!canPairDevices(slug)) return null;
  return <PairedDevices slug={slug} adding={adding} setAdding={setAdding} />;
}

function PairedDevices({
  slug,
  adding,
  setAdding,
}: {
  slug: string;
  adding: boolean;
  setAdding: (f: (v: boolean) => boolean) => void;
}) {
  const { record } = useProfile();
  const [note, setNote] = useState<string | null>(null);
  const unpublished = revocationsUnpublished(record);
  // A sign-out made while offline reaches the tables the next time this screen is open.
  useEffect(() => {
    if (unpublished) void publishRevocations(slug);
  }, [slug, unpublished]);
  const devices = (record.devices ?? []).filter((d) => !d.revokedAt);
  const signOut = (serial: number, label: string, expiresAt: number) => {
    setNote(null);
    void signOutDevice(slug, serial).then((published) =>
      setNote(
        published
          ? `${label} is signed out. Tables stop letting it in now.`
          : `${label} is signed out here. Tables hear as soon as the list can be published; it stops working by ${formatDate(expiresAt)} regardless.`,
      ),
    );
  };
  return (
    <div className="stack" data-testid="pairing-block">
      <div className={styles.rowField}>
        <div className={styles.rowText}>
          Add a device
          <small>
            Play as {record.name} on your phone or another computer. It makes its own key; yours
            never leaves this device.
          </small>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setAdding((v) => !v)}
          data-testid="add-device"
        >
          {adding ? 'Close' : 'Add a device'}
        </button>
      </div>
      {adding && <PairOffer slug={slug} name={record.name} />}
      {devices.length > 0 && (
        <ul className={styles.deviceList} data-testid="paired-devices">
          {devices.map((d) => (
            <li key={d.serial} className={styles.deviceRow}>
              <span>
                <strong>{d.label}</strong>{' '}
                <span className="muted small">
                  paired {relativeTime(d.pairedAt)} · renews while you use it
                </span>
              </span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => signOut(d.serial, d.label, d.expiresAt)}
                data-testid={`sign-out-${d.serial}`}
              >
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && (
        <p className="small" role="status" data-testid="sign-out-note">
          {note}
        </p>
      )}
    </div>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
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
      <PairingBlock slug={slug} />
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
        key that a device receives only when you approve pairing it, or inside your backup file;
        opponents never see it.
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
              Your other devices stop syncing until you pair them again. Do it if a backup file
              reached someone else.
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
            New sync key in use. Pair your other devices again to reconnect them.
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

/**
 * Settings, split in two: a General tab for everything that applies whatever you play (the app's
 * look, your player, devices, randomness, networking), and one tab per game for what only that game
 * uses. A game gets a tab by giving its definition a `Settings` panel.
 */
export function SettingsScreen() {
  const { game: gameId } = useParams<{ game?: string }>();
  const { slug } = useProfile();
  const game = gameId ? getGame(gameId) : undefined;
  const Panel = game?.Settings;
  const tabs = GAMES.filter((g) => g.Settings);
  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `${styles.tab} ${isActive ? styles.tabActive : ''}`;
  return (
    <div className="page page-narrow" data-testid="settings-screen">
      <div className="stack">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>{Panel && game ? game.name : 'Make it yours'}</h1>
        </div>
        <nav className={styles.tabs} aria-label="Settings sections">
          <NavLink
            to={`/${slug}/settings`}
            end
            className={tabClass}
            data-testid="settings-tab-general"
          >
            General
          </NavLink>
          {tabs.map((g) => (
            <NavLink
              key={g.id}
              to={`/${slug}/settings/${g.id}`}
              className={tabClass}
              data-testid={`settings-tab-${g.id}`}
            >
              <span aria-hidden="true">{g.icon}</span> {g.name}
            </NavLink>
          ))}
        </nav>
        {Panel ? <Panel /> : <GeneralSettings />}
      </div>
    </div>
  );
}

function GeneralSettings() {
  const [settings, update] = useSettings();
  const { looks } = useTheme();
  const { profile, slug, setName, setAvatar, avatars, locked, lockNow } = useProfile();
  const navigate = useNavigate();
  const [confirmRemove, setConfirmRemove] = useState(false);
  // The stored name is never empty, so edit through a draft that may be.
  const [nameDraft, setNameDraft] = useState(profile.name);
  const [transferNote, setTransferNote] = useState<string | null>(null);

  const exportPlayer = async () => {
    try {
      downloadJson(exportFileName(slug), await exportProfile(slug));
      setTransferNote(`Downloaded ${exportFileName(slug)}`);
    } catch {
      setTransferNote('Could not export this player');
    }
  };

  return (
    <>
      <section className={`card ${styles.section}`} data-testid="appearance-general">
        <h2>Appearance</h2>
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
        <div>
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
          <span className="label">Back up this player</span>
          <span className="help">
            Downloads this player with their key, settings and saved matches. Keep the file private:
            whoever has it can restore {profile.name}. To play on another device, pair it under
            Devices instead; it gets its own key.
          </span>
          <div className="row">
            <button
              className="btn btn-secondary btn-sm"
              onClick={exportPlayer}
              data-testid="export-profile"
            >
              Download backup…
            </button>
          </div>
          {transferNote && (
            <span className="small" role="status" data-testid="transfer-note">
              {transferNote}
            </span>
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

      <SafetySection />

      <DevicesSection slug={slug} />

      <section className={`card ${styles.section}`} data-testid="randomness-section">
        <h2>Randomness</h2>
        <p className="muted small">
          Defaults for the tables you host: where dice and shuffles come from, and how each draw is
          tied to the action so every seat can check it later. The host screen lets you change them
          for one table. Guests see the table’s choice in the Fairness panel.
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
    </>
  );
}
