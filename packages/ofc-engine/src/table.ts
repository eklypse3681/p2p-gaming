import type { Card } from './cards.js';
import { cardKey, hasDuplicates, isCard, newDeck, removeCards } from './cards.js';
import type { Rng } from './rng.js';
import { cardsPerTurn, defaultConfig, isComplete, placedPerTurn, scoreHand } from './rules.js';
import type {
  Action,
  Command,
  HandState,
  LedgerEntry,
  Placement,
  Row,
  Rows,
  SeatHand,
  TableConfig,
  TableState,
  Transfer,
} from './types.js';
import { ROWS, ROW_CAPACITY, RuleError } from './types.js';

// ------------------------------------------------------------------------------------------
// Construction
// ------------------------------------------------------------------------------------------

export function init(config: Partial<TableConfig> = {}, _rng?: Rng): TableState {
  const cfg = defaultConfig(config);
  if (cfg.seats !== 2 && cfg.seats !== 3) throw new RuleError('bad-config', 'seats must be 2 or 3');
  if (cfg.scoring.mode === 'buyin' && !(cfg.scoring.buyIn && cfg.scoring.buyIn > 0)) {
    throw new RuleError('bad-config', 'buy-in mode needs a positive buyIn');
  }
  const zeros = new Array<number>(cfg.seats).fill(0);
  return {
    config: cfg,
    status: 'lobby',
    button: 0,
    handNumber: 0,
    hand: null,
    scores: zeros.slice(),
    fantasyland: zeros.slice(),
    history: [],
    ledger: [],
    settleRequests: new Array<boolean>(cfg.seats).fill(false),
  };
}

/** Settle requests by seat, tolerant of tables created before the field existed. */
export function settleRequests(state: TableState): boolean[] {
  const out = new Array<boolean>(state.config.seats).fill(false);
  (state.settleRequests ?? []).forEach((v, i) => {
    if (i < out.length) out[i] = !!v;
  });
  return out;
}

function emptyRows(): Rows {
  return { top: [], middle: [], bottom: [] };
}

function fail(code: string, message: string): never {
  throw new RuleError(code, message);
}

function seatIndex(state: TableState, seat: number): number {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.config.seats) {
    fail('bad-seat', `seat ${seat} does not exist`);
  }
  return seat;
}

function requireHand(state: TableState): HandState {
  if (!state.hand) fail('no-hand', 'no hand in progress');
  return state.hand;
}

function cloneRows(r: Rows): Rows {
  return { top: r.top.slice(), middle: r.middle.slice(), bottom: r.bottom.slice() };
}

function cloneSeat(s: SeatHand): SeatHand {
  return {
    rows: cloneRows(s.rows),
    pending: s.pending.slice(),
    discards: s.discards.slice(),
    fantasyland: s.fantasyland,
    done: s.done,
    faceDown: s.faceDown,
  };
}

// ------------------------------------------------------------------------------------------
// Turn order helpers
// ------------------------------------------------------------------------------------------

/** Seats in acting order for a hand: left of the button first. */
export function seatOrder(button: number, seats: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= seats; i++) out.push((button + i) % seats);
  return out;
}

/** Next seat after `from` (cyclic, `from` itself last) that plays in turn order and still needs to act. */
function nextTurnSeat(hand: HandState, from: number, needsPending: boolean): number | null {
  const n = hand.seats.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    const s = hand.seats[i]!;
    if (s.fantasyland || s.done) continue;
    if (needsPending ? s.pending.length > 0 : s.pending.length === 0) return i;
  }
  return null;
}

export function allDone(hand: HandState): boolean {
  return hand.seats.every((s) => s.done);
}

/** Whether `seat` may place cards right now. */
export function canPlace(state: TableState, seat: number): boolean {
  const hand = state.hand;
  if (!hand || hand.phase !== 'setting') return false;
  const s = hand.seats[seat];
  if (!s || s.done || s.pending.length === 0) return false;
  return s.fantasyland || hand.toAct === seat;
}

/** Rows that still have room for `seat` (empty when the seat cannot act). */
export function legalRowsFor(state: TableState, seat: number): Row[] {
  if (!canPlace(state, seat)) return [];
  const rows = state.hand!.seats[seat]!.rows;
  return ROWS.filter((r) => rows[r].length < ROW_CAPACITY[r]);
}

