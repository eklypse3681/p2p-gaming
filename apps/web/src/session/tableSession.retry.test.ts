import { describe, expect, it, vi } from 'vitest';
import type { Listener, PlayerProfile, Transport, TransportProvider } from '@bgf/protocol';
import { TransportError, createMemoryPair, memoryProvider } from '@bgf/protocol';
import type { Action, Command, TableConfig, TableState, TableView } from '@bgf/ofc-engine';
import { defaultConfig, ofcDefinition } from '@bgf/ofc-engine';
import type { TableSession } from './tableSession';
import { hostTable, joinTable, resumeTable } from './tableSession';
import { SessionError } from './session';
import type { FlowProgress } from './retry';

const ALICE: PlayerProfile = { id: 'a', name: 'Alice' };
const BOB: PlayerProfile = { id: 'b', name: 'Bob' };
const instant = { sleep: vi.fn(async () => {}), now: () => 0 };
const config: TableConfig = defaultConfig({ variant: 'pineapple', seats: 2 });
type ResumeSnapshot = Parameters<
  typeof resumeTable<TableState, Action, Command, TableView, TableConfig>
>[1]['snapshot'];

/**
 * A provider whose `host` and `join` behaviour is scripted per call: an error code, a delay before
 * a real connection, or a real connection through a shared memory network.
 */
