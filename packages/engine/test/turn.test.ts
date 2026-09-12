import { describe, expect, it } from 'vitest';
import {
  BAR,
  OFF,
  applyPlay,
  boardFrom,
  boardsEqual,
  destinationsFrom,
  legalPlays,
  startingBoard,
  turnOptions,
  turnStartBoard,
} from '../src/index.js';
import { sig, sm } from './helpers.js';

describe('turnOptions', () => {
  it('lists first moves for both dice and tracks remaining dice', () => {
    const b = startingBoard();
    const t = turnOptions(b, 'white', [3, 1], []);
    expect(t.maxMoves).toBe(2);
    expect(t.complete).toBe(false);
    expect(t.remaining).toEqual([3, 1]);
    const keys = t.next.map(sig);
    expect(keys).toContain('8/5');
    expect(keys).toContain('6/5');
    expect(keys).toContain('24/21');
    expect(keys).toContain('24/23');
    expect(keys).toContain('13/10');
    expect(keys).not.toContain('13/12'); // blocked by black's 13-point stack
    // every next move is unique
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('after one sub-move only the other die remains, and after two the turn is complete', () => {
    const b = startingBoard();
    const t1 = turnOptions(b, 'white', [3, 1], [sm(8, 5, 3)]);
    expect(t1.remaining).toEqual([1]);
    expect(t1.complete).toBe(false);
    expect(t1.next.every((m) => m.die === 1)).toBe(true);
    expect(t1.next.map(sig)).toContain('5/4'); // the moved checker may continue
    expect(t1.next.map(sig)).toContain('6/5');
    const t2 = turnOptions(b, 'white', [3, 1], [sm(8, 5, 3), sm(6, 5, 1)]);
    expect(t2.complete).toBe(true);
    expect(t2.next).toEqual([]);
    expect(t2.remaining).toEqual([]);
  });

  it('a prefix that leads nowhere legal yields no next moves and is incomplete', () => {
    // From `tempting`: 8/2* strands the 1, so it is not a prefix of any legal play.
    const b = boardFrom({ 8: 1, 13: 1, 6: 13 }, { 23: 1, 13: 5, 20: 2, 24: 2, 6: 5 });
    const t = turnOptions(b, 'white', [6, 1], [sm(8, 2, 6)]);
    expect(t.next).toEqual([]);
    expect(t.complete).toBe(false);
    expect(t.maxMoves).toBe(2);
  });

  it('doubles expose four dice and four steps', () => {
    const b = startingBoard();
    const t0 = turnOptions(b, 'white', [6, 6], []);
    expect(t0.remaining).toEqual([6, 6, 6, 6]);
    expect(t0.maxMoves).toBe(4);
    const played = [sm(24, 18, 6), sm(24, 18, 6), sm(13, 7, 6)];
    const t3 = turnOptions(b, 'white', [6, 6], played);
    expect(t3.remaining).toEqual([6]);
    expect(t3.complete).toBe(false);
    expect(t3.next.map(sig)).toContain('13/7');
    expect(t3.next.map(sig)).toContain('8/2');
    expect(t3.next.map(sig)).not.toContain('18/12'); // white's 12-point is black's 13-point stack
    const t4 = turnOptions(b, 'white', [6, 6], [...played, sm(13, 7, 6)]);
    expect(t4.complete).toBe(true);
  });

  it('with no legal move the (empty) turn is complete', () => {
    const b = boardFrom({ 13: 1, 6: 14 }, { 18: 2, 13: 5, 20: 2, 6: 6 });
    const t = turnOptions(b, 'white', [6, 1], []);
    expect(t.maxMoves).toBe(0);
    expect(t.next).toEqual([]);
    expect(t.complete).toBe(true);
  });

  it('a forced single-die turn is complete after one move', () => {
    const b = boardFrom({ 8: 1, 6: 14 }, { 24: 2, 20: 2, 6: 5, 13: 5, 8: 1 });
    const t0 = turnOptions(b, 'white', [1, 6], []);
    expect(t0.maxMoves).toBe(1);
    expect(t0.next.map(sig)).toEqual(['8/2']);
    const t1 = turnOptions(b, 'white', [1, 6], [sm(8, 2, 6)]);
    expect(t1.complete).toBe(true);
    expect(t1.remaining).toEqual([1]);
  });
});

describe('turnStartBoard', () => {
  it('undoes the played sub-moves in reverse', () => {
    const b = boardFrom({ 8: 1, 7: 1, 6: 13 }, { 20: 1, 6: 14 });
    const play = [sm(8, 5, 3, true), sm(7, 5, 2)];
    const after = applyPlay(b, 'white', play);
    expect(boardsEqual(turnStartBoard(after, 'white', play), b)).toBe(true);
    expect(boardsEqual(turnStartBoard(after, 'white', []), after)).toBe(true);
  });
});

describe('destinationsFrom', () => {
  it('single-die and combined destinations from the starting position', () => {
    const b = startingBoard();
    const d = destinationsFrom(b, 'white', [3, 1], [], 8);
    expect(d.map((x) => x.to)).toEqual([7, 5, 4]); // sorted descending
    expect(d.find((x) => x.to === 4)!.via.map(sig)).toEqual(['8/5', '5/4']);
    expect(d.find((x) => x.to === 7)!.via).toHaveLength(1);
    // from 24 the combined 24/20 is reachable via 21 or 23
    const d24 = destinationsFrom(b, 'white', [3, 1], [], 24);
    expect(d24.map((x) => x.to)).toEqual([23, 21, 20]);
  });

  it('a combined destination needs a legal intermediate point', () => {
    // 13/12 blocked so 13→6 must go via 7
    const b = boardFrom({ 13: 1, 6: 14 }, { 13: 5, 6: 5, 8: 3, 24: 2 });
    const d = destinationsFrom(b, 'white', [6, 1], [], 13);
    expect(d.map((x) => x.to)).toEqual([7, 6]);
    expect(d.find((x) => x.to === 6)!.via.map(sig)).toEqual(['13/7', '7/6']);
    // block 7 too (black on its 18) → nothing at all from 13
    const b2 = boardFrom({ 13: 1, 6: 14 }, { 13: 5, 18: 2, 6: 5, 8: 1, 24: 2 });
    expect(destinationsFrom(b2, 'white', [6, 1], [], 13)).toEqual([]);
  });

  it('doubles chain up to four steps with one checker', () => {
    // black holds white's 12-point so the fourth 3 (12) is not reachable from 24
    const b = boardFrom({ 24: 1, 6: 14 }, { 13: 5, 6: 5, 8: 3, 24: 2 });
    const d = destinationsFrom(b, 'white', [3, 3], [], 24);
    expect(d.map((x) => x.to)).toEqual([21, 18, 15]);
    expect(d.find((x) => x.to === 15)!.via).toHaveLength(3);
    const open = boardFrom({ 24: 1, 6: 14 }, { 6: 5, 8: 3, 24: 2, 2: 5 });
    const d2 = destinationsFrom(open, 'white', [2, 2], [], 24);
    expect(d2.map((x) => x.to)).toEqual([22, 20, 18, 16]);
  });

  it('the bar is a valid source', () => {
    const b = boardFrom({ [BAR]: 1, 13: 14 }, { 13: 15 });
    const d = destinationsFrom(b, 'white', [3, 4], [], BAR);
    expect(d.map((x) => x.to)).toEqual([22, 21, 18]);
    expect(d.find((x) => x.to === 18)!.via[0]!.from).toBe(BAR);
    // nothing else may move while on the bar
    expect(destinationsFrom(b, 'white', [3, 4], [], 13)).toEqual([]);
  });

  it('bear-off destinations use `to: 0` and do not chain further', () => {
    const b = boardFrom({ 6: 1, 5: 1, 1: 13 }, { 13: 15 });
    const d = destinationsFrom(b, 'white', [6, 5], [], 6);
    expect(d.map((x) => x.to)).toEqual([1, OFF]);
    const d5 = destinationsFrom(b, 'white', [6, 5], [], 5);
    expect(d5.map((x) => x.to)).toEqual([OFF]);
  });

  it('respects moves already played', () => {
    const b = startingBoard();
    const d = destinationsFrom(b, 'white', [3, 1], [sm(8, 5, 3)], 6);
    expect(d.map((x) => x.to)).toEqual([5]);
    expect(destinationsFrom(b, 'white', [3, 1], [sm(8, 5, 3), sm(6, 5, 1)], 24)).toEqual([]);
  });

  it('every destination is a prefix of some legal play', () => {
    const b = startingBoard();
    const plays = legalPlays(b, 'white', [4, 2]);
    for (const from of [24, 13, 8, 6]) {
      for (const dest of destinationsFrom(b, 'white', [4, 2], [], from)) {
        const ok = plays.some((p) => dest.via.every((m, i) => sig([p[i]!]) === sig([m])));
        expect(ok).toBe(true);
      }
    }
  });
});
