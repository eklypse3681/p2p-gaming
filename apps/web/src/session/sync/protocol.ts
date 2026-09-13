import type { MatchSnapshot } from '@bgf/protocol';
import type { Settings } from '../settings';
import { sanitizeSettings } from '../settings';
import type { GameId } from '../../games/ids';
import { GAME_IDS, isGameId } from '../../games/ids';

/**
 * Device-to-device profile sync, pure part.
 *
 *   A ── sync-hello {nonce} ──▶ B      both sides send a hello as soon as the transport opens
 *   A ◀── sync-auth {mac} ───── B      mac = HMAC-SHA-256(syncKey, the other side's nonce)
 *   (each side verifies the other's mac; anything else before that closes the connection)
 *   A ── manifest ───────────▶ B      what I have: profile/settings timestamps, match refs
 *   A ◀── want ──────────────── B      what B is missing or has older
 *   A ── data ───────────────▶ B      the requested items; B applies with the merge rules
 *   ... and the same in the other direction; afterwards live changes are pushed as `data`.
 *
 * Merge rules: matches by id, higher `seq` wins (equal keeps local); profile name/avatar and the
 * settings blob are last-write-wins by `updatedAt`. Deletions are not synced.
 */

export const SYNC_PROTOCOL = 1;

export interface MatchRef {
  id: string;
  seq: number;
  updatedAt: number;
}

export interface Manifest {
  profile: { updatedAt: number };
  settings: { updatedAt: number };
  matches: Partial<Record<GameId, MatchRef[]>>;
}

export interface Want {
  profile: boolean;
  settings: boolean;
  matches: Partial<Record<GameId, string[]>>;
}

export interface SyncProfile {
  name: string;
  avatar: string;
  updatedAt: number;
}

export interface SyncSettings {
  settings: Settings;
  updatedAt: number;
}

export interface SyncData {
  profile?: SyncProfile;
  settings?: SyncSettings;
  matches?: Partial<Record<GameId, MatchSnapshot[]>>;
}

export type SyncMessage =
  | {
      type: 'sync-hello';
      protocol: number;
      profileId: string;
      deviceId: string;
      deviceLabel: string;
      nonce: string;
    }
  | { type: 'sync-auth'; mac: string }
  | ({ type: 'manifest' } & Manifest)
  | ({ type: 'want' } & Want)
  | ({ type: 'data' } & SyncData)
  | { type: 'bye' };

/** A local change worth pushing to the other devices. */
export type SyncChange =
  | { kind: 'profile' }
  | { kind: 'settings' }
  | { kind: 'match'; game: GameId; id: string }
  | { kind: 'unknown' };

/** What the manager needs from local storage; `LocalSyncStore` implements it over the app's stores. */
export interface SyncStore {
  readonly profileId: string;
  readonly syncKey: string;
  profile(): SyncProfile;
  /** Apply a remote profile if it is newer; returns whether anything changed. */
  applyProfile(profile: SyncProfile): boolean;
  settings(): SyncSettings;
  applySettings(settings: SyncSettings): boolean;
  listMatches(game: GameId): Promise<MatchSnapshot[]>;
  getMatch(game: GameId, id: string): Promise<MatchSnapshot | undefined>;
  putMatch(game: GameId, snapshot: MatchSnapshot): Promise<void>;
  /** Local changes made on this device (including ones applied from a peer — callers filter). */
  onChange(listener: (change: SyncChange) => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isMatchRef(v: unknown): v is MatchRef {
  return isObj(v) && isStr(v.id) && isNum(v.seq) && isNum(v.updatedAt);
}

function isSnapshotLike(v: unknown): v is MatchSnapshot {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.code) &&
    isNum(v.seq) &&
    isNum(v.updatedAt) &&
    isObj(v.match) &&
    Array.isArray(v.actions)
  );
}

function parseGameMap<T>(
  v: unknown,
  item: (x: unknown) => x is T,
): Partial<Record<GameId, T[]>> | null {
  if (v === undefined) return {};
  if (!isObj(v)) return null;
  const out: Partial<Record<GameId, T[]>> = {};
  for (const [game, list] of Object.entries(v)) {
    if (!isGameId(game)) continue; // a game this build does not know
    if (!Array.isArray(list) || !list.every(item)) return null;
    out[game] = list as T[];
  }
  return out;
}

function parseSyncProfile(v: unknown): SyncProfile | null {
  if (!isObj(v) || !isStr(v.name) || !v.name.trim() || !isNum(v.updatedAt)) return null;
  return { name: v.name, avatar: isStr(v.avatar) ? v.avatar : '', updatedAt: v.updatedAt };
}

function parseSyncSettings(v: unknown): SyncSettings | null {
  if (!isObj(v) || !isObj(v.settings) || !isNum(v.updatedAt)) return null;
  return { settings: sanitizeSettings(v.settings), updatedAt: v.updatedAt };
}

