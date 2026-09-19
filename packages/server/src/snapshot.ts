import type { Action, MatchConfig, MatchState, Player } from '@bgf/engine';
import { newMatch } from '@bgf/engine';
import type {
  ChatMessage,
  HomeSide,
  MatchSnapshot,
  RandomnessMode,
  TableChat,
  TableSnapshot,
} from '@bgf/protocol';
import { DEFAULT_HOME_SIDE } from '@bgf/protocol';

/**
 * Backgammon's seats on a table: 0 = white, 1 = black. The web app and the engine speak in
 * colours; the table core speaks in seat indexes. These helpers convert both ways, including
 * the persisted `MatchSnapshot` (colour-keyed, what the web app stores and syncs) and the
 * generic `TableSnapshot` (what travels on the wire and what the table core verifies).
 */

export const BACKGAMMON_GAME_ID = 'backgammon';

export type BackgammonTableSnapshot = TableSnapshot<MatchState, Action, MatchConfig>;

export function seatIndex(player: Player): number {
  return player === 'white' ? 0 : 1;
}

export function seatPlayer(seat: number): Player {
  return seat === 0 ? 'white' : 'black';
}

export function chatToTable(m: ChatMessage): TableChat {
  return { seat: seatIndex(m.seat), text: m.text, at: m.at };
}

export function chatFromTable(m: TableChat): ChatMessage {
  return { seat: seatPlayer(m.seat), text: m.text, at: m.at };
}

/** Persisted colour-keyed match → generic table snapshot. */
export function toTableSnapshot(m: MatchSnapshot): BackgammonTableSnapshot {
  const custom = m.initialMatch !== undefined;
  return {
    id: m.id,
    code: m.code,
    seq: m.seq,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    gameId: BACKGAMMON_GAME_ID,
    config: m.config,
    seats: [m.players?.white ?? null, m.players?.black ?? null],
    hostSeat: m.dealer ? null : seatIndex(m.hostSeat),
    ...(m.dealer ? { dealer: m.dealer } : {}),
    options: {
      homeSide: m.homeSide ?? DEFAULT_HOME_SIDE,
      ...(custom ? { customStart: true } : {}),
      ...(m.randomness ? { randomness: m.randomness } : {}),
      ...(m.autopilot !== undefined ? { autopilot: m.autopilot } : {}),
    },
    ...(m.ready ? { ready: [m.ready.white, m.ready.black] } : {}),
    initialState: m.initialMatch ?? newMatch(m.config),
    actions: m.actions,
    state: m.match,
    chat: (m.chat ?? []).map(chatToTable),
    ...(m.actionMeta ? { actionMeta: m.actionMeta } : {}),
    ...(m.entropyAudit ? { entropyAudit: m.entropyAudit } : {}),
  };
}

/** Generic table snapshot → the colour-keyed shape the web app persists. */
export function toMatchSnapshot(t: BackgammonTableSnapshot): MatchSnapshot {
  const homeSide = (t.options?.homeSide as HomeSide | undefined) ?? DEFAULT_HOME_SIDE;
  const out: MatchSnapshot = {
    id: t.id,
    code: t.code,
    seq: t.seq,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    config: t.config,
    players: { white: t.seats[0] ?? null, black: t.seats[1] ?? null },
    // A dealer-hosted backgammon table has no host seat; the colour-keyed shape defaults to white.
    hostSeat: seatPlayer(t.hostSeat ?? 0),
    homeSide,
    actions: t.actions,
    match: t.state,
    chat: (t.chat ?? []).map(chatFromTable),
  };
  if (t.dealer) out.dealer = t.dealer;
  if (t.options?.customStart) out.initialMatch = t.initialState;
  const randomness = t.options?.randomness as { provider?: unknown; mode?: unknown } | undefined;
  if (randomness && typeof randomness.provider === 'string') {
    out.randomness = { provider: randomness.provider };
    if (typeof randomness.mode === 'string')
      out.randomness.mode = randomness.mode as RandomnessMode;
  }
  if (t.actionMeta) out.actionMeta = t.actionMeta;
  if (t.entropyAudit) out.entropyAudit = t.entropyAudit;
  if (typeof t.options?.autopilot === 'boolean') out.autopilot = t.options.autopilot;
  if (t.ready) out.ready = { white: t.ready[0] ?? false, black: t.ready[1] ?? false };
  return out;
}
