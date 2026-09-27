import { useSyncExternalStore } from 'react';
import type { PlayerProfile } from '@bgf/protocol';
import { generateId } from '@bgf/protocol';
import { generateSeed, openWallet, seedToBase64Url } from '@bgf/wallet';
import { allKeys, createStore, readJson, removeKey, writeJson } from './storage';
import { GAME_IDS } from '../games/ids';
import type { EncryptedSecrets, PlainSecrets } from './secrets';
import {
  SecretsError,
  checkPassword,
  decryptSecrets,
  encryptSecrets,
  forgetUnlocked,
  isEncryptedSecrets,
  SECRET_FIELDS,
  pickSecrets,
  readUnlocked,
  rememberUnlocked,
} from './secrets';

/**
 * Players known to this browser, keyed by URL slug. The slug is the identity a tab plays as:
 * every route is `#/<slug>/...`, and settings and saved matches are stored per slug. Nothing is
 * ever assumed from a shared "current profile"; two tabs are simply two slugs.
 */

export const PROFILES_KEY = 'bgf:profiles';
export const MIGRATED_KEY = 'bgf:migrated';
/** Legacy IndexedDB databases still to be copied into per-profile stores: `[{ db, slug }]`. */
export const PENDING_DB_MIGRATIONS_KEY = 'bgf:migrate-pending';
export const MAX_NAME_LENGTH = 24;
export const MAX_SLUG_LENGTH = 32;
/** Slugs that would collide with global routes (including every game id). */
export const RESERVED_SLUGS: readonly string[] = [
  'join',
  'demo',
  'host',
  'game',
  'settings',
  'history',
  'games',
  'pair',
  'club',
  'clubs',
  ...GAME_IDS,
];

export const AVATARS = ['🎲', '🦊', '🐙', '🦉', '🐺', '🦁', '🐸', '🦄', '🐝', '🐳', '🦋', '🍀'];

export interface ProfileRecord {
  id: string;
  name: string;
  avatar: string;
  createdAt: number;
  lastUsedAt: number;
  /**
   * base64url ECDSA P-256 public key. Opponents' servers bind it to a seat the first time the
   * player sits down; only the matching private key can take that seat afterwards.
   */
  publicKey?: string;
  /** base64url PKCS#8 private key. Absent while the player is password-locked (see `secrets`). */
  privateKey?: string;
  /**
   * Secret shared only between this player's own devices (it travels in exports, transfer codes
   * and hand-off links, never to opponents). Devices holding the same key find each other and
   * sync settings and saved matches over WebRTC. Rotating it cuts every other device off.
   * Absent while the player is password-locked.
   */
  syncKey?: string;
  /**
   * base64url wallet seed (`@bgf/wallet`) that `privateKey` and `syncKey` derive from. Players
   * made before the wallet have none: their key was generated directly and stays their identity.
   * Absent while password-locked.
   */
  seed?: string;
  /**
   * On a paired device: this device's own private key. It never signs as the player by itself;
   * servers accept it only together with `grant`. Absent while password-locked.
   */
  deviceKey?: string;
  /** On a paired device: the `p2pd1.` grant from the player's key to this device's key. */
  grant?: string;
  /** On the player's own devices: every device they have paired, newest last. */
  devices?: PairedDevice[];
  /** Password-encrypted secrets (`privateKey`, `syncKey`, `seed`, `deviceKey`); plain ones removed. */
  secrets?: EncryptedSecrets;
  /** Last change to name/avatar; used for last-write-wins between devices. */
  updatedAt: number;
}

export type { PlainSecrets };

/** A device this player paired: what the grant said, for the Devices list and for sign-out. */
export interface PairedDevice {
  serial: number;
  label: string;
  publicKey: string;
  pairedAt: number;
  expiresAt: number;
  /** Set when the player signed this device out. */
  revokedAt?: number;
}

function withoutSecrets(record: ProfileRecord): ProfileRecord {
  const next = { ...record };
  for (const k of SECRET_FIELDS) delete next[k];
  return next;
}

export function isLocked(record: Pick<ProfileRecord, 'secrets'>): boolean {
  return isEncryptedSecrets(record.secrets);
}

export type ProfilesIndex = Record<string, ProfileRecord>;

