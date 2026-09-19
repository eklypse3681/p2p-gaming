import { vi } from 'vitest';
import type { GamePreset, ManagerEvent, TableInfo } from '../api/client';
import { RULES_PRESETS } from '@bgf/ofc-engine';

export function fakeTable(over: Partial<TableInfo> = {}): TableInfo {
  return {
    id: 'tbl-1',
    code: 'ABC123',
    game: 'ofc',
    name: 'Friday',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    seats: 3,
    inviteLink: 'http://app/#/ofc/join/ABC123',
    seatsInfo: [
      { seat: 0, name: 'Bob', connected: true, devices: 1 },
      { seat: 1, name: 'Carol', connected: false, devices: 0 },
      { seat: 2, name: null, connected: false, devices: 0 },
    ],
    occupied: 2,
    seq: 4,
    summary: {
      variant: 'pineapple',
      seats: 3,
      handNumber: 1,
      scores: [3, -3, 0],
      status: 'playing',
    },
    rules: 'Pineapple · 3 players · points up · royalties on · FL QQ 14',
    randomness: { mode: 'per-draw', provider: 'crypto' },
    autopilot: { enabled: true },
    ready: [],
    dealer: { id: 'd', name: 'House' },
    ...over,
  };
}

export const OFC_PRESETS: GamePreset[] = RULES_PRESETS.map((p) => ({ ...p, config: p.config }));

/** A `fetch` stub routing `/api/...` calls to handlers; returns the mock so tests can inspect calls. */
export function installFakeApi(
  routes: Record<string, (init: RequestInit, url: URL) => unknown | Promise<unknown>>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://console.test');
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`;
    const handler = routes[key] ?? routes[`${(init.method ?? 'GET').toUpperCase()} *`];
    if (!handler) {
      return new Response(JSON.stringify({ error: 'not-found', message: `no route ${key}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    try {
      const body = await handler(init, url);
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (e) {
      const err = e as { status?: number; message?: string; code?: string };
      return new Response(
        JSON.stringify({ error: err.code ?? 'error', message: err.message ?? 'error' }),
        { status: err.status ?? 500, headers: { 'content-type': 'application/json' } },
      );
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Minimal EventSource double: tests push events through `emit`. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Set<(ev: MessageEvent<string>) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent<string>) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  close() {
    this.closed = true;
  }
  /** Dealer `ManagerEvent`s or platform events: anything with a `type` the page listens for. */
  emit(event: ManagerEvent | { type: string; [key: string]: unknown }) {
    for (const fn of this.listeners.get(event.type) ?? [])
      fn({ data: JSON.stringify(event) } as MessageEvent<string>);
  }
}
