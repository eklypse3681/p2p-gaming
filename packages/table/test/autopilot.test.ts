import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerProfile } from '@bgf/protocol';
import { DEALER_SEAT, createMemoryPair } from '@bgf/protocol';
import type { AutopilotEvent, GameDefinition } from '../src/index.js';
import { CommandError, TableClient, TableServer, seededRng } from '../src/index.js';

/**
 * Toy "rounds" game: a round opens when the table says so, every seat plays once, then the
 * round is over. The autopilot opens the first round when all seats are filled and present,
 * and the next one when every seat is ready (immediately) or after a countdown (config).
 */
interface RoundsState {
  round: number;
  open: boolean;
  played: number[];
}
type RoundsAction = { type: 'open'; round: number } | { type: 'play'; seat: number };
type RoundsCommand = { type: 'open' } | { type: 'play' };
interface RoundsConfig {
  next: 'ready' | 'countdown';
  delayMs: number;
  seats: number;
}

const rounds: GameDefinition<RoundsState, RoundsAction, RoundsCommand, RoundsState, RoundsConfig> =
  {
    id: 'rounds',
    minSeats: 2,
    maxSeats: 3,
    normalizeConfig: (raw) => ({
      next: 'ready',
      delayMs: 5_000,
      seats: 2,
      ...((raw as Partial<RoundsConfig>) ?? {}),
    }),
    init: () => ({ round: 0, open: false, played: [] }),
    validateCommand(raw) {
      const r = raw as { type?: unknown };
      if (r?.type === 'open' || r?.type === 'play') return { type: r.type } as RoundsCommand;
      return null;
    },
    command(state, seat, cmd) {
      if (cmd.type === 'open') {
        if (state.open) throw new CommandError('round-open', 'a round is open');
        return { type: 'open', round: state.round + 1 };
      }
      if (seat < 0) throw new CommandError('not-a-player', 'the dealer does not play');
      if (!state.open) throw new CommandError('closed', 'no round is open');
      return { type: 'play', seat };
    },
    reduce(state, action) {
      if (action.type === 'open') return { round: action.round, open: true, played: [] };
      const played = [...state.played, action.seat];
      return { ...state, played, open: played.length < 2 ? true : false };
    },
    view: (s) => s,
    dealerCommands: ['open'],
    resetsReadiness: (a) => a.type === 'open',
    autopilot(state, ctx) {
      if (state.open) return null;
      const everyone = ctx.seatsFilled.every(Boolean) && ctx.present.every(Boolean);
      if (!everyone) return null;
      if (state.round === 0) return { command: { type: 'open' }, reason: 'all seats taken' };
      if (ctx.config.next === 'countdown') {
        return {
          command: { type: 'open' },
          afterMs: ctx.config.delayMs,
          reason: 'next round countdown',
        };
      }
      if (ctx.ready.every(Boolean)) return { command: { type: 'open' }, reason: 'everyone ready' };
      return null;
    },
  };

const P = (id: string): PlayerProfile => ({ id, name: id.toUpperCase() });
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(0);
};

type Server = TableServer<RoundsState, RoundsAction, RoundsCommand, RoundsState, RoundsConfig>;
type Client = TableClient<RoundsState, RoundsAction, RoundsConfig>;

function connect(server: Server, profile: PlayerProfile): Client {
  const [serverEnd, clientEnd] = createMemoryPair('auto');
  server.accept(serverEnd);
  return new TableClient({ transport: clientEnd, profile, pingIntervalMs: 0 });
}

