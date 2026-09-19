import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TableClientState } from '@bgf/table';
import type {
  Card,
  Command,
  HandResult,
  Placement,
  Row,
  Rows,
  SeatResult,
  TableConfig,
  TableView,
  Variant,
} from '@bgf/ofc-engine';
import {
  ROWS,
  ROW_CAPACITY,
  SUITS,
  bottomRoyalty,
  cardKey,
  describeHand,
  foulReason,
  isComplete,
  isQualifiedLow,
  middleIsLow,
  middleRoyalty,
  rankName,
  rowScoring,
  topRoyalty,
} from '@bgf/ofc-engine';

export type Phase = 'idle' | 'lobby' | 'setting' | 'showdown' | 'complete' | 'over';

export interface RowModel {
  row: Row;
  cards: Card[];
  /** Cards placed provisionally by the local player (not yet confirmed). */
  provisional: Card[];
  capacity: number;
  /** Text under the row: the hand so far, or null when empty. */
  description: string | null;
  /** 2-7 middle: whether the (complete) row qualifies. */
  qualifies: boolean | null;
  label: string;
  scoring: 'high' | 'top' | 'low27';
  /** Royalty the (complete) row earns under the table's rules; 0 when incomplete or none. */
  royalty: number;
}

export interface SeatModel {
  seat: number;
  name: string;
  isMe: boolean;
  toAct: boolean;
  fantasyland: boolean;
  faceDown: boolean;
  hiddenCount: number;
  /** Rows are hidden from the viewer (face-down Fantasyland hand, or the viewer is setting theirs). */
  hidden: boolean;
  done: boolean;
  pendingCount: number;
  discardCount: number;
  rows: Record<Row, RowModel>;
  score: number;
  /** Balance shown in buy-in mode (buyIn + net), else null. */
  balance: number | null;
  result: SeatResult | null;
  /** Foul warning for a complete (provisional) hand. */
  foul: string | null;
  present: boolean;
  /** Fantasyland cards owed next hand (0 = none). */
  fantasylandNext: number;
}

export interface TableModel {
  phase: Phase;
  variant: Variant;
  config: TableConfig | null;
  /** Seats in display order: opponents first (in seat order after me), me last. */
  seats: SeatModel[];
  me: SeatModel | null;
  mySeat: number | null;
  myTurn: boolean;
  /** The local player is setting a Fantasyland hand: opponents' rows are hidden until it is set. */
  settingFantasyland: boolean;
  canStart: boolean;
  requirement: { place: number; discard: number } | null;
  pending: Card[];
  handNumber: number;
  deckCount: number | null;
  button: number | null;
  turnText: string;
  result: HandResult | null;
  scores: number[];
  balances: number[];
  seatCount: number;
  bust: boolean;
}

export const ROW_LABELS: Record<Row, string> = { top: 'Top', middle: 'Middle', bottom: 'Bottom' };

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Text for a partial or complete row given how it scores. */
export function describeRow(
  cards: readonly Card[],
  scoring: 'high' | 'top' | 'low27',
): string | null {
  if (cards.length === 0) return null;
  const full = scoring === 'top' ? 3 : 5;
  if (cards.length === full) return describeHand(cards, scoring);
  const counts = new Map<number, number>();
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  const groups = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const [rank, n] = groups[0]!;
  const name = (r: number, plural = false) => rankName(r as Card['rank'], plural);
  if (n === 4) return `Four ${name(rank, true)}`;
  if (n === 3) return `Three ${name(rank, true)}`;
  if (n === 2) {
    const second = groups[1];
    if (second && second[1] === 2)
      return `Two pair, ${name(rank, true)} and ${name(second[0], true)}`;
    return `Pair of ${name(rank, true)}`;
  }
  const high = Math.max(...cards.map((c) => c.rank));
  if (scoring === 'low27') return `${cap(name(high))} high so far`;
  const suited = cards.every((c) => c.suit === cards[0]!.suit);
  return `${cap(name(high))} high${suited && cards.length >= 3 ? ' · suited' : ''}`;
}

