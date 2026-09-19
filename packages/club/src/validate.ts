import type { ClubCallMethod, ClubClientMessage, PlayerProfile } from '@bgf/protocol';
import { isRecord, validateProfile } from '@bgf/table';

const CALL_METHODS = new Set<string>([
  'info',
  'lobby',
  'sit',
  'leave',
  'settle',
  'statement',
  'transfer',
  'requestChips',
  'chat',
  'queue',
  'unqueue',
]);

export const MAX_CLUB_CHAT = 500;
export const MAX_NOTE = 200;

export type ClubValidation =
  { ok: true; message: ClubClientMessage } | { ok: false; reason: string };

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Shape-check an inbound club message; hostile input yields a reason, never a throw. */
export function validateClubMessage(raw: unknown): ClubValidation {
  if (!isRecord(raw) || typeof raw.type !== 'string') return { ok: false, reason: 'not a message' };
  switch (raw.type) {
    case 'hello': {
      if (!isInt(raw.protocol)) return { ok: false, reason: 'hello.protocol' };
      const profile: PlayerProfile | null = validateProfile(raw.profile);
      if (!profile) return { ok: false, reason: 'hello.profile' };
      if (
        raw.invite !== undefined &&
        (typeof raw.invite !== 'string' || raw.invite.length > 4096)
      ) {
        return { ok: false, reason: 'hello.invite' };
      }
      if (raw.spec !== undefined && !isInt(raw.spec)) return { ok: false, reason: 'hello.spec' };
      return {
        ok: true,
        message: {
          type: 'hello',
          protocol: raw.protocol,
          profile,
          ...(raw.invite ? { invite: raw.invite } : {}),
          ...(raw.spec !== undefined ? { spec: raw.spec } : {}),
        },
      };
    }
    case 'auth':
      if (typeof raw.signature !== 'string' || raw.signature.length > 256)
        return { ok: false, reason: 'auth.signature' };
      return { ok: true, message: { type: 'auth', signature: raw.signature } };
    case 'lobby':
    case 'statement':
    case 'bye':
      return { ok: true, message: { type: raw.type } };
    case 'sit': {
      if (raw.tableId !== undefined && typeof raw.tableId !== 'string')
        return { ok: false, reason: 'sit.tableId' };
      if (raw.templateId !== undefined && typeof raw.templateId !== 'string')
        return { ok: false, reason: 'sit.templateId' };
      if (raw.buyIn !== undefined && !(isInt(raw.buyIn) && raw.buyIn >= 0))
        return { ok: false, reason: 'sit.buyIn' };
      if (!raw.tableId && !raw.templateId)
        return { ok: false, reason: 'sit needs tableId or templateId' };
      return {
        ok: true,
        message: {
          type: 'sit',
          ...(raw.tableId ? { tableId: raw.tableId } : {}),
          ...(raw.templateId ? { templateId: raw.templateId } : {}),
          ...(raw.buyIn !== undefined ? { buyIn: raw.buyIn } : {}),
        },
      };
    }
    case 'leave':
      if (typeof raw.tableId !== 'string') return { ok: false, reason: 'leave.tableId' };
      return { ok: true, message: { type: 'leave', tableId: raw.tableId } };
    case 'transfer':
      if (typeof raw.to !== 'string' || !isInt(raw.amount) || raw.amount <= 0)
        return { ok: false, reason: 'transfer' };
      if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > MAX_NOTE))
        return { ok: false, reason: 'transfer.note' };
      return {
        ok: true,
        message: {
          type: 'transfer',
          to: raw.to,
          amount: raw.amount,
          ...(raw.note ? { note: raw.note } : {}),
        },
      };
    case 'request-chips':
      if (!isInt(raw.amount) || raw.amount <= 0)
        return { ok: false, reason: 'request-chips.amount' };
      if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > MAX_NOTE))
        return { ok: false, reason: 'request-chips.note' };
      return {
        ok: true,
        message: {
          type: 'request-chips',
          amount: raw.amount,
          ...(raw.note ? { note: raw.note } : {}),
        },
      };
    case 'chat':
      if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > MAX_CLUB_CHAT)
        return { ok: false, reason: 'chat.text' };
      return { ok: true, message: { type: 'chat', text: raw.text } };
    case 'ping':
      if (typeof raw.t !== 'number') return { ok: false, reason: 'ping.t' };
      return { ok: true, message: { type: 'ping', t: raw.t } };
    case 'call': {
      if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 128)
        return { ok: false, reason: 'call.id' };
      if (typeof raw.method !== 'string' || !CALL_METHODS.has(raw.method))
        return { ok: false, reason: 'call.method' };
      if (raw.params !== undefined && !isRecord(raw.params))
        return { ok: false, reason: 'call.params' };
      return {
        ok: true,
        message: {
          type: 'call',
          id: raw.id,
          method: raw.method as ClubCallMethod,
          ...(raw.params !== undefined ? { params: raw.params } : {}),
        },
      };
    }
    default:
      return { ok: false, reason: `unknown message type ${raw.type}` };
  }
}
