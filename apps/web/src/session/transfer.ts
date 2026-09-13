import type { MatchSnapshot } from '@bgf/protocol';
import type { Settings } from './settings';
import { DEFAULT_SETTINGS, getSettings, sanitizeSettings, updateSettings } from './settings';
import { getMatchStore } from './matchStore';
import {
  createProfile,
  getProfilesIndex,
  pickAvatar,
  sanitizeName,
  setProfileSyncKey,
  touchProfile,
  updateProfile,
} from './profiles';

export { sanitizeSettings };
import type { GameId } from '../games/ids';
import { GAME_IDS, isGameId } from '../games/ids';

/**
 * Moving a player to another browser.
 *
 * Two shapes:
 * - A **profile export** (`p2p-gaming-<slug>.json`): identity + settings + every saved match, for
 *   a full move. Importing it in another browser recreates the player with the *same id*, which
 *   is how a resumed match's `players[seat].id` recognises them. From then on the two browsers
 *   have separate histories.
 * - A **transfer code** (`p2pg1.<base64url>`): identity + settings only, short enough to paste.
 * - An **identity code** (`p2pi1.<base64url>`): identity only (id, name, avatar). Short enough for
 *   a QR code; used by hand-off links so a phone can pick up a live game as the same player.
 */

export const EXPORT_FORMAT = 'p2p-gaming-profile';
export const EXPORT_VERSION = 1;
export const TRANSFER_PREFIX = 'p2pg1.';
export const IDENTITY_PREFIX = 'p2pi1.';

/** True for either kind of pasteable code. */
export function isTransferCode(text: string): boolean {
  const t = text.trim();
  return t.startsWith(TRANSFER_PREFIX) || t.startsWith(IDENTITY_PREFIX);
}

export interface ExportedIdentity {
  id: string;
  name: string;
  avatar: string;
  createdAt: number;
  /** Device-sync secret; present in your own exports/codes, never shown to opponents. */
  syncKey?: string;
}

export interface ProfileExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: number;
  profile: ExportedIdentity;
  settings: Settings;
  matches: Partial<Record<GameId, MatchSnapshot[]>>;
}

export interface ImportResult {
  slug: string;
  /** True when a new player was created; false when an existing player with the same id was updated. */
  created: boolean;
  matchesAdded: number;
  matchesUpdated: number;
  matchesSkipped: number;
}