/** Royalty a complete row earns under `config` (0 when royalties are off). */
export function rowRoyalty(cards: readonly Card[], row: Row, config: TableConfig): number {
  if (cards.length !== ROW_CAPACITY[row]) return 0;
  if (row === 'top') return topRoyalty(cards, config.royalties);
  if (row === 'middle') return middleRoyalty(cards, config.royalties, config.variant);
  return bottomRoyalty(cards, config.royalties);
}

function rowsWith(base: Rows, provisional: readonly Placement[]): Rows {
  const out: Rows = {
    top: base.top.slice(),
    middle: base.middle.slice(),
    bottom: base.bottom.slice(),
  };
  for (const p of provisional) out[p.row].push(p.card);
  return out;
}

function phaseOf(view: TableView | null): Phase {
  if (!view) return 'idle';
  if (view.status === 'over') return 'over';
  if (!view.hand) return 'lobby';
  return view.hand.phase;
}

function turnTextFor(
  view: TableView,
  mySeat: number | null,
  names: (i: number) => string,
  req: { place: number; discard: number } | null,
): string {
  const hand = view.hand;
  if (!hand)
    return view.status === 'over' ? 'The table is over' : 'Waiting to start the first hand';
  if (hand.phase === 'showdown') return 'Showdown';
  if (hand.phase === 'complete') return 'Table over';
  if (mySeat !== null) {
    const me = hand.seats[mySeat];
    if (me && !me.done && me.pending.length > 0 && (me.fantasyland || hand.toAct === mySeat)) {
      if (me.fantasyland) return `Fantasyland: set your ${me.pending.length} cards`;
      if (!req) return 'Your turn';
      if (req.discard > 0) return `Your turn: place ${req.place}, discard ${req.discard}`;
      return req.place === 1 ? 'Your turn: place 1 card' : `Your turn: place ${req.place} cards`;
    }
  }
  if (hand.toAct !== null) return `Waiting for ${names(hand.toAct)}…`;
  const fl = hand.seats.findIndex((s) => s.fantasyland && !s.done);
  if (fl >= 0) return `Waiting for ${names(fl)} to set Fantasyland…`;
  return 'Dealing…';
}

/**
 * Pure model of the table for rendering. `provisional` are the local player's not-yet-confirmed
 * placements so the UI can show them in place and evaluate fouls live.
 */