/** How many cards `seat` must place and discard from its pending cards this turn. */
export function turnRequirement(
  state: TableState,
  seat: number,
): { place: number; discard: number } {
  const hand = requireHand(state);
  const s = hand.seats[seatIndex(state, seat)]!;
  const pending = s.pending.length;
  if (s.fantasyland) {
    const set = s.rows.top.length + s.rows.middle.length + s.rows.bottom.length;
    const place = 13 - set;
    return { place, discard: pending - place };
  }
  const set = s.rows.top.length + s.rows.middle.length + s.rows.bottom.length;
  if (set === 0) return { place: pending, discard: 0 };
  const place = Math.min(placedPerTurn(state.config.variant), 13 - set);
  return { place, discard: pending - place };
}

// ------------------------------------------------------------------------------------------
// Reducer
// ------------------------------------------------------------------------------------------

export function reduce(state: TableState, action: Action): TableState {
  switch (action.type) {
    case 'start-hand':
      return startHand(state, action);
    case 'place':
      return place(state, action);
    case 'deal-next':
      return dealNext(state, action);
    case 'showdown':
      return showdown(state);
    case 'settle':
      return settle(state, action.at);
    case 'adjust':
      return adjust(state, action);
    case 'settle-request': {
      const seat = seatIndex(state, action.seat);
      const requests = settleRequests(state);
      requests[seat] = action.requested;
      return { ...state, settleRequests: requests };
    }
  }
}

function startHand(state: TableState, action: Extract<Action, { type: 'start-hand' }>): TableState {
  if (state.status === 'over') fail('table-over', 'the table is over');
  if (state.hand && state.hand.phase === 'setting')
    fail('hand-in-progress', 'a hand is in progress');
  const n = state.config.seats;
  seatIndex(state, action.button);
  if (action.deals.length !== n) fail('bad-deal', 'every seat must be dealt');
  const all: Card[] = [];
  const seen = new Set<number>();
  for (const d of action.deals) {
    seatIndex(state, d.seat);
    if (seen.has(d.seat)) fail('bad-deal', 'seat dealt twice');
    seen.add(d.seat);
    const fl = state.fantasyland[d.seat] ?? 0;
    const expected = fl > 0 ? fl : 5;
    if (d.cards.length !== expected) fail('bad-deal', `seat ${d.seat} expects ${expected} cards`);
    if (!d.cards.every(isCard)) fail('bad-deal', 'malformed card');
    all.push(...d.cards);
  }
  if (hasDuplicates(all)) fail('bad-deal', 'duplicate cards dealt');
  const seats: SeatHand[] = [];
  for (let i = 0; i < n; i++) {
    const fl = (state.fantasyland[i] ?? 0) > 0;
    const cards = action.deals.find((d) => d.seat === i)!.cards.slice();
    seats.push({
      rows: emptyRows(),
      pending: cards,
      discards: [],
      fantasyland: fl,
      done: false,
      faceDown: fl,
    });
  }
  const hand: HandState = {
    number: state.handNumber + 1,
    button: action.button,
    phase: 'setting',
    seats,
    toAct: null,
    deck: removeCards(newDeck(), all),
    result: null,
  };
  // The first non-Fantasyland seat left of the button acts first.
  for (const i of seatOrder(action.button, n)) {
    const s = seats[i]!;
    if (!s.fantasyland) {
      hand.toAct = i;
      break;
    }
  }
  return {
    ...state,
    status: 'playing',
    button: action.button,
    handNumber: hand.number,
    hand,
    fantasyland: new Array<number>(n).fill(0),
  };
}

