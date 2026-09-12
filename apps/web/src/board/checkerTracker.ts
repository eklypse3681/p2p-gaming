import type { Action, Board, Player, SubMove } from '@bgf/engine';
import { BAR as REL_BAR, OFF as REL_OFF, countAt, opponent } from '@bgf/engine';
import type { BoardLocation } from './contract';
import { locationKey, toAbs, toRel } from './contract';

/**
 * Assigns stable identities to the 30 checkers so a renderer can animate them.
 * The engine only stores counts; the tracker turns "one checker moved 8 → 5" into
 * "checker w7 moved from point 8 to point 5" by always moving the top of a stack.
 *
 * Within `checkers`, the relative order of entries sharing a location is the stack order
 * (first = bottom). Every operation is pure and returns a new tracker.
 */

export interface TrackedChecker {
  id: string;
  player: Player;
  location: BoardLocation;
}

export interface Tracker {
  checkers: TrackedChecker[];
}

/** Engine player-relative point (1..24, 25 = bar, 0 = off) → absolute board location. */
export function relToLocation(player: Player, rel: number): BoardLocation {
  if (rel === REL_BAR) return { kind: 'bar', player };
  if (rel === REL_OFF) return { kind: 'off', player };
  return { kind: 'point', point: toAbs(player, rel) };
}

/** Inverse of `relToLocation` for a location that belongs to `player` (bar/tray must be theirs). */
export function locationToRel(player: Player, location: BoardLocation): number {
  if (location.kind === 'point') return toRel(player, location.point);
  if (location.kind === 'bar') return REL_BAR;
  return REL_OFF;
}

/** Every location a player's checkers can occupy, with the count on the board. */
function expectedCounts(
  board: Board,
  player: Player,
): Map<string, { location: BoardLocation; count: number }> {
  const out = new Map<string, { location: BoardLocation; count: number }>();
  for (let rel = 1; rel <= 24; rel++) {
    const n = countAt(board, player, rel);
    if (n > 0) {
      const location = relToLocation(player, rel);
      out.set(locationKey(location), { location, count: n });
    }
  }
  if (board.bar[player] > 0) {
    const location: BoardLocation = { kind: 'bar', player };
    out.set(locationKey(location), { location, count: board.bar[player] });
  }
  if (board.off[player] > 0) {
    const location: BoardLocation = { kind: 'off', player };
    out.set(locationKey(location), { location, count: board.off[player] });
  }
  return out;
}

/** Build a tracker from a board; ids are `w1..w15` and `b1..b15`. */
export function createTracker(board: Board): Tracker {
  const checkers: TrackedChecker[] = [];
  for (const player of ['white', 'black'] as const) {
    const prefix = player === 'white' ? 'w' : 'b';
    let n = 0;
    // Deterministic order: relative points 24 → 1, then bar, then off.
    const add = (location: BoardLocation, count: number) => {
      for (let i = 0; i < count; i++) checkers.push({ id: `${prefix}${++n}`, player, location });
    };
    for (let rel = 24; rel >= 1; rel--) {
      const c = countAt(board, player, rel);
      if (c > 0) add(relToLocation(player, rel), c);
    }
    if (board.bar[player] > 0) add({ kind: 'bar', player }, board.bar[player]);
    if (board.off[player] > 0) add({ kind: 'off', player }, board.off[player]);
  }
  return { checkers };
}

function topIndexAt(checkers: TrackedChecker[], player: Player, location: BoardLocation): number {
  const key = locationKey(location);
  for (let i = checkers.length - 1; i >= 0; i--) {
    const c = checkers[i]!;
    if (c.player === player && locationKey(c.location) === key) return i;
  }
  return -1;
}

/** Move the top checker of `player` at `from` to the top of `to`. Returns the moved id (or null). */
function moveTop(
  checkers: TrackedChecker[],
  player: Player,
  from: BoardLocation,
  to: BoardLocation,
): string | null {
  const i = topIndexAt(checkers, player, from);
  if (i < 0) return null;
  const [c] = checkers.splice(i, 1);
  const moved = { ...c!, location: to };
  checkers.push(moved); // last = top of its (new) stack
  return moved.id;
}

export interface ApplyResult {
  tracker: Tracker;
  /** Ids that changed location. */
  moved: string[];
  /** Ids sent to the bar by a hit. */
  hit: string[];
}

/** Apply a play (sequence of sub-moves) for `player`. */
export function applyPlayToTracker(
  tracker: Tracker,
  player: Player,
  play: readonly SubMove[],
): ApplyResult {
  const checkers = tracker.checkers.map((c) => ({ ...c }));
  const moved: string[] = [];
  const hit: string[] = [];
  for (const m of play) {
    const from = relToLocation(player, m.from);
    const to = relToLocation(player, m.to);
    if (m.hit && to.kind === 'point') {
      const id = moveTop(checkers, opponent(player), to, { kind: 'bar', player: opponent(player) });
      if (id) hit.push(id);
    }
    const id = moveTop(checkers, player, from, to);
    if (id) moved.push(id);
  }
  return { tracker: { checkers }, moved, hit };
}