export class TransferError extends Error {
  constructor(
    public readonly code: 'bad-code' | 'bad-file' | 'unknown-player',
    message: string,
  ) {
    super(message);
    this.name = 'TransferError';
  }
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

function identityOf(slug: string): ExportedIdentity {
  const record = getProfilesIndex()[slug];
  if (!record) throw new TransferError('unknown-player', `no player "${slug}" in this browser`);
  return {
    id: record.id,
    name: record.name,
    avatar: record.avatar,
    createdAt: record.createdAt,
    ...(record.syncKey ? { syncKey: record.syncKey } : {}),
  };
}

/** Identity, settings and every saved match of `slug`, across all games. */
export async function exportProfile(
  slug: string,
  now: number = Date.now(),
): Promise<ProfileExport> {
  const profile = identityOf(slug);
  const matches: Partial<Record<GameId, MatchSnapshot[]>> = {};
  for (const game of GAME_IDS) {
    const list = await getMatchStore(slug, game)
      .list()
      .catch(() => [] as MatchSnapshot[]);
    if (list.length) matches[game] = list;
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now,
    profile,
    settings: getSettings(slug),
    matches,
  };
}

export function exportFileName(slug: string): string {
  return `p2p-gaming-${slug}.json`;
}

// ---------------------------------------------------------------------------------------------
// Transfer code (identity + settings, no matches)
// ---------------------------------------------------------------------------------------------

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (data.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeTransferCode(profile: ExportedIdentity, settings?: Settings): string {
  const payload = { p: profile, ...(settings ? { s: settings } : {}) };
  return TRANSFER_PREFIX + toBase64Url(JSON.stringify(payload));
}

/** Transfer code for a player stored in this browser. */
export function transferCodeFor(slug: string): string {
  return encodeTransferCode(identityOf(slug), getSettings(slug));
}

/**
 * Identity-only code: id, name, avatar and (for your own devices) the sync key. No settings, no
 * matches; short enough for a QR code.
 */
export function encodeIdentityCode(profile: {
  id: string;
  name: string;
  avatar?: string;
  syncKey?: string;
}): string {
  const payload: Record<string, string> = { i: profile.id, n: profile.name };
  if (profile.avatar) payload.a = profile.avatar;
  if (profile.syncKey) payload.k = profile.syncKey;
  return IDENTITY_PREFIX + toBase64Url(JSON.stringify(payload));
}

/** Identity code for a player stored in this browser (includes the sync key). */
export function identityCodeFor(slug: string): string {
  const { id, name, avatar, syncKey } = identityOf(slug);
  return encodeIdentityCode({ id, name, avatar, syncKey });
}

export function decodeTransferCode(code: string): {
  profile: ExportedIdentity;
  settings?: Settings;
} {
  const trimmed = code.trim();
  const identityOnly = trimmed.startsWith(IDENTITY_PREFIX);
  if (!identityOnly && !trimmed.startsWith(TRANSFER_PREFIX)) {
    throw new TransferError(
      'bad-code',
      `a transfer code starts with "${TRANSFER_PREFIX}" (or "${IDENTITY_PREFIX}")`,
    );
  }
  const prefix = identityOnly ? IDENTITY_PREFIX : TRANSFER_PREFIX;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(trimmed.slice(prefix.length)));
  } catch {
    throw new TransferError('bad-code', 'that transfer code is damaged');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TransferError('bad-code', 'that transfer code is damaged');
  }
  if (identityOnly) {
    const { i, n, a, k } = parsed as { i?: unknown; n?: unknown; a?: unknown; k?: unknown };
    return { profile: parseIdentity({ id: i, name: n, avatar: a, syncKey: k }, 'bad-code') };
  }
  const { p, s } = parsed as { p?: unknown; s?: unknown };
  const profile = parseIdentity(p, 'bad-code');
  const settings = s === undefined ? undefined : sanitizeSettings(s);
  return settings ? { profile, settings } : { profile };
}

/** Turn a decoded transfer code into an importable export (without matches). */
export function exportFromTransferCode(code: string, now: number = Date.now()): ProfileExport {
  const { profile, settings } = decodeTransferCode(code);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now,
    profile,
    settings: settings ?? { ...DEFAULT_SETTINGS },
    matches: {},
  };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function parseIdentity(value: unknown, code: TransferError['code']): ExportedIdentity {
  if (typeof value !== 'object' || value === null) {
    throw new TransferError(code, 'no player identity found');
  }
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id.trim()) {
    throw new TransferError(code, 'the player identity has no id');
  }
  const name = sanitizeName(typeof v.name === 'string' ? v.name : '');
  if (!name) throw new TransferError(code, 'the player identity has no name');
  return {
    id: v.id,
    name,
    avatar: typeof v.avatar === 'string' && v.avatar ? v.avatar : pickAvatar(v.id),
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(),
    ...(typeof v.syncKey === 'string' && v.syncKey.trim() ? { syncKey: v.syncKey.trim() } : {}),
  };
}

function isSnapshotLike(v: unknown): v is MatchSnapshot {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as MatchSnapshot).id === 'string' &&
    typeof (v as MatchSnapshot).seq === 'number'
  );
}

