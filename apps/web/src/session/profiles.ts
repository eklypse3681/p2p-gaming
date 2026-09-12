import { useSyncExternalStore } from 'react';
import type { PlayerProfile } from '@bgf/protocol';
import { generateId } from '@bgf/protocol';
import { allKeys, createStore, readJson, removeKey, writeJson } from './storage';
import { GAME_IDS } from '../games/ids';

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
  ...GAME_IDS,
];

export const AVATARS = ['🎲', '🦊', '🐙', '🦉', '🐺', '🦁', '🐸', '🦄', '🐝', '🐳', '🦋', '🍀'];

export interface ProfileRecord {
  id: string;
  name: string;
  avatar: string;
  createdAt: number;
  lastUsedAt: number;
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
    };
    if (legacySettings) writeJson(`bgf:settings:${slug}`, legacySettings);
    pending.push({ db: ns ? `bgf-${ns}` : 'bgf', slug });
  }
  if (pending.length) writeJson(PENDING_DB_MIGRATIONS_KEY, pending);
  return index;
}

function load(): ProfilesIndex {
  const stored = readJson<ProfilesIndex>(PROFILES_KEY);
  if (stored && typeof stored === 'object') return stored;
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

export function toPlayerProfile(record: ProfileRecord): PlayerProfile {
  return { id: record.id, name: record.name, avatar: record.avatar };
}

/** Create a player from a display name; the slug is derived and made unique. */
export function createProfile(
  name: string,
  opts: { slug?: string; id?: string; avatar?: string; now?: number } = {},
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
  };
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

export function updateProfile(
  slug: string,
  patch: Partial<Pick<ProfileRecord, 'name' | 'avatar'>>,
): void {
  const index = store.get();
  const record = index[slug];
  if (!record) return;
  const next: ProfileRecord = { ...record };
  if (patch.name !== undefined) {
    const clean = sanitizeName(patch.name);
    if (clean) next.name = clean;
  }
  if (patch.avatar !== undefined) next.avatar = patch.avatar;
  commit({ ...index, [slug]: next });
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
}

export function subscribeProfiles(listener: () => void): () => void {
  return store.subscribe(listener);
}

export function useProfilesIndex(): ProfilesIndex {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** For tests: replace the whole index (also persisted). */
export function replaceProfilesForTests(index: ProfilesIndex): void {
  commit(index);
}

/** For tests: empty index, migration marked done. */
export function resetProfilesForTests(): void {
  commit({});
  writeJson(MIGRATED_KEY, 1);
}