/**
 * Apply a free-board move: the top `checker`-coloured checker at `from` goes to `to`; a lone
 * opposing checker already on `to` is hit to the bar. Coordinates are relative to `checker`.
 */
export function applyFreeMoveToTracker(
  tracker: Tracker,
  checker: Player,
  fromRel: number,
  toRel: number,
): ApplyResult {
  const checkers = tracker.checkers.map((c) => ({ ...c }));
  const moved: string[] = [];
  const hit: string[] = [];
  const from = relToLocation(checker, fromRel);
  const to = relToLocation(checker, toRel);
  if (to.kind === 'point') {
    const opp = opponent(checker);
    const key = locationKey(to);
    const opposing = checkers.filter((c) => c.player === opp && locationKey(c.location) === key);
    if (opposing.length === 1) {
      const id = moveTop(checkers, opp, to, { kind: 'bar', player: opp });
      if (id) hit.push(id);
    }
  }
  const id = moveTop(checkers, checker, from, to);
  if (id) moved.push(id);
  return { tracker: { checkers }, moved, hit };
}

/**
 * Make the tracker agree with `board` by moving as few checkers as possible.
 * Locations with too many checkers give their top ones to locations with too few.
 */
export function reconcile(tracker: Tracker, board: Board): ApplyResult {
  const checkers = tracker.checkers.map((c) => ({ ...c }));
  const moved: string[] = [];
  for (const player of ['white', 'black'] as const) {
    const expected = expectedCounts(board, player);
    const have = new Map<string, number>();
    for (const c of checkers) {
      if (c.player !== player) continue;
      const k = locationKey(c.location);
      have.set(k, (have.get(k) ?? 0) + 1);
    }
    const total = checkers.filter((c) => c.player === player).length;
    const expectedTotal = Array.from(expected.values()).reduce((a, b) => a + b.count, 0);
    if (total !== expectedTotal) {
      // Should never happen (15 checkers each); rebuild rather than guess.
      return { tracker: createTracker(board), moved: [], hit: [] };
    }
    const surplus: BoardLocation[] = [];
    for (const c of checkers) {
      if (c.player !== player) continue;
      const k = locationKey(c.location);
      const want = expected.get(k)?.count ?? 0;
      const got = have.get(k) ?? 0;
      if (got > want) {
        surplus.push(c.location);
        have.set(k, got - 1);
      }
    }
    const deficits: BoardLocation[] = [];
    for (const [k, { location, count }] of expected) {
      const got = have.get(k) ?? 0;
      for (let i = got; i < count; i++) deficits.push(location);
    }
    // Move surplus checkers (top first) into deficit slots.
    for (let i = 0; i < deficits.length; i++) {
      const from = surplus[i];
      const to = deficits[i];
      if (!from || !to) break;
      const id = moveTop(checkers, player, from, to);
      if (id) moved.push(id);
    }
  }
  return { tracker: { checkers }, moved, hit: [] };
}

/**
 * Advance the tracker by an engine action. Plays move identified checkers; everything else
 * only reconciles against the authoritative board (which also handles new games).
 */
export function trackAction(
  tracker: Tracker,
  action: Action | null,
  boardAfter: Board,
): ApplyResult {
  let result: ApplyResult = { tracker, moved: [], hit: [] };
  if (action && action.type === 'play') {
    result = applyPlayToTracker(tracker, action.player, action.play);
  } else if (action && action.type === 'free-move') {
    result = applyFreeMoveToTracker(tracker, action.checker, action.from, action.to);
  }
  const fixed = reconcile(result.tracker, boardAfter);
  return {
    tracker: fixed.tracker,
    moved: Array.from(new Set([...result.moved, ...result.hit, ...fixed.moved])),
    hit: result.hit,
  };
}

export interface StackedChecker extends TrackedChecker {
  index: number;
  stackSize: number;
}

/** Add stack index / size to each checker (order within a location = stack order). */
export function stacked(tracker: Tracker): StackedChecker[] {
  const sizes = new Map<string, number>();
  for (const c of tracker.checkers) {
    const k = locationKey(c.location);
    sizes.set(k, (sizes.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return tracker.checkers.map((c) => {
    const k = locationKey(c.location);
    const index = seen.get(k) ?? 0;
    seen.set(k, index + 1);
    return { ...c, index, stackSize: sizes.get(k) ?? 1 };
  });
}

export function countAtLocation(tracker: Tracker, location: BoardLocation): number {
  const k = locationKey(location);
  let n = 0;
  for (const c of tracker.checkers) if (locationKey(c.location) === k) n++;
  return n;
}
