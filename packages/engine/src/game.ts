import type {
  Board,
  CubeOwner,
  Die,
  DiceRoll,
  GamePhase,
  GameResult,
  GameState,
  Play,
  Player,
  RelPoint,
  ResultKind,
  SubMove,
  TurnRecord,
} from './types.js';
import { RuleError } from './types.js';
import {
  BAR,
  OFF,
  absIndex,
  applyPlay,
  cloneBoard,
  countAt,
  opponent,
  opponentCountAt,
  sign,
  startingBoard,
  CHECKERS_PER_PLAYER,
} from './board.js';
import { findLegalPlay, hasLegalMove } from './moves.js';

export const MAX_CUBE = 64;
/** Free-board games keep at most this many `free-move` records (oldest are dropped). */
export const FREE_MOVE_HISTORY_CAP = 2000;

export function newGame(
  opts: { crawford?: boolean; board?: Board; free?: boolean } = {},
): GameState {
  return {
    board: opts.board ?? startingBoard(),
    cube: { value: 1, owner: 'center' },
    phase: opts.free ? { kind: 'free', dice: null } : { kind: 'opening', rolls: {}, ties: 0 },
    crawford: opts.crawford ?? false,
    turnCount: 0,
    history: [],
  };
}

function fail(code: string, message: string): never {
  throw new RuleError(code, message);
}

function expectPhase<K extends GamePhase['kind']>(
  state: GameState,
  kind: K,
): Extract<GamePhase, { kind: K }> {
  if (state.phase.kind !== kind) {
    fail('wrong-phase', `expected phase ${kind} but game is in ${state.phase.kind}`);
  }
  return state.phase as Extract<GamePhase, { kind: K }>;
}

/** Who must act in the current phase (null when the game is over or waiting on both). */
export function playerToAct(state: GameState): Player | null {
  const ph = state.phase;
  switch (ph.kind) {
    case 'opening':
      return null;
    case 'to-roll':
    case 'moving':
      return ph.player;
    case 'double-offered':
      return opponent(ph.by);
    case 'resign-offered':
      return opponent(ph.by);
    case 'free':
    case 'over':
      return null;
  }
}

export function isFreeBoard(state: GameState): boolean {
  return state.phase.kind === 'free';
}

export function isGameOver(state: GameState): boolean {
  return state.phase.kind === 'over';
}

/** True if `player` may currently offer a double. */
export function canDouble(state: GameState, player: Player): boolean {
  const ph = state.phase;
  if (ph.kind !== 'to-roll' || ph.player !== player) return false;
  if (state.crawford) return false;
  if (state.cube.value >= MAX_CUBE) return false;
  return state.cube.owner === 'center' || state.cube.owner === player;
}

export function openingRoll(state: GameState, player: Player, die: Die): GameState {
  const ph = expectPhase(state, 'opening');
  if (ph.rolls[player] !== undefined) fail('already-rolled', `${player} already rolled`);
  const rolls = { ...ph.rolls, [player]: die };
  const w = rolls.white;
  const b = rolls.black;
  if (w === undefined || b === undefined) {
    return { ...state, phase: { kind: 'opening', rolls, ties: ph.ties } };
  }
  if (w === b) {
    return { ...state, phase: { kind: 'opening', rolls: {}, ties: ph.ties + 1 } };
  }
  const winner: Player = w > b ? 'white' : 'black';
  const dice: DiceRoll = winner === 'white' ? [w, b] : [b, w];
  const withRecord: GameState = {
    ...state,
    history: [...state.history, { type: 'opening', white: w, black: b }],
  };
  return startMoving(withRecord, winner, dice);
}

/** Enter the moving phase, or skip the turn if there is no legal move. */
function startMoving(state: GameState, player: Player, dice: DiceRoll): GameState {
  if (!hasLegalMove(state.board, player, dice)) {
    return {
      ...state,
      turnCount: state.turnCount + 1,
      history: [...state.history, { type: 'move', player, dice, play: [] }],
      phase: { kind: 'to-roll', player: opponent(player) },
    };
  }
  return { ...state, phase: { kind: 'moving', player, dice } };
}

export function roll(state: GameState, player: Player, dice: DiceRoll): GameState {
  const ph = expectPhase(state, 'to-roll');
  if (ph.player !== player) fail('not-your-turn', `it is ${ph.player}'s turn to roll`);
  return startMoving(state, player, dice);
}

/** Determine the result kind for `winner` given the final board. */
export function resultKind(board: Board, winner: Player): ResultKind {
  const loser = opponent(winner);
  if (board.off[loser] > 0) return 'single';
  // Backgammon: loser still has a checker on the bar or in the winner's home board
  // (which is the loser's 19..24).
  if (board.bar[loser] > 0) return 'backgammon';
  for (let rel = 19; rel <= 24; rel++) if (countAt(board, loser, rel) > 0) return 'backgammon';
  return 'gammon';
}

