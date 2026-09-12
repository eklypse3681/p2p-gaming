/**
 * Core backgammon types. The engine is pure: every function takes state and returns new state.
 *
 * Coordinate conventions
 * ----------------------
 * - `Board.points` has 24 entries in *absolute* order. Index 0 is White's 1-point, index 23 is
 *   White's 24-point. Positive numbers are White checkers, negative numbers are Black checkers.
 * - White moves from high absolute points toward index 0 and bears off from absolute points 1..6.
 * - Black moves the opposite direction and bears off from absolute points 19..24.
 * - Every move is expressed in *player-relative* points ("rel"): each player counts 1..24 from their
 *   own home board outward (1..6 = home board, 24 = farthest point). 25 is the bar, 0 is "off".
 *   A checker on rel point `n` moved with die `d` lands on rel point `n - d` (or bears off if <= 0).
 *   Use `absIndex()` / `relPoint()` to convert.
 */

export type Player = 'white' | 'black';
export const PLAYERS: readonly Player[] = ['white', 'black'] as const;

export type Die = 1 | 2 | 3 | 4 | 5 | 6;
export type DiceRoll = [Die, Die];

/** Player-relative point: 1..24 on the board, 25 = bar, 0 = borne off. */
export type RelPoint = number;

export interface Board {
  /** 24 absolute points; +n = n white checkers, -n = n black checkers. */
  points: number[];
  bar: Record<Player, number>;
  off: Record<Player, number>;
}

/** One checker moving by one die. `from` is 1..25 (25 = bar), `to` is 0..24 (0 = off). */
export interface SubMove {
  from: RelPoint;
  to: RelPoint;
  die: Die;
  /** True if this move hits an opposing blot on `to`. */
  hit: boolean;
}

/** A full turn: an ordered sequence of sub-moves (0..4 entries). */
export type Play = SubMove[];

export type CubeOwner = Player | 'center';
export interface Cube {
  value: number;
  owner: CubeOwner;
}

export type ResultKind = 'single' | 'gammon' | 'backgammon';
/** 'recorded' = entered manually in free-board mode. */
export type ResultHow = 'bearoff' | 'drop' | 'resign' | 'recorded';

/**
 * 'enforced': the engine validates every move against the rules (default).
 * 'free': a physical board. Either player may roll at any time, move any checker of either
 * colour anywhere (a lone opposing checker is hit to the bar, a point with two or more opposing
 * checkers is blocked), set the cube, and record the result to keep score.
 */
export type RulesMode = 'enforced' | 'free';

export interface GameResult {
  winner: Player;
  kind: ResultKind;
  how: ResultHow;
  /** Cube value at the time the game ended. */
  cube: number;
  /** Points awarded (kind multiplier x cube, subject to Jacoby in money play). */
  points: number;
}

export type GamePhase =
  /** Each player rolls one die to decide who starts. Ties are re-rolled. */
  | { kind: 'opening'; rolls: Partial<Record<Player, Die>>; ties: number }
  /** `player` is on roll and may roll the dice or (if allowed) offer a double. */
  | { kind: 'to-roll'; player: Player }
  /** `by` has offered a double; the opponent must take or drop. */
  | { kind: 'double-offered'; by: Player }
  /** `player` has rolled `dice` and must move. */
  | { kind: 'moving'; player: Player; dice: DiceRoll }
  /** `by` has offered to resign for `stakes`; opponent must accept or decline. */
  | { kind: 'resign-offered'; by: Player; stakes: ResultKind; prior: GamePhase }
  /** Free-board mode: no turn order; `dice` is the most recent roll, if any. */
  | { kind: 'free'; dice: { player: Player; dice: DiceRoll } | null }
  | { kind: 'over'; result: GameResult };

export type TurnRecord =
  | { type: 'opening'; white: Die; black: Die }
  /** A completed turn. `play` is empty when the player had no legal move. */
  | { type: 'move'; player: Player; dice: DiceRoll; play: Play }
  | { type: 'double'; player: Player; value: number }
  | { type: 'take'; player: Player }
  | { type: 'drop'; player: Player }
  | { type: 'resign-offer'; player: Player; stakes: ResultKind }
  | { type: 'resign-accept'; player: Player }
  | { type: 'resign-decline'; player: Player }
  | { type: 'free-roll'; player: Player; dice: DiceRoll }
  /** `from`/`to` are in the moved `checker` colour's relative coordinates (1..24, 25 bar, 0 off). */
  | {
      type: 'free-move';
      player: Player;
      checker: Player;
      from: RelPoint;
      to: RelPoint;
      hit: boolean;
    }
  | { type: 'free-cube'; player: Player; value: number; owner: CubeOwner }
  | { type: 'free-reset'; player: Player }
  | { type: 'free-result'; player: Player; winner: Player; kind: ResultKind };

export interface GameState {
  board: Board;
  cube: Cube;
  phase: GamePhase;
  /** True when this game is the Crawford game (cube may not be turned). */
  crawford: boolean;
  /** Number of completed 'move' turns so far (on a free board: number of rolls). */
  turnCount: number;
  history: TurnRecord[];
}

export interface MatchConfig {
  /** Points needed to win the match. 0 means an unlimited "money" session. */
  length: number;
  /** Apply the Crawford rule (match play only). */
  crawford: boolean;
  /** Apply the Jacoby rule (money play only): gammons only count if the cube was turned. */
  jacoby: boolean;
  /** Rule enforcement mode; defaults to 'enforced'. */
  rules?: RulesMode;
}

export interface GameSummary {
  number: number;
  result: GameResult;
  scoreAfter: Record<Player, number>;
  crawford: boolean;
  turns: TurnRecord[];
}

export interface MatchState {
  config: MatchConfig;
  score: Record<Player, number>;
  /** 1-based number of the current game (or of the next game if none is in progress). */
  gameNumber: number;
  /** The Crawford game has been played (or is in progress). */
  crawfordDone: boolean;
  game: GameState | null;
  games: GameSummary[];
  winner: Player | null;
}

/** Every state transition a match can undergo. Dice are part of the action so replays are deterministic. */
export type Action =
  | { type: 'start-game' }
  | { type: 'opening-roll'; player: Player; die: Die }
  | { type: 'roll'; player: Player; dice: DiceRoll }
  | { type: 'play'; player: Player; play: Play }
  | { type: 'double'; player: Player }
  | { type: 'take'; player: Player }
  | { type: 'drop'; player: Player }
  | { type: 'offer-resign'; player: Player; stakes: ResultKind }
  | { type: 'accept-resign'; player: Player }
  | { type: 'decline-resign'; player: Player }
  // ---- free-board mode only ----
  | { type: 'free-roll'; player: Player; dice: DiceRoll }
  /** Move one checker of colour `checker`; coordinates are relative to that colour. */
  | { type: 'free-move'; player: Player; checker: Player; from: RelPoint; to: RelPoint }
  | { type: 'free-cube'; player: Player; value: number; owner: CubeOwner }
  /** Put every checker back to the starting position (same game). */
  | { type: 'free-reset'; player: Player }
  /** End the game with a manually recorded result. */
  | { type: 'free-result'; player: Player; winner: Player; kind: ResultKind };

export class RuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuleError';
  }
}
