import type { Card } from './cards.js';
import {
  compareHigh5,
  compareLow27,
  compareMiddleVsTop,
  compareTop3,
  describeHigh,
  describeLow27,
  describeTop,
  evaluateHigh5,
  evaluateTop3,
  isQualifiedLow,
  isWheel27,
} from './evaluate.js';
import type {
  FantasylandConfig,
  FlowConfig,
  HandResult,
  PairResult,
  RoyaltyConfig,
  Row,
  Rows,
  ScoringConfig,
  SeatResult,
  TableConfig,
  Transfer,
  Variant,
} from './types.js';
import { ROWS, RuleError } from './types.js';

// ------------------------------------------------------------------------------------------
// Defaults
// ------------------------------------------------------------------------------------------

export const DEFAULT_ROYALTIES: RoyaltyConfig = {
  enabled: true,
  topPairs: { 6: 1, 7: 2, 8: 3, 9: 4, 10: 5, 11: 6, 12: 7, 13: 8, 14: 9 },
  topTrips: {
    2: 10,
    3: 11,
    4: 12,
    5: 13,
    6: 14,
    7: 15,
    8: 16,
    9: 17,
    10: 18,
    11: 19,
    12: 20,
    13: 21,
    14: 22,
  },
  middle: {
    trips: 2,
    straight: 4,
    flush: 8,
    'full-house': 12,
    quads: 20,
    'straight-flush': 30,
    'royal-flush': 50,
  },
  bottom: {
    straight: 2,
    flush: 4,
    'full-house': 6,
    quads: 10,
    'straight-flush': 15,
    'royal-flush': 25,
  },
  // 2-7 middle lows (only scored in the pineapple27 variant): 1-2-4-8 from nine-low to the wheel.
  middleLow: { ten: 0, nine: 1, eight: 2, seven: 4, wheel: 8 },
};

export const DEFAULT_FANTASYLAND: FantasylandConfig = {
  enabled: true,
  entry: 'QQ',
  cards: 14,
  progressive: false,
  progressiveCards: { QQ: 14, KK: 15, AA: 16, trips: 17 },
  superFantasyland: false,
  stay: { topTrips: true, middleFullHouse: true, bottomQuads: true },
};

export const DEFAULT_SCORING: ScoringConfig = { mode: 'up', multiplier: 1 };

export const DEFAULT_FLOW: FlowConfig = {
  startWhenFull: true,
  nextHand: 'ready',
  nextHandDelayMs: 8_000,
  settleOnConsensus: true,
  pauseWhenAbsent: true,
};

/** The table's flow settings, with defaults for tables created before they existed. */
export function flowConfig(config: TableConfig): FlowConfig {
  return { ...DEFAULT_FLOW, ...(config.flow ?? {}) };
}

/** Variant-aware defaults: classic OFC deals 13 in Fantasyland; 2-7 enters on KK by default. */
export function defaultConfig(overrides: Partial<TableConfig> = {}): TableConfig {
  const variant: Variant = overrides.variant ?? 'pineapple';
  // 2-7: KK+ on top or a middle wheel enters; both in one hand deals 15 (super Fantasyland);
  // a wheel in the middle does not keep you there (quads+ bottom or trips top do).
  const fantasyland: FantasylandConfig = {
    ...DEFAULT_FANTASYLAND,
    cards: variant === 'ofc' ? 13 : 14,
    entry: variant === 'pineapple27' ? 'KK' : 'QQ',
    superFantasyland: variant === 'pineapple27',
    ...(overrides.fantasyland ?? {}),
    stay: {
      ...DEFAULT_FANTASYLAND.stay,
      ...(variant === 'pineapple27' ? { middleFullHouse: false } : {}),
      ...(overrides.fantasyland?.stay ?? {}),
    },
    progressiveCards: {
      ...DEFAULT_FANTASYLAND.progressiveCards,
      ...(overrides.fantasyland?.progressiveCards ?? {}),
    },
  };
  const royalties: RoyaltyConfig = {
    ...DEFAULT_ROYALTIES,
    ...(overrides.royalties ?? {}),
    topPairs: { ...DEFAULT_ROYALTIES.topPairs, ...(overrides.royalties?.topPairs ?? {}) },
    topTrips: { ...DEFAULT_ROYALTIES.topTrips, ...(overrides.royalties?.topTrips ?? {}) },
    middle: { ...DEFAULT_ROYALTIES.middle, ...(overrides.royalties?.middle ?? {}) },
    bottom: { ...DEFAULT_ROYALTIES.bottom, ...(overrides.royalties?.bottom ?? {}) },
    middleLow: { ...DEFAULT_ROYALTIES.middleLow, ...(overrides.royalties?.middleLow ?? {}) },
  };
  return {
    variant,
    seats: overrides.seats ?? 2,
    lowQualifier: overrides.lowQualifier ?? 10,
    royalties,
    fantasyland,
    scoring: { ...DEFAULT_SCORING, ...(overrides.scoring ?? {}) },
    flow: { ...DEFAULT_FLOW, ...(overrides.flow ?? {}) },
  };
}