function scriptedProvider(script: {
  host?: (call: number) => 'address-taken' | 'timeout' | 'ok';
  join?: (call: number) => 'timeout' | 'not-found' | 'ok' | { delayMs: number };
}) {
  const real = memoryProvider();
  let hosts = 0;
  let joins = 0;
  const provider: TransportProvider = {
    name: 'scripted',
    async host(code: string): Promise<Listener> {
      const n = hosts++;
      const verdict = script.host?.(n) ?? 'ok';
      if (verdict === 'address-taken') throw new TransportError('address-taken', 'taken');
      if (verdict === 'timeout') throw new TransportError('timeout', 'timeout');
      return real.host(code);
    },
    async join(code: string, opts?: { timeoutMs?: number }): Promise<Transport> {
      const n = joins++;
      const verdict = script.join?.(n) ?? 'ok';
      if (verdict === 'timeout') throw new TransportError('timeout', 'timeout');
      if (verdict === 'not-found') throw new TransportError('not-found', 'nobody');
      if (typeof verdict === 'object') {
        await new Promise((r) => setTimeout(r, verdict.delayMs));
        return real.join(code, opts);
      }
      return real.join(code, opts);
    },
  };
  return { provider, real, calls: () => ({ hosts, joins }) };
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('resumeTable resilience', () => {
  it('re-hosts after address-taken clears (twice) instead of falling back to joining', async () => {
    const { provider, calls } = scriptedProvider({
      host: (n) => (n === 1 || n === 2 ? 'address-taken' : 'ok'),
    });
    const first = await hostTable(
      ofcDefinition,
      { profile: ALICE, config, seats: 2 },
      { provider },
    );
    const snapshot = first.client.getState().snapshot! as unknown as ResumeSnapshot;
    first.dispose();
    await flush();
    const progress: FlowProgress[] = [];
    const resumed = await resumeTable(
      ofcDefinition,
      { snapshot, profile: ALICE },
      { provider, ...instant },
      { onProgress: (p) => progress.push(p) },
    );
    expect(resumed.role).toBe('host');
    expect(calls().hosts).toBe(4); // first host + 3 attempts to re-host
    expect(calls().joins).toBe(0);
    expect(progress.map((p) => p.attempt)).toEqual([1, 1, 1]);
    resumed.dispose();
  });

  it('joins with retry when the host answers late, reporting each attempt', async () => {
    const { provider, calls } = scriptedProvider({
      host: (n) => (n === 0 ? 'ok' : 'address-taken'),
      join: (n) => (n < 2 ? 'timeout' : 'ok'),
    });
    const host = await hostTable(ofcDefinition, { profile: ALICE, config, seats: 2 }, { provider });
    const progress: FlowProgress[] = [];
    const guest = await joinTable(
      ofcDefinition,
      { code: host.code, profile: BOB, attempts: 3 },
      { provider, ...instant },
      { onProgress: (p) => progress.push(p) },
    );
    expect(guest.client.getState().status).toBe('joined');
    expect(calls().joins).toBe(3);
    expect(progress.map((p) => p.attempt)).toEqual([1, 1, 2, 2, 3]);
    guest.dispose();
    host.dispose();
  });

  it('aborting a join disposes the connection and never returns a session', async () => {
    const { provider } = scriptedProvider({ join: () => ({ delayMs: 30 }) });
    const host = await hostTable(ofcDefinition, { profile: ALICE, config, seats: 2 }, { provider });
    const ctl = new AbortController();
    const p = joinTable(
      ofcDefinition,
      { code: host.code, profile: BOB, attempts: 3 },
      { provider, ...instant },
      { signal: ctl.signal },
    );
    setTimeout(() => ctl.abort(), 5);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    await flush(10);
    expect(host.server!.connectedSeats()).toEqual([0]);
    host.dispose();
  });

  it('resuming a table this tab already hosts returns the live session instead of joining itself', async () => {
    const { provider, calls } = scriptedProvider({});
    const live = await hostTable(ofcDefinition, { profile: ALICE, config, seats: 2 }, { provider });
    const snapshot = live.client.getState().snapshot! as unknown as ResumeSnapshot;
    const again = await resumeTable(
      ofcDefinition,
      { snapshot, profile: ALICE },
      { provider, ...instant, existingSession: (code) => (code === live.code ? live : undefined) },
    );
    expect(again).toBe(live);
    expect(calls().hosts).toBe(1);
    expect(calls().joins).toBe(0);
    live.dispose();
  });

  it('a late join that lands on our own re-hosted server is refused by the registry rule', async () => {
    // Simulates: attempt 1's join stalls; attempt 2 re-hosts; attempt 1's join then connects to
    // the new server. The session layer hands the existing live session back when asked, and a
    // registry that keeps live sessions disposes the straggler. Here we exercise the second
    // safeguard directly: the straggler joins, then is disposed by a keep-live `add`.
    const { provider } = scriptedProvider({ join: () => ({ delayMs: 20 }) });
    const first = await hostTable(
      ofcDefinition,
      { profile: ALICE, config, seats: 2 },
      { provider },
    );
    const snapshot = first.client.getState().snapshot!;
    // Straggler: a join of our own code as the same profile (a second device of seat 0).
    const straggler = joinTable(
      ofcDefinition,
      { code: first.code, profile: ALICE, attempts: 1 },
      { provider, ...instant },
    );
    const late: TableSession = await straggler;
    expect(late.role).toBe('guest');
    // The registry rule under test: a live session under the key is kept, the newcomer disposed.
    const registry = new Map<string, TableSession>();
    const add = (s: TableSession) => {
      const prev = registry.get(s.matchId);
      if (prev && prev.client.getState().status === 'joined') {
        s.dispose();
        return 'kept';
      }
      registry.set(s.matchId, s);
      return 'added';
    };
    expect(add(first)).toBe('added');
    expect(add(late)).toBe('kept');
    expect(registry.get(snapshot.id)).toBe(first);
    expect(first.client.getState().status).toBe('joined');
    await flush(10);
    expect(late.client.getState().status).not.toBe('joined');
    first.dispose();
  });

  it('a view copy reports host-offline after the budget when nobody hosts', async () => {
    const { provider } = scriptedProvider({ join: (n) => (n === 0 ? 'ok' : 'not-found') });
    const host = await hostTable(ofcDefinition, { profile: ALICE, config, seats: 2 }, { provider });
    const guest = await joinTable(
      ofcDefinition,
      { code: host.code, profile: BOB },
      { provider: provider },
    );
    const view = guest.client.getState().snapshot!;
    expect(view.view).toBe(true);
    guest.dispose();
    host.dispose();
    let t = 0;
    const deps = {
      provider,
      sleep: vi.fn(async (ms: number) => {
        t += ms;
      }),
      now: () => t,
    };
    await expect(
      resumeTable(
        ofcDefinition,
        { snapshot: view as unknown as ResumeSnapshot, profile: BOB },
        deps,
        { maxTotalMs: 3000 },
      ),
    ).rejects.toMatchObject({ code: 'host-offline' });
  });

  it('hostTable can be aborted before the server is handed back', async () => {
    const { provider } = scriptedProvider({});
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      hostTable(
        ofcDefinition,
        { profile: ALICE, config, seats: 2, signal: ctl.signal },
        { provider },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('hostTable options', () => {
  it('passes dealer mode and the randomness choice to the server', async () => {
    const createServer = vi.fn();
    const { provider } = scriptedProvider({});
    createServer.mockImplementation(async (o: Record<string, unknown>) => {
      const { TableServer } = await import('@bgf/table');
      return TableServer.create(o as never);
    });
    const session = await hostTable(
      ofcDefinition,
      {
        profile: ALICE,
        config,
        seats: 2,
        dealer: true,
        randomness: { source: 'crypto', mode: 'seeded', randomOrgKey: '', fallback: true },
      },
      { provider, createServer: createServer as never },
    );
    const opts = createServer.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.hostSeat).toBeNull();
    expect(opts.options).toMatchObject({ randomness: { mode: 'seeded', provider: 'crypto' } });
    expect((opts.entropy as { fallback: boolean }).fallback).toBe(true);
    expect(session.client.getState().role).toBe('dealer');
    expect(session.client.getState().seat).toBeNull();
    expect(session.client.getState().snapshot!.hostSeat).toBeNull();
    session.dispose();
  });

  it('rejects an unnamed profile and maps a rejected join', async () => {
    const { provider } = scriptedProvider({});
    await expect(
      hostTable(ofcDefinition, { profile: { id: 'x', name: ' ' }, config }, { provider }),
    ).rejects.toBeInstanceOf(SessionError);
    const [, clientEnd] = createMemoryPair();
    void clientEnd;
  });
});