function table(opts: {
  hostSeat: number | null;
  options?: Record<string, unknown>;
  config?: Partial<RoundsConfig>;
}) {
  const events: AutopilotEvent[] = [];
  const server: Server = new TableServer({
    def: rounds,
    code: 'AUTO',
    host: P('host'),
    hostSeat: opts.hostSeat,
    seats: 2,
    config: opts.config,
    options: opts.options,
    rng: seededRng(1),
    now: () => Date.now(),
  });
  server.onAutopilot((e) => events.push(e));
  return { server, events };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('autopilot (unattended tables)', () => {
  it('is on for dealer-hosted tables: opens the first round as soon as both seats are filled and present', async () => {
    const { server, events } = table({ hostSeat: null });
    expect(server.autopilotStatus()).toEqual({ enabled: true });
    const a = connect(server, P('a'));
    await flush();
    expect(server.getSnapshot().state.open).toBe(false); // one seat still free
    const b = connect(server, P('b'));
    await flush();
    expect(server.getSnapshot().state).toMatchObject({ round: 1, open: true });
    expect(events).toEqual([{ kind: 'applied', reason: 'all seats taken', seq: 1 }]);
    // The action is attributed to the dealer seat.
    expect(a.getState().lastAction?.by).toBe(DEALER_SEAT);
    expect(b.getState().lastAction?.by).toBe(DEALER_SEAT);
    server.close();
  });

  it('is off for player-hosted tables unless options.autopilot is true', async () => {
    const plain = table({ hostSeat: 0 });
    connect(plain.server, P('host'));
    connect(plain.server, P('b'));
    await flush();
    expect(plain.server.autopilotStatus().enabled).toBe(false);
    expect(plain.server.getSnapshot().state.open).toBe(false);
    plain.server.close();

    const auto = table({ hostSeat: 0, options: { autopilot: true } });
    connect(auto.server, P('host'));
    connect(auto.server, P('b'));
    await flush();
    expect(auto.server.getSnapshot().state.open).toBe(true);
    auto.server.close();

    const off = table({ hostSeat: null, options: { autopilot: false } });
    connect(off.server, P('a'));
    connect(off.server, P('b'));
    await flush();
    expect(off.server.getSnapshot().state.open).toBe(false);
    off.server.close();
  });

  it('readiness: the next round opens when every seat is ready, and readiness clears when it opens', async () => {
    const { server, events } = table({ hostSeat: null });
    const a = connect(server, P('a'));
    const b = connect(server, P('b'));
    await flush();
    a.send({ type: 'play' });
    b.send({ type: 'play' });
    await flush();
    expect(server.getSnapshot().state).toMatchObject({ round: 1, open: false });
    a.setReady(true);
    await flush();
    expect(server.readiness()).toEqual([true, false]);
    expect(b.getState().ready).toEqual([true, false]);
    expect(server.getSnapshot().state.open).toBe(false);
    b.setReady(true);
    await flush();
    expect(server.getSnapshot().state).toMatchObject({ round: 2, open: true });
    expect(server.readiness()).toEqual([false, false]);
    expect(a.getState().ready).toEqual([false, false]);
    expect(events.map((e) => e.kind)).toEqual(['applied', 'applied']);
    // A dealer device may not toggle readiness.
    const dealer = new TableClient({
      transport: server.connectLocal(),
      profile: P('host'),
      pingIntervalMs: 0,
    });
    await flush();
    dealer.setReady(true);
    await flush();
    expect(dealer.getState().error?.code).toBe('not-seated');
    server.close();
  });

  it('countdown: schedules the next round, tells every client, and fires on time', async () => {
    const { server, events } = table({ hostSeat: null, config: { next: 'countdown' } });
    const a = connect(server, P('a'));
    const b = connect(server, P('b'));
    await flush();
    a.send({ type: 'play' });
    b.send({ type: 'play' });
    await flush();
    const at = Date.now() + 5_000;
    expect(server.autopilotStatus().pending).toEqual({ reason: 'next round countdown', at });
    expect(a.getState().autopilot).toEqual({ reason: 'next round countdown', at });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(server.getSnapshot().state.open).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();
    expect(server.getSnapshot().state).toMatchObject({ round: 2, open: true });
    expect(server.autopilotStatus().pending).toBeUndefined();
    expect(a.getState().autopilot).toBeNull();
    expect(events.map((e) => e.kind)).toEqual(['applied', 'scheduled', 'applied']);
    server.close();
  });

  it('countdown is cancelled when a player leaves and resumes when they are back', async () => {
    const { server, events } = table({ hostSeat: null, config: { next: 'countdown' } });
    const a = connect(server, P('a'));
    const b = connect(server, P('b'));
    await flush();
    a.send({ type: 'play' });
    b.send({ type: 'play' });
    await flush();
    expect(server.autopilotStatus().pending).toBeDefined();
    b.close();
    await flush();
    expect(server.autopilotStatus().pending).toBeUndefined();
    expect(a.getState().autopilot).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.getSnapshot().state.open).toBe(false);
    const b2 = connect(server, P('b'));
    await flush();
    expect(server.autopilotStatus().pending).toBeDefined();
    await vi.advanceTimersByTimeAsync(5_100);
    await flush();
    expect(server.getSnapshot().state).toMatchObject({ round: 2, open: true });
    expect(b2.getState().snapshot?.state.round).toBe(2);
    expect(events.filter((e) => e.kind === 'cancelled')).toHaveLength(1);
    server.close();
  });

  it('a refused decision is reported, not thrown, and a scheduled one is dropped on close', async () => {
    const broken: typeof rounds = {
      ...rounds,
      autopilot: (state, ctx) =>
        state.open || !ctx.seatsFilled.every(Boolean)
          ? null
          : { command: { type: 'play' }, reason: 'wrong command' },
    };
    const events: AutopilotEvent[] = [];
    const server = new TableServer({
      def: broken,
      code: 'BAD',
      host: P('host'),
      hostSeat: null,
      seats: 2,
      rng: seededRng(1),
    });
    server.onAutopilot((e) => events.push(e));
    connect(server, P('a'));
    connect(server, P('b'));
    await flush();
    expect(events[0]).toMatchObject({ kind: 'refused', code: 'not-a-player' });
    expect(server.getSnapshot().seq).toBe(0);
    server.close();

    const { server: s2 } = table({ hostSeat: null, config: { next: 'countdown' } });
    const a = connect(s2, P('a'));
    const b = connect(s2, P('b'));
    await flush();
    a.send({ type: 'play' });
    b.send({ type: 'play' });
    await flush();
    expect(s2.autopilotStatus().pending).toBeDefined();
    s2.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s2.getSnapshot().state.round).toBe(1);
  });
});
