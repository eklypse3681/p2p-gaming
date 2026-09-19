import { describe, expect, it } from 'vitest';
import {
  BAR,
  OFF,
  RuleError,
  boardFrom,
  emptyBoard,
  newGame,
  newMatch,
  startingBoard,
} from '@bgf/engine';
import type { DiceRoll, GameState, MatchState } from '@bgf/engine';
import type { MatchSnapshot } from '@bgf/protocol';
import type { Player } from '@bgf/engine';
import { PROTOCOL_VERSION, createMemoryPair } from '@bgf/protocol';
import { seatIndex, seatPlayer, toTableSnapshot } from '@bgf/server';
import { GameClient, MemoryMatchStore } from '../src/index.js';

/**
 * The tests describe traffic in backgammon terms (colours, MatchSnapshot); the wire carries the
 * generic table protocol (seat indexes, TableSnapshot, command envelopes). These two helpers
 * translate at the fake server's edge so the assertions keep their meaning.
 */
type ServerMessage = Record<string, unknown> & { type: string };
type ClientMessage = Record<string, unknown> & { type: string };

function toWire(m: ServerMessage): unknown {
  const seat = typeof m.seat === 'string' ? seatIndex(m.seat as Player) : m.seat;
  switch (m.type) {
    case 'welcome':
    case 'state':
      return {
        ...m,
        ...(m.seat !== undefined ? { seat } : {}),
        snapshot: toTableSnapshot(m.snapshot as MatchSnapshot),
        ...(typeof m.by === 'string' ? { by: seatIndex(m.by as Player) } : {}),
      };
    case 'preview':
      return { type: 'preview', seat, payload: m.play };
    case 'presence':
      return { ...m, seat };
    case 'chat': {
      const msg = m.message as { seat: Player; text: string; at: number };
      return { type: 'chat', message: { ...msg, seat: seatIndex(msg.seat) } };
    }
    default:
      return m;
  }
}

function fromWire(raw: unknown): ClientMessage {
  const m = raw as ClientMessage;
  if (m.type === 'command') return m.command as ClientMessage;
  if (m.type === 'preview') return { type: 'preview', play: m.payload };
  if (m.type === 'hello' && m.snapshot) {
    const snap = m.snapshot as { seq: number };
    return { ...m, snapshot: { seq: snap.seq } };
  }
  return m;
}
void seatPlayer;

const ME = { id: 'me', name: 'Me' };
const THEM = { id: 'them', name: 'Them' };

function snapshotWith(
  game: GameState | null,
  seq = 1,
  matchPatch: Partial<MatchState> = {},
): MatchSnapshot {
  const m = newMatch({ length: 5 });
  return {
    id: 'm1',
    code: 'CODE',
    seq,
    createdAt: 0,
    updatedAt: 0,
    config: m.config,
    players: { white: ME, black: THEM },
    hostSeat: 'white',
    actions: [],
    match: { ...m, game, ...matchPatch },
    chat: [],
  };
}

