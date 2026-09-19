import type { Card, Rank } from './cards.js';
import { rankName } from './cards.js';

/**
 * Hand evaluation. Every evaluator returns a category plus an ordered tiebreak vector so that
 * two hands compare lexicographically: category first, then `ranks` element by element.
 */

export type HighCategory =
  | 'high-card'
  | 'pair'
  | 'two-pair'
  | 'trips'
  | 'straight'
  | 'flush'
  | 'full-house'
  | 'quads'
  | 'straight-flush';

export const HIGH_ORDER: readonly HighCategory[] = [
  'high-card',
  'pair',
  'two-pair',
  'trips',
  'straight',
  'flush',
  'full-house',
  'quads',
  'straight-flush',
];

export interface HighEval {
  category: HighCategory;
  /** Tiebreak ranks, most significant first. */
  ranks: number[];
  /** Straight flush to the ace (A K Q J T suited). */
  royal: boolean;
}

export type TopCategory = 'high-card' | 'pair' | 'trips';

export interface TopEval {
  category: TopCategory;
  ranks: number[];
}

function groups(hand: readonly Card[]): { rank: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const c of hand) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
}

/**
 * Evaluate a 5-card hand as a high hand. `wheel` controls whether A-2-3-4-5 counts as a
 * five-high straight (true for high poker, false for 2-7 lowball where the ace is only high).
 */
export function evaluateHigh5(hand: readonly Card[], wheel = true): HighEval {
  if (hand.length !== 5) throw new RangeError('a five-card hand is required');
  const g = groups(hand);
  const flush = hand.every((c) => c.suit === hand[0]!.suit);
  const desc = hand.map((c) => c.rank as number).sort((a, b) => b - a);
  let straightHigh = 0;
  if (g.length === 5) {
    if (desc[0]! - desc[4]! === 4) straightHigh = desc[0]!;
    else if (wheel && desc[0] === 14 && desc[1] === 5 && desc[4] === 2) straightHigh = 5;
  }
  if (straightHigh && flush) {
    return { category: 'straight-flush', ranks: [straightHigh], royal: straightHigh === 14 };
  }
  if (g[0]!.count === 4)
    return { category: 'quads', ranks: [g[0]!.rank, g[1]!.rank], royal: false };
  if (g[0]!.count === 3 && g[1]!.count === 2) {
    return { category: 'full-house', ranks: [g[0]!.rank, g[1]!.rank], royal: false };
  }
  if (flush) return { category: 'flush', ranks: desc, royal: false };
  if (straightHigh) return { category: 'straight', ranks: [straightHigh], royal: false };
  if (g[0]!.count === 3) {
    return { category: 'trips', ranks: [g[0]!.rank, g[1]!.rank, g[2]!.rank], royal: false };
  }
  if (g[0]!.count === 2 && g[1]!.count === 2) {
    return { category: 'two-pair', ranks: [g[0]!.rank, g[1]!.rank, g[2]!.rank], royal: false };
  }
  if (g[0]!.count === 2) {
    return { category: 'pair', ranks: g.map((x) => x.rank), royal: false };
  }
  return { category: 'high-card', ranks: desc, royal: false };
}

/** Evaluate the 3-card top row: high card, pair or trips only (no straights or flushes). */
export function evaluateTop3(hand: readonly Card[]): TopEval {
  if (hand.length !== 3) throw new RangeError('a three-card hand is required');
  const g = groups(hand);
  if (g[0]!.count === 3) return { category: 'trips', ranks: [g[0]!.rank] };
  if (g[0]!.count === 2) return { category: 'pair', ranks: [g[0]!.rank, g[1]!.rank] };
  return { category: 'high-card', ranks: hand.map((c) => c.rank as number).sort((a, b) => b - a) };
}

function compareVectors(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]! ? 1 : -1;
  }
  return 0;
}

export function compareHighEval(a: HighEval, b: HighEval): number {
  const ca = HIGH_ORDER.indexOf(a.category);
  const cb = HIGH_ORDER.indexOf(b.category);
  if (ca !== cb) return ca > cb ? 1 : -1;
  return compareVectors(a.ranks, b.ranks);
}

/** >0 if `a` beats `b` as high hands, <0 if `b` wins, 0 for a tie. */
export function compareHigh5(a: readonly Card[], b: readonly Card[]): number {
  return compareHighEval(evaluateHigh5(a), evaluateHigh5(b));
}

