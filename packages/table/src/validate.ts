import type { PlayerProfile, TableClientMessage } from '@bgf/protocol';
import { looksLikePublicKey } from '@bgf/protocol';

export const MAX_CHAT_LENGTH = 500;
export const MAX_NAME_LENGTH = 40;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Sanitise a profile from the wire: trims and caps the name, keeps only known fields. */
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

export type TableValidation =
  { ok: true; message: TableClientMessage } | { ok: false; reason: string };

/**
 * Shape-checks the table-level envelope. Game commands and previews are passed through as
 * opaque payloads for the game definition to validate.
 */
export function validateTableMessage(raw: unknown): TableValidation {
  if (!isRecord(raw) || typeof raw.type !== 'string')
    return { ok: false, reason: 'not an object with a type' };
  switch (raw.type) {
    case 'hello': {
      const profile = validateProfile(raw.profile);
      if (!profile) return { ok: false, reason: 'invalid profile' };
      if (!isInt(raw.protocol)) return { ok: false, reason: 'missing protocol version' };
      const msg: TableClientMessage = { type: 'hello', protocol: raw.protocol, profile };
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
      if (
        typeof raw.signature !== 'string' ||
        raw.signature.length === 0 ||
        raw.signature.length > 512
      )
        return { ok: false, reason: 'invalid signature' };
      return { ok: true, message: { type: 'auth', signature: raw.signature } };
    }
    case 'command':
      if (raw.command === undefined) return { ok: false, reason: 'missing command' };
      return { ok: true, message: { type: 'command', command: raw.command } };
    case 'preview':
      return { ok: true, message: { type: 'preview', payload: raw.payload } };
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
    case 'ready':
      if (typeof raw.ready !== 'boolean') return { ok: false, reason: 'ready must be a boolean' };
      return { ok: true, message: { type: 'ready', ready: raw.ready } };
    case 'bye':
      return { ok: true, message: { type: 'bye' } };
    default:
      return { ok: false, reason: `unknown message type ${raw.type}` };
  }
}
