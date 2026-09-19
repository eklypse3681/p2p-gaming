import type { CommandContext, GameDefinition, InitContext } from '@bgf/table';
import type { Card } from './cards.js';
import { isCard } from './cards.js';
import { ofcAutopilot } from './autopilot.js';
import { defaultConfig } from './rules.js';
import { command, init, reduce, view } from './table.js';
import type { TableView } from './table.js';
import type { Action, Command, Placement, TableConfig, TableState } from './types.js';
import { ROWS } from './types.js';

export const OFC_GAME_ID = 'ofc';
const MAX_NOTE = 200;

function isPlacement(v: unknown): v is Placement {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as { card?: unknown; row?: unknown };
  return isCard(p.card) && typeof p.row === 'string' && (ROWS as readonly string[]).includes(p.row);
}

/** Shape-check a raw command from the wire; null refuses it. Rules are checked by `command`. */
export function validateOfcCommand(raw: unknown): Command | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case 'start':
      return { type: 'start' };
    case 'settle':
      return { type: 'settle' };
    case 'settle-request':
      return c.requested === undefined
        ? { type: 'settle-request' }
        : { type: 'settle-request', requested: c.requested === true };
    case 'place': {
      if (!Array.isArray(c.placements) || c.placements.length > 17) return null;
      if (!c.placements.every(isPlacement)) return null;
      const discards = c.discards === undefined ? [] : c.discards;
      if (!Array.isArray(discards) || discards.length > 17 || !discards.every(isCard)) return null;
      return {
        type: 'place',
        placements: (c.placements as Placement[]).map((p) => ({
          card: { rank: p.card.rank, suit: p.card.suit },
          row: p.row,
        })),
        discards: (discards as Card[]).map((d) => ({ rank: d.rank, suit: d.suit })),
      };
    }
    case 'adjust': {
      if (!Number.isInteger(c.seat) || typeof c.points !== 'number' || !Number.isFinite(c.points))
        return null;
      const note = typeof c.note === 'string' ? c.note.slice(0, MAX_NOTE) : '';
      return { type: 'adjust', seat: c.seat as number, points: c.points, note };
    }
    default:
      return null;
  }
}

/**
 * Redact an action for another seat without needing the table state: other seats' dealt cards
 * become counts, and their placements/discards are withheld (their rows are visible in the view
 * anyway, and a face-down Fantasyland hand must not leak through the action log).
 */
export function redactOfcAction(action: Action, viewer: number | null): Action {
  switch (action.type) {
    case 'start-hand':
      return {
        ...action,
        deals: action.deals.map((d) =>
          d.seat === viewer
            ? d
            : ({ seat: d.seat, cards: [], count: d.cards.length } as unknown as {
                seat: number;
                cards: Card[];
              }),
        ),
      };
    case 'deal-next':
      return action.seat === viewer
        ? action
        : ({ ...action, cards: [], count: action.cards.length } as unknown as Action);
    case 'place':
      return action.seat === viewer
        ? action
        : ({
            ...action,
            placements: [],
            discards: [],
            count: action.placements.length + action.discards.length,
          } as unknown as Action);
    default:
      return action;
  }
}

export function ofcSummary(state: TableState): {
  variant: TableConfig['variant'];
  seats: number;
  handNumber: number;
  scores: number[];
  status: TableState['status'];
} {
  return {
    variant: state.config.variant,
    seats: state.config.seats,
    handNumber: state.handNumber,
    scores: state.scores.slice(),
    status: state.status,
  };
}

/** Open Face Chinese Poker on the table core: 2–3 seats, secret deck, per-seat views. */
export const ofcDefinition: GameDefinition<TableState, Action, Command, TableView, TableConfig> = {
  id: OFC_GAME_ID,
  minSeats: 2,
  maxSeats: 3,
  hiddenInformation: true,
  /**
   * Open Face Chinese is played face up, but three things stay hidden: the cards a player has
   * been dealt and not yet placed, Pineapple discards, and a face-down Fantasyland hand. The deck
   * itself is drawn card by card at deal time, so with per-draw or beacon randomness nobody can
   * know a future card; a *playing* host on a seeded table knows the hand's seed.
   */
  trust: {
    hiddenInformation: true,
    hostCanSee: [
      'the three cards another player has been dealt and not yet placed',
      "other players' Pineapple discards",
      'a face-down Fantasyland hand before showdown',
    ],
    notes:
      'The deck is not pre-shuffled: each deal draws from the remaining cards at that moment, so with per-draw or beacon randomness even the host cannot know a future card.',
  },
  normalizeConfig(raw: unknown): TableConfig {
    return defaultConfig((raw ?? {}) as Partial<TableConfig>);
  },
  init(config: TableConfig, ctx: InitContext): TableState {
    // The table decides how many seats exist; the config follows it.
    return init({ ...config, seats: ctx.seats as 2 | 3 });
  },
  validateCommand: validateOfcCommand,
  command(state, seat, cmd, ctx: CommandContext): Action[] {
    return command(state, seat, cmd, ctx.rng, () => ctx.now);
  },
  reduce,
  view(state, seat) {
    // A spectator (null) is a viewer that owns no seat: everything hidden is withheld.
    return view(state, seat ?? -1);
  },
  viewAction: redactOfcAction,
  isOver(state) {
    return state.status === 'over';
  },
  summary: ofcSummary,
  /** A non-playing dealer runs the hand and the ledger; it never places cards. */
  dealerCommands: ['start', 'settle', 'adjust'],
  /** Unattended play: deals when the room is ready, settles on consensus (see `ofcAutopilot`). */
  autopilot: ofcAutopilot,
  /** Everyone's "ready" is spent when a hand is dealt. */
  resetsReadiness(action) {
    return action.type === 'start-hand';
  },
  /** Seeded randomness: every hand is one segment, revealed at showdown. */
  segmentBoundary(_state, cmd) {
    return cmd.type === 'start';
  },
  segmentComplete(state) {
    return state.hand !== null && state.hand.phase !== 'setting';
  },
};
