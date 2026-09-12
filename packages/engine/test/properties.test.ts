import { describe, expect, it } from 'vitest';
import type { DiceRoll, SubMove } from '../src/index.js';
import {
  BAR,
  OFF,
  allInHome,
  applyPlay,
  applySubMove,
  boardsEqual,
  countAt,
  findLegalPlay,
  legalPlays,
  opponentCountAt,
  totalCheckers,
  turnOptions,
  turnStartBoard,
  undoSubMove,
} from '../src/index.js';
import { prng, randomBoard, randomDie, sig } from './helpers.js';

const ITERATIONS = 250;

describe('properties of legalPlays', () => {
  const rnd = prng(0xbeef);

  it('every generated play is well-formed, applies cleanly and preserves invariants', () => {
    let positionsWithMoves = 0;
    let playsChecked = 0;
    const problems: string[] = [];
    const note = (what: string, board: unknown, dice: DiceRoll, p: readonly SubMove[]) => {
      if (problems.length < 5) problems.push(`${what}: dice=${dice} play=${sig(p)} board=${JSON.stringify(board)}`);
    };
    for (let i = 0; i < ITERATIONS; i++) {
      const board = randomBoard(rnd);
      const player = rnd() < 0.5 ? 'white' : 'black';
      const dice: DiceRoll = [randomDie(rnd), randomDie(rnd)];
      const plays = legalPlays(board, player, dice);
      if (plays.length === 0) continue;
      positionsWithMoves++;
      const len = plays[0]!.length;
      const maxLen = dice[0] === dice[1] ? 4 : 2;
      if (len < 1 || len > maxLen) note('bad length', board, dice, plays[0]!);
      const seen = new Set<string>();
      // findLegalPlay re-enumerates, so only spot-check a few plays per position
      const sample = new Set([0, plays.length - 1, Math.floor(plays.length / 2)]);
      plays.forEach((p, idx) => {
        playsChecked++;
        // (d) all plays have the same length
        if (p.length !== len) note('unequal length', board, dice, p);
        // no duplicate sequences
        const key = p.map((m) => `${m.from}>${m.to}/${m.die}`).join(' ');
        if (seen.has(key)) note('duplicate', board, dice, p);
        seen.add(key);
        let b = board;
        for (const m of p) {
          if (m.die !== dice[0] && m.die !== dice[1]) note('foreign die', board, dice, p);
          // source must hold one of the mover's checkers
          if (countAt(b, player, m.from) === 0) note('empty source', board, dice, p);
          // bar first
          if (b.bar[player] > 0 && m.from !== BAR) note('bar not entered first', board, dice, p);
          if (m.to === OFF) {
            if (!allInHome(b, player) || m.from > 6) note('illegal bear-off', board, dice, p);
          } else {
            if (m.to !== m.from - m.die) note('distance != die', board, dice, p);
            // (c) never lands on a point held by two or more opponents
            const opp = opponentCountAt(b, player, m.to);
            if (opp > 1) note('landed on a block', board, dice, p);
            if (m.hit !== (opp === 1)) note('wrong hit flag', board, dice, p);
          }
          // (a) applies without throwing
          b = applySubMove(b, player, m);
          // (b) checker counts preserved
          if (totalCheckers(b, 'white') !== 15 || totalCheckers(b, 'black') !== 15) {
            note('checker count changed', board, dice, p);
          }
        }
        // (e) findLegalPlay accepts the play (with hit flags stripped)
        if (sample.has(idx)) {
          const stripped = p.map((m) => ({ ...m, hit: false }));
          const found = findLegalPlay(board, player, dice, stripped);
          if (!found || sig(found) !== sig(p)) note('findLegalPlay rejected', board, dice, p);
        }
      });
    }
    expect(problems).toEqual([]);
    expect(positionsWithMoves).toBeGreaterThan(ITERATIONS / 2);
    expect(playsChecked).toBeGreaterThan(ITERATIONS);
  }, 30_000);

  it('rejects mutated plays', () => {
    const r = prng(0xcafe);
    let checked = 0;
    for (let i = 0; i < ITERATIONS && checked < 100; i++) {
      const board = randomBoard(r);
      const player = r() < 0.5 ? 'white' : 'black';
      const dice: DiceRoll = [randomDie(r), randomDie(r)];
      const plays = legalPlays(board, player, dice);
      if (plays.length === 0) continue;
      const p = plays[Math.floor(r() * plays.length)]!;
      // a source point without any of the mover's checkers is always illegal
      let empty = -1;
      for (let rel = 1; rel <= 24; rel++) {
        if (countAt(board, player, rel) === 0) {
          empty = rel;
          break;
        }
      }
      expect(empty).toBeGreaterThan(0);
      const first = p[0]!;
      const bogus: SubMove = { ...first, from: empty, to: Math.max(OFF, empty - first.die) };
      expect(findLegalPlay(board, player, dice, [bogus, ...p.slice(1)])).toBeNull();
      // too long
      expect(findLegalPlay(board, player, dice, [...p, first])).toBeNull();
      // too short (when the play has at least two moves)
      if (p.length > 1) expect(findLegalPlay(board, player, dice, p.slice(0, -1))).toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('the higher-die rule and the maximal-length rule hold', () => {
    const r = prng(0xd00d);
    for (let i = 0; i < ITERATIONS; i++) {
      const board = randomBoard(r);
      const player = r() < 0.5 ? 'white' : 'black';
      const dice: DiceRoll = [randomDie(r), randomDie(r)];
      const plays = legalPlays(board, player, dice);
      if (plays.length === 0 || dice[0] === dice[1]) continue;
      const len = plays[0]!.length;
      if (len === 1) {
        const hi = Math.max(dice[0], dice[1]);
        const lo = Math.min(dice[0], dice[1]);
        const dieUsed = plays[0]!.map((p) => p.die);
        // if any play uses the higher die, all plays must
        const anyHi = plays.some((p) => p[0]!.die === hi);
        if (anyHi) expect(plays.every((p) => p[0]!.die === hi)).toBe(true);
        else expect(plays.every((p) => p[0]!.die === lo)).toBe(true);
        expect(dieUsed).toHaveLength(1);
      } else {
        expect(len).toBe(2);
        for (const p of plays) expect(new Set(p.map((m) => m.die)).size).toBe(2);
      }
    }
  });
});

describe('properties of turnOptions', () => {
  it('stepping through any legal play keeps it as a prefix and completes at the end', () => {
    const r = prng(0xf00d);
    for (let i = 0; i < 120; i++) {
      const board = randomBoard(r);
      const player = r() < 0.5 ? 'white' : 'black';
      const dice: DiceRoll = [randomDie(r), randomDie(r)];
      const plays = legalPlays(board, player, dice);
      if (plays.length === 0) {
        const t = turnOptions(board, player, dice, []);
        expect(t.maxMoves).toBe(0);
        expect(t.complete).toBe(true);
        continue;
      }
      const p = plays[Math.floor(r() * plays.length)]!;
      for (let k = 0; k < p.length; k++) {
        const t = turnOptions(board, player, dice, p.slice(0, k));
        expect(t.complete).toBe(false);
        expect(t.maxMoves).toBe(p.length);
        expect(t.next.map(sig)).toContain(sig([p[k]!]));
        expect(t.remaining).toHaveLength((dice[0] === dice[1] ? 4 : 2) - k);
      }
      const done = turnOptions(board, player, dice, p);
      expect(done.complete).toBe(true);
      expect(done.next).toEqual([]);
      // the reconstructed start board matches
      const after = applyPlay(board, player, p);
      expect(boardsEqual(turnStartBoard(after, player, p), board)).toBe(true);
    }
  });
});

describe('apply/undo symmetry', () => {
  it('undoing a play in reverse restores the board for random positions', () => {
    const r = prng(0xabcd);
    for (let i = 0; i < 150; i++) {
      const board = randomBoard(r);
      const player = r() < 0.5 ? 'white' : 'black';
      const dice: DiceRoll = [randomDie(r), randomDie(r)];
      const plays = legalPlays(board, player, dice);
      for (const p of plays.slice(0, 5)) {
        let b = applyPlay(board, player, p);
        for (let k = p.length - 1; k >= 0; k--) b = undoSubMove(b, player, p[k]!);
        expect(boardsEqual(b, board)).toBe(true);
      }
    }
  });
});
