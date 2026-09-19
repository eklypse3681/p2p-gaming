import type {
  Card,
  Command,
  Placement,
  Row,
  Rows,
  TableConfig,
  TableState,
  TableView,
} from '@bgf/ofc-engine';
import {
  HIGH_ORDER,
  ROWS,
  ROW_CAPACITY,
  bottomRoyalty,
  canPlace,
  cardKey,
  evaluateHigh5,
  evaluateTop3,
  fantasylandQualification,
  isComplete,
  isFoul,
  isQualifiedLow,
  middleIsLow,
  middleRoyalty,
  topRoyalty,
  turnRequirement,
} from '@bgf/ofc-engine';

/** Either the authoritative state or a seat's view: both carry what the bot needs for its own seat. */
export type OfcBotState = TableState | TableView;

export interface OfcBotOptions {
  /** Tie-break randomness; deterministic order when omitted. */
  rng?: { int(n: number): number };
}

const FOUL = -100_000;

// ------------------------------------------------------------------------------------------
// Row keys for partial hands
// ------------------------------------------------------------------------------------------

function groupsOf(cards: readonly Card[]): Array<{ rank: number; count: number }> {
  const counts = new Map<number, number>();
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
}

/** Category index (HIGH_ORDER) and primary rank of what is *made* so far in a 5-card row. */
function partialHighKey(cards: readonly Card[]): { cat: number; rank: number } {
  if (cards.length === 5) {
    const e = evaluateHigh5(cards);
    return { cat: HIGH_ORDER.indexOf(e.category), rank: e.ranks[0] ?? 0 };
  }
  const g = groupsOf(cards);
  const first = g[0];
  if (!first) return { cat: 0, rank: 0 };
  if (first.count === 4) return { cat: HIGH_ORDER.indexOf('quads'), rank: first.rank };
  if (first.count === 3) {
    if (g[1] && g[1].count >= 2) return { cat: HIGH_ORDER.indexOf('full-house'), rank: first.rank };
    return { cat: HIGH_ORDER.indexOf('trips'), rank: first.rank };
  }
  if (first.count === 2) {
    if (g[1] && g[1].count === 2) return { cat: HIGH_ORDER.indexOf('two-pair'), rank: first.rank };
    return { cat: HIGH_ORDER.indexOf('pair'), rank: first.rank };
  }
  return { cat: 0, rank: first.rank };
}

/** Same idea for the 3-card top: high-card 0, pair 1, trips 3 (aligned with HIGH_ORDER). */
function partialTopKey(cards: readonly Card[]): { cat: number; rank: number } {
  if (cards.length === 3) {
    const e = evaluateTop3(cards);
    const cat = e.category === 'trips' ? 3 : e.category === 'pair' ? 1 : 0;
    return { cat, rank: e.ranks[0] ?? 0 };
  }
  const g = groupsOf(cards);
  const first = g[0];
  if (!first) return { cat: 0, rank: 0 };
  if (first.count >= 3) return { cat: 3, rank: first.rank };
  if (first.count === 2) return { cat: 1, rank: first.rank };
  return { cat: 0, rank: first.rank };
}

/** Positive when `upper` is currently stronger than `lower` (a foul in the making). */
function orderingGap(
  upper: { cat: number; rank: number },
  lower: { cat: number; rank: number },
): number {
  if (upper.cat !== lower.cat) return (upper.cat - lower.cat) * 10;
  return (upper.rank - lower.rank) / 2;
}

function fill(rows: Rows, row: Row): number {
  return ROW_CAPACITY[row] - rows[row].length;
}

// ------------------------------------------------------------------------------------------
// Heuristic value of a (possibly partial) set of rows
// ------------------------------------------------------------------------------------------

function completeValue(rows: Rows, config: TableConfig): number {
  if (isFoul(rows, config)) return FOUL;
  const r = config.royalties;
  const royalties =
    topRoyalty(rows.top, r) +
    middleRoyalty(rows.middle, r, config.variant) +
    bottomRoyalty(rows.bottom, r);
  const fl = fantasylandQualification(rows, false, config);
  const strength =
    partialHighKey(rows.bottom).cat * 3 +
    (middleIsLow(config.variant) ? 0 : partialHighKey(rows.middle).cat * 2) +
    partialTopKey(rows.top).cat;
  return 1000 + royalties * 10 + (fl.cards > 0 ? 60 + (fl.cards - 14) * 20 : 0) + strength;
}

