import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { isValidRoomCode, normalizeRoomCode } from '@bgf/protocol';
import {
  createProfile,
  isLocked,
  isUnlocked,
  listProfiles,
  touchProfile,
  useProfilesIndex,
} from '../session/profiles';
import { UnlockPrompt } from '../session/UnlockPrompt';
import { profilePath } from '../session/ProfileProvider';
import { relativeTime } from '../session/time';
import { gamePath } from '../games/GameProvider';
import type { GameId } from '../games/ids';
import { DEFAULT_GAME } from '../games/ids';
import { getGame } from '../games/registry';
import {
  TransferError,
  decodeTransferCode,
  describeImport,
  importFromText,
} from '../session/transfer';
import { identityFromSearch } from '../session/links';
import styles from './PickerScreen.module.css';

/**
 * `#/` — who is playing in this tab? Every other route lives under the chosen player's slug.
 * With `#/<game>/join/:code` (an invite link) the chosen player goes straight to joining that
 * match; the profile-less legacy form `#/join/:code` means backgammon.
 */
export function PickerScreen({ game }: { game?: GameId } = {}) {
  const { code } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const index = useProfilesIndex();
  const profiles = useMemo(() => listProfiles(), [index]); // eslint-disable-line react-hooks/exhaustive-deps
  const joining = code && isValidRoomCode(normalizeRoomCode(code)) ? normalizeRoomCode(code) : null;
  const gameId = game ?? DEFAULT_GAME;
  const gameName = getGame(gameId)?.name ?? gameId;
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Follow-ups an import may need before it can finish.
  const [importPassword, setImportPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);
  const [keyMismatch, setKeyMismatch] = useState(false);
  const [pendingImport, setPendingImport] = useState<string | null>(null);
  // A locked player that was chosen: unlock inline, then continue.
  const [unlocking, setUnlocking] = useState<string | null>(null);

  // A hand-off link (`?import=<identity code>`) names the player: import them and go straight on.
  const autoCode = joining ? identityFromSearch(location.search) : null;
  const autoName = useMemo(() => {
    if (!autoCode) return null;
    try {
      return decodeTransferCode(autoCode).profile.name;
    } catch {
      return null;
    }
  }, [autoCode]);
  const autoStarted = useRef<string | null>(null);

  const go = (slug: string) => {
    touchProfile(slug);
    navigate(joining ? gamePath(slug, gameId, `/join/${joining}`) : profilePath(slug, '/'));
  };

  const choose = (slug: string) => {
    const record = index[slug];
    if (record && isLocked(record) && !isUnlocked(slug)) {
      setUnlocking(slug);
      return;
    }
    go(slug);
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Enter a name');
      return;
    }
    try {
      const entry = createProfile(name);
      choose(entry.slug);
    } catch {
      setError('Could not create that player');
    }
  };

  const runImport = async (
    text: string,
    extra: { password?: string; replaceKey?: boolean } = {},
  ) => {
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const result = await importFromText(text, extra);
      const entry = listProfiles().find((p) => p.slug === result.slug);
      setImportResult(describeImport(result, entry?.name ?? result.slug));
      setNeedPassword(false);
      setKeyMismatch(false);
      setPendingImport(null);
      setImportPassword('');
      go(result.slug);
    } catch (e) {
      if (e instanceof TransferError && e.code === 'password-required') {
        setPendingImport(text);
        setNeedPassword(true);
        setImportOpen(true);
      } else if (e instanceof TransferError && e.code === 'key-mismatch') {
        setPendingImport(text);
        setKeyMismatch(true);
        setImportOpen(true);
      }
      setImportError(e instanceof TransferError ? e.message : 'Could not import that player');
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    if (!autoCode || autoStarted.current === autoCode) return;
    autoStarted.current = autoCode;
    void runImport(autoCode);
    // runImport is recreated every render; the ref guard makes this effectively run-once per code.
  }, [autoCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await runImport(await file.text());
    } catch {
      setImportError('Could not read that file');
    }
  };

  const importPanel = (
    <section className={`card ${styles.newCard}`} data-testid="import-profile-panel">
      <div>
        <h2>Import a player</h2>
        <p className="muted small">
          Bring a player from another browser: pick the file you exported there, or paste a transfer
          code. The player keeps the same identity, so saved matches recognise them. History
          diverges from here on.
        </p>
      </div>
      <div className={styles.newRow}>
        <label className="btn btn-secondary" htmlFor="import-profile-file">
          Choose export file…
        </label>
        <input
          id="import-profile-file"
          type="file"
          accept="application/json,.json"
          className={styles.fileInput}
          onChange={importFile}
          data-testid="import-profile-file"
          aria-label="Player export file"
        />
      </div>
      <textarea
        className="input"
        rows={3}
        placeholder="…or paste a transfer code (p2pg1.…) or the export file's contents"
        value={importText}
        aria-label="Transfer code"
        onChange={(e) => {
          setImportText(e.target.value);
          setImportError(null);
        }}
        data-testid="import-profile-code"
      />
      {needPassword && (
        <label className="field">
          <span className="label">Password for this player</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={importPassword}
            onChange={(e) => setImportPassword(e.target.value)}
            data-testid="import-password"
          />
        </label>
      )}
      <div className={styles.newRow}>
        <button
          className="btn btn-primary"
          type="button"
          disabled={
            importing || (needPassword ? !importPassword : !(pendingImport ?? importText).trim())
          }
          onClick={() =>
            runImport(pendingImport ?? importText, {
              ...(needPassword ? { password: importPassword } : {}),
            })
          }
          data-testid="import-profile-button"
        >
          {joining ? 'Import and join' : 'Import'}
        </button>
        {keyMismatch && pendingImport && (
          <button
            className="btn btn-danger"
            type="button"
            disabled={importing}
            onClick={() =>
              runImport(pendingImport, {
                replaceKey: true,
                ...(importPassword ? { password: importPassword } : {}),
              })
            }
            data-testid="import-replace-key"
          >
            Replace the key stored here
          </button>
        )}
        <button
          className="btn btn-ghost"
          type="button"
          onClick={() => {
            setImportOpen(false);
            setNeedPassword(false);
            setKeyMismatch(false);
            setPendingImport(null);
          }}
        >
          Cancel
        </button>
      </div>
      {importError && (
        <span className="error-text" role="alert" data-testid="import-error">
          {importError}
        </span>
      )}
      {importResult && (
        <span className="small" role="status" data-testid="import-result">
          {importResult}
        </span>
      )}
    </section>
  );

  const form = (
    <form className={`card ${styles.newCard}`} onSubmit={create} data-testid="new-profile-form">
      <div>
        <h2>{profiles.length ? 'New player' : 'Create your player'}</h2>
        <p className="muted small">
          Your name is what your opponent sees. It becomes part of the address, so the browser
          always knows who is playing in this tab.
        </p>
      </div>
      <div className={styles.newRow}>
        <input
          className="input"
          data-testid="new-profile-name"
          placeholder="Your name"
          value={name}
          maxLength={24}
          autoComplete="nickname"
          aria-label="New player name"
          aria-invalid={!!error}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
        <button className="btn btn-primary" type="submit" data-testid="new-profile-button">
          {joining ? 'Create and join' : 'Create'}
        </button>
      </div>
      {error && (
        <span className="error-text" role="alert" data-testid="new-profile-error">
          {error}
        </span>
      )}
    </form>
  );

  return (
    <div className="page page-narrow" data-testid="picker-screen">
      <div className="stack">
        <div className={styles.hero}>
          <div className="eyebrow">Peer-to-peer · no accounts · no servers</div>
          <h1>{joining ? "You're invited" : "Who's playing?"}</h1>
          {joining && autoCode && !importError ? (
            <p className="muted" data-testid="import-auto" role="status">
              Continuing as <strong>{autoName ?? 'you'}</strong> in {gameName} match{' '}
              <code className="mono">{joining}</code>…
            </p>
          ) : joining ? (
            <p className="muted" data-testid="picker-joining">
              Pick who you are and you'll join {gameName} match{' '}
              <code className="mono">{joining}</code>.
            </p>
          ) : (
            <p className="muted">
              Pick a player to continue. Open another player in a second tab to play both sides.
            </p>
          )}
        </div>

        {unlocking && index[unlocking] && (
          <UnlockPrompt
            slug={unlocking}
            name={index[unlocking]!.name}
            avatar={index[unlocking]!.avatar}
            onUnlocked={() => {
              const slug = unlocking;
              setUnlocking(null);
              go(slug);
            }}
            onCancel={() => setUnlocking(null)}
          />
        )}

        {profiles.length === 0 && form}

        {profiles.length > 0 && (
          <div className={styles.list} data-testid="profile-list">
            {profiles.map((p) => (
              <button
                key={p.slug}
                type="button"
                className={`card ${styles.profile}`}
                onClick={() => choose(p.slug)}
                data-testid={`profile-${p.slug}`}
              >
                <span className={styles.avatar} aria-hidden="true">
                  {p.avatar}
                </span>
                <span className={styles.body}>
                  <span className={styles.name}>
                    {p.name}
                    {isLocked(p) && (
                      <span
                        className="badge"
                        data-testid="profile-locked"
                        title="Password protected"
                      >
                        {' '}
                        🔒
                      </span>
                    )}
                  </span>
                  <span className={styles.meta}>
                    <code>#/{p.slug}/</code> · {relativeTime(p.lastUsedAt)}
                  </span>
                </span>
                <span className={styles.go} aria-hidden="true">
                  {joining ? 'Join →' : 'Play →'}
                </span>
              </button>
            ))}
          </div>
        )}

        {profiles.length > 0 && form}

        {autoCode && importError && !importOpen && (
          <span className="error-text" role="alert" data-testid="import-error">
            {importError}
          </span>
        )}

        {importOpen ? (
          importPanel
        ) : (
          <p className="muted small">
            Played on another browser?{' '}
            <button
              type="button"
              className="btn-link"
              onClick={() => setImportOpen(true)}
              data-testid="import-profile-toggle"
            >
              Import a player
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