function moving(
  dice: [number, number],
  board = startingBoard(),
  player: 'white' | 'black' = 'white',
): GameState {
  return { ...newGame({ board }), phase: { kind: 'moving', player, dice: dice as DiceRoll } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake server end: records client messages and lets tests push server messages. */
async function setup(opts: { store?: MemoryMatchStore; resumeSnapshot?: MatchSnapshot } = {}) {
  const [serverEnd, clientEnd] = createMemoryPair('draft');
  const received: ClientMessage[] = [];
  serverEnd.onMessage((m) => received.push(fromWire(m)));
  const client = new GameClient({
    transport: clientEnd,
    profile: ME,
    pingIntervalMs: 0,
    previewThrottleMs: 0,
    store: opts.store,
    resumeSnapshot: opts.resumeSnapshot,
  });
  await tick();
  const push = async (m: ServerMessage) => {
    serverEnd.send(toWire(m));
    await tick();
  };
  return { client, received, push, serverEnd };
}

describe('GameClient draft', () => {
  it('sends hello (with the resume snapshot) and reflects welcome', async () => {
    const resume = snapshotWith(null, 4);
    const { client, received, push } = await setup({ resumeSnapshot: resume });
    expect(received[0]).toMatchObject({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      profile: ME,
      snapshot: { seq: 4 },
    });
    expect(client.getState().status).toBe('connecting');
    await push({ type: 'welcome', seat: 'white', snapshot: snapshotWith(null, 4) });
    const s = client.getState();
    expect(s.status).toBe('joined');
    expect(s.seat).toBe('white');
    expect(s.presence.white).toBe(true);
    expect(s.draft.board).toEqual(emptyBoard());
    expect(s.draft.next).toEqual([]);
  });

  it('stages, unstages, clears, completes and commits a play', async () => {
    const { client, received, push } = await setup();
    await push({ type: 'welcome', seat: 'white', snapshot: snapshotWith(moving([3, 1])) });
    let d = client.getState().draft;
    expect(d.maxMoves).toBe(2);
    expect(d.remaining).toEqual([3, 1]);
    expect(d.complete).toBe(false);
    expect(d.next.some((m) => m.from === 8 && m.to === 5)).toBe(true);

    client.stage({ from: 8, to: 5, die: 3, hit: false });
    d = client.getState().draft;
    expect(d.played).toEqual([{ from: 8, to: 5, die: 3, hit: false }]);
    expect(d.remaining).toEqual([1]);
    expect(d.board.points[4]).toBe(1); // white now on abs 5-point (index 4)
    expect(d.board.points[7]).toBe(2);
    expect(d.complete).toBe(false);
    await tick();
    expect(received.at(-1)).toEqual({ type: 'preview', play: d.played });

    client.stage({ from: 6, to: 5, die: 1, hit: false });
    d = client.getState().draft;
    expect(d.complete).toBe(true);
    expect(d.remaining).toEqual([]);
    expect(d.next).toEqual([]);

    client.unstage();
    d = client.getState().draft;
    expect(d.played.length).toBe(1);
    expect(d.complete).toBe(false);
    await tick();
    expect(received.at(-1)).toEqual({ type: 'preview', play: d.played });

    client.clearDraft();
    d = client.getState().draft;
    expect(d.played).toEqual([]);
    expect(d.board).toEqual(startingBoard());
    await tick();
    expect(received.at(-1)).toEqual({ type: 'preview', play: [] });

    expect(() => client.commit()).toThrow(RuleError);
    client.stage([
      { from: 8, to: 5, die: 3, hit: false },
      { from: 6, to: 5, die: 1, hit: false },
    ]);
    await tick();
    const before = received.length;
    client.commit();
    await tick();
    expect(received.slice(before)).toEqual([
      { type: 'preview', play: [] },
      { type: 'play', play: client.getState().draft.played },
    ]);
    expect(client.getState().draft.pending).toBe(true);
    expect(() => client.stage({ from: 24, to: 21, die: 3, hit: false })).toThrow(
      /already being sent/,
    );
    // Server confirms: turn passes → draft resets to the new authoritative board.
    const after = { ...moving([4, 2], undefined, 'black'), board: client.getState().draft.board };
    await push({
      type: 'state',
      snapshot: snapshotWith(after, 2),
      action: { type: 'play', player: 'white', play: [] },
      by: 'white',
    });
    d = client.getState().draft;
    expect(d.played).toEqual([]);
    expect(d.pending).toBe(false);
    expect(d.board).toEqual(after.board);
    expect(d.next).toEqual([]);
    expect(client.getState().lastAction).toMatchObject({ by: 'white', seq: 2 });
  });

  it('rejects illegal stages and drafting when it is not my move', async () => {
    const { client, push } = await setup();
    await push({ type: 'welcome', seat: 'black', snapshot: snapshotWith(moving([3, 1])) });
    expect(() => client.stage({ from: 8, to: 5, die: 3, hit: false })).toThrow(/not your turn/);
    expect(client.destinations(8)).toEqual([]);
    await push({ type: 'state', snapshot: snapshotWith(moving([3, 1], undefined, 'black'), 2) });
    expect(() => client.stage({ from: 8, to: 5, die: 5, hit: false })).toThrow(/not legal/);
    expect(() => client.stage({ from: 8, to: 5, die: 3, hit: false })).not.toThrow();
  });

  it('destinations include two-step routes and bar entry', async () => {
    const { client, push } = await setup();
    await push({ type: 'welcome', seat: 'white', snapshot: snapshotWith(moving([3, 1])) });
    const dests = client.destinations(8);
    expect(dests.map((d) => d.to).sort()).toEqual([4, 5, 7]);
    expect(dests.find((d) => d.to === 4)!.via.length).toBe(2);
    client.stage(dests.find((d) => d.to === 4)!.via);
    expect(client.getState().draft.complete).toBe(true);

    const board = boardFrom({ [BAR]: 1, 13: 14 }, { 13: 15 });
    await push({ type: 'state', snapshot: snapshotWith(moving([6, 2], board), 2) });
    const fromBar = client.destinations(BAR);
    expect(fromBar.map((d) => d.to).sort()).toEqual([17, 19, 23]);
    expect(client.destinations(13)).toEqual([]);
  });

  it('a server error while pending unblocks the draft', async () => {
    const { client, push } = await setup();
    await push({
      type: 'welcome',
      seat: 'white',
      snapshot: snapshotWith(moving([6, 6], boardFrom({ 6: 15 }, { 13: 15 }))),
    });
    const d = client.getState().draft;
    expect(d.maxMoves).toBe(4);
    while (!client.getState().draft.complete) client.stage(client.getState().draft.next[0]!);
    expect(client.getState().draft.played.every((m) => m.to === OFF)).toBe(true);
    client.commit();
    expect(client.getState().draft.pending).toBe(true);
    await push({ type: 'error', code: 'illegal-play', message: 'nope' });
    expect(client.getState().draft.pending).toBe(false);
    expect(client.getState().error).toMatchObject({ code: 'illegal-play' });
  });

  it('keeps the draft across a resignation offer/decline and resets on other changes', async () => {
    const { client, push } = await setup();
    const g = moving([5, 2]);
    await push({ type: 'welcome', seat: 'white', snapshot: snapshotWith(g) });
    const m = client.getState().draft.next[0]!;
    client.stage(m);
    const offered: GameState = {
      ...g,
      phase: { kind: 'resign-offered', by: 'black', stakes: 'single', prior: g.phase },
    };
    await push({ type: 'state', snapshot: snapshotWith(offered, 2) });
    expect(client.getState().draft.played).toEqual([m]);
    await push({ type: 'state', snapshot: snapshotWith(g, 3) });
    expect(client.getState().draft.played).toEqual([m]);
    // Same dice but a different turn (turnCount bumped) → reset.
    await push({ type: 'state', snapshot: snapshotWith({ ...g, turnCount: 1 }, 4) });
    expect(client.getState().draft.played).toEqual([]);
    // Opponent's phase → no options at all.
    await push({
      type: 'state',
      snapshot: snapshotWith({ ...g, phase: { kind: 'to-roll', player: 'black' } }, 5),
    });
    expect(client.getState().draft.next).toEqual([]);
    expect(client.getState().draft.maxMoves).toBe(0);
  });

  it('tracks previews from the opponent, presence, chat, rejection and disconnects', async () => {
    const store = new MemoryMatchStore();
    const { client, push, serverEnd } = await setup({ store });
    await push({ type: 'welcome', seat: 'white', snapshot: snapshotWith(null, 7) });
    expect(store.peek('m1')!.seq).toBe(7);
    await push({ type: 'preview', seat: 'black', play: [{ from: 13, to: 8, die: 5, hit: false }] });
    expect(client.getState().opponentPreview).toEqual([{ from: 13, to: 8, die: 5, hit: false }]);
    await push({ type: 'preview', seat: 'white', play: [{ from: 1, to: 0, die: 1, hit: false }] });
    expect(client.getState().opponentPreview).toEqual([{ from: 13, to: 8, die: 5, hit: false }]);
    await push({ type: 'preview', seat: 'black', play: [] });
    expect(client.getState().opponentPreview).toBeNull();
    await push({ type: 'presence', seat: 'black', connected: true });
    expect(client.getState().presence).toEqual({ white: true, black: true });
    await push({ type: 'chat', message: { seat: 'black', text: 'gl', at: 1 } });
    expect(client.getState().chat).toEqual([{ seat: 'black', text: 'gl', at: 1 }]);
    expect(store.peek('m1')!.chat).toEqual([{ seat: 'black', text: 'gl', at: 1 }]);
    await push({ type: 'pong', t: Date.now() - 5 });
    expect(client.getState().latencyMs).toBeGreaterThanOrEqual(5);
    let notified = 0;
    const unsub = client.subscribe(() => notified++);
    serverEnd.close();
    await tick();
    expect(client.getState().status).toBe('disconnected');
    expect(client.getState().presence).toEqual({ white: false, black: false });
    expect(notified).toBe(1);
    unsub();
  });

  it('rejection is terminal', async () => {
    const { client, push, serverEnd } = await setup();
    await push({ type: 'rejected', reason: 'full', message: 'both seats are taken' });
    expect(client.getState().status).toBe('rejected');
    expect(client.getState().rejectReason).toBe('full');
    serverEnd.close();
    await tick();
    expect(client.getState().status).toBe('rejected');
  });

  it('close sends bye and stops everything', async () => {
    const { client, received, push } = await setup();
    await push({ type: 'welcome', seat: 'white', snapshot: snapshotWith(moving([3, 1])) });
    client.close();
    await tick();
    expect(received.at(-1)).toEqual({ type: 'bye' });
    expect(client.getState().status).toBe('disconnected');
    client.close(); // idempotent
    expect(() => client.stage({ from: 8, to: 5, die: 3, hit: false })).toThrow();
  });
});
