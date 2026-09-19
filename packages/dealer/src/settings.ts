import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RandomnessMode } from '@bgf/protocol';
import type { EntropySourceName } from './entropy.js';
import { isEntropySourceName } from './entropy.js';
import { DEFAULT_APP_URL } from './dealer.js';

/** Process-wide preferences of the dealer runtime, persisted in `<dataDir>/settings.json`. */
export interface DealerSettings {
  /** Base URL of the web app for invite links. */
  appUrl: string;
  /** Display name of the dealer profile. */
  dealerName: string;
  /** Randomness source used when a table does not name one. */
  defaultEntropy: EntropySourceName;
  /** random.org API key; empty = none. Never leaves this machine except in requests to random.org. */
  randomOrgApiKey: string;
  /** Randomness mode used when a table does not name one. */
  defaultRandomness: RandomnessMode;
  /** Bearer token the console must present; empty = none (fine on localhost). */
  consoleToken: string;
}

export const SETTINGS_FILE = 'settings.json';

export const DEFAULT_SETTINGS: DealerSettings = {
  appUrl: DEFAULT_APP_URL,
  dealerName: 'Dealer',
  defaultEntropy: 'crypto',
  randomOrgApiKey: '',
  defaultRandomness: 'per-draw',
  consoleToken: '',
};

export const RANDOMNESS_MODES: readonly RandomnessMode[] = ['per-draw', 'seeded', 'beacon'];

export function isRandomnessMode(value: unknown): value is RandomnessMode {
  return typeof value === 'string' && (RANDOMNESS_MODES as readonly string[]).includes(value);
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/** Merge a raw object into valid settings; unknown or malformed values fall back to defaults. */
export function normalizeSettings(
  raw: unknown,
  base: DealerSettings = DEFAULT_SETTINGS,
): DealerSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const appUrl = str(r.appUrl, base.appUrl).trim() || base.appUrl;
  return {
    appUrl: appUrl.endsWith('/') ? appUrl : `${appUrl}/`,
    dealerName: str(r.dealerName, base.dealerName).trim().slice(0, 40) || base.dealerName,
    defaultEntropy: isEntropySourceName(r.defaultEntropy) ? r.defaultEntropy : base.defaultEntropy,
    randomOrgApiKey: str(r.randomOrgApiKey, base.randomOrgApiKey).trim(),
    defaultRandomness: isRandomnessMode(r.defaultRandomness)
      ? r.defaultRandomness
      : base.defaultRandomness,
    consoleToken: str(r.consoleToken, base.consoleToken).trim(),
  };
}

export async function loadSettings(dataDir: string): Promise<DealerSettings> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, SETTINGS_FILE), 'utf8')) as unknown;
    return normalizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(dataDir: string, settings: DealerSettings): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, SETTINGS_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
}

/** What the console may see: the API key is masked, its presence is reported. */
export function publicSettings(settings: DealerSettings): Omit<
  DealerSettings,
  'randomOrgApiKey'
> & {
  randomOrgApiKey: string;
  hasRandomOrgKey: boolean;
} {
  const key = settings.randomOrgApiKey;
  return {
    ...settings,
    randomOrgApiKey: key ? `••••${key.slice(-4)}` : '',
    hasRandomOrgKey: key.length > 0,
  };
}