const TOP_ORDER: readonly TopCategory[] = ['high-card', 'pair', 'trips'];

export function compareTopEval(a: TopEval, b: TopEval): number {
  const ca = TOP_ORDER.indexOf(a.category);
  const cb = TOP_ORDER.indexOf(b.category);
  if (ca !== cb) return ca > cb ? 1 : -1;
  return compareVectors(a.ranks, b.ranks);
}

export function compareTop3(a: readonly Card[], b: readonly Card[]): number {
  return compareTopEval(evaluateTop3(a), evaluateTop3(b));
}

/** Map a top-row category onto the high-hand scale so rows can be compared for fouls. */
export function topAsHigh(t: TopEval): HighEval {
  const category: HighCategory =
    t.category === 'trips' ? 'trips' : t.category === 'pair' ? 'pair' : 'high-card';
  return { category, ranks: t.ranks, royal: false };
}

/**
 * >0 if the 5-card `middle` is stronger than the 3-card `top` as high hands, 0 if equal in
 * every comparable respect, <0 if the top is stronger (which fouls the hand).
 */
export function compareMiddleVsTop(middle: readonly Card[], top: readonly Card[]): number {
  return compareHighEval(evaluateHigh5(middle), topAsHigh(evaluateTop3(top)));
}

/** 2-7 lowball: >0 if `a` is the better (lower) hand, <0 if `b` is, 0 for a tie. */
export function compareLow27(a: readonly Card[], b: readonly Card[]): number {
  const c = compareHighEval(evaluateHigh5(a, false), evaluateHigh5(b, false));
  return c === 0 ? 0 : -c;
}

/** A 2-7 hand "qualifies" as a low when it has no pair, straight or flush. */
export function isQualifiedLow(hand: readonly Card[], maxHigh = 10): boolean {
  const e = evaluateHigh5(hand, false);
  return e.category === 'high-card' && e.ranks[0]! <= maxHigh;
}

/** True for 7-5-4-3-2 (the best possible 2-7 hand, "number one"). */
export function isWheel27(hand: readonly Card[]): boolean {
  const e = evaluateHigh5(hand, false);
  return e.category === 'high-card' && e.ranks.join(',') === '7,5,4,3,2';
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function describeHigh(e: HighEval): string {
  const r = e.ranks;
  const name = (x: number, plural = false) => rankName(x as Rank, plural);
  switch (e.category) {
    case 'straight-flush':
      return e.royal ? 'Royal flush' : `Straight flush, ${name(r[0]!)} high`;
    case 'quads':
      return `Four ${name(r[0]!, true)}`;
    case 'full-house':
      return `Full house, ${name(r[0]!, true)} over ${name(r[1]!, true)}`;
    case 'flush':
      return `Flush, ${name(r[0]!)} high`;
    case 'straight':
      return `Straight, ${name(r[0]!)} high`;
    case 'trips':
      return `Three ${name(r[0]!, true)}`;
    case 'two-pair':
      return `Two pair, ${name(r[0]!, true)} and ${name(r[1]!, true)}`;
    case 'pair':
      return `Pair of ${name(r[0]!, true)}`;
    case 'high-card':
      return `${cap(name(r[0]!))} high`;
  }
}

export function describeTop(e: TopEval): string {
  const name = (x: number, plural = false) => rankName(x as Rank, plural);
  if (e.category === 'trips') return `Three ${name(e.ranks[0]!, true)}`;
  if (e.category === 'pair') return `Pair of ${name(e.ranks[0]!, true)}`;
  return `${cap(name(e.ranks[0]!))} high`;
}

export function describeLow27(hand: readonly Card[]): string {
  const e = evaluateHigh5(hand, false);
  if (e.category !== 'high-card') return `${describeHigh(e)} (no low)`;
  if (isWheel27(hand)) return 'Seven-five, number one';
  return `${cap(rankName(e.ranks[0]! as Rank))}-low`;
}

export type RowKind = 'top' | 'middle' | 'bottom';

/** Human text for a row given how it is scored. */
export function describeHand(hand: readonly Card[], scoring: 'high' | 'top' | 'low27'): string {
  if (scoring === 'top') return describeTop(evaluateTop3(hand));
  if (scoring === 'low27') return describeLow27(hand);
  return describeHigh(evaluateHigh5(hand));
}
