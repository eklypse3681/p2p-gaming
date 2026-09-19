import { describe, expect, it } from 'vitest';
import type { PlayerProfile } from '@bgf/protocol';
import { createMemoryPair } from '@bgf/protocol';
import type { EntropySource, GameDefinition } from '../src/index.js';
import {
  TableClient,
  TableServer,
  checkSerials,
  createByteRng,
  deriveDraws,
  drawsMatch,
  hexToBytes,
  verifySnapshot,
  viewSnapshot,
} from '../src/index.js';

/** A tiny hidden-information card game: `shuffle` reorders the deck, `draw` deals the top card. */
interface DeckState {
  deck: number[];
  dealt: { seat: number; card: number }[];
}
type DeckAction =
  { type: 'shuffled'; deck: number[] } | { type: 'dealt'; seat: number; card: number };
type DeckCommand =
  { type: 'shuffle'; size?: number } | { type: 'draw' } | { type: 'noop' } | { type: 'bad' };
interface DeckView {
  deckCount: number;
  dealt: { seat: number; card: number | null }[];
}

const deckGame: GameDefinition<DeckState, DeckAction, DeckCommand, DeckView> = {
  id: 'deck',
  minSeats: 2,
  maxSeats: 3,
  hiddenInformation: true,
  init: (_c, ctx) => ({ deck: ctx.rng.shuffle([1, 2, 3, 4, 5, 6, 7, 8]), dealt: [] }),
  validateCommand: (raw) => {
    const r = raw as { type?: unknown; size?: unknown };
    if (r?.type === 'shuffle')
      return { type: 'shuffle', size: typeof r.size === 'number' ? r.size : undefined };
    return r?.type === 'draw' || r?.type === 'noop' || r?.type === 'bad'
      ? ({ type: r.type } as DeckCommand)
      : null;
  },
  command(state, seat, cmd, ctx) {
    if (cmd.type === 'shuffle') {
      // `size` lets a test force a big draw (many ints) to exhaust the byte budget.
      const deck = cmd.size ? Array.from({ length: cmd.size }, (_, i) => i) : state.deck;
      return { type: 'shuffled', deck: ctx.rng.shuffle(deck).slice(0, 8) };
    }
    if (cmd.type === 'draw') return { type: 'dealt', seat, card: state.deck[0]! };
    if (cmd.type === 'bad') {
      ctx.rng.int(6);
      throw Object.assign(new Error('not now'), { code: 'not-now' });
    }
    return [];
  },
  reduce(state, action) {
    if (action.type === 'shuffled') return { ...state, deck: action.deck };
    return {
      deck: state.deck.slice(1),
      dealt: [...state.dealt, { seat: action.seat, card: action.card }],
    };
  },
  view: (state, seat) => ({
    deckCount: state.deck.length,
    dealt: state.dealt.map((d) => ({ seat: d.seat, card: d.seat === seat ? d.card : null })),
  }),
  viewAction: (action, seat) => {
    if (action.type === 'shuffled') return null;
    return action.seat === seat ? action : { ...action, card: -1 };
  },
};

/** A fake oracle: numbered "signed" requests, optionally failing, with a serial counter. */
function oracle(opts: { fail?: () => boolean; delayMs?: number } = {}) {
  let serial = 100;
  const requests: { bytes: number; label: string }[] = [];
  const source: EntropySource = {
    id: 'oracle',
    async draw(bytes, ctx) {
      requests.push({ bytes, label: ctx.label });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail?.()) throw new Error('oracle down');
      const out = new Uint8Array(bytes);
      for (let i = 0; i < bytes; i++) out[i] = (i * 37 + serial) & 0xff;
      serial += 1;
      return {
        bytes: out,
        proof: {
          kind: 'random.org-signed',
          random: { data: Array.from(out) },
          signature: `sig-${serial}`,
          serialNumber: serial,
        },
        fetchedAt: 5,
        serialNumber: serial,
        bitsLeft: 1000,
        requestsLeft: 50,
      };
    },
  };
  return { source, requests, skipSerial: () => (serial += 1) };
}

const P = (id: string): PlayerProfile => ({ id, name: id });
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