function lowMiddleValue(middle: readonly Card[], config: TableConfig): number {
  let v = 0;
  const seen = new Set<number>();
  const suits = new Map<string, number>();
  for (const c of middle) {
    if (c.rank > config.lowQualifier) v -= 500;
    if (seen.has(c.rank)) v -= 500;
    seen.add(c.rank);
    suits.set(c.suit, (suits.get(c.suit) ?? 0) + 1);
    v += (11 - Math.min(c.rank, 11)) * 3; // 2 is the best card in a 2-7 middle
  }
  for (const n of suits.values()) if (n >= 3) v -= (n - 2) * 25;
  // Straight danger: long runs of consecutive ranks.
  const ranks = Array.from(seen).sort((a, b) => a - b);
  let run = 1;
  let longest = 1;
  for (let i = 1; i < ranks.length; i++) {
    run = ranks[i]! === ranks[i - 1]! + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  if (longest >= 4) v -= 80;
  else if (longest === 3) v -= 12;
  if (middle.length === 5 && !isQualifiedLow(middle, config.lowQualifier)) return FOUL;
  // Every qualified card in the middle is progress towards not fouling: fill it early and let
  // the bottom and top absorb the high cards and duplicates that arrive later.
  v += middle.length * 22;
  return v;
}

function highRowValue(cards: readonly Card[], row: Row): number {
  let v = 0;
  const g = groupsOf(cards);
  for (const grp of g) {
    if (grp.count >= 2) {
      const base = grp.count === 4 ? 60 : grp.count === 3 ? 30 : 12;
      v += base + grp.rank * (row === 'bottom' ? 1 : 0.7);
    } else {
      v += row === 'bottom' ? grp.rank / 2 : grp.rank / 4;
    }
  }
  // Flush and straight draws are worth a little on the bottom/middle.
  const suits = new Map<string, number>();
  for (const c of cards) suits.set(c.suit, (suits.get(c.suit) ?? 0) + 1);
  for (const n of suits.values()) if (n >= 3) v += (n - 2) * 4;
  return v;
}

function topValue(cards: readonly Card[], config: TableConfig): number {
  const g = groupsOf(cards);
  const first = g[0];
  let v = 0;
  for (const c of cards) v += (15 - c.rank) / 4; // low cards are safe on top
  if (!first) return v;
  const entry = { QQ: 12, KK: 13, AA: 14 }[config.fantasyland.entry];
  if (first.count >= 3) v += 40 + first.rank;
  else if (first.count === 2) {
    v += first.rank >= entry && config.fantasyland.enabled ? 30 + first.rank : 4 + first.rank / 2;
  }
  return v;
}

/** Value of `rows` for the rest of the hand; complete hands are scored exactly. */
export function evaluateRows(rows: Rows, config: TableConfig): number {
  if (isComplete(rows)) return completeValue(rows, config);
  const low = middleIsLow(config.variant);
  let v = 0;
  v += highRowValue(rows.bottom, 'bottom');
  v += low ? lowMiddleValue(rows.middle, config) : highRowValue(rows.middle, 'middle');
  v += topValue(rows.top, config);

  const b = partialHighKey(rows.bottom);
  const t = partialTopKey(rows.top);
  if (low) {
    // Bottom must end up above the top; the middle is judged on its own. With the middle taking
    // the low cards, the bottom is all the strength there is, so a top pair the bottom cannot
    // yet beat is a serious foul risk.
    const gap = orderingGap(t, b);
    if (gap > 0) v -= gap * 12 * (1 - 0.1 * fill(rows, 'bottom'));
  } else {
    const m = partialHighKey(rows.middle);
    const gapMB = orderingGap(m, b);
    if (gapMB > 0) v -= gapMB * 4 * (1 - 0.15 * fill(rows, 'bottom'));
    const gapTM = orderingGap(t, m);
    if (gapTM > 0) v -= gapTM * 5 * (1 - 0.15 * fill(rows, 'middle'));
    const gapTB = orderingGap(t, b);
    if (gapTB > 0) v -= gapTB * 5 * (1 - 0.15 * fill(rows, 'bottom'));
  }
  // A five-card row that is complete but weak against a strong top is a foul waiting to happen;
  // isFoul only fires when everything is set, so check made rows against each other now.
  if (rows.top.length === 3 && rows.bottom.length === 5) {
    const probe: Rows = { top: rows.top, middle: rows.middle, bottom: rows.bottom };
    if (rows.middle.length === 5 && isFoul(probe, config)) return FOUL;
  }
  return v;
}

// ------------------------------------------------------------------------------------------
// Candidate enumeration
// ------------------------------------------------------------------------------------------

function cloneRows(rows: Rows): Rows {
  return { top: rows.top.slice(), middle: rows.middle.slice(), bottom: rows.bottom.slice() };
}

function subsets<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick: T[] = [];
  const rec = (start: number) => {
    if (pick.length === k) {
      out.push(pick.slice());
      return;
    }
    for (let i = start; i < items.length; i++) {
      pick.push(items[i]!);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(0);
  return out;
}

interface Candidate {
  placements: Placement[];
  discards: Card[];
  value: number;
}

/** Every way to put `cards` into the rows respecting capacity (3^n minus overflow). */
function assignments(rows: Rows, cards: readonly Card[], config: TableConfig): Candidate[] {
  const out: Candidate[] = [];
  const placements: Placement[] = [];
  const rec = (i: number, current: Rows) => {
    if (i === cards.length) {
      out.push({
        placements: placements.slice(),
        discards: [],
        value: evaluateRows(current, config),
      });
      return;
    }
    const card = cards[i]!;
    for (const row of ROWS) {
      if (current[row].length >= ROW_CAPACITY[row]) continue;
      const next = cloneRows(current);
      next[row].push(card);
      placements.push({ card, row });
      rec(i + 1, next);
      placements.pop();
    }
  };
  rec(0, rows);
  return out;
}

function best(cands: Candidate[], rng?: OfcBotOptions['rng']): Candidate {
  let top: Candidate[] = [];
  let bestValue = -Infinity;
  for (const c of cands) {
    if (c.value > bestValue) {
      bestValue = c.value;
      top = [c];
    } else if (c.value === bestValue) top.push(c);
  }
  if (top.length === 0) throw new Error('no candidate placement');
  return top[rng ? rng.int(top.length) : 0]!;
}

/** Fantasyland: choose 13 of the dealt cards for the strongest non-fouling set. */
function fantasylandSet(
  pending: readonly Card[],
  config: TableConfig,
  rng?: OfcBotOptions['rng'],
): Candidate {
  const low = middleIsLow(config.variant);
  const bottoms = subsets(pending, 5)
    .map((cards) => ({ cards, e: evaluateHigh5(cards) }))
    .sort(
      (a, b) =>
        HIGH_ORDER.indexOf(b.e.category) - HIGH_ORDER.indexOf(a.e.category) ||
        (b.e.ranks[0] ?? 0) - (a.e.ranks[0] ?? 0),
    )
    .slice(0, 40);
  const cands: Candidate[] = [];
  for (const bottom of bottoms) {
    const used = new Set(bottom.cards.map(cardKey));
    const rest = pending.filter((c) => !used.has(cardKey(c)));
    const middles = subsets(rest, 5).filter((m) => !low || isQualifiedLow(m, config.lowQualifier));
    // Keep the search bounded: strongest / lowest middles first.
    const scored = middles
      .map((m) => ({
        m,
        v: low
          ? lowMiddleValue(m, config)
          : evaluateRows({ top: [], middle: m, bottom: [] }, config),
      }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 25);
    for (const { m } of scored) {
      const used2 = new Set([...bottom.cards, ...m].map(cardKey));
      const rest2 = rest.filter((c) => !used2.has(cardKey(c)));
      for (const top of subsets(rest2, 3)) {
        const rows: Rows = { top, middle: m, bottom: bottom.cards };
        const value = completeValue(rows, config);
        if (value === FOUL) continue;
        const placedKeys = new Set([...top, ...m, ...bottom.cards].map(cardKey));
        cands.push({
          placements: [
            ...bottom.cards.map((card) => ({ card, row: 'bottom' as Row })),
            ...m.map((card) => ({ card, row: 'middle' as Row })),
            ...top.map((card) => ({ card, row: 'top' as Row })),
          ],
          discards: pending.filter((c) => !placedKeys.has(cardKey(c))),
          value,
        });
      }
    }
  }
  if (cands.length > 0) return best(cands, rng);
  // No non-fouling set exists (very rare): place anything legal.
  const sorted = pending.slice().sort((a, b) => b.rank - a.rank);
  const placements: Placement[] = [
    ...sorted.slice(0, 5).map((card) => ({ card, row: 'bottom' as Row })),
    ...sorted.slice(5, 10).map((card) => ({ card, row: 'middle' as Row })),
    ...sorted.slice(10, 13).map((card) => ({ card, row: 'top' as Row })),
  ];
  return { placements, discards: sorted.slice(13), value: FOUL };
}

/**
 * A legal, sensible placement for `seat`, or null when the seat cannot act. Pure: the same
 * state yields the same command unless an `rng` is given for tie-breaks.
 */
export function ofcBot(state: OfcBotState, seat: number, opts: OfcBotOptions = {}): Command | null {
  if (!canPlace(state as TableState, seat)) return null;
  const hand = state.hand!;
  const me = hand.seats[seat]!;
  const config = state.config;
  const req = turnRequirement(state as TableState, seat);
  const pending = me.pending;
  if (me.fantasyland) {
    const c = fantasylandSet(pending, config, opts.rng);
    return { type: 'place', placements: c.placements, discards: c.discards };
  }
  const cands: Candidate[] = [];
  for (const chosen of subsets(pending, req.place)) {
    const keys = new Set(chosen.map(cardKey));
    const discards = pending.filter((c) => !keys.has(cardKey(c)));
    for (const a of assignments(me.rows, chosen, config)) cands.push({ ...a, discards });
  }
  const c = best(cands, opts.rng);
  return { type: 'place', placements: c.placements, discards: c.discards };
}
