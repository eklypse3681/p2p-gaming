import type {
  Action,
  GameResult,
  GameState,
  MatchConfig,
  MatchState,
  Player,
  ResultKind,
  RulesMode,
} from './types.js';
import { RuleError } from './types.js';
import * as G from './game.js';

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  length: 5,
  crawford: true,
  jacoby: true,
  rules: 'enforced',
};

/** Rule enforcement mode of a match config (defaults to 'enforced' for older snapshots). */
export function rulesMode(config: MatchConfig): RulesMode {
  return config.rules ?? 'enforced';
}

export function isFreeMode(config: MatchConfig): boolean {
  return rulesMode(config) === 'free';
}

const FREE_ACTIONS: ReadonlySet<Action['type']> = new Set([
  'free-roll',
  'free-move',
  'free-cube',
  'free-reset',
  'free-result',
]);
const ENFORCED_ONLY_ACTIONS: ReadonlySet<Action['type']> = new Set([
  'opening-roll',
  'roll',
  'play',
  'double',
  'take',
  'drop',
]);

export function newMatch(config: Partial<MatchConfig> = {}): MatchState {
  return {
    config: { ...DEFAULT_MATCH_CONFIG, ...config },
    score: { white: 0, black: 0 },
    gameNumber: 1,
    crawfordDone: false,
    game: null,
    games: [],
    winner: null,
  };
}

export function isMoneyPlay(config: MatchConfig): boolean {
  return config.length <= 0;
}

/** Points needed by `player` to win the match (Infinity in money play). */
export function pointsAway(match: MatchState, player: Player): number {
  if (isMoneyPlay(match.config)) return Infinity;
  return Math.max(0, match.config.length - match.score[player]);
}

function multiplier(kind: ResultKind): number {
  return kind === 'single' ? 1 : kind === 'gammon' ? 2 : 3;
}

/** Points a result is worth under this match's rules. */
export function scoreResult(match: MatchState, game: GameState, result: GameResult): number {
  let kind = result.kind;
  if (isMoneyPlay(match.config) && match.config.jacoby && game.cube.owner === 'center') {
    kind = 'single';
  }
  return multiplier(kind) * result.cube;
}

function nextGameIsCrawford(match: MatchState): boolean {
  if (isMoneyPlay(match.config) || !match.config.crawford || match.crawfordDone) return false;
  const L = match.config.length;
  return match.score.white === L - 1 || match.score.black === L - 1;
}

export function startGame(match: MatchState): MatchState {
  if (match.winner) throw new RuleError('match-over', 'the match is over');
  if (match.game && match.game.phase.kind !== 'over') {
    throw new RuleError('game-in-progress', 'a game is already in progress');
  }
  const crawford = nextGameIsCrawford(match);
  return {
    ...match,
    crawfordDone: match.crawfordDone || crawford,
    game: G.newGame({ crawford, free: isFreeMode(match.config) }),
  };
}

/** If the current game just ended, fold its result into the match score. */
function settle(match: MatchState, game: GameState): MatchState {
  if (game.phase.kind !== 'over') return { ...match, game };
  const result = game.phase.result;
  if (result.points > 0) return { ...match, game }; // already settled
  const points = scoreResult(match, game, result);
  const settled: GameResult = { ...result, points };
  const settledGame: GameState = { ...game, phase: { kind: 'over', result: settled } };
  const score = { ...match.score, [result.winner]: match.score[result.winner] + points };
  const games = [
    ...match.games,
    {
      number: match.gameNumber,
      result: settled,
      scoreAfter: score,
      crawford: game.crawford,
      turns: game.history,
    },
  ];
  const winner =
    !isMoneyPlay(match.config) && score[result.winner] >= match.config.length
      ? result.winner
      : null;
  return {
    ...match,
    game: settledGame,
    score,
    games,
    winner,
    gameNumber: match.gameNumber + 1,
  };
}

function requireGame(match: MatchState): GameState {
  if (!match.game) throw new RuleError('no-game', 'no game in progress');
  return match.game;
}

/** The single reducer used by the server; deterministic given the action log. */
export function applyAction(match: MatchState, action: Action): MatchState {
  const free = isFreeMode(match.config);
  if (!free && FREE_ACTIONS.has(action.type)) {
    throw new RuleError('free-mode', 'only available on a free board');
  }
  if (free && ENFORCED_ONLY_ACTIONS.has(action.type)) {
    throw new RuleError('wrong-phase', 'dice and cube actions are not available on a free board');
  }
  switch (action.type) {
    case 'start-game':
      return startGame(match);
    case 'opening-roll':
      return settle(match, G.openingRoll(requireGame(match), action.player, action.die));
    case 'roll':
      return settle(match, G.roll(requireGame(match), action.player, action.dice));
    case 'play':
      return settle(match, G.play(requireGame(match), action.player, action.play));
    case 'double':
      return settle(match, G.double(requireGame(match), action.player));
    case 'take':
      return settle(match, G.take(requireGame(match), action.player));
    case 'drop':
      return settle(match, G.drop(requireGame(match), action.player));
    case 'offer-resign':
      return settle(match, G.offerResign(requireGame(match), action.player, action.stakes));
    case 'accept-resign':
      return settle(match, G.acceptResign(requireGame(match), action.player));
    case 'decline-resign':
      return settle(match, G.declineResign(requireGame(match), action.player));
    case 'free-roll':
      return settle(match, G.freeRoll(requireGame(match), action.player, action.dice));
    case 'free-move':
      return settle(
        match,
        G.freeMove(requireGame(match), action.player, action.checker, action.from, action.to),
      );
    case 'free-cube':
      return settle(
        match,
        G.freeCube(requireGame(match), action.player, action.value, action.owner),
      );
    case 'free-reset':
      return settle(match, G.freeReset(requireGame(match), action.player));
    case 'free-result':
      return settle(
        match,
        G.freeResult(requireGame(match), action.player, action.winner, action.kind),
      );
  }
}

/** Rebuild a match from its action log. Throws if the log is inconsistent. */
export function replay(config: Partial<MatchConfig>, actions: readonly Action[]): MatchState {
  let m = newMatch(config);
  for (const a of actions) m = applyAction(m, a);
  return m;
}