export function buildTableModel(
  state: TableClientState<TableView>,
  mySeat: number | null,
  names: readonly string[],
  provisional: readonly Placement[] = [],
): TableModel {
  const view = (state.snapshot?.state as TableView | undefined) ?? null;
  const phase = phaseOf(view);
  const name = (i: number) => names[i] ?? state.snapshot?.seats[i]?.name ?? `Seat ${i + 1}`;
  if (!view) {
    return {
      phase,
      variant: 'ofc',
      config: null,
      seats: [],
      me: null,
      mySeat,
      myTurn: false,
      settingFantasyland: false,
      canStart: false,
      requirement: null,
      pending: [],
      handNumber: 0,
      deckCount: null,
      button: null,
      turnText: 'Connecting…',
      result: null,
      scores: [],
      balances: [],
      seatCount: 0,
      bust: false,
    };
  }
  const config = view.config;
  const n = config.seats;
  const hand = view.hand;
  const base = config.scoring.mode === 'buyin' ? (config.scoring.buyIn ?? 0) : 0;
  const balances = view.scores.map((s) => base + s);
  const meHand = mySeat !== null ? (hand?.seats[mySeat] ?? null) : null;
  const canAct =
    !!hand &&
    hand.phase === 'setting' &&
    !!meHand &&
    !meHand.done &&
    meHand.pending.length > 0 &&
    (meHand.fantasyland || hand.toAct === mySeat);
  let requirement: { place: number; discard: number } | null = null;
  if (canAct && meHand) {
    const set = meHand.rows.top.length + meHand.rows.middle.length + meHand.rows.bottom.length;
    const pending = meHand.pending.length;
    let place: number;
    if (meHand.fantasyland) place = 13 - set;
    else if (set === 0) place = pending;
    else place = Math.min(config.variant === 'ofc' ? 1 : 2, 13 - set);
    requirement = { place, discard: pending - place };
  }
  const seatModels: SeatModel[] = [];
  for (let i = 0; i < n; i++) {
    const sh = hand?.seats[i];
    const isMe = i === mySeat;
    const baseRows: Rows = sh ? sh.rows : { top: [], middle: [], bottom: [] };
    const provRows = isMe ? rowsWith(baseRows, provisional) : baseRows;
    const rows = {} as Record<Row, RowModel>;
    for (const row of ROWS) {
      const scoring = rowScoring(config.variant, row);
      const cards = provRows[row];
      const complete = cards.length === ROW_CAPACITY[row];
      // What the row earns by the table's rules; a fouled seat forfeits it, which the UI shows
      // as a voided stamp rather than no stamp at all.
      const royalty = complete ? rowRoyalty(cards, row, config) : 0;
      rows[row] = {
        row,
        cards: baseRows[row],
        provisional: isMe ? provisional.filter((p) => p.row === row).map((p) => p.card) : [],
        capacity: ROW_CAPACITY[row],
        description: describeRow(cards, scoring),
        qualifies:
          scoring === 'low27' && complete ? isQualifiedLow(cards, config.lowQualifier) : null,
        label: row === 'middle' && middleIsLow(config.variant) ? 'Middle · 2-7' : ROW_LABELS[row],
        scoring,
        royalty,
      };
    }
    const result = hand?.result?.seats[i] ?? null;
    const foul =
      hand && hand.phase === 'setting' && isComplete(provRows)
        ? foulReason(provRows, config)
        : result?.fouled
          ? 'Fouled'
          : null;
    seatModels.push({
      seat: i,
      name: name(i),
      isMe,
      toAct: !!hand && hand.phase === 'setting' && hand.toAct === i,
      fantasyland: sh?.fantasyland ?? (view.fantasyland[i] ?? 0) > 0,
      faceDown: sh?.faceDown ?? false,
      hiddenCount: sh?.hiddenCount ?? 0,
      hidden: !isMe && (sh?.hiddenCount ?? 0) > 0,
      done: sh?.done ?? false,
      pendingCount: sh?.pendingCount ?? 0,
      discardCount: sh?.discardCount ?? 0,
      rows,
      score: view.scores[i] ?? 0,
      balance: config.scoring.mode === 'buyin' ? (balances[i] ?? 0) : null,
      result,
      foul,
      present: state.presence[i] ?? false,
      fantasylandNext: view.fantasyland[i] ?? 0,
    });
  }
  const ordered: SeatModel[] = [];
  if (mySeat !== null && mySeat < n) {
    for (let k = 1; k < n; k++) ordered.push(seatModels[(mySeat + k) % n]!);
    ordered.push(seatModels[mySeat]!);
  } else {
    ordered.push(...seatModels);
  }
  const me = mySeat !== null ? (seatModels[mySeat] ?? null) : null;
  const canStart =
    view.status !== 'over' && (!hand || hand.phase === 'showdown') && mySeat !== null;
  return {
    phase,
    variant: config.variant,
    config,
    seats: ordered,
    me,
    mySeat,
    myTurn: canAct,
    settingFantasyland:
      !!hand && hand.phase === 'setting' && !!meHand && meHand.fantasyland && !meHand.done,
    canStart,
    requirement,
    pending: meHand?.pending ?? [],
    handNumber: hand?.number ?? view.handNumber,
    deckCount: hand ? hand.deckCount : null,
    button: hand?.button ?? view.button,
    turnText: turnTextFor(view, mySeat, name, requirement),
    result: hand?.result ?? null,
    scores: view.scores,
    balances,
    seatCount: n,
    bust: view.status === 'over' && config.scoring.mode === 'buyin',
  };
}

