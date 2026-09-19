import type { CubeOwner, Play, Player, RelPoint, ResultKind, SubMove } from '@bgf/engine';
import type { PlayerProfile, TableClientMessage } from '@bgf/protocol';
import {
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  isInt,
  isRecord,
  validateProfile as validateTableProfile,
  validateTableMessage,
} from '@bgf/table';

/**
 * Defensive validation of backgammon commands. The table core validates the envelope
 * (hello/auth/chat/ping/bye/command/preview); everything inside `command` is checked here
 * before the definition acts on it, so the server never throws on malformed input.
 */

export { MAX_CHAT_LENGTH, MAX_NAME_LENGTH };

/** A backgammon command as sent inside a `command` envelope. */
export type BackgammonCommand =
  | { type: 'start-game' }
  | { type: 'opening-roll' }
  | { type: 'roll' }
  | { type: 'play'; play: Play }
  | { type: 'double' }
  | { type: 'take' }
  | { type: 'drop' }
  | { type: 'offer-resign'; stakes: ResultKind }
  | { type: 'accept-resign' }
  | { type: 'decline-resign' }
  | { type: 'free-roll' }
  | { type: 'free-move'; checker: Player; from: RelPoint; to: RelPoint }
  | { type: 'free-cube'; value: number; owner: CubeOwner }
  | { type: 'free-reset' }
  | { type: 'free-result'; winner: Player; kind: ResultKind };

const RESULT_KINDS: ReadonlySet<string> = new Set(['single', 'gammon', 'backgammon']);
const PLAYERS: ReadonlySet<string> = new Set(['white', 'black']);
const CUBE_OWNERS: ReadonlySet<string> = new Set(['white', 'black', 'center']);
const CUBE_VALUES: ReadonlySet<number> = new Set([1, 2, 4, 8, 16, 32, 64]);

export function validateProfile(v: unknown): PlayerProfile | null {
  return validateTableProfile(v);
}

export function validateSubMove(v: unknown): SubMove | null {
  if (!isRecord(v)) return null;
  const { from, to, die } = v;
  if (!isInt(from) || from < 1 || from > 25) return null;
  if (!isInt(to) || to < 0 || to > 24) return null;
  if (!isInt(die) || die < 1 || die > 6) return null;
  return { from, to, die: die as SubMove['die'], hit: v.hit === true };
}

export function validatePlay(v: unknown): SubMove[] | null {
  if (!Array.isArray(v) || v.length > 4) return null;
  const out: SubMove[] = [];
  for (const m of v) {
    const sm = validateSubMove(m);
    if (!sm) return null;
    out.push(sm);
  }
  return out;
}

/** Returns a sanitised, fully-typed backgammon command or null. */
export function validateCommand(raw: unknown): BackgammonCommand | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'start-game':
    case 'opening-roll':
    case 'roll':
    case 'double':
    case 'take':
    case 'drop':
    case 'accept-resign':
    case 'decline-resign':
    case 'free-roll':
    case 'free-reset':
      return { type: raw.type };
    case 'free-move': {
      const { checker, from, to } = raw;
      if (typeof checker !== 'string' || !PLAYERS.has(checker)) return null;
      if (!isInt(from) || from < 0 || from > 25) return null;
      if (!isInt(to) || to < 0 || to > 25) return null;
      return { type: 'free-move', checker: checker as Player, from, to };
    }
    case 'free-cube': {
      const { value, owner } = raw;
      if (!isInt(value) || !CUBE_VALUES.has(value)) return null;
      if (typeof owner !== 'string' || !CUBE_OWNERS.has(owner)) return null;
      return { type: 'free-cube', value, owner: owner as CubeOwner };
    }
    case 'free-result': {
      const { winner, kind } = raw;
      if (typeof winner !== 'string' || !PLAYERS.has(winner)) return null;
      if (typeof kind !== 'string' || !RESULT_KINDS.has(kind)) return null;
      return { type: 'free-result', winner: winner as Player, kind: kind as ResultKind };
    }
    case 'play': {
      const play = validatePlay(raw.play);
      if (!play) return null;
      return { type: 'play', play };
    }
    case 'offer-resign': {
      if (typeof raw.stakes !== 'string' || !RESULT_KINDS.has(raw.stakes)) return null;
      return { type: 'offer-resign', stakes: raw.stakes as ResultKind };
    }
    default:
      return null;
  }
}

export type ValidationResult =
  | {
      ok: true;
      message: TableClientMessage | BackgammonCommand | { type: 'preview'; play: Play };
    }
  | { ok: false; reason: string };

/**
 * Validates anything a backgammon client might send, either a table envelope message or a bare
 * backgammon command (the pre-envelope shape). Kept for tests and tooling; the server itself
 * validates the envelope in the table core and the command in `validateCommand`.
 */
export function validateClientMessage(raw: unknown): ValidationResult {
  if (!isRecord(raw) || typeof raw.type !== 'string')
    return { ok: false, reason: 'not an object with a type' };
  if (raw.type === 'preview') {
    const play = validatePlay(raw.play ?? raw.payload);
    if (!play) return { ok: false, reason: 'invalid preview' };
    return { ok: true, message: { type: 'preview', play } };
  }
  const table = validateTableMessage(raw);
  if (table.ok) return table;
  const command = validateCommand(raw);
  if (command) return { ok: true, message: command };
  return table;
}
