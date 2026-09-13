import type { ClientMessage, PlayerProfile } from '@bgf/protocol';
import { looksLikePublicKey } from '@bgf/protocol';
import type { CubeOwner, Player, ResultKind, SubMove } from '@bgf/engine';

/**
 * Defensive validation of inbound client messages. The server must never throw on malformed
 * input, so every field is checked before the message is acted upon.
 */

const RESULT_KINDS: ReadonlySet<string> = new Set(['single', 'gammon', 'backgammon']);
const PLAYERS: ReadonlySet<string> = new Set(['white', 'black']);
const CUBE_OWNERS: ReadonlySet<string> = new Set(['white', 'black', 'center']);
const CUBE_VALUES: ReadonlySet<number> = new Set([1, 2, 4, 8, 16, 32, 64]);

export const MAX_CHAT_LENGTH = 500;
export const MAX_NAME_LENGTH = 40;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

export function validateProfile(v: unknown): PlayerProfile | null {
  if (!isRecord(v)) return null;
  const { id, name, avatar, publicKey } = v;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  if (trimmed.length === 0) return null;
  const profile: PlayerProfile = { id, name: trimmed };
  if (typeof avatar === 'string' && avatar.length > 0 && avatar.length <= 16)
    profile.avatar = avatar;
  if (publicKey !== undefined) {
    if (!looksLikePublicKey(publicKey)) return null;
    profile.publicKey = publicKey;
  }
  return profile;
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

export type ValidationResult = { ok: true; message: ClientMessage } | { ok: false; reason: string };

/** Returns a sanitised, fully-typed client message or a reason it was rejected. */
export function validateClientMessage(raw: unknown): ValidationResult {
  if (!isRecord(raw) || typeof raw.type !== 'string')
    return { ok: false, reason: 'not an object with a type' };
  switch (raw.type) {
    case 'hello': {
      const profile = validateProfile(raw.profile);
      if (!profile) return { ok: false, reason: 'invalid profile' };
      if (!isInt(raw.protocol)) return { ok: false, reason: 'missing protocol version' };
      const msg: ClientMessage = { type: 'hello', protocol: raw.protocol, profile };
      if (raw.snapshot !== undefined) {
        if (
          !isRecord(raw.snapshot) ||
          typeof raw.snapshot.id !== 'string' ||
          !isInt(raw.snapshot.seq)
        ) {
          return { ok: false, reason: 'invalid snapshot' };
        }
        // Deeper verification happens by replaying the action log in the server.
        msg.snapshot = raw.snapshot as unknown as NonNullable<typeof msg.snapshot>;
      }
      return { ok: true, message: msg };
    }
    case 'auth': {
      if (typeof raw.signature !== 'string' || raw.signature.length === 0 || raw.signature.length > 512)
        return { ok: false, reason: 'invalid signature' };
      return { ok: true, message: { type: 'auth', signature: raw.signature } };
    }
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
    case 'bye':
      return { ok: true, message: { type: raw.type } };
    case 'free-move': {
      const { checker, from, to } = raw;
      if (typeof checker !== 'string' || !PLAYERS.has(checker))
        return { ok: false, reason: 'invalid checker' };
      if (!isInt(from) || from < 0 || from > 25) return { ok: false, reason: 'invalid from' };
      if (!isInt(to) || to < 0 || to > 25) return { ok: false, reason: 'invalid to' };
      return { ok: true, message: { type: 'free-move', checker: checker as Player, from, to } };
    }
    case 'free-cube': {
      const { value, owner } = raw;
      if (!isInt(value) || !CUBE_VALUES.has(value))
        return { ok: false, reason: 'invalid cube value' };
      if (typeof owner !== 'string' || !CUBE_OWNERS.has(owner))
        return { ok: false, reason: 'invalid cube owner' };
      return { ok: true, message: { type: 'free-cube', value, owner: owner as CubeOwner } };
    }
    case 'free-result': {
      const { winner, kind } = raw;
      if (typeof winner !== 'string' || !PLAYERS.has(winner))
        return { ok: false, reason: 'invalid winner' };
      if (typeof kind !== 'string' || !RESULT_KINDS.has(kind))
        return { ok: false, reason: 'invalid result kind' };
      return {
        ok: true,
        message: { type: 'free-result', winner: winner as Player, kind: kind as ResultKind },
      };
    }
    case 'play': {
      const play = validatePlay(raw.play);
      if (!play) return { ok: false, reason: 'invalid play' };
      return { ok: true, message: { type: 'play', play } };
    }
    case 'preview': {
      const play = validatePlay(raw.play);
      if (!play) return { ok: false, reason: 'invalid preview' };
      return { ok: true, message: { type: 'preview', play } };
    }
    case 'offer-resign': {
      if (typeof raw.stakes !== 'string' || !RESULT_KINDS.has(raw.stakes)) {
        return { ok: false, reason: 'invalid stakes' };
      }
      return { ok: true, message: { type: 'offer-resign', stakes: raw.stakes as ResultKind } };
    }
    case 'chat': {
      if (typeof raw.text !== 'string') return { ok: false, reason: 'invalid chat' };
      const text = raw.text.trim().slice(0, MAX_CHAT_LENGTH);
      if (text.length === 0) return { ok: false, reason: 'empty chat' };
      return { ok: true, message: { type: 'chat', text } };
    }
    case 'ping': {
      if (typeof raw.t !== 'number' || !Number.isFinite(raw.t))
        return { ok: false, reason: 'invalid ping' };
      return { ok: true, message: { type: 'ping', t: raw.t } };
    }
    default:
      return { ok: false, reason: `unknown message type ${raw.type}` };
  }
}