export function useOfcTableModel(
  state: TableClientState<TableView>,
  mySeat: number | null,
  names: readonly string[] = [],
  provisional: readonly Placement[] = [],
): TableModel {
  const namesKey = names.join('|');
  return useMemo(
    () => buildTableModel(state, mySeat, namesKey ? namesKey.split('|') : [], provisional),
    [state, mySeat, namesKey, provisional],
  );
}

// ------------------------------------------------------------------------------------------
// Local placement draft
// ------------------------------------------------------------------------------------------

export interface PlacementDraft {
  placed: Placement[];
  /** Cards not yet placed (pending minus placed). The head of these become discards. */
  remaining: Card[];
  /** Cards that will be discarded on confirm (derived once `place` is met). */
  discards: Card[];
  selected: Card | null;
  requirement: { place: number; discard: number } | null;
  canConfirm: boolean;
  /** Rows that still have room. */
  legalRows: Row[];
  select: (card: Card | null) => void;
  /** Place `card` (or the selected card) on `row`; returns false when illegal. */
  place: (row: Row, card?: Card) => boolean;
  undo: () => void;
  clear: () => void;
  confirm: () => boolean;
  /** Timestamp of the last illegal drop, for a shake animation. */
  invalidAt: number;
}

function rowFree(base: Rows, placed: readonly Placement[], row: Row): boolean {
  const used = base[row].length + placed.filter((p) => p.row === row).length;
  return used < ROW_CAPACITY[row];
}

/**
 * Builds the local player's placement before it is sent. Resets whenever the authoritative
 * pending cards change (a new deal, or the placement was accepted).
 */
