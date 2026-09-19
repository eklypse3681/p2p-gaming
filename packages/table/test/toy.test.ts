import { describe, expect, it } from 'vitest';
import type { PlayerProfile, TableServerMessage, TableSnapshot } from '@bgf/protocol';
import { PROTOCOL_VERSION, createMemoryPair } from '@bgf/protocol';
import type { GameDefinition } from '../src/index.js';
import {
  CommandError,
  TableClient,
  TableServer,
  cryptoRng,
  scriptedRng,
  seededRng,
  verifySnapshot,
  viewSnapshot,
} from '../src/index.js';

/**
 * A toy hidden-information game for three seats: the table holds a secret number; each seat
 * may guess. A guess is public, the secret is not, and the deal (re-drawing the secret) must
 * not reveal it to guests.
 */
interface ToyState {
  secret: number;
  guesses: { seat: number; value: number; hit: boolean }[];
  round: number;
}
type ToyAction =
  { type: 'deal'; secret: number } | { type: 'guess'; seat: number; value: number; hit: boolean };
type ToyCommand = { type: 'guess'; value: number } | { type: 'redeal' };
interface ToyView {
  secret: number | null;
  guesses: ToyState['guesses'];
  round: number;
}

const toy: GameDefinition<ToyState, ToyAction, ToyCommand, ToyView, { max: number }> = {
  id: 'toy',
  minSeats: 2,
  maxSeats: 3,
  hiddenInformation: true,
  normalizeConfig: (c) => ({ max: (c as { max?: number })?.max ?? 10 }),
  init: (cfg, ctx) => ({ secret: ctx.rng.int(cfg.max) + 1, guesses: [], round: 1 }),
  validateCommand(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (r.type === 'redeal') return { type: 'redeal' };
    if (r.type === 'guess' && Number.isInteger(r.value))
      return { type: 'guess', value: r.value as number };
    return null;
  },
  command(state, seat, cmd, ctx) {
    if (cmd.type === 'redeal') return { type: 'deal', secret: ctx.rng.int(10) + 1 };
    if (cmd.value < 1) throw new CommandError('too-low', 'guess at least 1');
    return { type: 'guess', seat, value: cmd.value, hit: cmd.value === state.secret };
  },
  reduce(state, action) {
    if (action.type === 'deal') return { ...state, secret: action.secret, round: state.round + 1 };
    return { ...state, guesses: [...state.guesses, action] };
  },
  view: (state, seat) => ({
    // Seat 0 (the host in these tests) sees the secret; everyone else does not.
    secret: seat === 0 ? state.secret : null,
    guesses: state.guesses,
    round: state.round,
  }),
  viewAction: (action, seat) =>
    action.type === 'deal' ? (seat === 0 ? action : { type: 'deal', secret: -1 }) : action,
};

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const P = (id: string): PlayerProfile => ({ id, name: id.toUpperCase() });

function connect(
  server: TableServer<ToyState, ToyAction, ToyCommand, ToyView, { max: number }>,
  profile: PlayerProfile,
  resume?: TableSnapshot<ToyState, ToyAction>,
) {
  const [serverEnd, clientEnd] = createMemoryPair('toy');
  server.accept(serverEnd);
  const client = new TableClient<ToyState, ToyAction, { max: number }, ToyView>({
    transport: clientEnd,
    profile,
    pingIntervalMs: 0,
    resumeSnapshot: resume as never,
  });
  return client;
}

