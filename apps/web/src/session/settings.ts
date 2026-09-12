import { useCallback, useSyncExternalStore } from 'react';
import type { RendererId } from '../themes/theme';
import { DEFAULT_PARTS, parseThemeId } from '../themes';
import type { HomeSide } from '../board/contract';
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
}

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
};

type LegacySettings = Partial<Settings> & { homeSide?: HomeSide; themeId?: string };

/**
 * Older builds stored a per-viewer `homeSide` (now an explicit preference) and a single
 * `themeId` (now a look + board set + piece set; a known preset or composed id maps to its
 * parts, anything else keeps the defaults).
 */
export function migrateSettings(stored: LegacySettings | null): Partial<Settings> {
  if (!stored) return {};
  const { homeSide, themeId, ...rest } = stored;
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

function load(slug: string): Settings {
  const stored = migrateSettings(readJson<LegacySettings>(settingsKey(slug)));
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    peer: { ...DEFAULT_SETTINGS.peer, ...(stored.peer ?? {}) },
  };
}

/** Resolve the preference against the table layout for the seat being viewed from. */
export function effectiveHomeSide(preference: HomeSidePreference, tableSide: HomeSide): HomeSide {
  return preference === 'table' ? tableSide : preference;
}

type SettingsStore = ReturnType<typeof createStore<Settings>>;
const stores = new Map<string, SettingsStore>();

function storeFor(slug: string): SettingsStore {
  let s = stores.get(slug);
  if (!s) {
    s = createStore<Settings>(load(slug));
    stores.set(slug, s);
  }
  return s;
}

export function getSettings(slug = ''): Settings {
  return storeFor(slug).get();
}

export function updateSettings(slug: string, patch: Partial<Settings>): void {
  const s = storeFor(slug);
  const next = { ...s.get(), ...patch };
  s.set(next);
  writeJson(settingsKey(slug), next);
}

export function resetSettings(slug = ''): void {
  const s = storeFor(slug);
  s.set(DEFAULT_SETTINGS);
  writeJson(settingsKey(slug), DEFAULT_SETTINGS);
}

/** Drop cached stores (tests). */
export function resetSettingsCacheForTests(): void {
  stores.clear();
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