// ------------------------------------------------------------------------------------------
// Variant helpers
// ------------------------------------------------------------------------------------------

export function isPineapple(variant: Variant): boolean {
  return variant !== 'ofc';
}

export function middleIsLow(variant: Variant): boolean {
  return variant === 'pineapple27';
}

/** Cards dealt per turn after the initial five. */
export function cardsPerTurn(variant: Variant): number {
  return isPineapple(variant) ? 3 : 1;
}

/** Cards placed per turn after the initial five. */
export function placedPerTurn(variant: Variant): number {
  return isPineapple(variant) ? 2 : 1;
}

export function rowScoring(variant: Variant, row: Row): 'high' | 'top' | 'low27' {
  if (row === 'top') return 'top';
  if (row === 'middle' && middleIsLow(variant)) return 'low27';
  return 'high';
}

// ------------------------------------------------------------------------------------------
// Fouls
// ------------------------------------------------------------------------------------------

export function isComplete(rows: Rows): boolean {
  return rows.top.length === 3 && rows.middle.length === 5 && rows.bottom.length === 5;
}

/** True when a complete hand is set in an illegal order (or, in 2-7, the middle does not qualify). */
export function isFoul(rows: Rows, config: Pick<TableConfig, 'variant' | 'lowQualifier'>): boolean {
  return foulReason(rows, config) !== null;
}

function bottomBeatsTop(rows: Rows): boolean {
  // Comparing a 3-card top with a 5-card row reuses the middle/top comparison.
  return compareMiddleVsTop(rows.bottom, rows.top) >= 0;
}

export function foulReason(
  rows: Rows,
  config: Pick<TableConfig, 'variant' | 'lowQualifier'>,
): string | null {
  if (!isComplete(rows)) throw new RuleError('incomplete', 'hand is not complete');
  if (middleIsLow(config.variant)) {
    if (!isQualifiedLow(rows.middle, config.lowQualifier)) {
      return `middle must be a ${config.lowQualifier}-low or better`;
    }
    if (!bottomBeatsTop(rows)) return 'top is stronger than bottom';
    return null;
  }
  if (compareHigh5(rows.bottom, rows.middle) < 0) return 'middle is stronger than bottom';
  if (compareMiddleVsTop(rows.middle, rows.top) < 0) return 'top is stronger than middle';
  return null;
}

// ------------------------------------------------------------------------------------------
// Royalties
// ------------------------------------------------------------------------------------------

export function topRoyalty(top: readonly Card[], r: RoyaltyConfig): number {
  if (!r.enabled) return 0;
  const e = evaluateTop3(top);
  if (e.category === 'trips') return r.topTrips[e.ranks[0]!] ?? 0;
  if (e.category === 'pair') return r.topPairs[e.ranks[0]!] ?? 0;
  return 0;
}

function highRoyalty(
  hand: readonly Card[],
  table: RoyaltyConfig['middle'] | RoyaltyConfig['bottom'],
): number {
  const e = evaluateHigh5(hand);
  if (e.category === 'straight-flush' && e.royal && table['royal-flush'] !== undefined) {
    return table['royal-flush'];
  }
  return table[e.category] ?? 0;
}

export function middleRoyalty(middle: readonly Card[], r: RoyaltyConfig, variant: Variant): number {
  if (!r.enabled) return 0;
  if (!middleIsLow(variant)) return highRoyalty(middle, r.middle);
  if (!isQualifiedLow(middle, 14)) return 0;
  if (isWheel27(middle)) return r.middleLow.wheel;
  const high = evaluateHigh5(middle, false).ranks[0]!;
  if (high === 7) return r.middleLow.seven;
  if (high === 8) return r.middleLow.eight;
  if (high === 9) return r.middleLow.nine;
  if (high === 10) return r.middleLow.ten;
  return 0;
}