async function table(
  o: ReturnType<typeof oracle>,
  extra: Partial<{ fallback: boolean; bytes: number }> = {},
) {
  const server = await TableServer.create({
    def: deckGame,
    code: 'DECK',
    host: P('h'),
    seats: 2,
    entropy: { source: o.source, bytes: extra.bytes ?? 64, fallback: extra.fallback ?? false },
    now: () => 1,
    matchId: 'deck-1',
  });
  const host = new TableClient<DeckState, DeckAction, unknown, DeckView>({
    transport: server.connectLocal(),
    profile: P('h'),
    pingIntervalMs: 0,
  });
  const [serverEnd, guestEnd] = createMemoryPair('g');
  server.accept(serverEnd);
  const guest = new TableClient<DeckState, DeckAction, unknown, DeckView>({
    transport: guestEnd,
    profile: P('g'),
    pingIntervalMs: 0,
  });
  await flush();
  return { server, host, guest };
}

describe('just-in-time entropy', () => {
  it('draws at command time, one request per drawing command, and records proof, bytes and draws', async () => {
    const o = oracle();
    const { server, host, guest } = await table(o);
    // init shuffled the deck → one request labelled init, recorded on the audit.
    expect(o.requests).toEqual([{ bytes: 64, label: 'init' }]);
    const snap0 = server.getSnapshot();
    expect(snap0.options.randomness).toEqual({ mode: 'per-draw', provider: 'oracle' });
    expect(snap0.entropyAudit?.init).toMatchObject({
      label: 'init',
      provider: 'oracle',
      fallback: false,
    });
    expect(snap0.entropyAudit!.init!.sources[0]).toMatchObject({
      serialNumber: 101,
      bitsLeft: 1000,
      requestsLeft: 50,
    });

    const deckBefore = snap0.state.deck;
    guest.send({ type: 'shuffle' }); // randomness → request at command time
    guest.send({ type: 'draw' }); // no randomness → no request, no meta
    guest.send({ type: 'noop' });
    await flush();
    expect(o.requests).toEqual([
      { bytes: 64, label: 'init' },
      { bytes: 64, label: 'shuffle' },
    ]);
    const snap = server.getSnapshot();
    expect(snap.actions.map((a) => a.type)).toEqual(['shuffled', 'dealt']);
    expect(snap.actionMeta![1]).toBeUndefined();
    const rec = snap.actionMeta![0]!.entropy!;
    expect(rec).toMatchObject({ label: 'shuffle', provider: 'oracle', fallback: false });
    expect(rec.sources).toHaveLength(1);
    expect(rec.sources[0]!.proof.kind).toBe('random.org-signed');
    expect(rec.bytesUsed).toBe(rec.bytes.length / 2);
    expect(rec.draws.length).toBe(7); // Fisher–Yates over 8 cards = 7 ints
    // The record re-derives: bytes → the recorded values, and the values → the action.
    expect(drawsMatch(rec)).toBe(true);
    const values = deriveDraws(hexToBytes(rec.sources[0]!.bytes), rec.draws);
    expect(values).toEqual(rec.draws.map((d) => d.value));
    const replayRng = createByteRng(hexToBytes(rec.sources[0]!.bytes));
    expect(replayRng.shuffle(deckBefore)).toEqual((snap.actions[0] as { deck: number[] }).deck);

    // Guests get the record for actions they can see, re-keyed to their filtered log.
    expect(host.getState().snapshot!.actionMeta).toEqual(snap.actionMeta);
    const guestSnap = guest.getState().snapshot!;
    expect(guestSnap.actions.map((a) => a.type)).toEqual(['dealt']);
    expect(guestSnap.actionMeta).toEqual({});
    expect(guestSnap.options.randomness).toEqual({ mode: 'per-draw', provider: 'oracle' });
    expect(viewSnapshot(deckGame, snap, 1).entropyAudit?.init?.sources[0]!.proof).toEqual(
      snap.entropyAudit!.init!.sources[0]!.proof,
    );
    const replayed = verifySnapshot(deckGame, snap);
    expect(replayed.state).toEqual(snap.state);
    expect(replayed.actionMeta).toEqual(snap.actionMeta);
    server.close();
  });

  it('re-runs with a bigger budget when a command needs more bytes, keeping every proof', async () => {
    const o = oracle();
    const { server, host } = await table(o, { bytes: 16 });
    o.requests.length = 0;
    host.send({ type: 'shuffle', size: 40 }); // 39 ints ≈ 156+ bytes → 16, 32, 64, 128 → four requests
    await flush();
    expect(o.requests.map((r) => r.bytes)).toEqual([16, 32, 64, 128]);
    const init = server.getSnapshot().entropyAudit!.init!;
    const rec = server.getSnapshot().actionMeta![0]!.entropy!;
    expect(rec.sources).toHaveLength(4);
    const first = init.sources[init.sources.length - 1]!.serialNumber! + 1;
    expect(rec.sources.map((s) => s.serialNumber)).toEqual([
      first,
      first + 1,
      first + 2,
      first + 3,
    ]);
    expect(rec.bytesUsed).toBeGreaterThan(16 + 32 + 64);
    expect(drawsMatch(rec)).toBe(true);
    expect(checkSerials([server.getSnapshot().entropyAudit!.init!, rec]).ok).toBe(true);
    server.close();
  });

  it('keeps arrival order while a draw is in flight', async () => {
    const o = oracle({ delayMs: 15 });
    const { server, host, guest } = await table(o);
    // Each transport batches its own sends, so space them out to fix the arrival order.
    host.send({ type: 'shuffle' }); // slow (in flight)
    await flush(1);
    guest.send({ type: 'draw' }); // sync, but must wait behind the shuffle
    await flush(1);
    host.send({ type: 'shuffle' }); // second draw, after the guest's deal
    await flush(1);
    guest.send({ type: 'draw' });
    await new Promise((r) => setTimeout(r, 80));
    await flush();
    expect(server.getSnapshot().actions.map((a) => a.type)).toEqual([
      'shuffled',
      'dealt',
      'shuffled',
      'dealt',
    ]);
    server.close();
  });

  it('refuses the command with entropy-unavailable when the source fails and no fallback is allowed', async () => {
    const o = oracle({ fail: () => o.requests.length > 1 });
    const { server, host } = await table(o);
    const seq = server.getSnapshot().seq;
    host.send({ type: 'shuffle' });
    await flush();
    expect(host.getState().error).toMatchObject({ code: 'entropy-unavailable' });
    expect(server.getSnapshot().seq).toBe(seq);
    expect(server.getSnapshot().actions).toEqual([]);
    server.close();
  });

  it('falls back to this device only when configured, and flags the record', async () => {
    const o = oracle({ fail: () => o.requests.length > 1 });
    const { server, host } = await table(o, { fallback: true });
    host.send({ type: 'shuffle' });
    await flush();
    const rec = server.getSnapshot().actionMeta![0]!.entropy!;
    expect(rec).toMatchObject({ fallback: true, provider: 'oracle' });
    expect(rec.sources[0]!.proof).toEqual({ kind: 'none' });
    expect(drawsMatch(rec)).toBe(true);
    expect(host.getState().error).toBeNull();
    server.close();
  });

  it('rule errors from a drawing command reach the sender only, with nothing applied', async () => {
    const o = oracle();
    const { server, host, guest } = await table(o);
    guest.send({ type: 'bad' });
    await flush();
    expect(guest.getState().error).toMatchObject({ code: 'not-now' });
    expect(host.getState().error).toBeNull();
    expect(server.getSnapshot().actions).toEqual([]);
    server.close();
  });

  it('checkSerials flags hidden requests between draws', async () => {
    const o = oracle();
    const { server, host } = await table(o);
    host.send({ type: 'shuffle' });
    await flush();
    o.skipSerial(); // the same key served another request in between (or a re-request)
    host.send({ type: 'shuffle' });
    await flush();
    const snap = server.getSnapshot();
    const records = [
      snap.entropyAudit!.init!,
      snap.actionMeta![0]!.entropy!,
      snap.actionMeta![1]!.entropy!,
    ];
    const check = checkSerials(records);
    expect(check.ok).toBe(false);
    expect(check.gaps).toEqual([{ afterIndex: 1, from: 102, to: 104 }]);
    server.close();
  });

  it('a synchronous table refuses to construct a game whose init draws when the source is just-in-time', () => {
    const o = oracle();
    expect(
      () =>
        new TableServer({ def: deckGame, code: 'X', host: P('h'), entropy: { source: o.source } }),
    ).toThrow(/TableServer.create/);
  });
});
