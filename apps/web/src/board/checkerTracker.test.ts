import { describe, expect, it } from 'vitest';
import {
  BAR,
  boardFrom,
  applyPlay,
  startingBoard,
  applyAction,
  newMatch,
  newGame,
} from '@bgf/engine';
import type { SubMove } from '@bgf/engine';
import {
  applyPlayToTracker,
  createTracker,
  reconcile,
  relToLocation,
  stacked,
  trackAction,
  countAtLocation,
  applyFreeMoveToTracker,
} from './checkerTracker';
import { locationKey } from './contract';

describe('checkerTracker', () => {
  it('creates 30 checkers with stable ids from the starting board', () => {
    const t = createTracker(startingBoard());
    expect(t.checkers).toHaveLength(30);
    expect(t.checkers.filter((c) => c.player === 'white')).toHaveLength(15);
    expect(new Set(t.checkers.map((c) => c.id)).size).toBe(30);
    const s = stacked(t);
    const p6 = s.filter((c) => locationKey(c.location) === 'p6');
    expect(p6).toHaveLength(5);
    expect(p6.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
    expect(p6.every((c) => c.stackSize === 5)).toBe(true);
    // black's 6-point is abs 19
    expect(s.filter((c) => locationKey(c.location) === 'p19' && c.player === 'black')).toHaveLength(
      5,
    );
  });

  it('moves exactly the top checker of the source stack', () => {
    const t = createTracker(startingBoard());
    const before = stacked(t);
    const top8 = before.filter((c) => locationKey(c.location) === 'p8').at(-1)!;
    const play: SubMove[] = [{ from: 8, to: 5, die: 3, hit: false }];
    const { tracker, moved, hit } = applyPlayToTracker(t, 'white', play);
    expect(moved).toEqual([top8.id]);
    expect(hit).toEqual([]);
    const after = stacked(tracker);
    expect(after.find((c) => c.id === top8.id)!.location).toEqual({ kind: 'point', point: 5 });
    expect(after.filter((c) => locationKey(c.location) === 'p8')).toHaveLength(2);
    // everything else stayed
    for (const c of before) {
      if (c.id === top8.id) continue;
      expect(after.find((x) => x.id === c.id)!.location).toEqual(c.location);
    }
  });

  it('sends a hit checker to the bar and bears off into the tray', () => {
    // white blot on rel 5 (abs 5); black checker on black rel 20 = abs 5? No: black rel 20 = abs 5.
    const board = boardFrom({ 5: 1, 13: 14 }, { 24: 1, 13: 14 });
    // black rel 24 = abs 1. Black rolls 4 from rel 24 → rel 20 = abs 5, hitting white.
    const t = createTracker(board);
    const whiteBlot = t.checkers.find(
      (c) => c.player === 'white' && locationKey(c.location) === 'p5',
    )!;
    const res = applyPlayToTracker(t, 'black', [{ from: 24, to: 20, die: 4, hit: true }]);
    expect(res.hit).toEqual([whiteBlot.id]);
    const after = res.tracker.checkers.find((c) => c.id === whiteBlot.id)!;
    expect(after.location).toEqual({ kind: 'bar', player: 'white' });
    expect(countAtLocation(res.tracker, { kind: 'point', point: 5 })).toBe(1);

    const bearing = boardFrom({ 3: 2, 1: 13 }, { 13: 15 });
    const t2 = createTracker(bearing);
    const r2 = applyPlayToTracker(t2, 'white', [
      { from: 3, to: 0, die: 6, hit: false },
      { from: 3, to: 0, die: 5, hit: false },
    ]);
    expect(countAtLocation(r2.tracker, { kind: 'off', player: 'white' })).toBe(2);
    expect(countAtLocation(r2.tracker, { kind: 'point', point: 3 })).toBe(0);
  });

  it('bar entry moves the bar checker', () => {
    const board = boardFrom({ [BAR]: 1, 13: 14 }, { 13: 15 });
    const t = createTracker(board);
    const res = applyPlayToTracker(t, 'white', [{ from: 25, to: 20, die: 5, hit: false }]);
    expect(countAtLocation(res.tracker, { kind: 'bar', player: 'white' })).toBe(0);
    expect(countAtLocation(res.tracker, { kind: 'point', point: 20 })).toBe(1);
    expect(relToLocation('black', 25)).toEqual({ kind: 'bar', player: 'black' });
    expect(relToLocation('black', 1)).toEqual({ kind: 'point', point: 24 });
  });

  it('reconcile fixes drift with minimal moves and agrees with the board', () => {
    const start = startingBoard();
    const t = createTracker(start);
    const play: SubMove[] = [
      { from: 13, to: 7, die: 6, hit: false },
      { from: 8, to: 7, die: 1, hit: false },
    ];
    const boardAfter = applyPlay(start, 'white', play);
    // Tracker never saw the play: reconcile must move exactly two checkers.
    const res = reconcile(t, boardAfter);
    expect(res.moved).toHaveLength(2);
    expect(countAtLocation(res.tracker, { kind: 'point', point: 7 })).toBe(2);
    expect(countAtLocation(res.tracker, { kind: 'point', point: 13 })).toBe(4);
    expect(countAtLocation(res.tracker, { kind: 'point', point: 8 })).toBe(2);
    // Already consistent → no moves.
    expect(reconcile(res.tracker, boardAfter).moved).toEqual([]);
    // Reconcile back to a fresh starting board (new game) restores counts.
    const back = reconcile(res.tracker, start);
    expect(back.moved).toHaveLength(2);
    for (const c of createTracker(start).checkers) {
      expect(countAtLocation(back.tracker, c.location)).toBe(
        countAtLocation(createTracker(start), c.location),
      );
    }
  });

  it('trackAction applies plays and reconciles everything else', () => {
    const start = startingBoard();
    const t = createTracker(start);
    const play: SubMove[] = [{ from: 24, to: 18, die: 6, hit: false }];
    const after = applyPlay(start, 'white', play);
    const res = trackAction(t, { type: 'play', player: 'white', play }, after);
    expect(res.moved).toHaveLength(1);
    expect(countAtLocation(res.tracker, { kind: 'point', point: 18 })).toBe(1);
    const same = trackAction(res.tracker, { type: 'roll', player: 'black', dice: [3, 1] }, after);
    expect(same.moved).toEqual([]);
    const reset = trackAction(res.tracker, { type: 'start-game' }, start);
    expect(reset.moved).toHaveLength(1);
  });

  it('free moves relocate the top checker and hit a lone opposing checker', () => {
    // white: abs 13 ×5, abs 10 ×1 · black: abs 12 ×5 (black rel 13), abs 19 ×5 (black rel 6)
    const board = boardFrom({ 13: 5, 10: 1 }, { 13: 5, 6: 5 });
    const t = createTracker(board);
    // black (rel 13 = abs 12) moves onto abs 10 (= black rel 15) where a lone white checker sits
    const res = applyFreeMoveToTracker(t, 'black', 13, 15);
    expect(res.moved).toHaveLength(1);
    expect(res.hit).toHaveLength(1);
    const moved = res.tracker.checkers.find((c) => c.id === res.moved[0])!;
    expect(moved.location).toEqual({ kind: 'point', point: 10 });
    const hit = res.tracker.checkers.find((c) => c.id === res.hit[0])!;
    expect(hit.player).toBe('white');
    expect(hit.location).toEqual({ kind: 'bar', player: 'white' });
    // via trackAction with the engine's board after the move
    const after = applyAction(
      { ...newMatch({ rules: 'free' }), game: { ...newGame({ free: true, board }) } },
      { type: 'free-move', player: 'white', checker: 'black', from: 13, to: 15 },
    ).game!.board;
    const tracked = trackAction(
      t,
      { type: 'free-move', player: 'white', checker: 'black', from: 13, to: 15 },
      after,
    );
    expect(tracked.hit).toHaveLength(1);
    expect(countAtLocation(tracked.tracker, { kind: 'bar', player: 'white' })).toBe(1);
    expect(countAtLocation(tracked.tracker, { kind: 'point', point: 10 })).toBe(1);
  });
});
