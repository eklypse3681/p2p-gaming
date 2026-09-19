import { useCallback, useSyncExternalStore } from 'react';
import type { RendererId } from '../themes/theme';
import { DEFAULT_PARTS, parseThemeId } from '../themes';
import type { HomeSide } from '../board/contract';
import type { RandomnessMode } from '@bgf/protocol';
import { createStore, readJson, writeJson } from './storage';
import { useOptionalProfile } from './ProfileProvider';

export interface PeerServerSettings {
  host: string;
  port: string;
  path: string;
  secure: boolean;
  key: string;
}

export type ReducedMotionSetting = 'system' | 'on' | 'off';
/** 'table' follows the match's table layout (host's choice, mirrored for the seat across). */
export type HomeSidePreference = 'table' | HomeSide;

export interface Settings {
  /** UI look (chrome palette + light/dark). */
  look: string;
  /** Board set (frame, felt, points, dice, cube). */
  boardSet: string;
  /** Piece set (the two checker styles). */
  pieceSet: string;
  rendererId: RendererId;
  /** Which side your home board (points 1..6) sits on; 'table' = as the table is laid out. */
  homeSidePreference: HomeSidePreference;
  flipBoard: boolean;
  reducedMotion: ReducedMotionSetting;
  sound: boolean;
  /** Empty host = the free PeerJS cloud. */
  peer: PeerServerSettings;
  /** One ICE server per line: `stun:host:port` or `turn:host:port|username|credential`. */
  iceServers: string;
  /** Sync settings and saved matches with this player's other devices over WebRTC. */
  sync: boolean;
  /** Default randomness source when hosting: this device, random.org (signed) or the drand beacon. */
  entropySource: EntropySourceId;
  /** Default randomness mode when hosting; see ARCHITECTURE "Randomness modes". */
  randomnessMode: RandomnessMode;
  /** random.org API key (free tier); stored only in this browser, used only when hosting. */
  randomOrgKey: string;
  /** Use this device's generator when the oracle is unreachable (flagged in the audit). */
  entropyFallback: boolean;
}

export type EntropySourceId = 'crypto' | 'random.org' | 'drand';
export const ENTROPY_SOURCES: readonly EntropySourceId[] = ['crypto', 'random.org', 'drand'];
export const RANDOMNESS_MODES: readonly RandomnessMode[] = ['per-draw', 'seeded', 'beacon'];

/** Settings live per player: `bgf:settings:<slug>`. Outside a profile route (`slug === ''`) the
 *  global key `bgf:settings` is used, e.g. for the theme on the player picker. */
export const SETTINGS_KEY = 'bgf:settings';
export function settingsKey(slug: string): string {
  return slug ? `${SETTINGS_KEY}:${slug}` : SETTINGS_KEY;
}

export const DEFAULT_SETTINGS: Settings = {
  look: DEFAULT_PARTS.look,
  boardSet: DEFAULT_PARTS.board,
  pieceSet: DEFAULT_PARTS.pieces,
  rendererId: 'svg2d',
  homeSidePreference: 'table',
  flipBoard: false,
  reducedMotion: 'system',
  sound: true,
  peer: { host: '', port: '', path: '', secure: true, key: '' },
  iceServers: '',
  sync: true,
  entropySource: 'crypto',
  randomnessMode: 'per-draw',
  randomOrgKey: '',
  entropyFallback: false,
};

/** What is actually persisted: the settings plus when they last changed (for device sync). */
type StoredSettings = Partial<Settings> & { updatedAt?: number };

type LegacySettings = StoredSettings & { homeSide?: HomeSide; themeId?: string };

/**
 * Older builds stored a per-viewer `homeSide` (now an explicit preference) and a single
 * `themeId` (now a look + board set + piece set; a known preset or composed id maps to its
 * parts, anything else keeps the defaults).
 */
export function migrateSettings(stored: LegacySettings | null): Partial<Settings> {
  if (!stored) return {};
  const { homeSide, themeId, updatedAt: _updatedAt, ...rest } = stored;
  const out: Partial<Settings> = { ...rest };
  if (out.homeSidePreference === undefined && (homeSide === 'left' || homeSide === 'right')) {
    out.homeSidePreference = homeSide;
  }
  if (themeId !== undefined && out.look === undefined) {
    const parts = parseThemeId(themeId);
    if (parts) {
      out.look = parts.look;
      out.boardSet = parts.board;
      out.pieceSet = parts.pieces;
    }
  }
  return out;
}

function load(slug: string): { settings: Settings; updatedAt: number } {
  const raw = readJson<LegacySettings>(settingsKey(slug));
  const stored = migrateSettings(raw);
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      ...stored,
      peer: { ...DEFAULT_SETTINGS.peer, ...(stored.peer ?? {}) },
    },
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

