import { describe, expect, it } from 'vitest';
import type { Action, MatchState } from '../src/index.js';
import {
  applyAction,
  canDouble,
  cryptoDice,
  legalPlays,
  newMatch,
  replay,
  rollDice,
  scriptedDice,
  seededDice,
} from '../src/index.js';

/**
 * Drive a whole match with a naive policy (first legal play; double when allowed on a scripted
 * coin, always take), collecting the action log.
 */
function simulateMatch(seed: number, length: number): { actions: Action[]; final: MatchState } {
  const dice = seededDice(seed);
  const coin = seededDice(seed ^ 0x5bd1e995);
  const actions: Action[] = [];
  let m = newMatch({ length, crawford: true, jacoby: true });
  const step = (a: Action) => {
    m = applyAction(m, a);
    actions.push(a);
  };
  step({ type: 'start-game' });
  let guard = 0;
  while (!m.winner) {
    if (++guard > 20_000) throw new Error('simulation did not terminate');
    const g = m.game!;
    const ph = g.phase;
    switch (ph.kind) {
      case 'opening':
        if (ph.rolls.white === undefined) step({ type: 'opening-roll', player: 'white', die: dice.rollDie() });
        else step({ type: 'opening-roll', player: 'black', die: dice.rollDie() });
        break;
      case 'to-roll':
        if (canDouble(g, ph.player) && coin.rollDie() === 6) step({ type: 'double', player: ph.player });
        else step({ type: 'roll', player: ph.player, dice: rollDice(dice) });
        break;
      case 'double-offered':
        step({ type: 'take', player: ph.by === 'white' ? 'black' : 'white' });
        break;
      case 'moving': {
        const plays = legalPlays(g.board, ph.player, ph.dice);
        step({ type: 'play', player: ph.player, play: plays[0]! });
        break;
      }
      case 'resign-offered':
        throw new Error('unexpected');
      case 'over':
        step({ type: 'start-game' });
        break;
    }
  }
  return { actions, final: m };
}

describe('replay', () => {
  it('reproduces a simulated match exactly from its action log', () => {
    const { actions, final } = simulateMatch(42, 3);
    expect(final.winner).not.toBeNull();
    expect(actions.length).toBeGreaterThan(20);
    const again = replay({ length: 3, crawford: true, jacoby: true }, actions);
    expect(again).toEqual(final);
    expect(JSON.stringify(again)).toBe(JSON.stringify(final));
  });

  it('several seeds terminate and stay internally consistent', () => {
    for (const seed of [1, 7, 99, 2024]) {
      const { final } = simulateMatch(seed, 5);
      expect(final.winner).not.toBeNull();
      expect(final.games.length).toBeGreaterThan(0);
      const total = final.games.reduce((n, g) => n + g.result.points, 0);
      expect(final.score.white + final.score.black).toBe(total);
      expect(final.games.at(-1)!.scoreAfter).toEqual(final.score);
      expect(final.gameNumber).toBe(final.games.length + 1);
      for (const g of final.games) expect(g.result.points).toBeGreaterThan(0);
    }
  });

  it('a truncated or corrupted log fails to replay', () => {
    const { actions } = simulateMatch(5, 1);
    const bad = actions.slice();
    bad.splice(3, 1); // drop an action → later ones are out of phase
    expect(() => replay({ length: 1 }, bad)).toThrow();
  });
});

describe('dice sources', () => {
  it('seededDice is deterministic per seed and uniform enough', () => {
    const a = seededDice(123);
    const b = seededDice(123);
    const seqA = Array.from({ length: 50 }, () => a.rollDie());
    const seqB = Array.from({ length: 50 }, () => b.rollDie());
    expect(seqA).toEqual(seqB);
    expect(Array.from({ length: 50 }, () => seededDice(124).rollDie())).not.toEqual(seqA);
    const counts = [0, 0, 0, 0, 0, 0, 0];
    const src = seededDice(7);
    for (let i = 0; i < 6000; i++) {
      const d = src.rollDie();
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(6);
      counts[d]!++;
    }
    for (let f = 1; f <= 6; f++) {
      expect(counts[f]).toBeGreaterThan(800);
      expect(counts[f]).toBeLessThan(1200);
    }
  });

  it('scriptedDice replays its script in a loop', () => {
    const s = scriptedDice([3, 1, 6]);
    expect([s.rollDie(), s.rollDie(), s.rollDie(), s.rollDie()]).toEqual([3, 1, 6, 3]);
    expect(rollDice(scriptedDice([5, 2]))).toEqual([5, 2]);
  });

  it('cryptoDice stays in range', () => {
    const c = cryptoDice();
    for (let i = 0; i < 500; i++) {
      const d = c.rollDie();
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(6);
    }
  });
});
