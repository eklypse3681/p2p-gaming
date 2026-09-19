import type { Action, MatchConfig, MatchState, Player } from '@bgf/engine';
import { applyAction, isFreeMode, newMatch } from '@bgf/engine';
import type { CommandContext, GameDefinition, Rng } from '@bgf/table';
import { CommandError } from '@bgf/table';
import { validateCommand, validatePlay } from './validate.js';
import type { BackgammonCommand } from './validate.js';
import { BACKGAMMON_GAME_ID, seatPlayer } from './snapshot.js';

export type { BackgammonCommand };

function rollDie(rng: Rng): 1 | 2 | 3 | 4 | 5 | 6 {
  return (rng.int(6) + 1) as 1 | 2 | 3 | 4 | 5 | 6;
}

function rollDice(rng: Rng): [1 | 2 | 3 | 4 | 5 | 6, 1 | 2 | 3 | 4 | 5 | 6] {
  return [rollDie(rng), rollDie(rng)];
}

/** Backgammon on the table core: two seats, no hidden information, dice drawn from the rng. */
export const backgammonDefinition: GameDefinition<
  MatchState,
  Action,
  BackgammonCommand,
  MatchState,
  MatchConfig
> = {
  id: BACKGAMMON_GAME_ID,
  minSeats: 2,
  maxSeats: 2,
  hiddenInformation: false,
  /** Everything in backgammon is on the board; the host holds nothing the guest cannot see. */
  trust: { hiddenInformation: false, hostCanSee: [] },
  normalizeConfig(config: unknown): MatchConfig {
    return newMatch((config ?? {}) as Partial<MatchConfig>).config;
  },
  init(config) {
    return newMatch(config);
  },
  validateCommand,
  validatePreview(raw) {
    return validatePlay(raw);
  },
  command(match, seat, command, ctx: CommandContext): Action {
    const player: Player = seatPlayer(seat);
    const game = match.game;
    switch (command.type) {
      case 'start-game':
        return { type: 'start-game' };
      case 'opening-roll': {
        if (!game || game.phase.kind !== 'opening')
          throw new CommandError('wrong-phase', 'not in the opening roll');
        if (game.phase.rolls[player] !== undefined)
          throw new CommandError('already-rolled', 'you already rolled');
        return { type: 'opening-roll', player, die: rollDie(ctx.rng) };
      }
      case 'roll': {
        if (!game || game.phase.kind !== 'to-roll')
          throw new CommandError('wrong-phase', 'not waiting for a roll');
        if (game.phase.player !== player)
          throw new CommandError('not-your-turn', 'it is not your turn to roll');
        return { type: 'roll', player, dice: rollDice(ctx.rng) };
      }
      case 'play':
        return { type: 'play', player, play: command.play };
      case 'double':
        return { type: 'double', player };
      case 'take':
        return { type: 'take', player };
      case 'drop':
        return { type: 'drop', player };
      case 'offer-resign':
        return { type: 'offer-resign', player, stakes: command.stakes };
      case 'accept-resign':
        return { type: 'accept-resign', player };
      case 'decline-resign':
        return { type: 'decline-resign', player };
      case 'free-roll': {
        if (!isFreeMode(match.config))
          throw new CommandError('free-mode', 'only available on a free board');
        if (!game || game.phase.kind !== 'free')
          throw new CommandError('wrong-phase', 'no free board in play');
        return { type: 'free-roll', player, dice: rollDice(ctx.rng) };
      }
      case 'free-move':
        return {
          type: 'free-move',
          player,
          checker: command.checker,
          from: command.from,
          to: command.to,
        };
      case 'free-cube':
        return { type: 'free-cube', player, value: command.value, owner: command.owner };
      case 'free-reset':
        return { type: 'free-reset', player };
      case 'free-result':
        return { type: 'free-result', player, winner: command.winner, kind: command.kind };
    }
  },
  reduce(match, action) {
    return applyAction(match, action); // throws RuleError (coded) on an illegal action
  },
  view(match) {
    return match;
  },
  /** Seeded randomness: one game is one segment (committed at start, revealed when it ends). */
  segmentBoundary(_match, command) {
    return command.type === 'start-game';
  },
  segmentComplete(match) {
    return match.game?.phase.kind === 'over';
  },
  isOver(match) {
    return match.winner !== null;
  },
  summary(match) {
    return { score: match.score, gameNumber: match.gameNumber, winner: match.winner };
  },
  /** A dealer (or the autopilot) may start games; everything else needs a seat. */
  dealerCommands: ['start-game'],
  /** Everyone's "ready" is spent when a game starts. */
  resetsReadiness(action) {
    return action.type === 'start-game';
  },
  /**
   * Unattended play: the first game starts once both seats are taken and present; after a game
   * is over the next one starts when both players are ready. A finished match does nothing.
   */
  autopilot(match, ctx) {
    if (match.winner !== null) return null;
    const room = ctx.seatsFilled.every(Boolean) && ctx.present.every(Boolean) && ctx.dealerPresent;
    if (!room || ctx.seatsFilled.length < 2) return null;
    if (match.game === null) {
      return {
        command: { type: 'start-game' },
        reason: 'both players are here: starting the game',
      };
    }
    if (match.game.phase.kind !== 'over') return null;
    if (ctx.ready.length >= 2 && ctx.ready.slice(0, 2).every(Boolean)) {
      return { command: { type: 'start-game' }, reason: 'both players are ready: next game' };
    }
    return null;
  },
};
