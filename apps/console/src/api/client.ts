import type { DealerSettings, GamePreset, ManagerEvent, TableInfo, TableStatus } from '@bgf/dealer';
import type { TableSnapshot } from '@bgf/protocol';
import type { TableConfig } from '@bgf/ofc-engine';

export type { DealerSettings, GamePreset, ManagerEvent, TableInfo, TableStatus };

export type PublicSettings = Omit<DealerSettings, 'randomOrgApiKey'> & {
  randomOrgApiKey: string;
  hasRandomOrgKey: boolean;
};

export interface StatusResponse {
  ok: boolean;
  /** Missing on the dealer runtime; `'platform'` for the hosted club platform. */
  mode?: 'dealer' | 'platform';
  version: string;
  dataDir: string;
  host: string;
  port: number;
  uptimeMs: number;
  tables: number;
  running: number;
  consoleBuilt: boolean;
  dealer: { id: string; name: string; avatar?: string };
  settings: PublicSettings;
  // Platform status fields (present when `mode === 'platform'`).
  dev?: boolean;
  appUrl?: string;
  clubs?: number;
  platformPublicKey?: string;
  store?: { kind: 'file' | 'memory'; dataDir: string | null; pendingWrites: number };
  signedIn?: { profileId: string; name: string } | null;
  /** The public play-money club, when the platform hosts one. */
  house?: { clubId: string; name: string; joinGrant: number; faucet: number } | null;
}

export interface TableDetail extends TableInfo {
  events: ManagerEvent[];
}

export interface AutopilotInfo {
  enabled: boolean;
  pending?: { reason: string; at: number };
}

export interface LedgerResponse {
  balances: number[];
  unsettled: number[];
  plan: Array<{ from: number; to: number; points: number; amount: number }>;
  entries: unknown[];
  multiplier: number;
  mode: 'up' | 'buyin';
  buyIn: number | null;
  names: (string | null)[];
}

export interface Ruleset {
  name: string;
  config: TableConfig;
  description: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

const TOKEN_KEY = 'dealer-console-token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

/** Base of the API. The console is served by the dealer itself, so relative paths work; a Vite
 *  dev server proxies `/api` to the runtime. */
export const API_BASE = (import.meta.env?.VITE_API_BASE as string | undefined) ?? '';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, b.error ?? 'error', b.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  status: () => request<StatusResponse>('/status'),
  settings: () => request<PublicSettings>('/settings'),
  updateSettings: (patch: Partial<DealerSettings>) =>
    request<PublicSettings>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  presets: (game: string) => request<GamePreset[]>(`/presets?game=${encodeURIComponent(game)}`),
  rulesets: () => request<Ruleset[]>('/rulesets'),
  saveRuleset: (name: string, config: unknown) =>
    request<{ name: string; config: TableConfig }>(`/rulesets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  deleteRuleset: (name: string) =>
    request<{ ok: true }>(`/rulesets/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  tables: () => request<TableInfo[]>('/tables'),
  table: (id: string) => request<TableDetail>(`/tables/${encodeURIComponent(id)}`),
  createTable: (body: {
    game: string;
    config?: unknown;
    seats?: number;
    name?: string;
    code?: string;
    entropy?: string;
    randomness?: string;
    fallback?: boolean;
    options?: Record<string, unknown>;
  }) => request<TableInfo>('/tables', { method: 'POST', body: JSON.stringify(body) }),
  resume: (id: string) =>
    request<TableInfo>(`/tables/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  stop: (id: string) =>
    request<TableInfo>(`/tables/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  remove: (id: string, purge = false) =>
    request<{ ok: true }>(`/tables/${encodeURIComponent(id)}/remove`, {
      method: 'POST',
      body: JSON.stringify({ purge }),
    }),
  command: (id: string, command: unknown) =>
    request<{ seq: number }>(`/tables/${encodeURIComponent(id)}/command`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),
  snapshot: (id: string) => request<TableSnapshot>(`/tables/${encodeURIComponent(id)}/snapshot`),
  ledger: (id: string) => request<LedgerResponse>(`/tables/${encodeURIComponent(id)}/ledger`),
  auditUrl: (id: string) => {
    const token = getToken();
    return `${API_BASE}/api/tables/${encodeURIComponent(id)}/audit${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  },
};

/** Live events over server-sent events; the token travels as a query parameter (EventSource has no headers). */
export function subscribeEvents(
  onEvent: (event: ManagerEvent) => void,
  onState?: (state: 'open' | 'error') => void,
): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const token = getToken();
  const es = new EventSource(
    `${API_BASE}/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`,
  );
  const handler = (ev: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(ev.data) as ManagerEvent;
      if (parsed && typeof parsed.type === 'string') onEvent(parsed);
    } catch {
      /* ignore malformed */
    }
  };
  for (const type of [
    'created',
    'resumed',
    'stopped',
    'removed',
    'seat',
    'action',
    'error',
    'settings',
    'message',
  ]) {
    es.addEventListener(type, handler as EventListener);
  }
  es.onopen = () => onState?.('open');
  es.onerror = () => onState?.('error');
  return () => es.close();
}