function place(state: TableState, action: Extract<Action, { type: 'place' }>): TableState {
  const hand = requireHand(state);
  if (hand.phase !== 'setting') fail('wrong-phase', 'the hand is not being set');
  const seat = seatIndex(state, action.seat);
  const s = hand.seats[seat]!;
  if (s.done) fail('already-set', 'this seat has set all its cards');
  if (s.pending.length === 0) fail('no-cards', 'no cards to place');
  if (!s.fantasyland && hand.toAct !== seat)
    fail('not-your-turn', `it is seat ${hand.toAct}'s turn`);
  const req = turnRequirement(state, seat);
  const placements = action.placements;
  const discards = action.discards ?? [];
  if (placements.length !== req.place) fail('bad-placement', `place exactly ${req.place} card(s)`);
  if (discards.length !== req.discard)
    fail('bad-placement', `discard exactly ${req.discard} card(s)`);
  const used = [...placements.map((p) => p.card), ...discards];
  if (!used.every(isCard)) fail('bad-placement', 'malformed card');
  if (hasDuplicates(used)) fail('bad-placement', 'a card was used twice');
  const pendingKeys = new Set(s.pending.map(cardKey));
  for (const c of used)
    if (!pendingKeys.has(cardKey(c))) fail('bad-placement', `${cardKey(c)} was not dealt to you`);
  const rows = cloneRows(s.rows);
  for (const p of placements) {
    if (!ROWS.includes(p.row)) fail('bad-placement', `unknown row ${String(p.row)}`);
    if (rows[p.row].length >= ROW_CAPACITY[p.row]) fail('row-full', `${p.row} row is full`);
    rows[p.row].push(p.card);
  }
  const next = cloneSeat(s);
  next.rows = rows;
  next.pending = [];
  next.discards = [...s.discards, ...discards];
  next.done = isComplete(rows);
  const seats = hand.seats.map((x, i) => (i === seat ? next : x));
  const newHand: HandState = { ...hand, seats };
  if (hand.toAct === seat) {
    // Pass the turn to the next seat still holding pending cards (initial round); otherwise wait
    // for a deal-next.
    newHand.toAct = nextTurnSeat(newHand, seat, true);
  }
  return { ...state, hand: newHand };
}

function dealNext(state: TableState, action: Extract<Action, { type: 'deal-next' }>): TableState {
  const hand = requireHand(state);
  if (hand.phase !== 'setting') fail('wrong-phase', 'the hand is not being set');
  if (hand.toAct !== null) fail('wrong-turn', `seat ${hand.toAct} still has to act`);
  const seat = seatIndex(state, action.seat);
  const s = hand.seats[seat]!;
  if (s.fantasyland) fail('bad-deal', 'Fantasyland seats are dealt at the start');
  if (s.done) fail('bad-deal', 'seat is already set');
  if (s.pending.length > 0) fail('bad-deal', 'seat already holds cards');
  const expected = cardsPerTurn(state.config.variant);
  if (action.cards.length !== expected) fail('bad-deal', `deal exactly ${expected} card(s)`);
  if (!action.cards.every(isCard) || hasDuplicates(action.cards))
    fail('bad-deal', 'malformed deal');
  const deckKeys = new Set(hand.deck.map(cardKey));
  for (const c of action.cards)
    if (!deckKeys.has(cardKey(c))) fail('bad-deal', `${cardKey(c)} is not in the deck`);
  const next = cloneSeat(s);
  next.pending = action.cards.slice();
  const seats = hand.seats.map((x, i) => (i === seat ? next : x));
  return {
    ...state,
    hand: { ...hand, seats, toAct: seat, deck: removeCards(hand.deck, action.cards) },
  };
}

function showdown(state: TableState): TableState {
  const hand = requireHand(state);
  if (hand.phase !== 'setting') fail('wrong-phase', 'the hand is not being set');
  if (!allDone(hand)) fail('not-done', 'not every seat has set its hand');
  const result = scoreHand(
    hand.number,
    hand.seats.map((s) => s.rows),
    hand.seats.map((s) => s.fantasyland),
    state.config,
  );
  const scores = state.scores.map((v, i) => v + result.seats[i]!.points);
  const fantasyland = result.seats.map((s) => s.fantasylandNext);
  const ledger: LedgerEntry[] = [
    ...state.ledger,
    { type: 'hand', hand: hand.number, transfers: result.transfers },
  ];
  const seats = hand.seats.map((s) => ({ ...cloneSeat(s), faceDown: false }));
  const next: TableState = {
    ...state,
    hand: { ...hand, seats, phase: 'showdown', result, toAct: null },
    scores,
    fantasyland,
    history: [...state.history, result],
    ledger,
    button: (hand.button + 1) % state.config.seats,
  };
  if (isBust(next)) {
    return { ...next, status: 'over', hand: { ...next.hand!, phase: 'complete' } };
  }
  return next;
}

function settle(state: TableState, at: number): TableState {
  const plan = settlementPlan(state);
  const entry: LedgerEntry = {
    type: 'settlement',
    at,
    multiplier: state.config.scoring.multiplier,
    transfers: plan,
  };
  return {
    ...state,
    ledger: [...state.ledger, entry],
    settleRequests: new Array<boolean>(state.config.seats).fill(false),
  };
}

function adjust(state: TableState, action: Extract<Action, { type: 'adjust' }>): TableState {
  const seat = seatIndex(state, action.seat);
  if (!Number.isFinite(action.points) || action.points === 0)
    fail('bad-adjust', 'points must be a non-zero number');
  const scores = state.scores.map((v, i) => (i === seat ? v + action.points : v));
  const entry: LedgerEntry = {
    type: 'adjust',
    at: action.at,
    seat,
    points: action.points,
    note: action.note ?? '',
  };
  return { ...state, scores, ledger: [...state.ledger, entry] };
}

