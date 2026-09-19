import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { memoryProvider } from '@bgf/protocol';
import type { DealerEvent } from '../src/index.js';
import { createDealer, loadOrCreateProfile, loadTable, main } from '../src/index.js';
import { joinAs, tempDir, until } from './helpers.js';

describe('createDealer', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir()));
  afterEach(() => cleanup());

  it('hosts backgammon, seats a guest, applies its commands and persists every step', async () => {
    const provider = memoryProvider();
    const events: DealerEvent[] = [];
    const dealer = await createDealer({
      game: 'backgammon',
      dataDir: dir,
      transport: provider,
      code: 'TEST01',
      config: { length: 3 },
      appUrl: 'http://localhost:5173/',
    });
    let persisted = -1;
    dealer.onEvent((e) => {
      events.push(e);
      if (e.type === 'saved') persisted = dealer.snapshot().seq;
    });
    await dealer.start();
    expect(dealer.code).toBe('TEST01');
    expect(dealer.inviteLink).toBe('http://localhost:5173/#/backgammon/join/TEST01');
    expect(dealer.profile.name).toBe('Dealer');
    expect(dealer.profile).not.toHaveProperty('privateKey');

    // Dealer mode: the runtime takes no seat, so guests fill seats 0 and 1.
    expect(dealer.snapshot().hostSeat).toBeNull();
    expect(dealer.snapshot().seats).toEqual([null, null]);
    const guest = await joinAs(await provider.join('TEST01'), 'guest-1', 'Bob');
    expect(guest.getState().status).toBe('joined');
    expect(guest.getState().seat).toBe(0);
    await until(() => events.some((e) => e.type === 'seat' && e.connected), 3000, 'seat event');
    const other = await joinAs(await provider.join('TEST01'), 'guest-2', 'Carol');
    expect(other.getState().seat).toBe(1);

    guest.send({ type: 'start-game' });
    await until(() => dealer.snapshot().seq >= 1, 3000, 'start-game');
    guest.send({ type: 'opening-roll' });
    other.send({ type: 'opening-roll' });
    await until(() => dealer.snapshot().seq >= 3, 3000, 'opening rolls');
    const match = dealer.snapshot().state as { game: { phase: { kind: string } } };
    expect(['moving', 'opening']).toContain(match.game.phase.kind); // a tie re-rolls
    expect(events.filter((e) => e.type === 'action').length).toBeGreaterThanOrEqual(3);
    other.close();

    const seqNow = dealer.snapshot().seq;
    await until(() => persisted === seqNow, 3000, 'persist');
    guest.close();
    await dealer.stop();
    expect(events.at(-1)).toEqual({ type: 'stopped' });
    expect((await loadTable(dir, dealer.tableId))?.snapshot.seq).toBe(seqNow);
  });

  it('resumes a persisted table with the same id, seq and code', async () => {
    const provider = memoryProvider();
    const first = await createDealer({ game: 'backgammon', dataDir: dir, transport: provider });
    await first.start();
    const guest = await joinAs(await provider.join(first.code), 'guest-1', 'Bob');
    guest.send({ type: 'start-game' });
    await until(() => first.snapshot().seq >= 1, 3000, 'start-game');
    guest.close();
    await first.stop();

    const second = await createDealer({
      game: 'ofc', // ignored: the saved record decides
      dataDir: dir,
      transport: memoryProvider(),
      resume: first.code,
    });
    expect(second.game).toBe('backgammon');
    expect(second.tableId).toBe(first.tableId);
    expect(second.code).toBe(first.code);
    expect(second.snapshot().seq).toBe(1);
    await second.start();
    await second.stop();
    await expect(
      createDealer({ game: 'ofc', dataDir: dir, transport: memoryProvider(), resume: 'NOPE' }),
    ).rejects.toThrow(/no saved table/);
  });

  it('builds an OFC table from a rules file and reuses the dealer profile keys', async () => {
    const rules = join(dir, 'rules.json');
    await writeFile(
      rules,
      JSON.stringify({ variant: 'pineapple27', seats: 3, scoring: { mode: 'buyin', buyIn: 100 } }),
    );
    const before = await loadOrCreateProfile(dir, 'House');
    const lines: string[] = [];
    const io = {
      log: (l: string) => lines.push(l),
      error: (l: string) => lines.push(`ERR ${l}`),
      waitForSignal: () => new Promise<void>((r) => setTimeout(r, 200)),
      stopPollMs: 50,
    };
    // `main` with a memory transport is not wired (it always uses PeerJS), so drive the library.
    const dealer = await createDealer({
      game: 'ofc',
      dataDir: dir,
      transport: memoryProvider(),
      config: JSON.parse(await (await import('node:fs/promises')).readFile(rules, 'utf8')),
      profile: { name: 'House' },
    });
    const config = dealer.snapshot().config as {
      variant: string;
      seats: number;
      scoring: { mode: string; buyIn?: number };
    };
    expect(config.variant).toBe('pineapple27');
    expect(config.seats).toBe(3);
    expect(config.scoring).toMatchObject({ mode: 'buyin', buyIn: 100 });
    expect(dealer.snapshot().seats).toEqual([null, null, null]);
    expect(dealer.snapshot().dealer?.id).toBe(before.id);
    expect(dealer.profile.publicKey).toBe(before.publicKey);
    expect(dealer.profile.id).toBe(before.id);
    await dealer.stop();
    expect((await loadOrCreateProfile(dir, 'House')).privateKey).toBe(before.privateKey);

    // CLI paths that need no network: list, status, stop, help, bad args.
    expect(await main(['list', '--data', dir], io)).toBe(0);
    expect(lines.at(-1)).toContain(dealer.tableId);
    expect(await main(['status', dealer.code, '--data', dir], io)).toBe(0);
    expect(lines.at(-2)).toContain('pineapple27');
    expect(await main(['stop', dealer.code, '--data', dir], io)).toBe(0);
    expect(await main(['status', 'NOPE', '--data', dir], io)).toBe(1);
    expect(await main(['help'], io)).toBe(0);
    expect(await main(['host'], io)).toBe(2);
  });
});