/**
 * Keep only known settings keys with the right primitive types; anything else falls back to the
 * defaults. Used for imports and for data arriving from another device.
 */
export function sanitizeSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS };
  const migrated = migrateSettings(value as LegacySettings);
  const out: Settings = { ...DEFAULT_SETTINGS, peer: { ...DEFAULT_SETTINGS.peer } };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const candidate = migrated[key];
    if (candidate === undefined) continue;
    if (key === 'peer') {
      if (typeof candidate === 'object' && candidate !== null) {
        const peer = candidate as Partial<Settings['peer']>;
        for (const pk of Object.keys(DEFAULT_SETTINGS.peer) as (keyof Settings['peer'])[]) {
          const pv = peer[pk];
          if (typeof pv === typeof DEFAULT_SETTINGS.peer[pk]) {
            (out.peer as unknown as Record<string, unknown>)[pk] = pv;
          }
        }
      }
      continue;
    }
    if (typeof candidate === typeof DEFAULT_SETTINGS[key]) {
      (out as unknown as Record<string, unknown>)[key] = candidate;
    }
  }
  if (!ENTROPY_SOURCES.includes(out.entropySource))
    out.entropySource = DEFAULT_SETTINGS.entropySource;
  if (!RANDOMNESS_MODES.includes(out.randomnessMode))
    out.randomnessMode = DEFAULT_SETTINGS.randomnessMode;
  return out;
}

/** Resolve the preference against the table layout for the seat being viewed from. */
export function effectiveHomeSide(preference: HomeSidePreference, tableSide: HomeSide): HomeSide {
  return preference === 'table' ? tableSide : preference;
}

type SettingsStore = ReturnType<typeof createStore<Settings>>;
const stores = new Map<string, SettingsStore>();
const updatedAts = new Map<string, number>();

function storeFor(slug: string): SettingsStore {
  let s = stores.get(slug);
  if (!s) {
    const loaded = load(slug);
    s = createStore<Settings>(loaded.settings);
    stores.set(slug, s);
    updatedAts.set(slug, loaded.updatedAt);
  }
  return s;
}

export function getSettings(slug = ''): Settings {
  return storeFor(slug).get();
}

/** When this player's settings last changed (0 when never written). */
export function getSettingsUpdatedAt(slug = ''): number {
  storeFor(slug);
  return updatedAts.get(slug) ?? 0;
}

function persist(slug: string, next: Settings, updatedAt: number): void {
  const s = storeFor(slug);
  updatedAts.set(slug, updatedAt);
  s.set(next);
  writeJson(settingsKey(slug), { ...next, updatedAt } satisfies StoredSettings);
}

export function updateSettings(
  slug: string,
  patch: Partial<Settings>,
  opts: { updatedAt?: number } = {},
): void {
  persist(slug, { ...storeFor(slug).get(), ...patch }, opts.updatedAt ?? Date.now());
}

/** Replace every setting (e.g. with a copy from another device) with an explicit timestamp. */
export function replaceSettings(slug: string, settings: Settings, updatedAt: number): void {
  persist(slug, sanitizeSettings(settings), updatedAt);
}

export function resetSettings(slug = ''): void {
  persist(slug, DEFAULT_SETTINGS, Date.now());
}

export function subscribeSettings(slug: string, listener: () => void): () => void {
  return storeFor(slug).subscribe(listener);
}

/** Drop cached stores (tests). */
export function resetSettingsCacheForTests(): void {
  stores.clear();
  updatedAts.clear();
}

/**
 * Settings of the profile in scope (the `:profile` route segment), or the global settings when
 * rendered outside a profile. Pass `slug` to force a specific profile.
 */
export function useSettings(slug?: string): [Settings, (patch: Partial<Settings>) => void] {
  const ctx = useOptionalProfile();
  const key = slug ?? ctx?.slug ?? '';
  const s = storeFor(key);
  const settings = useSyncExternalStore(s.subscribe, s.get, s.get);
  const update = useCallback((patch: Partial<Settings>) => updateSettings(key, patch), [key]);
  return [settings, update];
}

/** Parse the ICE server textarea into RTCIceServer objects; malformed lines are skipped. */
export function parseIceServers(text: string): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [url, username, credential] = line.split('|').map((s) => s.trim());
    if (!url || !/^(stun|stuns|turn|turns):/.test(url)) continue;
    const server: RTCIceServer = { urls: url };
    if (username) server.username = username;
    if (credential) server.credential = credential;
    out.push(server);
  }
  return out;
}

/** Effective reduced-motion flag, honouring the OS preference when set to 'system'. */
export function resolveReducedMotion(setting: ReducedMotionSetting): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
