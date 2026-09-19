import type { Card } from './cards.js';
import type { HighCategory } from './evaluate.js';

export type Variant = 'ofc' | 'pineapple' | 'pineapple27';
export type Row = 'top' | 'middle' | 'bottom';
export const ROWS: readonly Row[] = ['top', 'middle', 'bottom'];
export const ROW_CAPACITY: Record<Row, number> = { top: 3, middle: 5, bottom: 5 };

export type PairRank = 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export type FantasylandEntry = 'QQ' | 'KK' | 'AA';

export interface RoyaltyConfig {
  /** Master switch. */
  enabled: boolean;
  /** Top row pairs by rank (66..AA) and trips by rank (222..AAA). Missing rank = 0. */
  topPairs: Partial<Record<number, number>>;
  topTrips: Partial<Record<number, number>>;
  /** Middle row (high scoring). */
  middle: Partial<Record<HighCategory | 'royal-flush', number>>;
  /** Bottom row. */
  bottom: Partial<Record<HighCategory | 'royal-flush', number>>;
  /** Middle row in 2-7 variants, keyed by the low's high card, plus the wheel (7-5-4-3-2). */
  middleLow: { ten: number; nine: number; eight: number; seven: number; wheel: number };
}

export interface FantasylandConfig {
  enabled: boolean;
  /** Minimum top pair to enter (trips always qualify). */
  entry: FantasylandEntry;
  /** Cards dealt in Fantasyland (classic OFC: 13; pineapple: 14). */
  cards: number;
  /** Pineapple: 14/15/16/17 for QQ/KK/AA/trips instead of the flat `cards`. */
  progressive: boolean;
  progressiveCards: { QQ: number; KK: number; AA: number; trips: number };
  /** Qualifying twice in one hand (e.g. KK on top and a wheel in the middle) adds one card. */
  superFantasyland: boolean;
  stay: { topTrips: boolean; middleFullHouse: boolean; bottomQuads: boolean };
}

export interface ScoringConfig {
  /** 'up' counts from zero; 'buyin' starts each seat at `buyIn` and counts down. */
  mode: 'up' | 'buyin';
  buyIn?: number;
  /** Currency units per point, used for settlements. */
  multiplier: number;
  /** In buy-in mode, end the table when a seat reaches zero or less. */
  bustEnds?: boolean;
}

/** How an unattended table moves between hands. */
export interface FlowConfig {
  /** Deal the first hand as soon as every seat is taken (and present). */
  startWhenFull: boolean;
  /** After a showdown: deal when everyone pressed Ready, or after a countdown. */
  nextHand: 'ready' | 'countdown';
  /** Countdown length for `nextHand: 'countdown'`. */
  nextHandDelayMs: number;
  /** Settle automatically once every seated player has asked to settle. */
  settleOnConsensus: boolean;
  /** Do nothing while a seated player has no device connected. */
  pauseWhenAbsent: boolean;
}

export interface TableConfig {
  variant: Variant;
  seats: 2 | 3;
  royalties: RoyaltyConfig;
  fantasyland: FantasylandConfig;
  scoring: ScoringConfig;
  /** 2-7 middle must be this-low or better to avoid fouling (default 10). */
  lowQualifier: number;
  /** Unattended-table flow (see `FlowConfig`); absent in tables created before it existed. */
  flow?: FlowConfig;
}

export interface Rows {
  top: Card[];
  middle: Card[];
  bottom: Card[];
}

export interface SeatHand {
  rows: Rows;
  /** Cards dealt to this seat and not yet placed. */
  pending: Card[];
  /** Face-down discards (pineapple, Fantasyland). */
  discards: Card[];
  /** This seat is in Fantasyland for the current hand. */
  fantasyland: boolean;
  /** All 13 cards are set. */
  done: boolean;
  /** Fantasyland hands stay face down until the showdown. */
  faceDown: boolean;
}

export interface RowResult {
  cards: Card[];
  description: string;
  royalty: number;
}

export interface SeatResult {
  fouled: boolean;
  rows: Record<Row, RowResult>;
  royalties: number;
  /** Net points this hand (sum over opponents). */
  points: number;
  /** Fantasyland qualification for the next hand: cards to deal, 0 = none. */
  fantasylandNext: number;
  /** Why the seat qualified (for UI), e.g. ['top KK'] */
  qualifiedBy: string[];
}

export interface PairResult {
  a: number;
  b: number;
  /** Row wins from a's point of view: +1 a wins, -1 b wins, 0 tie. */
  rows: Record<Row, number>;
  scoop: number;
  /** Net royalties from a's point of view. */
  royalties: number;
  /** Total points from a's point of view. */
  net: number;
}

export interface HandResult {
  hand: number;
  seats: SeatResult[];
  pairs: PairResult[];
  /** Positive transfers only. */
  transfers: Transfer[];
}

export interface Transfer {
  from: number;
  to: number;
  points: number;
}

export interface HandState {
  number: number;
  button: number;
  phase: 'setting' | 'showdown' | 'complete';
  seats: SeatHand[];
  /** Seat that must place next (non-Fantasyland turn order), or null while only FL seats remain. */
  toAct: number | null;
  /** Cards not yet dealt (server side; never sent to clients). */
  deck: Card[];
  result: HandResult | null;
}

export type LedgerEntry =
  | { type: 'hand'; hand: number; transfers: Transfer[] }
  | { type: 'adjust'; at: number; seat: number; points: number; note: string }
  | {
      type: 'settlement';
      at: number;
      multiplier: number;
      transfers: Array<Transfer & { amount: number }>;
    };

export interface TableState {
  config: TableConfig;
  status: 'lobby' | 'playing' | 'over';
  /** Seat holding the button for the current/next hand. */
  button: number;
  handNumber: number;
  hand: HandState | null;
  /** Net points per seat since the table started. */
  scores: number[];
  /** Fantasyland cards owed next hand per seat (0 = normal hand). */
  fantasyland: number[];
  history: HandResult[];
  ledger: LedgerEntry[];
  /** Seats that asked to settle; cleared by a settlement. Absent in older tables. */
  settleRequests?: boolean[];
}

export interface Placement {
  card: Card;
  row: Row;
}

export type Action =
  | { type: 'start-hand'; button: number; deals: Array<{ seat: number; cards: Card[] }> }
  | { type: 'place'; seat: number; placements: Placement[]; discards: Card[] }
  | { type: 'deal-next'; seat: number; cards: Card[] }
  | { type: 'showdown' }
  | { type: 'settle'; at: number }
  | { type: 'adjust'; at: number; seat: number; points: number; note: string }
  | { type: 'settle-request'; seat: number; requested: boolean };

export type Command =
  | { type: 'start' }
  | { type: 'place'; placements: Placement[]; discards?: Card[] }
  | { type: 'settle' }
  | { type: 'adjust'; seat: number; points: number; note: string }
  /** "I'd like to settle up" (toggle when `requested` is omitted). */
  | { type: 'settle-request'; requested?: boolean };

export class RuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuleError';
  }
}