export function bottomRoyalty(bottom: readonly Card[], r: RoyaltyConfig): number {
  if (!r.enabled) return 0;
  return highRoyalty(bottom, r.bottom);
}

// ------------------------------------------------------------------------------------------
// Fantasyland
// ------------------------------------------------------------------------------------------

const ENTRY_RANK: Record<'QQ' | 'KK' | 'AA', number> = { QQ: 12, KK: 13, AA: 14 };

/** Cards the seat is dealt next hand, and why; 0 when it does not qualify. */
export function fantasylandQualification(
  rows: Rows,
  inFantasyland: boolean,
  config: TableConfig,
): { cards: number; reasons: string[] } {
  const fl = config.fantasyland;
  if (!fl.enabled) return { cards: 0, reasons: [] };
  const top = evaluateTop3(rows.top);
  const reasons: string[] = [];
  if (inFantasyland) {
    if (fl.stay.topTrips && top.category === 'trips') reasons.push('top trips');
    if (middleIsLow(config.variant)) {
      if (fl.stay.middleFullHouse && isWheel27(rows.middle)) reasons.push('middle wheel');
    } else if (fl.stay.middleFullHouse) {
      const m = evaluateHigh5(rows.middle);
      if (['full-house', 'quads', 'straight-flush'].includes(m.category))
        reasons.push('middle full house+');
    }
    if (fl.stay.bottomQuads) {
      const b = evaluateHigh5(rows.bottom);
      if (['quads', 'straight-flush'].includes(b.category)) reasons.push('bottom quads+');
    }
    if (reasons.length === 0) return { cards: 0, reasons };
    return { cards: fantasylandCards(rows, config), reasons };
  }
  const entryRank = ENTRY_RANK[fl.entry];
  if (top.category === 'trips' || (top.category === 'pair' && top.ranks[0]! >= entryRank)) {
    reasons.push(
      top.category === 'trips'
        ? 'top trips'
        : `top ${'JQKA'[top.ranks[0]! - 11]}${'JQKA'[top.ranks[0]! - 11]}`,
    );
  }
  if (middleIsLow(config.variant) && isWheel27(rows.middle)) reasons.push('middle wheel');
  if (reasons.length === 0) return { cards: 0, reasons };
  let cards = fantasylandCards(rows, config);
  if (fl.superFantasyland && reasons.length >= 2) cards += 1;
  return { cards, reasons };
}

function fantasylandCards(rows: Rows, config: TableConfig): number {
  const fl = config.fantasyland;
  if (config.variant === 'ofc') return fl.cards;
  if (!fl.progressive) return fl.cards;
  const top = evaluateTop3(rows.top);
  if (top.category === 'trips') return fl.progressiveCards.trips;
  const r = top.category === 'pair' ? top.ranks[0]! : 0;
  if (r >= 14) return fl.progressiveCards.AA;
  if (r >= 13) return fl.progressiveCards.KK;
  if (r >= 12) return fl.progressiveCards.QQ;
  return fl.cards;
}

// ------------------------------------------------------------------------------------------
// Scoring
// ------------------------------------------------------------------------------------------

function compareRow(
  a: readonly Card[],
  b: readonly Card[],
  scoring: 'high' | 'top' | 'low27',
): number {
  if (scoring === 'top') return compareTop3(a, b);
  if (scoring === 'low27') return compareLow27(a, b);
  return compareHigh5(a, b);
}

function describeRow(cards: readonly Card[], scoring: 'high' | 'top' | 'low27'): string {
  if (scoring === 'top') return describeTop(evaluateTop3(cards));
  if (scoring === 'low27') return describeLow27(cards);
  return describeHigh(evaluateHigh5(cards));
}