export interface ProfileEntry extends ProfileRecord {
  slug: string;
}

export function pickAvatar(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length]!;
}

export function sanitizeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

/** `[a-z0-9-]{1,32}`, not reserved. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(slug) && !RESERVED_SLUGS.includes(slug);
}

/** Lower-case, spaces → `-`, everything else stripped; falls back to `player`. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
  const slug = base || 'player';
  return RESERVED_SLUGS.includes(slug) ? `${slug}-1` : slug;
}

/** `steve-2` → "Steve 2". */
export function prettifySlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** First free slug for `name` among `taken`: `steve`, `steve-2`, `steve-3`, … */
export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const base = slugify(name);
  if (!set.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, MAX_SLUG_LENGTH - String(n).length - 1)}-${n}`;
    if (!set.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------------------------
// Legacy migration (single `bgf:profile` / `bgf:profile:<ns>` keys from earlier builds)
// ---------------------------------------------------------------------------------------------

interface LegacyProfile {
  id?: string;
  name?: string;
  avatar?: string;
}

export interface PendingDbMigration {
  db: string;
  slug: string;
}

/**
 * Turn legacy single-profile keys into index entries. Runs once (guarded by `bgf:migrated`).
 * Returns the index it produced (possibly empty). Settings are copied to the per-profile key;
 * IndexedDB copies are queued for `runPendingDbMigrations` (they are asynchronous).
 */
export function migrateLegacyProfiles(now: number = Date.now()): ProfilesIndex {
  const index: ProfilesIndex = {};
  const pending: PendingDbMigration[] = [];
  const legacySettings = readJson<unknown>('bgf:settings');
  for (const key of allKeys()) {
    if (key !== 'bgf:profile' && !key.startsWith('bgf:profile:')) continue;
    const legacy = readJson<LegacyProfile>(key);
    if (!legacy || typeof legacy.id !== 'string' || !legacy.id) continue;
    const ns = key === 'bgf:profile' ? '' : key.slice('bgf:profile:'.length);
    const name = sanitizeName(typeof legacy.name === 'string' ? legacy.name : '');
    if (!name && !ns) continue; // a fresh visitor who never picked a name: nothing to keep
    const slug = uniqueSlug(name || ns, Object.keys(index));
    index[slug] = {
      id: legacy.id,
      name: name || prettifySlug(slug),
      avatar:
        typeof legacy.avatar === 'string' && legacy.avatar ? legacy.avatar : pickAvatar(legacy.id),
      createdAt: now,
      lastUsedAt: now,
      syncKey: generateId(),
      updatedAt: now,
    };
    if (legacySettings) writeJson(`bgf:settings:${slug}`, legacySettings);
    pending.push({ db: ns ? `bgf-${ns}` : 'bgf', slug });
  }
  if (pending.length) writeJson(PENDING_DB_MIGRATIONS_KEY, pending);
  return index;
}

/** Older records lack `syncKey`/`updatedAt`: fill them in (and persist) so every player can sync. */
export function completeRecords(index: ProfilesIndex): { index: ProfilesIndex; changed: boolean } {
  let changed = false;
  const out: ProfilesIndex = {};
  for (const [slug, record] of Object.entries(index)) {
    if (!record || typeof record !== 'object') continue;
    const next: ProfileRecord = { ...record };
    if (!isLocked(next) && (typeof next.syncKey !== 'string' || !next.syncKey)) {
      next.syncKey = generateId();
      changed = true;
    }
    if (typeof next.updatedAt !== 'number') {
      next.updatedAt = typeof next.createdAt === 'number' ? next.createdAt : 0;
      changed = true;
    }
    out[slug] = next;
  }
  return { index: out, changed };
}

function load(): ProfilesIndex {
  const stored = readJson<ProfilesIndex>(PROFILES_KEY);
  if (stored && typeof stored === 'object') {
    const { index, changed } = completeRecords(stored);
    if (changed) writeJson(PROFILES_KEY, index);
    return index;
  }
  let index: ProfilesIndex = {};
  if (!readJson<number>(MIGRATED_KEY)) {
    index = migrateLegacyProfiles();
    writeJson(MIGRATED_KEY, 1);
  }
  writeJson(PROFILES_KEY, index);
  return index;
}

const store = createStore<ProfilesIndex>(load());

function commit(next: ProfilesIndex): void {
  store.set(next);
  writeJson(PROFILES_KEY, next);
}

export function getProfilesIndex(): ProfilesIndex {
  return store.get();
}

/** Most recently used first. */
export function listProfiles(): ProfileEntry[] {
  return Object.entries(store.get())
    .map(([slug, record]) => ({ slug, ...record }))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export function getProfile(slug: string): ProfileRecord | null {
  return store.get()[slug] ?? null;
}

/** What the server (and opponents) see: id, name, avatar and the public key. Never secrets. */
export function toPlayerProfile(record: ProfileRecord): PlayerProfile {
  const out: PlayerProfile = { id: record.id, name: record.name, avatar: record.avatar };
  if (record.publicKey) out.publicKey = record.publicKey;
  return out;
}

/**
 * This tab's view of a player's secrets: the plain fields for an unlocked player, the
 * session copy for a locked player that was unlocked in this tab, or null while locked.
 */
export function getSecrets(slug: string): PlainSecrets | null {
  const record = store.get()[slug];
  if (!record) return null;
  if (isLocked(record)) return readUnlocked(slug);
  return pickSecrets(record as unknown as Record<string, unknown>);
}

/** True when this tab may use the player's secrets (not locked, or unlocked here). */
export function isUnlocked(slug: string): boolean {
  return getSecrets(slug) !== null;
}

/** Notify subscribers without changing the index (e.g. after the session unlock state changed). */
function bump(): void {
  store.set({ ...store.get() });
}

/**
 * Make sure the player has an identity key. A new player gets a wallet seed and their key is
 * derived from it, so a backup of the seed restores it. (Players made before
 * the wallet keep the key they already have: it is what their seats are bound to.) No-op for
 * locked players and paired devices, which were keyed before they could be either.
 */
export async function ensureKeys(slug: string): Promise<ProfileRecord | null> {
  const record = store.get()[slug];
  if (!record) return null;
  if (record.publicKey || isLocked(record)) return record;
  const wallet = await openWallet(generateSeed());
  const index = store.get();
  const current = index[slug];
  if (!current) return null;
  if (current.publicKey) return current; // raced with another call
  const next: ProfileRecord = {
    ...current,
    publicKey: wallet.publicKey,
    privateKey: wallet.root.privateKey,
    seed: seedToBase64Url(wallet.seed),
    // The sync key stays as it is: a player from before keys may already share it with other
    // devices, and replacing it would silently cut them off.
  };
  commit({ ...index, [slug]: next });
  return next;
}

function dropEmpty(secrets: PlainSecrets): PlainSecrets {
  const out = { ...secrets };
  for (const k of SECRET_FIELDS) if (out[k] === '') delete out[k];
  return out;
}

/**
 * Write new secrets for a player; a locked player needs its password to re-encrypt them. An
 * empty string removes that secret (a replaced key takes its seed with it).
 */
export async function setProfileSecrets(
  slug: string,
  patch: Partial<PlainSecrets> & { publicKey?: string },
  opts: { password?: string; iterations?: number } = {},
): Promise<void> {
  const index = store.get();
  const record = index[slug];
  if (!record) return;
  const next: ProfileRecord = { ...record };
  if (patch.publicKey) next.publicKey = patch.publicKey;
  if (isLocked(record)) {
    if (!opts.password) throw new SecretsError('wrong-password', 'password required');
    const current = await decryptSecrets(record.secrets!, opts.password);
    const merged = dropEmpty({ ...current, ...pickSecrets(patch) });
    const locked = withoutSecrets(next);
    locked.secrets = await encryptSecrets(merged, opts.password, opts.iterations);
    commit({ ...index, [slug]: locked });
    if (readUnlocked(slug)) rememberUnlocked(slug, merged);
    return;
  }
  Object.assign(next, pickSecrets(patch));
  for (const k of SECRET_FIELDS) if (next[k] === '') delete next[k];
  commit({ ...index, [slug]: next });
}

// ---- password lock ---------------------------------------------------------------------------

/** Protect the player's secrets with a password. This tab stays unlocked. */
export async function lockProfile(
  slug: string,
  password: string,
  opts: { iterations?: number } = {},
): Promise<void> {
  checkPassword(password);
  const index = store.get();
  const record = index[slug];
  if (!record) throw new Error(`no player "${slug}"`);
  if (isLocked(record)) throw new SecretsError('bad-secrets', 'already locked');
  const plain = pickSecrets(record as unknown as Record<string, unknown>);
  const secrets = await encryptSecrets(plain, password, opts.iterations);
  const next: ProfileRecord = { ...withoutSecrets(record), secrets };
  commit({ ...index, [slug]: next });
  rememberUnlocked(slug, plain);
}

/** Try a password; on success this tab holds the secrets until `lockNow` or the tab closes. */
export async function unlockProfile(slug: string, password: string): Promise<boolean> {
  const record = store.get()[slug];
  if (!record) return false;
  if (!isLocked(record)) return true;
  try {
    const plain = await decryptSecrets(record.secrets!, password);
    rememberUnlocked(slug, plain);
    bump();
    return true;
  } catch (e) {
    if (e instanceof SecretsError && e.code === 'wrong-password') return false;
    throw e;
  }
}

export async function changePassword(
  slug: string,
  oldPassword: string,
  newPassword: string,
  opts: { iterations?: number } = {},
): Promise<void> {
  checkPassword(newPassword);
  const index = store.get();
  const record = index[slug];
  if (!record || !isLocked(record)) throw new SecretsError('bad-secrets', 'not locked');
  const plain = await decryptSecrets(record.secrets!, oldPassword);
  const secrets = await encryptSecrets(plain, newPassword, opts.iterations);
  commit({ ...index, [slug]: { ...record, secrets } });
  rememberUnlocked(slug, plain);
}

/** Store the secrets in the clear again. */
export async function removePassword(slug: string, password: string): Promise<void> {
  const index = store.get();
  const record = index[slug];
  if (!record || !isLocked(record)) return;
  const plain = await decryptSecrets(record.secrets!, password);
  const next: ProfileRecord = { ...record, ...plain };
  delete next.secrets;
  commit({ ...index, [slug]: next });
  forgetUnlocked(slug);
}

/** Forget the unlocked secrets in this tab; the next visit asks for the password again. */
export function lockNow(slug: string): void {
  forgetUnlocked(slug);
  bump();
}

/** Create a player from a display name; the slug is derived and made unique. */
export function createProfile(
  name: string,
  opts: {
    slug?: string;
    id?: string;
    avatar?: string;
    now?: number;
    syncKey?: string;
    updatedAt?: number;
    publicKey?: string;
    privateKey?: string;
    seed?: string;
    /** A paired device: its own key and the grant that lets it act for the player. */
    deviceKey?: string;
    grant?: string;
    /** Import of a locked player: keep its encrypted block (no plain secrets are stored). */
    secrets?: EncryptedSecrets;
  } = {},
): ProfileEntry {
  const clean = sanitizeName(name);
  if (!clean) throw new Error('name required');
  const index = store.get();
  const slug = opts.slug ?? uniqueSlug(clean, Object.keys(index));
  if (!isValidSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  if (index[slug]) throw new Error(`slug taken: ${slug}`);
  const id = opts.id ?? generateId();
  const now = opts.now ?? Date.now();
  const record: ProfileRecord = {
    id,
    name: clean,
    avatar: opts.avatar ?? pickAvatar(id),
    createdAt: now,
    lastUsedAt: now,
    updatedAt: opts.updatedAt ?? now,
  };
  if (opts.publicKey) record.publicKey = opts.publicKey;
  if (opts.secrets && isEncryptedSecrets(opts.secrets)) {
    record.secrets = opts.secrets;
  } else {
    record.syncKey = opts.syncKey ?? generateId();
    if (opts.privateKey) record.privateKey = opts.privateKey;
    if (opts.seed) record.seed = opts.seed;
    if (opts.deviceKey) record.deviceKey = opts.deviceKey;
  }
  if (opts.grant) record.grant = opts.grant;
  commit({ ...index, [slug]: record });
  return { slug, ...record };
}

/** The record for `slug`, creating it (name = prettified slug, fresh id) when unknown. */
export function ensureProfile(slug: string): ProfileRecord {
  const existing = store.get()[slug];
  if (existing) return existing;
  if (!isValidSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  createProfile(prettifySlug(slug), { slug });
  return store.get()[slug]!;
}

/**
 * Change name and/or avatar. Stamps `updatedAt` (now, or the explicit time when applying a change
 * that happened on another device). Nothing is written when nothing changes.
 */
export function updateProfile(
  slug: string,
  patch: Partial<Pick<ProfileRecord, 'name' | 'avatar'>>,
  opts: { updatedAt?: number } = {},
): boolean {
  const index = store.get();
  const record = index[slug];
  if (!record) return false;
  const next: ProfileRecord = { ...record };
  if (patch.name !== undefined) {
    const clean = sanitizeName(patch.name);
    if (clean) next.name = clean;
  }
  if (patch.avatar !== undefined && patch.avatar) next.avatar = patch.avatar;
  if (next.name === record.name && next.avatar === record.avatar) return false;
  next.updatedAt = opts.updatedAt ?? Date.now();
  commit({ ...index, [slug]: next });
  return true;
}

/**
 * Adopt a sync key (e.g. from an import) so this device joins that player's sync group. A locked
 * player needs its password.
 */
export async function setProfileSyncKey(
  slug: string,
  syncKey: string,
  opts: { password?: string } = {},
): Promise<void> {
  const record = store.get()[slug];
  if (!record || !syncKey) return;
  if (!isLocked(record) && record.syncKey === syncKey) return;
  await setProfileSecrets(slug, { syncKey }, opts);
}

/** New secret: every other device stops syncing until it imports a fresh code. */
export async function rotateSyncKey(
  slug: string,
  opts: { password?: string } = {},
): Promise<string> {
  const key = generateId();
  await setProfileSyncKey(slug, key, opts);
  return key;
}

export function touchProfile(slug: string, now: number = Date.now()): void {
  const index = store.get();
  const record = index[slug];
  if (!record || record.lastUsedAt === now) return;
  commit({ ...index, [slug]: { ...record, lastUsedAt: now } });
}

export function deleteProfile(slug: string): void {
  const index = { ...store.get() };
  if (!(slug in index)) return;
  delete index[slug];
  commit(index);
  removeKey(`bgf:settings:${slug}`);
  forgetUnlocked(slug);
}

export function subscribeProfiles(listener: () => void): () => void {
  return store.subscribe(listener);
}

export function useProfilesIndex(): ProfilesIndex {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** For tests: replace the whole index (also persisted); partial records are completed. */
export function replaceProfilesForTests(index: ProfilesIndex): void {
  commit(completeRecords(index).index);
}

/** For tests: empty index, migration marked done. */
export function resetProfilesForTests(): void {
  commit({});
  writeJson(MIGRATED_KEY, 1);
}

// ---- paired devices --------------------------------------------------------------------------

/** How this device signs as the player: its own key alone, or its device key plus the grant. */
export function isPairedDevice(record: Pick<ProfileRecord, 'grant'>): boolean {
  return typeof record.grant === 'string' && record.grant.length > 0;
}

/** The serial the next paired device gets: one past every serial ever handed out. */
export function nextDeviceSerial(record: Pick<ProfileRecord, 'devices'>): number {
  return (record.devices ?? []).reduce((max, d) => Math.max(max, d.serial), 0) + 1;
}

export function recordPairedDevice(slug: string, device: PairedDevice): void {
  const index = store.get();
  const record = index[slug];
  if (!record) return;
  const devices = [...(record.devices ?? []).filter((d) => d.serial !== device.serial), device];
  commit({ ...index, [slug]: { ...record, devices } });
}

export function markDeviceRevoked(slug: string, serial: number, at: number = Date.now()): void {
  const index = store.get();
  const record = index[slug];
  if (!record?.devices) return;
  const devices = record.devices.map((d) => (d.serial === serial ? { ...d, revokedAt: at } : d));
  commit({ ...index, [slug]: { ...record, devices } });
}

/** A paired device re-paired: new device key and grant, same player. */
export async function setDeviceGrant(
  slug: string,
  input: { deviceKey: string; grant: string },
  opts: { password?: string } = {},
): Promise<void> {
  await setProfileSecrets(slug, { deviceKey: input.deviceKey }, opts);
  const index = store.get();
  const record = index[slug];
  if (!record) return;
  commit({ ...index, [slug]: { ...record, grant: input.grant } });
}
