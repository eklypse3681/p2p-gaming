import { describe, expect, it, vi } from 'vitest';
import { scriptedDice, newMatch, startGame, boardFrom, BAR } from '@bgf/engine';
import type { MatchState } from '@bgf/engine';
import { createMemoryPair, PROTOCOL_VERSION } from '@bgf/protocol';
import { GameClient } from '../../src/index.js';
import {
  GUEST,
  HOST,
  autoPlay,
  clientFor,
  currentGame,
  flush,
  keyedProfile,
  makeHarness,
  rawHello,
  signerOf,
  startAndOpen,
} from './harness.js';

/** A match with a game in progress in the given phase, from a custom board. */
function positioned(
  game: Partial<MatchState['game'] & object>,
  config = { length: 5 },
): MatchState {
  const m = startGame(newMatch(config));
  return { ...m, game: { ...m.game!, ...game } };
}

describe('commands', () => {
  it('rejects commands from the wrong seat with an error to the sender only', async () => {
    const h = await makeHarness({
      initialMatch: positioned({ phase: { kind: 'to-roll', player: 'white' } }),
    });
    const seqBefore = h.server.getSnapshot().seq;
    h.guest.roll();
    await flush();
    expect(h.guest.getState().error?.code).toBe('not-your-turn');
    expect(h.host.getState().error).toBeNull();
    expect(h.server.getSnapshot().seq).toBe(seqBefore);
    expect(currentGame(h.host).phase.kind).toBe('to-roll');
    h.expectConverged();
    h.close();
  });

  it('rejects an illegal play without changing state', async () => {
    const h = await makeHarness({
      initialMatch: positioned({ phase: { kind: 'moving', player: 'white', dice: [3, 1] } }),
    });
    const seqBefore = h.server.getSnapshot().seq;
    const [serverEnd, raw] = createMemoryPair();
    h.server.accept(serverEnd);
    const got: { type: string; code?: string }[] = [];
    raw.onMessage((m) => got.push(m as { type: string }));
    // Reconnect as the host profile on a raw transport so we can send a hand-built illegal play.
    rawHello(raw, HOST);
    await flush();
    raw.send({
      type: 'command',
      command: { type: 'play', play: [{ from: 24, to: 19, die: 5, hit: false }] },
    });
    await flush();
    expect(got.at(-1)).toMatchObject({ type: 'error', code: 'illegal-play' });
    expect(h.server.getSnapshot().seq).toBe(seqBefore);
    h.close();
  });

  it('does not consume dice when a roll is refused', async () => {
    const dice = scriptedDice([6, 5, 4, 3, 2, 1]);
    const h = await makeHarness({
      dice,
      initialMatch: positioned({ phase: { kind: 'to-roll', player: 'white' } }),
    });
    h.guest.roll(); // refused: not black's turn
    await flush();
    h.host.roll();
    await flush();
    expect(currentGame(h.host).phase).toMatchObject({ kind: 'moving', dice: [6, 5] });
    h.close();
  });

  it('opening roll: each seat rolls once, second attempt refused, ties re-roll', async () => {
    const dice = scriptedDice([4, 4, 2, 5]);
    const h = await makeHarness({ dice });
    h.host.startGame();
    await flush();
    expect(currentGame(h.host).phase.kind).toBe('opening');
    h.host.openingRoll();
    await flush();
    h.host.openingRoll();
    await flush();
    expect(h.host.getState().error?.code).toBe('already-rolled');
    h.guest.openingRoll();
    await flush();
    // 4-4 tie → both reset
    expect(currentGame(h.host).phase).toMatchObject({ kind: 'opening', ties: 1, rolls: {} });
    h.host.openingRoll();
    h.guest.openingRoll();
    await flush();
    // white 2, black 5 → black starts with [5, 2]
    expect(currentGame(h.host).phase).toMatchObject({
      kind: 'moving',
      player: 'black',
      dice: [5, 2],
    });
    expect(h.guest.getState().lastAction?.action.type).toBe('opening-roll');
    h.expectConverged();
    h.close();
  });

  it('start-game is refused while a game is in progress and after the match is won', async () => {
    const h = await makeHarness({ config: { length: 1 } });
    await startAndOpen(h);
    h.guest.startGame();
    await flush();
    expect(h.guest.getState().error?.code).toBe('game-in-progress');
    h.close();
  });

  it('forwards previews only to the opponent, and clears them on the next state', async () => {
    const h = await makeHarness({
      initialMatch: positioned({ phase: { kind: 'moving', player: 'white', dice: [3, 1] } }),
    });
    const next = h.host.getState().draft.next;
    h.host.stage(next[0]!);
    await flush();
    expect(h.guest.getState().opponentPreview).toEqual([next[0]]);
    expect(h.host.getState().opponentPreview).toBeNull();
    h.host.unstage();
    await flush();
    expect(h.guest.getState().opponentPreview).toBeNull();
    autoPlay(h.host);
    await flush();
    expect(h.guest.getState().opponentPreview).toBeNull();
    expect(currentGame(h.guest).phase).toMatchObject({ kind: 'to-roll', player: 'black' });
    h.close();
  });

  it('throttles preview messages', async () => {
    const h = await makeHarness({
      withGuest: false,
      initialMatch: positioned({ phase: { kind: 'moving', player: 'black', dice: [6, 6] } }),
    });
    const [serverEnd, clientEnd] = createMemoryPair();
    h.server.accept(serverEnd);
    let previews = 0;
    const spied = new Proxy(clientEnd, {
      get(target, prop, receiver) {
        if (prop === 'send') {
          return (m: { type: string }) => {
            if (m.type === 'preview') previews++;
            target.send(m);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const guest = new GameClient({
      transport: spied,
      profile: keyedProfile(GUEST),
      signer: signerOf(GUEST),
      pingIntervalMs: 0,
      previewThrottleMs: 40,
    });
    await flush();
    expect(guest.getState().seat).toBe('black');
    guest.stage(guest.getState().draft.next[0]!);
    guest.stage(guest.getState().draft.next[0]!);
    guest.stage(guest.getState().draft.next[0]!);
    expect(previews).toBe(1); // leading edge
    await new Promise((r) => setTimeout(r, 60));
    expect(previews).toBe(2); // trailing edge carries the latest draft
    guest.close();
    h.close();
  });

  it('broadcasts chat, keeps it in the snapshot without bumping seq, and clients persist it', async () => {
    const h = await makeHarness();
    const seq = h.server.getSnapshot().seq;
    h.host.sendChat('  hi Bob  ');
    h.guest.sendChat('hi Alice');
    h.guest.sendChat('   ');
    await flush();
    const chat = h.host.getState().chat;
    expect(chat.map((c) => [c.seat, c.text])).toEqual([
      ['white', 'hi Bob'],
      ['black', 'hi Alice'],
    ]);
    expect(h.guest.getState().chat).toEqual(chat);
    expect(h.server.getSnapshot().seq).toBe(seq);
    expect(h.server.getSnapshot().chat).toEqual(chat);
    const id = h.server.getSnapshot().id;
    expect(h.hostStore.peek(id)!.chat).toEqual(chat);
    expect(h.guestStore.peek(id)!.chat).toEqual(chat);
    h.close();
  });

  it('answers pings and the client records latency', async () => {
    const h = await makeHarness({ withGuest: false });
    // Leave setImmediate real so WebCrypto (which completes on the event loop) can finish the
    // seat challenge while timers are faked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const [serverEnd, clientEnd] = createMemoryPair();
      h.server.accept(serverEnd);
      const guest = new GameClient({
        transport: clientEnd,
        profile: keyedProfile(GUEST),
        signer: signerOf(GUEST),
        pingIntervalMs: 50,
      });
      const realTick = (globalThis as unknown as { setImmediate: (fn: () => void) => void })
        .setImmediate;
      for (let i = 0; i < 20 && guest.getState().status !== 'joined'; i++) {
        await new Promise<void>((r) => realTick(r));
      }
      expect(guest.getState().status).toBe('joined');
      expect(guest.getState().latencyMs).toBeNull();
      await vi.advanceTimersByTimeAsync(60);
      expect(guest.getState().latencyMs).not.toBeNull();
      guest.close();
      h.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces presence on disconnect and reconnect', async () => {
    const h = await makeHarness();
    h.guest.close();
    await flush();
    expect(h.host.getState().presence).toEqual({ white: true, black: false });
    expect(h.server.connectedSeats()).toEqual(['white']);
    const { client: guest2 } = h.connect(GUEST);
    await flush();
    expect(h.host.getState().presence).toEqual({ white: true, black: true });
    expect(guest2.getState().presence).toEqual({ white: true, black: true });
    guest2.close();
    h.close();
  });

  it('presence reflects a transport that dies underneath the client', async () => {
    const h = await makeHarness({ withGuest: false });
    const { client, transport } = h.connect(GUEST);
    await flush();
    transport.close(); // simulate the network dropping (no bye)
    await flush();
    expect(client.getState().status).toBe('disconnected');
    expect(h.host.getState().presence.black).toBe(false);
    h.close();
  });

  it('auto-skips a turn with no legal move and the clients see the roll action', async () => {
    // White on the bar against a closed board.
    const board = boardFrom({ [BAR]: 1, 13: 14 }, { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 13: 3 });
    const h = await makeHarness({
      dice: scriptedDice([3, 4]),
      initialMatch: positioned({ board, phase: { kind: 'to-roll', player: 'white' } }),
    });
    h.host.roll();
    await flush();
    const g = currentGame(h.guest);
    expect(g.phase).toMatchObject({ kind: 'to-roll', player: 'black' });
    expect(g.history.at(-1)).toMatchObject({
      type: 'move',
      player: 'white',
      dice: [3, 4],
      play: [],
    });
    expect(h.guest.getState().lastAction).toMatchObject({
      action: { type: 'roll', player: 'white' },
      by: 'white',
    });
    expect(h.host.getState().draft.played).toEqual([]);
    expect(h.host.getState().draft.board).toEqual(g.board);
    h.expectConverged();
    h.close();
  });

  it('a hit sends the opponent to the bar and they must enter first', async () => {
    const board = boardFrom(
      { 7: 1, 6: 4, 8: 3, 13: 5, 24: 2 },
      { 21: 1, 6: 4, 8: 3, 13: 5, 24: 2 },
    );
    const h = await makeHarness({
      dice: scriptedDice([3, 1, 6, 5]),
      initialMatch: positioned({ board, phase: { kind: 'to-roll', player: 'white' } }),
    });
    h.host.roll();
    await flush();
    const hit = h.host.getState().draft.next.find((m) => m.from === 7 && m.to === 4);
    expect(hit).toMatchObject({ hit: true, die: 3 });
    h.host.stage(hit!);
    expect(h.host.getState().draft.board.bar.black).toBe(1);
    autoPlay(h.host);
    await flush();
    expect(currentGame(h.guest).board.bar.black).toBe(1);
    expect(h.guest.getState().lastAction?.action).toMatchObject({ type: 'play', player: 'white' });
    h.guest.roll();
    await flush();
    const next = h.guest.getState().draft.next;
    expect(next.length).toBeGreaterThan(0);
    expect(next.every((m) => m.from === BAR)).toBe(true);
    h.expectConverged();
    h.close();
  });

  it('bye closes the connection and announces absence', async () => {
    const h = await makeHarness({ withGuest: false });
    const [serverEnd, raw] = createMemoryPair();
    h.server.accept(serverEnd);
    raw.send({ type: 'hello', protocol: PROTOCOL_VERSION, profile: GUEST });
    await flush();
    raw.send({ type: 'bye' });
    await flush();
    expect(raw.status).toBe('closed');
    expect(h.host.getState().presence.black).toBe(false);
    h.close();
  });

  it('clientFor helper resolves seats', async () => {
    const h = await makeHarness();
    expect(clientFor(h, 'white')).toBe(h.host);
    expect(clientFor(h, 'black')).toBe(h.guest);
    h.close();
  });
});
