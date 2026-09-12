import { describe, expect, it } from 'vitest';
import {
  BAR,
  OFF,
  boardFrom,
  newMatch,
  replay,
  scriptedDice,
  seededDice,
  startGame,
} from '@bgf/engine';
import type { MatchState } from '@bgf/engine';
import {
  autoPlay,
  clientFor,
  currentGame,
  flush,
  makeHarness,
  playOut,
  startAndOpen,
} from './harness.js';

function positioned(
  game: Partial<NonNullable<MatchState['game']>>,
  config: Partial<MatchState['config']> = { length: 5 },
): MatchState {
  const m = startGame(newMatch(config));
  return { ...m, game: { ...m.game!, ...game } };
}

describe('full game over two clients', () => {
  it('plays a complete seeded game to the end with both clients converging at every step', async () => {
    const h = await makeHarness({ dice: seededDice(2024), config: { length: 3 } });
    await startAndOpen(h);
    const actions = await playOut(h);
    const g = currentGame(h.host);
    expect(g.phase.kind).toBe('over');
    if (g.phase.kind !== 'over') return;
    expect(g.board.off[g.phase.result.winner]).toBe(15);
    expect(g.phase.result.points).toBeGreaterThanOrEqual(1);
    const snap = h.server.getSnapshot();
    expect(snap.match.score[g.phase.result.winner]).toBe(g.phase.result.points);
    expect(snap.match.games.length).toBe(1);
    expect(snap.match.gameNumber).toBe(2);
    expect(snap.seq).toBe(snap.actions.length);
    expect(actions.length).toBeGreaterThan(20);
    // The action log replays to the identical match state.
    expect(replay(snap.config, snap.actions)).toEqual(snap.match);
    // Both stores hold the final snapshot.
    expect(h.hostStore.peek(snap.id)!.seq).toBe(snap.seq);
    expect(h.guestStore.peek(snap.id)!.seq).toBe(snap.seq);
    h.close();
  }, 30_000);

  it('bear-off ends the game and the match layer scores a backgammon with the cube', async () => {
    // White has one checker left on its 2-point; black still has a checker in white's home board.
    const board = boardFrom({ 2: 1, [OFF]: 14 }, { 24: 2, 13: 13 });
    const h = await makeHarness({
      dice: scriptedDice([6, 5]),
      initialMatch: positioned({
        board,
        cube: { value: 2, owner: 'black' },
        phase: { kind: 'to-roll', player: 'white' },
      }),
    });
    h.host.roll();
    await flush();
    expect(h.host.getState().draft.maxMoves).toBe(1);
    autoPlay(h.host);
    await flush();
    const g = currentGame(h.guest);
    expect(g.phase).toMatchObject({
      kind: 'over',
      result: { winner: 'white', kind: 'backgammon', how: 'bearoff', cube: 2, points: 6 },
    });
    expect(h.guest.getState().snapshot!.match.score).toEqual({ white: 6, black: 0 });
    expect(h.guest.getState().snapshot!.match.winner).toBe('white'); // 6 >= 5: match over
    h.close();
  });

  it('winning enough points ends the match and start-game is refused', async () => {
    const board = boardFrom({ 1: 1, [OFF]: 14 }, { 1: 1, [OFF]: 14 });
    const h = await makeHarness({
      dice: scriptedDice([2, 1]),
      config: { length: 1 },
      initialMatch: positioned(
        { board, phase: { kind: 'to-roll', player: 'black' } },
        { length: 1 },
      ),
    });
    h.guest.roll();
    await flush();
    autoPlay(h.guest);
    await flush();
    const snap = h.host.getState().snapshot!;
    expect(snap.match.winner).toBe('black');
    expect(snap.match.score).toEqual({ white: 0, black: 1 });
    expect(snap.match.games[0]!.result).toMatchObject({
      winner: 'black',
      kind: 'single',
      points: 1,
    });
    h.host.startGame();
    await flush();
    expect(h.host.getState().error?.code).toBe('match-over');
    h.expectConverged();
    h.close();
  });

  it('double → take transfers the cube; the taker may later redouble; drop ends the game', async () => {
    const h = await makeHarness({
      dice: scriptedDice([3, 1, 4, 2]),
      initialMatch: positioned({ phase: { kind: 'to-roll', player: 'white' } }),
    });
    h.guest.double(); // not on roll
    await flush();
    expect(h.guest.getState().error?.code).toBe('cannot-double');
    h.host.double();
    await flush();
    expect(currentGame(h.guest).phase).toEqual({ kind: 'double-offered', by: 'white' });
    h.host.take(); // only the responder may take
    await flush();
    expect(h.host.getState().error?.code).toBe('not-your-turn');
    h.guest.take();
    await flush();
    let g = currentGame(h.host);
    expect(g.cube).toEqual({ value: 2, owner: 'black' });
    expect(g.phase).toEqual({ kind: 'to-roll', player: 'white' });
    h.host.double(); // cube is now black's
    await flush();
    expect(h.host.getState().error?.code).toBe('cannot-double');
    h.host.roll();
    await flush();
    autoPlay(h.host);
    await flush();
    g = currentGame(h.guest);
    expect(g.phase).toEqual({ kind: 'to-roll', player: 'black' });
    h.guest.double();
    await flush();
    expect(currentGame(h.host).phase).toEqual({ kind: 'double-offered', by: 'black' });
    h.host.drop();
    await flush();
    g = currentGame(h.host);
    expect(g.phase).toMatchObject({
      kind: 'over',
      result: { winner: 'black', how: 'drop', cube: 2, points: 2 },
    });
    expect(h.host.getState().snapshot!.match.score).toEqual({ white: 0, black: 2 });
    expect(g.history.map((t) => t.type)).toEqual(['double', 'take', 'move', 'double', 'drop']);
    h.expectConverged();
    h.close();
  });

  it('no doubling in the Crawford game, and doubling returns afterwards', async () => {
    const h = await makeHarness({
      dice: scriptedDice([2, 1]),
      config: { length: 2 },
      initialMatch: {
        ...newMatch({ length: 2 }),
        score: { white: 1, black: 0 },
      },
    });
    h.guest.startGame();
    await flush();
    let g = currentGame(h.host);
    expect(g.crawford).toBe(true);
    expect(h.host.getState().snapshot!.match.crawfordDone).toBe(true);
    // finish the opening roll: white 2, black 1 → white moves
    h.host.openingRoll();
    h.guest.openingRoll();
    await flush();
    autoPlay(h.host);
    await flush();
    h.guest.double();
    await flush();
    expect(h.guest.getState().error?.code).toBe('crawford');
    // Black resigns this game; next game is post-Crawford and doubling is allowed again.
    h.guest.offerResign('single');
    await flush();
    h.host.acceptResign();
    await flush();
    expect(h.host.getState().snapshot!.match.winner).toBe('white'); // 2 points reached
    h.close();
    // Separate match where the loser of the Crawford game is still alive.
    const h2 = await makeHarness({
      dice: scriptedDice([2, 1]),
      config: { length: 3 },
      initialMatch: { ...newMatch({ length: 3 }), score: { white: 2, black: 0 } },
    });
    h2.host.startGame();
    await flush();
    h2.host.openingRoll();
    h2.guest.openingRoll();
    await flush();
    h2.host.offerResign('single');
    await flush();
    h2.guest.acceptResign();
    await flush();
    expect(h2.host.getState().snapshot!.match.score).toEqual({ white: 2, black: 1 });
    h2.guest.startGame();
    await flush();
    g = currentGame(h2.host);
    expect(g.crawford).toBe(false);
    h2.host.openingRoll();
    h2.guest.openingRoll();
    await flush();
    autoPlay(h2.host);
    await flush();
    h2.guest.double();
    await flush();
    expect(currentGame(h2.host).phase).toEqual({ kind: 'double-offered', by: 'black' });
    h2.expectConverged();
    h2.close();
  });

  it('resignation: decline restores the phase (and the draft); accept scores the offered stakes', async () => {
    const h = await makeHarness({
      dice: scriptedDice([3, 1]),
      initialMatch: positioned({
        cube: { value: 4, owner: 'white' },
        phase: { kind: 'to-roll', player: 'white' },
      }),
    });
    h.host.roll();
    await flush();
    const first = h.host.getState().draft.next[0]!;
    h.host.stage(first);
    h.host.offerResign('gammon');
    await flush();
    expect(currentGame(h.guest).phase).toMatchObject({
      kind: 'resign-offered',
      by: 'white',
      stakes: 'gammon',
    });
    expect(h.host.getState().draft.played).toEqual([first]); // draft survives the offer
    h.host.acceptResign(); // wrong seat
    await flush();
    expect(h.host.getState().error?.code).toBe('not-your-turn');
    h.guest.declineResign();
    await flush();
    expect(currentGame(h.host).phase).toMatchObject({
      kind: 'moving',
      player: 'white',
      dice: [3, 1],
    });
    expect(h.host.getState().draft.played).toEqual([first]);
    autoPlay(h.host);
    await flush();
    expect(currentGame(h.host).phase).toEqual({ kind: 'to-roll', player: 'black' });
    h.guest.offerResign('backgammon');
    await flush();
    h.host.acceptResign();
    await flush();
    const g = currentGame(h.guest);
    expect(g.phase).toMatchObject({
      kind: 'over',
      result: { winner: 'white', kind: 'backgammon', how: 'resign', cube: 4, points: 12 },
    });
    expect(h.guest.getState().snapshot!.match.winner).toBe('white');
    h.expectConverged();
    h.close();
  });

  it('either seat can start the next game after one ends, and the score carries over', async () => {
    const board = boardFrom({ 1: 1, [OFF]: 14 }, { 13: 15 });
    const h = await makeHarness({
      dice: scriptedDice([1, 1, 5, 2]),
      config: { length: 7 },
      initialMatch: positioned(
        { board, phase: { kind: 'to-roll', player: 'white' } },
        { length: 7 },
      ),
    });
    h.host.roll();
    await flush();
    autoPlay(h.host);
    await flush();
    expect(currentGame(h.guest).phase).toMatchObject({
      kind: 'over',
      result: { kind: 'gammon', points: 2 },
    });
    h.guest.startGame();
    await flush();
    const snap = h.host.getState().snapshot!;
    expect(snap.match.gameNumber).toBe(2);
    expect(snap.match.score).toEqual({ white: 2, black: 0 });
    expect(snap.match.games.length).toBe(1);
    expect(currentGame(h.host).phase).toMatchObject({ kind: 'opening', ties: 0 });
    expect(currentGame(h.host).board.off).toEqual({ white: 0, black: 0 });
    h.host.openingRoll();
    h.guest.openingRoll();
    await flush();
    expect(currentGame(h.host).phase).toMatchObject({
      kind: 'moving',
      player: 'white',
      dice: [5, 2],
    });
    h.expectConverged();
    h.close();
  });

  it('money play with Jacoby: an untouched cube turns a gammon into a single', async () => {
    const board = boardFrom({ 1: 1, [OFF]: 14 }, { 13: 15 });
    const h = await makeHarness({
      dice: scriptedDice([1, 1]),
      config: { length: 0, jacoby: true },
      initialMatch: positioned(
        { board, phase: { kind: 'to-roll', player: 'white' } },
        { length: 0, jacoby: true },
      ),
    });
    h.host.roll();
    await flush();
    autoPlay(h.host);
    await flush();
    expect(currentGame(h.host).phase).toMatchObject({
      kind: 'over',
      result: { kind: 'gammon', points: 1 },
    });
    expect(h.host.getState().snapshot!.match.winner).toBeNull();
    h.close();
  });

  it('bar entry is enforced through the whole stack', async () => {
    const board = boardFrom({ [BAR]: 2, 13: 13 }, { 1: 2, 2: 2, 13: 11 });
    const h = await makeHarness({
      dice: scriptedDice([1, 3]),
      initialMatch: positioned({ board, phase: { kind: 'to-roll', player: 'white' } }),
    });
    h.host.roll();
    await flush();
    const d = h.host.getState().draft;
    // die 1 → 24 blocked, die 3 → 22 open; only one checker can enter, the other stays; max 1 move
    expect(d.maxMoves).toBe(1);
    expect(d.next).toEqual([{ from: BAR, to: 22, die: 3, hit: false }]);
    h.close();
  });

  it('clientFor works for both seats after a hostSeat swap', async () => {
    const h = await makeHarness({ hostSeat: 'black' });
    expect(clientFor(h, 'black')).toBe(h.host);
    h.close();
  });
});