export function play(state: GameState, player: Player, moves: readonly SubMove[]): GameState {
  const ph = expectPhase(state, 'moving');
  if (ph.player !== player) fail('not-your-turn', `it is ${ph.player}'s turn to move`);
  const canonical = findLegalPlay(state.board, player, ph.dice, moves);
  if (!canonical) fail('illegal-play', 'that is not a legal play');
  const board = applyPlay(state.board, player, canonical);
  const history = [
    ...state.history,
    { type: 'move' as const, player, dice: ph.dice, play: canonical },
  ];
  const turnCount = state.turnCount + 1;
  if (board.off[player] === CHECKERS_PER_PLAYER) {
    const result: GameResult = {
      winner: player,
      kind: resultKind(board, player),
      how: 'bearoff',
      cube: state.cube.value,
      points: 0, // filled in by the match layer
    };
    return { ...state, board, history, turnCount, phase: { kind: 'over', result } };
  }
  return {
    ...state,
    board,
    history,
    turnCount,
    phase: { kind: 'to-roll', player: opponent(player) },
  };
}

export function double(state: GameState, player: Player): GameState {
  expectPhase(state, 'to-roll');
  if (!canDouble(state, player)) {
    if (state.crawford) fail('crawford', 'no doubling in the Crawford game');
    fail('cannot-double', `${player} may not double now`);
  }
  return {
    ...state,
    history: [...state.history, { type: 'double', player, value: state.cube.value * 2 }],
    phase: { kind: 'double-offered', by: player },
  };
}

export function take(state: GameState, player: Player): GameState {
  const ph = expectPhase(state, 'double-offered');
  if (opponent(ph.by) !== player)
    fail('not-your-turn', 'only the player offered the cube may take');
  return {
    ...state,
    cube: { value: state.cube.value * 2, owner: player },
    history: [...state.history, { type: 'take', player }],
    phase: { kind: 'to-roll', player: ph.by },
  };
}

export function drop(state: GameState, player: Player): GameState {
  const ph = expectPhase(state, 'double-offered');
  if (opponent(ph.by) !== player)
    fail('not-your-turn', 'only the player offered the cube may drop');
  const result: GameResult = {
    winner: ph.by,
    kind: 'single',
    how: 'drop',
    cube: state.cube.value,
    points: 0,
  };
  return {
    ...state,
    history: [...state.history, { type: 'drop', player }],
    phase: { kind: 'over', result },
  };
}

export function offerResign(state: GameState, player: Player, stakes: ResultKind): GameState {
  const ph = state.phase;
  if (ph.kind === 'over') fail('game-over', 'the game is over');
  if (ph.kind === 'opening') fail('wrong-phase', 'cannot resign before the opening roll');
  if (ph.kind === 'resign-offered') fail('wrong-phase', 'a resignation is already pending');
  return {
    ...state,
    history: [...state.history, { type: 'resign-offer', player, stakes }],
    phase: { kind: 'resign-offered', by: player, stakes, prior: ph },
  };
}

export function acceptResign(state: GameState, player: Player): GameState {
  const ph = expectPhase(state, 'resign-offered');
  if (opponent(ph.by) !== player) fail('not-your-turn', 'only the opponent may accept');
  const result: GameResult = {
    winner: player,
    kind: ph.stakes,
    how: 'resign',
    cube: state.cube.value,
    points: 0,
  };
  return {
    ...state,
    history: [...state.history, { type: 'resign-accept', player }],
    phase: { kind: 'over', result },
  };
}

export function declineResign(state: GameState, player: Player): GameState {
  const ph = expectPhase(state, 'resign-offered');
  if (opponent(ph.by) !== player) fail('not-your-turn', 'only the opponent may decline');
  return {
    ...state,
    history: [...state.history, { type: 'resign-decline', player }],
    phase: ph.prior,
  };
}

// -----------------------------------------------------------------------------------------------
// Free-board mode: a physical board. No turn order, no dice validation; the engine only keeps the
// position consistent (one colour per point) and records what happened.
// -----------------------------------------------------------------------------------------------

const VALID_CUBE_VALUES: ReadonlySet<number> = new Set([1, 2, 4, 8, 16, 32, 64]);