// ------------------------------------------------------------------------------------------
// Ledger
// ------------------------------------------------------------------------------------------

/** Net points per seat since the last settlement (sums to zero unless adjusted). */
export function unsettledBalances(state: TableState): number[] {
  const n = state.config.seats;
  const out = new Array<number>(n).fill(0);
  let start = 0;
  for (let i = state.ledger.length - 1; i >= 0; i--) {
    if (state.ledger[i]!.type === 'settlement') {
      start = i + 1;
      break;
    }
  }
  for (let i = start; i < state.ledger.length; i++) {
    const e = state.ledger[i]!;
    if (e.type === 'hand') {
      for (const t of e.transfers) {
        out[t.from]! -= t.points;
        out[t.to]! += t.points;
      }
    } else if (e.type === 'adjust') {
      out[e.seat]! += e.points;
    }
  }
  return out;
}

/** Displayed balance per seat: from zero in 'up' mode, from the buy-in in 'buyin' mode. */
export function balances(state: TableState): number[] {
  const base = state.config.scoring.mode === 'buyin' ? (state.config.scoring.buyIn ?? 0) : 0;
  return unsettledBalances(state).map((v) => base + v);
}

export function isBust(state: TableState): boolean {
  const sc = state.config.scoring;
  if (sc.mode !== 'buyin' || !sc.bustEnds) return false;
  return balances(state).some((b) => b <= 0);
}

