import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryProvider } from '@bgf/protocol';
import type { ConsoleServer } from '../src/index.js';
import { DealerManager, startConsoleServer } from '../src/index.js';
import { joinAs, tempDir, until } from './helpers.js';

async function api(base: string, path: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}api${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

/** Read SSE events from `/api/events` until `pred` matches or the timeout passes. */
async function waitForSse(
  base: string,
  pred: (event: { type: string; data: Record<string, unknown> }) => boolean,
  ms = 5000,
  token?: string,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const res = await fetch(`${base}api/events${token ? `?token=${token}` : ''}`, {
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const type = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!data) continue;
        const event = { type, data: JSON.parse(data) as Record<string, unknown> };
        if (pred(event)) {
          clearTimeout(timer);
          controller.abort();
          return event;
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  }
  clearTimeout(timer);
  throw new Error('SSE event not seen');
}

describe('console server', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: ConsoleServer | null = null;
  let manager: DealerManager;
  beforeEach(async () => ({ dir, cleanup } = await tempDir()));
  afterEach(async () => {
    await server?.close();
    server = null;
    await manager?.close();
    await cleanup();
  });

  it('exposes status, presets, tables, snapshots, ledger and live events', async () => {
    const provider = memoryProvider();
    manager = await DealerManager.open({ dataDir: dir, transportFor: () => provider });
    server = await startConsoleServer({ manager, port: 0, staticDir: `${dir}/no-console` });
    const base = server.url;

    const status = await api(base, '/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ ok: true, tables: 0, running: 0, consoleBuilt: false });
    expect((status.body!.settings as { hasRandomOrgKey: boolean }).hasRandomOrgKey).toBe(false);

    // Static: not built → friendly page, API untouched.
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Console not built');

    const presets = await api(base, '/presets?game=ofc');
    expect((presets.body as unknown as Array<{ id: string }>).map((p) => p.id)).toContain(
      'standard-pineapple',
    );
    expect((await api(base, '/presets?game=chess')).status).toBe(400);

    const preset = (presets.body as unknown as Array<{ id: string; config: object }>).find(
      (p) => p.id === 'standard-pineapple',
    )!;
    const created = await api(base, '/tables', {
      method: 'POST',
      body: JSON.stringify({
        game: 'ofc',
        config: { ...preset.config, seats: 2 },
        name: 'API table',
        code: 'API001',
      }),
    });
    expect(created.status).toBe(201);
    const id = created.body!.id as string;
    expect(created.body).toMatchObject({ code: 'API001', status: 'running', name: 'API table' });

    const bad = await api(base, '/tables', {
      method: 'POST',
      body: JSON.stringify({ game: 'ofc', config: { seats: 9 } }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'invalid' });

    // SSE receives the seat event when a guest joins.
    const seatEvent = waitForSse(
      base,
      (e) => e.type === 'seat' && (e.data.data as { name: string }).name === 'Bob',
    );
    const guest = await joinAs(await provider.join('API001'), 'g1', 'Bob');
    expect(guest.getState().seat).toBe(0);
    expect((await seatEvent).type).toBe('seat');

    const detail = await api(base, `/tables/${id}`);
    expect(detail.status).toBe(200);
    expect((detail.body!.seatsInfo as Array<{ name: string | null }>)[0]!.name).toBe('Bob');
    expect(Array.isArray(detail.body!.events)).toBe(true);

    const snapshot = await api(base, `/tables/${id}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body!.view).toBe(true);
    expect(JSON.stringify(snapshot.body)).not.toContain('"deck"');
    expect((await api(base, `/tables/${id}/ledger`)).body).toMatchObject({ mode: 'up' });
    expect((await api(base, `/tables/${id}/audit`)).status).toBe(200);
    expect((await api(base, '/tables/nope/snapshot')).status).toBe(404);

    // The second seat fills: the unattended table deals by itself; a manual "start" on top of
    // the running hand is refused, while a dealer command that applies (adjust) goes through.
    const other = await joinAs(await provider.join('API001'), 'g2', 'Carol');
    await until(() => (other.getState().snapshot?.seq ?? 0) >= 1, 3000, 'guest saw the deal');
    expect(
      ((await api(base, `/tables/${id}`)).body!.autopilot as { enabled: boolean }).enabled,
    ).toBe(true);
    const refused = await api(base, `/tables/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: { type: 'start' } }),
    });
    expect(refused.status).toBe(422);
    const adjusted = await api(base, `/tables/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: { type: 'adjust', seat: 0, points: 1, note: 'test' } }),
    });
    expect(adjusted.status).toBe(200);
    expect(adjusted.body!.seq).toBeGreaterThanOrEqual(2);
    guest.close();
    other.close();

    expect((await api(base, `/tables/${id}/stop`, { method: 'POST' })).body).toMatchObject({
      status: 'stopped',
    });
    expect((await api(base, `/tables/${id}/resume`, { method: 'POST' })).body).toMatchObject({
      status: 'running',
    });
    expect((await api(base, `/tables/${id}/remove`, { method: 'POST' })).status).toBe(409);
    await api(base, `/tables/${id}/stop`, { method: 'POST' });
    expect(
      (
        await api(base, `/tables/${id}/remove`, {
          method: 'POST',
          body: JSON.stringify({ purge: true }),
        })
      ).status,
    ).toBe(200);
    expect(((await api(base, '/tables')).body as unknown as unknown[]).length).toBe(0);

    // Settings round trip; the key is masked on the way out.
    const put = await api(base, '/settings', {
      method: 'PUT',
      body: JSON.stringify({ dealerName: 'House', randomOrgApiKey: 'secret-key-9999' }),
    });
    expect(put.body).toMatchObject({
      dealerName: 'House',
      randomOrgApiKey: '••••9999',
      hasRandomOrgKey: true,
    });
    expect(
      (
        await api(base, '/settings', {
          method: 'PUT',
          body: JSON.stringify({ defaultRandomness: 'lucky' }),
        })
      ).status,
    ).toBe(400);

    // Rule sets.
    expect(
      (
        await api(base, '/rulesets/Ours', {
          method: 'PUT',
          body: JSON.stringify({ config: { variant: 'ofc' } }),
        })
      ).status,
    ).toBe(200);
    expect(
      ((await api(base, '/rulesets')).body as unknown as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    ).toEqual(['Ours']);
    expect((await api(base, '/rulesets/Ours', { method: 'DELETE' })).status).toBe(200);
    expect((await api(base, '/nothing')).status).toBe(404);
  });

  it('requires the token when configured and refuses non-loopback hosts without one', async () => {
    manager = await DealerManager.open({ dataDir: dir, transportFor: () => memoryProvider() });
    await expect(startConsoleServer({ manager, port: 0, host: '0.0.0.0' })).rejects.toThrow(
      /token/,
    );
    server = await startConsoleServer({
      manager,
      port: 0,
      token: 's3cret',
      staticDir: `${dir}/none`,
    });
    expect((await api(server.url, '/status')).status).toBe(401);
    expect((await api(server.url, '/status', {}, 'wrong')).status).toBe(401);
    expect((await api(server.url, '/status', {}, 's3cret')).status).toBe(200);
    // SSE can only pass the token in the query string.
    const hello = await waitForSse(server.url, (e) => e.type === 'hello', 3000, 's3cret');
    expect(hello.type).toBe('hello');
    // The static page never needs the token (it is the login screen).
    expect((await fetch(server.url)).status).toBe(200);
  });

  it('serves a built console from the static directory', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const staticDir = `${dir}/console`;
    await mkdir(`${staticDir}/assets`, { recursive: true });
    await writeFile(
      `${staticDir}/index.html`,
      '<!doctype html><title>Dealer console</title><div id="root"></div>',
    );
    await writeFile(`${staticDir}/assets/app.js`, 'console.log(1)');
    manager = await DealerManager.open({ dataDir: dir, transportFor: () => memoryProvider() });
    server = await startConsoleServer({ manager, port: 0, staticDir });
    const index = await fetch(server.url);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('Dealer console');
    const js = await fetch(`${server.url}assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    // Unknown paths fall back to the SPA shell; traversal is refused.
    expect(await (await fetch(`${server.url}tables/abc`)).text()).toContain('Dealer console');
    expect((await fetch(`${server.url}..%2F..%2Fsettings.json`)).status).not.toBe(500);
    expect((await api(server.url, '/status')).body).toMatchObject({ consoleBuilt: true });
  });
});