/** Validate a message from the wire; null for anything malformed. */
export function parseSyncMessage(raw: unknown): SyncMessage | null {
  if (!isObj(raw) || !isStr(raw.type)) return null;
  switch (raw.type) {
    case 'sync-hello':
      if (
        !isNum(raw.protocol) ||
        !isStr(raw.profileId) ||
        !isStr(raw.deviceId) ||
        !isStr(raw.nonce) ||
        !/^[0-9a-f]{16,128}$/.test(raw.nonce)
      ) {
        return null;
      }
      return {
        type: 'sync-hello',
        protocol: raw.protocol,
        profileId: raw.profileId,
        deviceId: raw.deviceId,
        deviceLabel: isStr(raw.deviceLabel) ? raw.deviceLabel.slice(0, 60) : 'device',
        nonce: raw.nonce,
      };
    case 'sync-auth':
      return isStr(raw.mac) && /^[0-9a-f]{64}$/.test(raw.mac)
        ? { type: 'sync-auth', mac: raw.mac }
        : null;
    case 'manifest': {
      if (!isObj(raw.profile) || !isNum(raw.profile.updatedAt)) return null;
      if (!isObj(raw.settings) || !isNum(raw.settings.updatedAt)) return null;
      const matches = parseGameMap(raw.matches, isMatchRef);
      if (!matches) return null;
      return {
        type: 'manifest',
        profile: { updatedAt: raw.profile.updatedAt },
        settings: { updatedAt: raw.settings.updatedAt },
        matches,
      };
    }
    case 'want': {
      const matches = parseGameMap(raw.matches, isStr);
      if (!matches) return null;
      return {
        type: 'want',
        profile: raw.profile === true,
        settings: raw.settings === true,
        matches,
      };
    }
    case 'data': {
      const out: SyncMessage = { type: 'data' };
      if (raw.profile !== undefined) {
        const p = parseSyncProfile(raw.profile);
        if (!p) return null;
        out.profile = p;
      }
      if (raw.settings !== undefined) {
        const s = parseSyncSettings(raw.settings);
        if (!s) return null;
        out.settings = s;
      }
      if (raw.matches !== undefined) {
        const m = parseGameMap(raw.matches, isSnapshotLike);
        if (!m) return null;
        out.matches = m;
      }
      return out;
    }
    case 'bye':
      return { type: 'bye' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Manifest / diff / merge
// ---------------------------------------------------------------------------------------------

export async function buildManifest(store: SyncStore): Promise<Manifest> {
  const matches: Partial<Record<GameId, MatchRef[]>> = {};
  for (const game of GAME_IDS) {
    const list = await store.listMatches(game).catch(() => [] as MatchSnapshot[]);
    if (list.length) {
      matches[game] = list.map((m) => ({ id: m.id, seq: m.seq, updatedAt: m.updatedAt }));
    }
  }
  return {
    profile: { updatedAt: store.profile().updatedAt },
    settings: { updatedAt: store.settings().updatedAt },
    matches,
  };
}

/** What `local` should ask `remote` for. */
export function diffManifests(local: Manifest, remote: Manifest): Want {
  const want: Want = {
    profile: remote.profile.updatedAt > local.profile.updatedAt,
    settings: remote.settings.updatedAt > local.settings.updatedAt,
    matches: {},
  };
  for (const [game, refs] of Object.entries(remote.matches) as [GameId, MatchRef[]][]) {
    const mine = new Map((local.matches[game] ?? []).map((r) => [r.id, r]));
    const ids = refs.filter((r) => mergeRef(mine.get(r.id), r) !== 'skip').map((r) => r.id);
    if (ids.length) want.matches[game] = ids;
  }
  return want;
}

export function isEmptyWant(w: Want): boolean {
  return !w.profile && !w.settings && Object.values(w.matches).every((ids) => !ids?.length);
}

export function isEmptyData(d: SyncData): boolean {
  return (
    !d.profile && !d.settings && (!d.matches || Object.values(d.matches).every((l) => !l?.length))
  );
}

function mergeRef(
  local: { seq: number } | undefined,
  incoming: { seq: number },
): 'add' | 'update' | 'skip' {
  if (!local) return 'add';
  return incoming.seq > local.seq ? 'update' : 'skip';
}

/** Higher `seq` wins; equal keeps the local copy. */
export function mergeMatch(
  local: MatchSnapshot | undefined,
  incoming: MatchSnapshot,
): 'add' | 'update' | 'skip' {
  return mergeRef(local, incoming);
}

/** Gather what a peer asked for. */
export async function collectData(store: SyncStore, want: Want): Promise<SyncData> {
  const data: SyncData = {};
  if (want.profile) data.profile = store.profile();
  if (want.settings) data.settings = store.settings();
  for (const [game, ids] of Object.entries(want.matches) as [GameId, string[]][]) {
    const list: MatchSnapshot[] = [];
    for (const id of ids) {
      const m = await store.getMatch(game, id).catch(() => undefined);
      if (m) list.push(m);
    }
    if (list.length) (data.matches ??= {})[game] = list;
  }
  return data;
}

export interface ApplyResult {
  profile: boolean;
  settings: boolean;
  matchesAdded: number;
  matchesUpdated: number;
  matchesSkipped: number;
}

/** Apply a peer's data with the merge rules. */
export async function applyData(store: SyncStore, data: SyncData): Promise<ApplyResult> {
  const result: ApplyResult = {
    profile: false,
    settings: false,
    matchesAdded: 0,
    matchesUpdated: 0,
    matchesSkipped: 0,
  };
  if (data.profile) result.profile = store.applyProfile(data.profile);
  if (data.settings) result.settings = store.applySettings(data.settings);
  for (const [game, list] of Object.entries(data.matches ?? {}) as [GameId, MatchSnapshot[]][]) {
    for (const incoming of list) {
      const local = await store.getMatch(game, incoming.id).catch(() => undefined);
      const verdict = mergeMatch(local, incoming);
      if (verdict === 'skip') {
        result.matchesSkipped++;
        continue;
      }
      await store.putMatch(game, incoming);
      if (verdict === 'add') result.matchesAdded++;
      else result.matchesUpdated++;
    }
  }
  return result;
}

export function applied(r: ApplyResult): boolean {
  return r.profile || r.settings || r.matchesAdded > 0 || r.matchesUpdated > 0;
}