/** Score a completed hand for every seat. `inFantasyland[i]` says who played this hand in FL. */
export function scoreHand(
  handNumber: number,
  hands: readonly Rows[],
  inFantasyland: readonly boolean[],
  config: TableConfig,
): HandResult {
  const n = hands.length;
  const seats: SeatResult[] = hands.map((rows, i) => {
    const fouled = isFoul(rows, config);
    const rowResults = {} as Record<Row, { cards: Card[]; description: string; royalty: number }>;
    for (const row of ROWS) {
      const scoring = rowScoring(config.variant, row);
      const royalty = fouled
        ? 0
        : row === 'top'
          ? topRoyalty(rows.top, config.royalties)
          : row === 'middle'
            ? middleRoyalty(rows.middle, config.royalties, config.variant)
            : bottomRoyalty(rows.bottom, config.royalties);
      rowResults[row] = {
        cards: rows[row].slice(),
        description: describeRow(rows[row], scoring),
        royalty,
      };
    }
    const royalties = ROWS.reduce((s, r) => s + rowResults[r].royalty, 0);
    const q = fouled
      ? { cards: 0, reasons: [] }
      : fantasylandQualification(rows, inFantasyland[i] ?? false, config);
    return {
      fouled,
      rows: rowResults,
      royalties,
      points: 0,
      fantasylandNext: q.cards,
      qualifiedBy: q.reasons,
    };
  });
  const pairs: PairResult[] = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const pr = scorePair(a, b, hands, seats, config);
      pairs.push(pr);
      seats[a]!.points += pr.net;
      seats[b]!.points -= pr.net;
    }
  }
  const transfers: Transfer[] = pairs
    .filter((p) => p.net !== 0)
    .map((p) =>
      p.net > 0 ? { from: p.b, to: p.a, points: p.net } : { from: p.a, to: p.b, points: -p.net },
    );
  return { hand: handNumber, seats, pairs, transfers };
}

function scorePair(
  a: number,
  b: number,
  hands: readonly Rows[],
  seats: readonly SeatResult[],
  config: TableConfig,
): PairResult {
  const fa = seats[a]!.fouled;
  const fb = seats[b]!.fouled;
  const rows: Record<Row, number> = { top: 0, middle: 0, bottom: 0 };
  let scoop = 0;
  let royalties = 0;
  if (fa && fb) return { a, b, rows, scoop, royalties, net: 0 };
  if (fa || fb) {
    const sign = fa ? -1 : 1; // the non-fouled side wins everything
    for (const r of ROWS) rows[r] = sign;
    scoop = 3 * sign;
    royalties = sign * (fa ? seats[b]!.royalties : seats[a]!.royalties);
    return { a, b, rows, scoop, royalties, net: 3 * sign + scoop + royalties };
  }
  let wins = 0;
  let losses = 0;
  for (const r of ROWS) {
    const c = compareRow(hands[a]![r], hands[b]![r], rowScoring(config.variant, r));
    rows[r] = c > 0 ? 1 : c < 0 ? -1 : 0;
    if (c > 0) wins++;
    if (c < 0) losses++;
  }
  if (wins === 3) scoop = 3;
  if (losses === 3) scoop = -3;
  royalties = seats[a]!.royalties - seats[b]!.royalties;
  const net = wins - losses + scoop + royalties;
  return { a, b, rows, scoop, royalties, net };
}

/** One line per seat, e.g. "Alice: bottom flush +4, top 99 +4; wins 12 from Bob". */
export function handSummary(result: HandResult, names?: readonly string[]): string[] {
  const name = (i: number) => names?.[i] ?? `Seat ${i + 1}`;
  return result.seats.map((s, i) => {
    if (s.fouled) return `${name(i)}: fouled`;
    const parts: string[] = [];
    for (const row of ROWS) {
      const r = s.rows[row];
      if (r.royalty > 0) parts.push(`${row} ${r.description.toLowerCase()} +${r.royalty}`);
    }
    const scooped = result.pairs.filter(
      (p) => (p.a === i && p.scoop === 3) || (p.b === i && p.scoop === -3),
    );
    if (scooped.length) parts.push(`scoop${scooped.length > 1 ? ` x${scooped.length}` : ''}`);
    if (s.fantasylandNext) parts.push(`Fantasyland (${s.fantasylandNext})`);
    const owed = result.transfers
      .filter((t) => t.to === i)
      .map((t) => `${t.points} from ${name(t.from)}`);
    const paid = result.transfers
      .filter((t) => t.from === i)
      .map((t) => `${t.points} to ${name(t.to)}`);
    const flow = [
      ...(owed.length ? [`wins ${owed.join(', ')}`] : []),
      ...(paid.length ? [`pays ${paid.join(', ')}`] : []),
    ];
    const head = parts.length ? parts.join(', ') : 'no royalties';
    return `${name(i)}: ${head}${flow.length ? `; ${flow.join('; ')}` : ''}`;
  });
}