/** Append a record, dropping the oldest `free-move` records beyond the cap. */
function appendFreeRecord(history: TurnRecord[], record: TurnRecord): TurnRecord[] {
  if (record.type !== 'free-move') return [...history, record];
  let freeMoves = 0;
  for (const r of history) if (r.type === 'free-move') freeMoves++;
  if (freeMoves < FREE_MOVE_HISTORY_CAP) return [...history, record];
  let dropped = false;
  const trimmed = history.filter((r) => {
    if (dropped || r.type !== 'free-move') return true;
    dropped = true;
    return false;
  });
  return [...trimmed, record];
}

function checkLocation(value: unknown, what: string): RelPoint {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < OFF || value > BAR) {
    fail('bad-location', `${what} must be a point 1..24, the bar (25) or off (0)`);
  }
  return value;
}

/** Roll the dice on a free board; any player, any time. */
export function freeRoll(state: GameState, player: Player, dice: DiceRoll): GameState {
  expectPhase(state, 'free');
  return {
    ...state,
    turnCount: state.turnCount + 1,
    phase: { kind: 'free', dice: { player, dice } },
    history: appendFreeRecord(state.history, { type: 'free-roll', player, dice }),
  };
}

/**
 * Move one checker of colour `checker` from `from` to `to` (both relative to that colour).
 * Any direction is allowed. A lone opposing checker on `to` is hit; two or more block the move.
 */
export function freeMove(
  state: GameState,
  player: Player,
  checker: Player,
  from: RelPoint,
  to: RelPoint,
): GameState {
  expectPhase(state, 'free');
  if (checker !== 'white' && checker !== 'black')
    fail('bad-checker', 'checker must be white or black');
  checkLocation(from, 'from');
  checkLocation(to, 'to');
  if (from === to) fail('same-location', 'the checker is already there');
  if (countAt(state.board, checker, from) === 0) {
    fail(
      'empty-source',
      `no ${checker} checker at ${from === BAR ? 'the bar' : from === OFF ? 'off' : `point ${from}`}`,
    );
  }
  let hit = false;
  if (to !== BAR && to !== OFF) {
    const opposing = opponentCountAt(state.board, checker, to);
    if (opposing >= 2) fail('blocked', `point ${to} is held by ${opponent(checker)}`);
    hit = opposing === 1;
  }
  const board = cloneBoard(state.board);
  const s = sign(checker);
  if (from === BAR) board.bar[checker] -= 1;
  else if (from === OFF) board.off[checker] -= 1;
  else {
    const i = absIndex(checker, from);
    board.points[i] = (board.points[i] ?? 0) - s;
  }
  if (to === BAR) board.bar[checker] += 1;
  else if (to === OFF) board.off[checker] += 1;
  else {
    const i = absIndex(checker, to);
    if (hit) {
      board.points[i] = 0;
      board.bar[opponent(checker)] += 1;
    }
    board.points[i] = (board.points[i] ?? 0) + s;
  }
  return {
    ...state,
    board,
    history: appendFreeRecord(state.history, { type: 'free-move', player, checker, from, to, hit }),
  };
}

/** Set the cube by hand. Value must be a power of two up to 64; a cube at 1 must be centred. */
export function freeCube(
  state: GameState,
  player: Player,
  value: number,
  owner: CubeOwner,
): GameState {
  expectPhase(state, 'free');
  if (!VALID_CUBE_VALUES.has(value))
    fail('bad-cube', 'cube value must be 1, 2, 4, 8, 16, 32 or 64');
  if (owner !== 'white' && owner !== 'black' && owner !== 'center')
    fail('bad-cube', 'bad cube owner');
  if (value === 1 && owner !== 'center') fail('bad-cube', 'a cube at 1 must be centred');
  return {
    ...state,
    cube: { value, owner },
    history: appendFreeRecord(state.history, { type: 'free-cube', player, value, owner }),
  };
}

/** Put every checker back to the starting position and clear the dice; cube unchanged. */
export function freeReset(state: GameState, player: Player): GameState {
  expectPhase(state, 'free');
  return {
    ...state,
    board: startingBoard(),
    phase: { kind: 'free', dice: null },
    history: appendFreeRecord(state.history, { type: 'free-reset', player }),
  };
}

/** End a free-board game with a manually recorded result. */
export function freeResult(
  state: GameState,
  player: Player,
  winner: Player,
  kind: ResultKind,
): GameState {
  expectPhase(state, 'free');
  if (winner !== 'white' && winner !== 'black') fail('bad-result', 'winner must be white or black');
  if (kind !== 'single' && kind !== 'gammon' && kind !== 'backgammon')
    fail('bad-result', 'bad result kind');
  const result: GameResult = { winner, kind, how: 'recorded', cube: state.cube.value, points: 0 };
  return {
    ...state,
    history: appendFreeRecord(state.history, { type: 'free-result', player, winner, kind }),
    phase: { kind: 'over', result },
  };
}

export type { Play };