export function usePlacementDraft(
  state: TableClientState<TableView>,
  mySeat: number | null,
  send: (command: Command) => void,
): PlacementDraft {
  const view = (state.snapshot?.state as TableView | undefined) ?? null;
  const meHand = mySeat !== null ? (view?.hand?.seats[mySeat] ?? null) : null;
  const pending = useMemo(() => meHand?.pending ?? [], [meHand]);
  // Reset only when *my* cards change (a new deal, or my placement was accepted) — not on every
  // table update, or an opponent acting while I set a Fantasyland hand would wipe my draft.
  const committed = meHand
    ? meHand.rows.top.length + meHand.rows.middle.length + meHand.rows.bottom.length
    : 0;
  const pendingKey = `${pending.map(cardKey).join(',')}|${committed}|${meHand?.done ? 1 : 0}`;
  const baseRows = useMemo<Rows>(
    () => meHand?.rows ?? { top: [], middle: [], bottom: [] },
    [meHand],
  );

  const [placedRaw, setPlaced] = useState<Placement[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  // Between the server accepting a placement and the reset effect below, the placed cards are
  // already in the committed rows: ignore them so nothing renders twice.
  const placed = useMemo(() => {
    const pendingKeys = new Set(pending.map(cardKey));
    return placedRaw.filter((p) => pendingKeys.has(cardKey(p.card)));
  }, [placedRaw, pending]);
  const [invalidAt, setInvalidAt] = useState(0);
  const lastKey = useRef(pendingKey);
  useEffect(() => {
    if (lastKey.current !== pendingKey) {
      lastKey.current = pendingKey;
      setPlaced([]);
      setSelected(null);
    }
  }, [pendingKey]);

  const model = useMemo(() => buildTableModel(state, mySeat, [], placed), [state, mySeat, placed]);
  const requirement = model.requirement;
  const remaining = useMemo(() => {
    const placedKeys = new Set(placed.map((p) => cardKey(p.card)));
    return pending.filter((c) => !placedKeys.has(cardKey(c)));
  }, [pending, placed]);
  const discards = useMemo(() => {
    const full = requirement !== null && placed.length >= requirement.place;
    return full && requirement ? remaining.slice(0, requirement.discard) : [];
  }, [requirement, placed.length, remaining]);
  const canConfirm =
    requirement !== null &&
    placed.length === requirement.place &&
    remaining.length === requirement.discard;
  const legalRows = requirement ? ROWS.filter((r) => rowFree(baseRows, placed, r)) : [];

  const select = useCallback((card: Card | null) => setSelected(card), []);
  const place = useCallback(
    (row: Row, card?: Card): boolean => {
      const c = card ?? selected;
      if (!c || !requirement) return false;
      if (!pending.some((p) => cardKey(p) === cardKey(c))) return false;
      if (!rowFree(baseRows, placed, row)) {
        setInvalidAt(Date.now());
        return false;
      }
      setPlaced((prev) => {
        let next = prev.filter((p) => cardKey(p.card) !== cardKey(c));
        // Placing beyond the requirement swaps out the most recent placement (pineapple swap-back).
        if (next.length >= requirement.place) next = next.slice(0, requirement.place - 1);
        return [...next, { card: c, row }];
      });
      setSelected(null);
      return true;
    },
    [selected, requirement, pending, baseRows, placed],
  );
  const undo = useCallback(() => {
    setPlaced((prev) => prev.slice(0, -1));
    setSelected(null);
  }, []);
  const clear = useCallback(() => {
    setPlaced([]);
    setSelected(null);
  }, []);
  const confirm = useCallback((): boolean => {
    if (!canConfirm) return false;
    send({ type: 'place', placements: placed, discards });
    return true;
  }, [canConfirm, placed, discards, send]);

  return {
    placed,
    remaining,
    discards,
    selected,
    requirement,
    canConfirm,
    legalRows,
    select,
    place,
    undo,
    clear,
    confirm,
    invalidAt,
  };
}

/** Aggregate row outcome for a seat across its pairs: win/lose/tie. */
export function rowOutcome(result: HandResult, seat: number, row: Row): 'win' | 'lose' | 'tie' {
  let net = 0;
  for (const p of result.pairs) {
    if (p.a === seat) net += p.rows[row];
    else if (p.b === seat) net -= p.rows[row];
  }
  return net > 0 ? 'win' : net < 0 ? 'lose' : 'tie';
}

export function seatScooped(result: HandResult, seat: number): boolean {
  return result.pairs.some(
    (p) => (p.a === seat && p.scoop === 3) || (p.b === seat && p.scoop === -3),
  );
}

/** One opponent's column in a seat's showdown block, from that seat's point of view. */
export interface PairwiseLine {
  opponent: number;
  rows: Record<Row, number>;
  royalties: number;
  scoop: number;
  total: number;
}

/** A seat's results against every other seat, in seat order. */
export function pairwiseFor(result: HandResult, seat: number): PairwiseLine[] {
  const lines: PairwiseLine[] = [];
  for (const p of result.pairs) {
    if (p.a !== seat && p.b !== seat) continue;
    const flip = p.a === seat ? (n: number) => n : (n: number) => (n === 0 ? 0 : -n);
    lines.push({
      opponent: p.a === seat ? p.b : p.a,
      rows: { top: flip(p.rows.top), middle: flip(p.rows.middle), bottom: flip(p.rows.bottom) },
      royalties: flip(p.royalties),
      scoop: flip(p.scoop),
      total: flip(p.net),
    });
  }
  return lines.sort((x, y) => x.opponent - y.opponent);
}

export type SortMode = 'dealt' | 'low' | 'high' | 'suit';

const SUIT_ORDER: Record<Card['suit'], number> = { c: 0, d: 1, h: 2, s: 3 };

/** Order cards for the tray; 'dealt' keeps the server's order. */
export function sortCards(cards: readonly Card[], mode: SortMode): Card[] {
  const out = cards.slice();
  if (mode === 'dealt') return out;
  if (mode === 'low') {
    return out.sort((a, b) => a.rank - b.rank || SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit]);
  }
  if (mode === 'high') {
    return out.sort((a, b) => b.rank - a.rank || SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit]);
  }
  return out.sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || b.rank - a.rank);
}

/** `+3`, `−1`, `0`, with a proper minus sign. */
export function signed(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return '0';
}