/** Who pays whom, in points and currency, to bring every seat back to its baseline. */
export function settlementPlan(state: TableState): Array<Transfer & { amount: number }> {
  const bal = unsettledBalances(state);
  const debtors = bal.map((v, i) => ({ seat: i, left: -v })).filter((d) => d.left > 0);
  const creditors = bal.map((v, i) => ({ seat: i, left: v })).filter((c) => c.left > 0);
  const out: Array<Transfer & { amount: number }> = [];
  let ci = 0;
  for (const d of debtors) {
    while (d.left > 0 && ci < creditors.length) {
      const c = creditors[ci]!;
      const points = Math.min(d.left, c.left);
      out.push({
        from: d.seat,
        to: c.seat,
        points,
        amount: points * state.config.scoring.multiplier,
      });
      d.left -= points;
      c.left -= points;
      if (c.left === 0) ci++;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Commands (host side): turn a seat's intent into deterministic actions
// ------------------------------------------------------------------------------------------

function draw(deck: readonly Card[], n: number, rng: Rng): { cards: Card[]; rest: Card[] } {
  const rest = deck.slice();
  const cards: Card[] = [];
  for (let i = 0; i < n; i++) {
    if (rest.length === 0) fail('deck-empty', 'the deck is exhausted');
    const j = rng.int(rest.length);
    cards.push(rest[j]!);
    rest.splice(j, 1);
  }
  return { cards, rest };
}

export function canStartHand(state: TableState): boolean {
  if (state.status === 'over') return false;
  return !state.hand || state.hand.phase === 'showdown';
}

export function command(
  state: TableState,
  seat: number,
  cmd: Command,
  rng: Rng,
  now: () => number = Date.now,
): Action[] {
  // `start`, `settle` and `adjust` may come from a non-playing dealer (seat -1); a placement
  // or a settle request needs the sender to hold a seat.
  if (cmd.type === 'place' || cmd.type === 'settle-request') seatIndex(state, seat);
  switch (cmd.type) {
    case 'start': {
      if (!canStartHand(state)) fail('cannot-start', 'a hand cannot start now');
      let deck = newDeck();
      const deals: Array<{ seat: number; cards: Card[] }> = [];
      for (const i of seatOrder(state.button, state.config.seats)) {
        const fl = state.fantasyland[i] ?? 0;
        const d = draw(deck, fl > 0 ? fl : 5, rng);
        deck = d.rest;
        deals.push({ seat: i, cards: d.cards });
      }
      return [{ type: 'start-hand', button: state.button, deals }];
    }
    case 'place': {
      const action: Action = {
        type: 'place',
        seat,
        placements: cmd.placements,
        discards: cmd.discards ?? [],
      };
      const after = reduce(state, action); // validates
      const actions: Action[] = [action];
      const hand = after.hand!;
      if (allDone(hand)) {
        actions.push({ type: 'showdown' });
      } else if (hand.toAct === null) {
        const nextSeat = nextTurnSeat(hand, seat, false);
        if (nextSeat !== null) {
          const d = draw(hand.deck, cardsPerTurn(state.config.variant), rng);
          actions.push({ type: 'deal-next', seat: nextSeat, cards: d.cards });
        }
      }
      return actions;
    }
    case 'settle':
      return [{ type: 'settle', at: now() }];
    case 'adjust':
      return [{ type: 'adjust', at: now(), seat: cmd.seat, points: cmd.points, note: cmd.note }];
    case 'settle-request': {
      if (state.hand && state.hand.phase === 'setting')
        fail('hand-in-progress', 'ask to settle between hands');
      const requested = cmd.requested ?? !settleRequests(state)[seat];
      return [{ type: 'settle-request', seat, requested }];
    }
  }
}

/** Apply a list of actions in order. */
export function applyAll(state: TableState, actions: readonly Action[]): TableState {
  let s = state;
  for (const a of actions) s = reduce(s, a);
  return s;
}

/** Rebuild a table from its action log. */
export function replay(config: Partial<TableConfig>, actions: readonly Action[]): TableState {
  return applyAll(init(config), actions);
}

// ------------------------------------------------------------------------------------------
// Views: what a given seat is allowed to see
// ------------------------------------------------------------------------------------------

export interface SeatHandView extends SeatHand {
  pendingCount: number;
  discardCount: number;
  /** Cards set but hidden (face-down Fantasyland hand). */
  hiddenCount: number;
}

export interface HandView extends Omit<HandState, 'seats' | 'deck'> {
  seats: SeatHandView[];
  deckCount: number;
}

export interface TableView extends Omit<TableState, 'hand'> {
  hand: HandView | null;
  /** The seat this view was made for. */
  viewer: number;
}

/**
 * A seat in Fantasyland sees nothing of the other seats' rows until it has set its own hand:
 * with all its cards in hand it could otherwise tailor the hand to what is already on the table.
 */
export function viewerIsSettingFantasyland(hand: HandState, viewer: number): boolean {
  const me = hand.seats[viewer];
  return hand.phase === 'setting' && !!me && me.fantasyland && !me.done;
}

export function view(state: TableState, viewer: number): TableView {
  const hand = state.hand;
  if (!hand) return { ...state, hand: null, viewer };
  const blind = viewerIsSettingFantasyland(hand, viewer);
  const seats: SeatHandView[] = hand.seats.map((s, i) => {
    const own = i === viewer;
    const set = s.rows.top.length + s.rows.middle.length + s.rows.bottom.length;
    const hideRows = !own && (s.faceDown || blind);
    return {
      rows: hideRows ? emptyRows() : cloneRows(s.rows),
      pending: own ? s.pending.slice() : [],
      discards: own ? s.discards.slice() : [],
      fantasyland: s.fantasyland,
      done: s.done,
      faceDown: s.faceDown,
      pendingCount: s.pending.length,
      discardCount: s.discards.length,
      hiddenCount: hideRows ? set : 0,
    };
  });
  const { deck, ...rest } = hand;
  return { ...state, hand: { ...rest, seats, deckCount: deck.length }, viewer };
}

/**
 * Strip what `viewer` may not see from an action, for display logs. Redacted actions carry a
 * `count` in place of hidden cards and cannot be replayed.
 */
export function redactAction(
  state: TableState,
  action: Action,
  viewer: number,
): Action & { redacted?: true } {
  switch (action.type) {
    case 'start-hand':
      return {
        ...action,
        redacted: true,
        deals: action.deals.map((d) =>
          d.seat === viewer
            ? d
            : ({ seat: d.seat, cards: [], count: d.cards.length } as {
                seat: number;
                cards: Card[];
              }),
        ),
      };
    case 'deal-next':
      return action.seat === viewer
        ? action
        : ({ ...action, cards: [], count: action.cards.length, redacted: true } as Action & {
            redacted: true;
          });
    case 'place': {
      if (action.seat === viewer) return action;
      const s = state.hand?.seats[action.seat];
      const hideRows = !!s && s.faceDown;
      return {
        ...action,
        redacted: true,
        placements: hideRows ? [] : action.placements,
        discards: [],
        count: hideRows
          ? action.placements.length + action.discards.length
          : action.discards.length,
      } as Action & { redacted: true };
    }
    default:
      return action;
  }
}

export type { Placement };
