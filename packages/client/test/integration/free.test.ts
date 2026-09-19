import { describe, expect, it } from 'vitest';
import { BAR, OFF, countAt, scriptedDice, startingBoard } from '@bgf/engine';
import { GameServer } from '@bgf/server';
import {
  GameClient,
  MemoryMatchStore,
  canFreeRoll,
  isFreeMode,
  lastFreeDice,
  phaseSummary,
} from '../../src/index.js';
import {
  GUEST,
  HOST,
  clientFor,
  currentGame,
  flush,
  keyedProfile,
  makeHarness,
  rawHello,
  signerOf,
} from './harness.js';

async function freeHarness(config: Record<string, unknown> = {}) {
  const h = await makeHarness({
    config: { length: 5, rules: 'free', ...config },
    dice: scriptedDice([3, 1, 6, 6, 2, 5]),
  });
  h.host.startGame();
  await flush();
  return h;
}

describe('free board over the wire', () => {
  it('starts a free game both clients recognise', async () => {
    const h = await freeHarness();
    expect(currentGame(h.host).phase).toEqual({ kind: 'free', dice: null });
    expect(isFreeMode(h.host.getState())).toBe(true);
    expect(isFreeMode(h.guest.getState())).toBe(true);
    expect(canFreeRoll(h.guest.getState())).toBe(true);
    expect(phaseSummary(h.guest.getState()).text).toMatch(/Free board/);
    // The draft is inert on a free board.
    const d = h.host.getState().draft;
    expect(d.next).toEqual([]);
    expect(d.complete).toBe(false);
    expect(d.maxMoves).toBe(0);
    expect(d.board).toEqual(startingBoard());
    expect(h.host.destinations(24)).toEqual([]);
    h.expectConverged();
    h.close();
  });

  it('both players can roll; the dice come from the server', async () => {
    const h = await freeHarness();
    h.guest.freeRoll();
    await flush();
    expect(lastFreeDice(h.host.getState())).toEqual({ player: 'black', dice: [3, 1] });
    expect(phaseSummary(h.host.getState()).text).toBe('Free board — Bob rolled 3-1');
    expect(phaseSummary(h.guest.getState()).text).toBe('Free board — You rolled 3-1');
    h.host.freeRoll();
    await flush();
    expect(lastFreeDice(h.guest.getState())).toEqual({ player: 'white', dice: [6, 6] });
    expect(h.host.getState().lastAction).toMatchObject({
      action: { type: 'free-roll', player: 'white' },
      by: 'white',
    });
    h.expectConverged();
    h.close();
  });

  it('the guest moves a white checker; a hit is visible on both sides', async () => {
    const h = await freeHarness();
    const seqBefore = h.host.getState().snapshot!.seq;
    h.guest.freeMove('white', 24, 20);
    await flush();
    expect(countAt(currentGame(h.host).board, 'white', 20)).toBe(1);
    expect(h.host.getState().snapshot!.seq).toBe(seqBefore + 1);
    expect(h.host.getState().lastAction).toMatchObject({
      action: { type: 'free-move', player: 'black', checker: 'white', from: 24, to: 20 },
      by: 'black',
    });
    // Black's 5-point is white's 20-point: hit it.
    h.guest.freeMove('black', 8, 5);
    await flush();
    for (const c of [h.host, h.guest]) {
      const b = currentGame(c).board;
      expect(b.bar.white).toBe(1);
      expect(countAt(b, 'white', 20)).toBe(0);
      expect(countAt(b, 'black', 5)).toBe(1);
    }
    // Enter from the bar and bear a black checker off, driven by the other client each time.
    h.host.freeMove('white', BAR, 22);
    h.guest.freeMove('black', 6, OFF);
    await flush();
    expect(currentGame(h.guest).board.bar.white).toBe(0);
    expect(currentGame(h.host).board.off.black).toBe(1);
    h.expectConverged();
    h.close();
  });

  it('a blocked move yields an error for the sender only and no seq change', async () => {
    const h = await freeHarness();
    const seq = h.host.getState().snapshot!.seq;
    h.host.freeMove('white', 24, 19); // black holds its 6-point
    await flush();
    expect(h.host.getState().error).toMatchObject({ code: 'blocked' });
    expect(h.guest.getState().error).toBeNull();
    expect(h.host.getState().snapshot!.seq).toBe(seq);
    h.guest.freeMove('white', 24, 24);
    await flush();
    expect(h.guest.getState().error).toMatchObject({ code: 'same-location' });
    expect(h.guest.getState().snapshot!.seq).toBe(seq);
    h.expectConverged();
    h.close();
  });

  it('malformed free messages are rejected without touching state', async () => {
    const h = await freeHarness();
    const seq = h.server.getSnapshot().seq;
    // Bypass the client and send raw garbage through the guest's transport.
    const [serverEnd, clientEnd] = (await import('@bgf/protocol')).createMemoryPair('raw');
    h.server.accept(serverEnd);
    const errors: unknown[] = [];
    clientEnd.onMessage((m) => errors.push(m));
    rawHello(clientEnd, GUEST);
    await flush();
    clientEnd.send({
      type: 'command',
      command: { type: 'free-move', checker: 'purple', from: 1, to: 2 },
    });
    clientEnd.send({
      type: 'command',
      command: { type: 'free-move', checker: 'white', from: 99, to: 2 },
    });
    clientEnd.send({ type: 'command', command: { type: 'free-cube', value: 3, owner: 'white' } });
    clientEnd.send({
      type: 'command',
      command: { type: 'free-result', winner: 'white', kind: 'huge' },
    });
    await flush();
    const codes = errors
      .filter((m) => (m as { type: string }).type === 'error')
      .map((m) => (m as { code: string }).code);
    expect(codes).toEqual(['bad-message', 'bad-message', 'bad-message', 'bad-message']);
    expect(h.server.getSnapshot().seq).toBe(seq);
    clientEnd.close();
    h.close();
  });

  it('cube, reset and recorded results propagate and score', async () => {
    const h = await freeHarness();
    h.guest.setCube(4, 'white');
    await flush();
    expect(currentGame(h.host).cube).toEqual({ value: 4, owner: 'white' });
    h.host.freeMove('white', 24, 4);
    h.host.freeRoll();
    await flush();
    h.guest.resetBoard();
    await flush();
    expect(currentGame(h.host).board).toEqual(startingBoard());
    expect(currentGame(h.host).phase).toEqual({ kind: 'free', dice: null });
    expect(currentGame(h.host).cube).toEqual({ value: 4, owner: 'white' });
    h.guest.recordResult('white', 'gammon');
    await flush();
    for (const c of [h.host, h.guest]) {
      const s = c.getState().snapshot!.match;
      expect(s.score).toEqual({ white: 8, black: 0 });
      expect(s.winner).toBe('white');
      expect(s.game!.phase).toMatchObject({ kind: 'over', result: { how: 'recorded', points: 8 } });
    }
    expect(phaseSummary(h.host.getState()).text).toBe('You win the match!');
    h.expectConverged();
    h.close();
  });

  it('the next game starts on a free board and keeps the score', async () => {
    const h = await freeHarness({ length: 11 });
    h.host.recordResult('black', 'single');
    await flush();
    expect(h.guest.getState().snapshot!.match.score).toEqual({ white: 0, black: 1 });
    h.guest.startGame();
    await flush();
    const g = currentGame(h.host);
    expect(g.phase).toEqual({ kind: 'free', dice: null });
    expect(g.board).toEqual(startingBoard());
    expect(h.host.getState().snapshot!.match.gameNumber).toBe(2);
    h.expectConverged();
    h.close();
  });

  it('enforced-mode matches refuse free commands', async () => {
    const h = await makeHarness({ config: { length: 5 } });
    h.host.startGame();
    await flush();
    const seq = h.host.getState().snapshot!.seq;
    h.host.freeRoll();
    h.guest.freeMove('white', 24, 20);
    h.host.setCube(2, 'black');
    h.guest.resetBoard();
    h.host.recordResult('white', 'single');
    await flush();
    expect(h.host.getState().error).toMatchObject({ code: 'free-mode' });
    expect(h.guest.getState().error).toMatchObject({ code: 'free-mode' });
    expect(h.host.getState().snapshot!.seq).toBe(seq);
    h.close();
  });

  it('resumes mid-game from a persisted snapshot by replaying free actions', async () => {
    const h = await freeHarness();
    h.host.freeRoll();
    await flush();
    h.guest.freeMove('white', 24, 20);
    h.guest.freeMove('black', 8, 5);
    await flush();
    h.host.setCube(2, 'black');
    await flush();
    h.guest.sendChat('pause here');
    await flush();
    const saved = h.guestStore.peek(h.server.getSnapshot().id)!;
    expect(saved.actions.map((a) => a.type)).toEqual([
      'start-game',
      'free-roll',
      'free-move',
      'free-move',
      'free-cube',
    ]);
    h.close();

    // The guest resumes as host from its own copy.
    const server = new GameServer({
      code: saved.code,
      host: keyedProfile(GUEST),
      snapshot: saved,
      dice: scriptedDice([4, 4]),
    });
    const guestAsHost = new GameClient({
      transport: server.connectLocal(),
      profile: keyedProfile(GUEST),
      signer: signerOf(GUEST),
      store: new MemoryMatchStore(),
      pingIntervalMs: 0,
    });
    const { createMemoryPair } = await import('@bgf/protocol');
    const [serverEnd, clientEnd] = createMemoryPair('resume');
    server.accept(serverEnd);
    const original = new GameClient({
      transport: clientEnd,
      profile: keyedProfile(HOST),
      signer: signerOf(HOST),
      pingIntervalMs: 0,
    });
    await flush();
    expect(guestAsHost.getState().seat).toBe('black');
    expect(original.getState().seat).toBe('white');
    for (const c of [guestAsHost, original]) {
      const g = currentGame(c);
      expect(g.phase).toEqual({ kind: 'free', dice: { player: 'white', dice: [3, 1] } });
      expect(g.board.bar.white).toBe(1);
      expect(g.cube).toEqual({ value: 2, owner: 'black' });
      expect(c.getState().chat.map((m) => m.text)).toEqual(['pause here']);
    }
    // Play on after the resume.
    original.freeRoll();
    await flush();
    expect(lastFreeDice(guestAsHost.getState())).toEqual({ player: 'white', dice: [4, 4] });
    expect(clientFor).toBeTypeOf('function');
    original.close();
    guestAsHost.close();
    server.close();
  });
});