describe('unattended OFC from a terminal', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir()));
  afterEach(() => cleanup());
  it('deals the hand itself once three guests sit down, and the next when everyone is ready', async () => {
    const provider = memoryProvider();
    const dealer = await createDealer({
      game: 'ofc',
      dataDir: dir,
      transport: provider,
      seats: 3,
      config: { variant: 'pineapple', seats: 3 },
      code: 'AUTO01',
    });
    const events: DealerEvent[] = [];
    dealer.onEvent((e) => events.push(e));
    await dealer.start();
    const guests = [];
    for (const [id, name] of [
      ['g1', 'Ada'],
      ['g2', 'Bob'],
      ['g3', 'Cy'],
    ] as const) {
      guests.push(await joinAs(await provider.join('AUTO01'), id, name));
    }
    // Nobody pressed anything: the first hand is on the table.
    await until(() => dealer.snapshot().seq >= 1, 5000, 'first deal');
    let state = dealer.snapshot().state as { hand: { phase: string } | null; handNumber: number };
    expect(state.hand?.phase).toBe('setting');
    expect(events.some((e) => e.type === 'autopilot' && e.kind === 'applied')).toBe(true);

    // Everyone sets their cards (first fit) until the showdown.
    for (let guard = 0; guard < 80; guard++) {
      const full = dealer.snapshot().state as {
        hand: {
          phase: string;
          toAct: number | null;
          seats: Array<{
            pending: Array<{ rank: number; suit: string }>;
            rows: Record<'top' | 'middle' | 'bottom', unknown[]>;
            fantasyland: boolean;
            done: boolean;
          }>;
        } | null;
        config: { variant: string };
      };
      const hand = full.hand!;
      if (hand.phase !== 'setting') break;
      const fl = hand.seats.findIndex((s) => s.fantasyland && !s.done && s.pending.length > 0);
      const seat = hand.toAct ?? (fl >= 0 ? fl : null);
      if (seat === null) throw new Error('nobody to act');
      const me = hand.seats[seat]!;
      const cap = { top: 3, middle: 5, bottom: 5 } as const;
      const room = {
        top: cap.top - me.rows.top.length,
        middle: cap.middle - me.rows.middle.length,
        bottom: cap.bottom - me.rows.bottom.length,
      };
      const total = room.top + room.middle + room.bottom;
      const toPlace = me.fantasyland
        ? 13
        : Math.min(me.pending.length, me.pending.length === 5 ? 5 : 2);
      const placements: Array<{ card: unknown; row: 'top' | 'middle' | 'bottom' }> = [];
      const pending = me.pending.slice();
      for (const row of ['bottom', 'middle', 'top'] as const) {
        while (placements.length < Math.min(toPlace, total) && room[row] > 0 && pending.length) {
          placements.push({ card: pending.shift(), row });
          room[row]--;
        }
      }
      guests[seat]!.send({ type: 'place', placements, discards: pending });
      const before = dealer.snapshot().seq;
      await until(() => dealer.snapshot().seq > before, 5000, `seat ${seat} placed`);
    }
    state = dealer.snapshot().state as typeof state;
    expect(state.hand?.phase).toBe('showdown');

    // Everyone ready → the next hand deals itself.
    for (const g of guests) g.setReady(true);
    await until(
      () => (dealer.snapshot().state as typeof state).handNumber === 2,
      5000,
      'second hand',
    );
    expect((dealer.snapshot().state as typeof state).hand?.phase).toBe('setting');
    for (const g of guests) g.close();
    await dealer.stop();
  }, 30_000);
});