describe('table core with a hidden-information toy game', () => {
  it('seats three players, redacts the secret for guests, and shows the host everything', async () => {
    const server = new TableServer({
      def: toy,
      code: 'TOY',
      host: P('a'),
      seats: 3,
      rng: seededRng(1),
      now: () => 1,
    });
    expect(server.seatCount).toBe(3);
    const a = new TableClient<ToyState, ToyAction, { max: number }, ToyView>({
      transport: server.connectLocal(),
      profile: P('a'),
      pingIntervalMs: 0,
    });
    const b = connect(server, P('b'));
    const c = connect(server, P('c'));
    const d = connect(server, P('d'));
    await flush();
    expect([a, b, c].map((x) => x.getState().seat)).toEqual([0, 1, 2]);
    expect(d.getState().status).toBe('rejected');
    expect(d.getState().rejectReason).toBe('full');
    const secret = server.getSnapshot().state.secret;
    expect(a.getState().snapshot!.state.secret).toBe(secret);
    expect(a.getState().snapshot!.view).toBeUndefined();
    expect(b.getState().snapshot!.state.secret).toBeNull();
    expect(b.getState().snapshot!.view).toBe(true);
    expect(c.getState().snapshot!.initialState.secret).toBeNull();
    // Presence: everyone sees all three seats present.
    expect(a.getState().presence).toEqual([true, true, true]);
    expect(c.getState().presence).toEqual([true, true, true]);

    // A guess from seat 2 is public; a redeal is visible to the host only.
    c.send({ type: 'guess', value: secret });
    await flush();
    expect(a.getState().lastAction).toMatchObject({
      action: { type: 'guess', seat: 2, hit: true },
      by: 2,
      seq: 1,
    });
    expect(b.getState().lastAction).toMatchObject({
      action: { type: 'guess', seat: 2, hit: true },
      by: 2,
    });
    b.send({ type: 'redeal' });
    await flush();
    expect(a.getState().lastAction!.action).toEqual({
      type: 'deal',
      secret: server.getSnapshot().state.secret,
    });
    expect(b.getState().lastAction!.action).toEqual({ type: 'deal', secret: -1 });
    expect(b.getState().snapshot!.actions).toEqual([
      expect.objectContaining({ type: 'guess' }),
      { type: 'deal', secret: -1 },
    ]);
    expect(server.getSnapshot().seq).toBe(2);

    // A rule error reaches only the sender and changes nothing.
    b.send({ type: 'guess', value: 0 });
    await flush();
    expect(b.getState().error).toMatchObject({ code: 'too-low' });
    expect(a.getState().error).toBeNull();
    expect(server.getSnapshot().seq).toBe(2);

    // Previews go to the other seats only.
    c.sendPreview({ thinking: 7 });
    await flush();
    expect(a.getState().previews).toEqual({ 2: { thinking: 7 } });
    expect(b.getState().previews).toEqual({ 2: { thinking: 7 } });
    expect(c.getState().previews).toEqual({});

    // Presence flips only when the last device of a seat leaves.
    const c2 = connect(server, P('c'));
    await flush();
    expect(server.connectionCount(2)).toBe(2);
    c.close();
    await flush();
    expect(a.getState().presence[2]).toBe(true);
    c2.close();
    await flush();
    expect(a.getState().presence[2]).toBe(false);
    expect(server.connectedSeats()).toEqual([0, 1]);
    server.close();
  });

  it('replays deterministically from the persisted initial state and refuses a guest view on resume', async () => {
    const server = new TableServer({
      def: toy,
      code: 'TOY2',
      host: P('a'),
      seats: 2,
      rng: scriptedRng([4, 2, 9]),
      now: () => 5,
    });
    const a = new TableClient<ToyState, ToyAction, { max: number }, ToyView>({
      transport: server.connectLocal(),
      profile: P('a'),
      pingIntervalMs: 0,
    });
    const b = connect(server, P('b'));
    await flush();
    expect(server.getSnapshot().initialState.secret).toBe(5); // scripted 4 → int(10) = 4 → +1
    b.send({ type: 'redeal' });
    a.send({ type: 'guess', value: 3 });
    await flush();
    const authoritative = server.getSnapshot();
    expect(authoritative.seq).toBe(2);
    const replayed = verifySnapshot(toy, authoritative);
    expect(replayed.state).toEqual(authoritative.state);
    expect(() => verifySnapshot(toy, viewSnapshot(toy, authoritative, 1))).toThrow(/view/);

    // The host copy resumes; a guest offering a (fabricated, newer) view is refused.
    server.close();
    await flush();
    const resumed = new TableServer({
      def: toy,
      code: 'TOY2',
      host: P('a'),
      snapshot: authoritative,
      rng: cryptoRng(),
    });
    expect(resumed.getSnapshot().state).toEqual(authoritative.state);
    const forged = { ...b.getState().snapshot!, seq: 99 } as TableSnapshot<ToyState, ToyAction>;
    const b2 = connect(resumed, P('b'), forged);
    await flush();
    expect(b2.getState().status).toBe('joined');
    expect(b2.getState().error).toMatchObject({ code: 'host-only-resume' });
    expect(resumed.getSnapshot().seq).toBe(2);
    resumed.close();
  });

  it('rejects a bad first message, a protocol mismatch and a wrong-match snapshot', async () => {
    const server = new TableServer({ def: toy, code: 'TOY3', host: P('a') });
    const tryHello = async (msg: unknown) => {
      const [serverEnd, clientEnd] = createMemoryPair('raw');
      server.accept(serverEnd);
      const inbox: TableServerMessage[] = [];
      clientEnd.onMessage((m) => inbox.push(m as TableServerMessage));
      clientEnd.send(msg);
      await flush();
      return inbox;
    };
    expect((await tryHello({ type: 'command', command: {} }))[0]).toMatchObject({
      type: 'rejected',
      reason: 'bad-hello',
    });
    expect((await tryHello({ type: 'hello', protocol: 1, profile: P('b') }))[0]).toMatchObject({
      type: 'rejected',
      reason: 'protocol',
    });
    expect(
      (
        await tryHello({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          profile: P('b'),
          snapshot: { id: 'other', seq: 1 },
        })
      )[0],
    ).toMatchObject({ type: 'rejected', reason: 'wrong-match' });
    server.close();
  });
});