/** Validate a profile export (JSON text or an already-parsed object). Throws `TransferError`. */
export function parseProfileExport(input: string | unknown): ProfileExport {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new TransferError('bad-file', 'that file is not a P2P Gaming player export');
    }
  }
  if (typeof value !== 'object' || value === null) {
    throw new TransferError('bad-file', 'that file is not a P2P Gaming player export');
  }
  const v = value as Record<string, unknown>;
  if (v.format !== EXPORT_FORMAT) {
    throw new TransferError('bad-file', 'that file is not a P2P Gaming player export');
  }
  if (v.version !== EXPORT_VERSION) {
    throw new TransferError('bad-file', `unsupported export version ${String(v.version)}`);
  }
  const profile = parseIdentity(v.profile, 'bad-file');
  const settings = sanitizeSettings(v.settings);
  const matches: Partial<Record<GameId, MatchSnapshot[]>> = {};
  if (v.matches !== undefined) {
    if (typeof v.matches !== 'object' || v.matches === null) {
      throw new TransferError('bad-file', 'the saved matches in that file are malformed');
    }
    for (const [game, list] of Object.entries(v.matches as Record<string, unknown>)) {
      if (!isGameId(game)) continue; // a game this build does not know: nothing we can do with it
      if (!Array.isArray(list) || !list.every(isSnapshotLike)) {
        throw new TransferError('bad-file', `the saved ${game} matches in that file are malformed`);
      }
      matches[game] = list as MatchSnapshot[];
    }
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: typeof v.exportedAt === 'number' ? v.exportedAt : Date.now(),
    profile,
    settings,
    matches,
  };
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

export interface ImportOptions {
  /**
   * Overwrite the player's settings with the imported ones. Defaults to true when the player is
   * new to this browser and false when merging into an existing player.
   */
  replaceSettings?: boolean;
  now?: number;
}

function slugForId(id: string): string | null {
  for (const [slug, record] of Object.entries(getProfilesIndex())) {
    if (record.id === id) return slug;
  }
  return null;
}

/**
 * Bring an exported player into this browser. A player with the same id is updated in place
 * (name, avatar, optionally settings) and their matches merged, keeping whichever copy of each
 * match has the higher `seq`. Otherwise a new player is created with the imported id.
 */
export async function importProfile(
  data: ProfileExport,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const now = opts.now ?? Date.now();
  const existingSlug = slugForId(data.profile.id);
  let slug: string;
  let created: boolean;
  if (existingSlug) {
    slug = existingSlug;
    created = false;
    updateProfile(slug, { name: data.profile.name, avatar: data.profile.avatar });
    // Your own code: adopting its sync key joins this browser to that player's devices.
    if (data.profile.syncKey) setProfileSyncKey(slug, data.profile.syncKey);
  } else {
    slug = createProfile(data.profile.name, {
      id: data.profile.id,
      avatar: data.profile.avatar,
      now,
      syncKey: data.profile.syncKey,
    }).slug;
    created = true;
  }
  if (opts.replaceSettings ?? created) updateSettings(slug, data.settings);

  let matchesAdded = 0;
  let matchesUpdated = 0;
  let matchesSkipped = 0;
  for (const [game, list] of Object.entries(data.matches)) {
    if (!isGameId(game) || !list || list.length === 0) continue;
    const store = getMatchStore(slug, game);
    for (const snapshot of list) {
      const current = await store.get(snapshot.id);
      if (!current) {
        await store.put(snapshot);
        matchesAdded++;
      } else if (current.seq < snapshot.seq) {
        await store.put(snapshot);
        matchesUpdated++;
      } else {
        matchesSkipped++;
      }
    }
  }
  touchProfile(slug, now);
  return { slug, created, matchesAdded, matchesUpdated, matchesSkipped };
}

/** Import from pasted text: a transfer code or the JSON of an export file. */
export async function importFromText(
  text: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const trimmed = text.trim();
  const data = isTransferCode(trimmed)
    ? exportFromTransferCode(trimmed, opts.now)
    : parseProfileExport(trimmed);
  return importProfile(data, opts);
}

/** One-line summary for the UI. */
export function describeImport(result: ImportResult, name: string): string {
  const parts: string[] = [];
  if (result.matchesAdded)
    parts.push(`${result.matchesAdded} match${result.matchesAdded === 1 ? '' : 'es'} added`);
  if (result.matchesUpdated) parts.push(`${result.matchesUpdated} updated`);
  if (result.matchesSkipped) parts.push(`${result.matchesSkipped} already up to date`);
  const detail = parts.length ? ` (${parts.join(', ')})` : '';
  return `${result.created ? 'Imported' : 'Updated'} ${name} as #/${result.slug}/${detail}`;
}

/** Trigger a browser download of a JSON document. */
export function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
