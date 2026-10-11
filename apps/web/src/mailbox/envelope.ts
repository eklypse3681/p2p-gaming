import type { TableClientMessage } from '@bgf/protocol';

/**
 * What players mail each other, sealed with the match key (`crypto.ts`).
 *
 *  - `view`: the table's position as the recipient may see it (a backgammon match in full, an
 *    OFC table redacted for their seat), from whichever device hosts it. `live` says that device
 *    is hosting right now, so the recipient can connect instead of playing by mail.
 *  - `cmd`: a move (or readiness, or chat) from a player whose host is away, for the host's
 *    device to apply (OFC: only the host holds the cards).
 */
export type Envelope =
  | {
      v: 1;
      t: 'view';
      game: string;
      snapshot: { id: string; seq: number } & Record<string, unknown>;
      live?: boolean;
      /** Problems with this player's own mailed moves, as the table reported them. */
      errors?: { code: string; message: string }[];
    }
  | { v: 1; t: 'cmd'; game: string; seat: number; msg: TableClientMessage };

export function isEnvelope(v: unknown): v is Envelope {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  if (e.v !== 1 || typeof e.game !== 'string') return false;
  if (e.t === 'view') {
    const s = e.snapshot as Record<string, unknown> | undefined;
    return !!s && typeof s.id === 'string' && typeof s.seq === 'number';
  }
  if (e.t === 'cmd') {
    const m = e.msg as Record<string, unknown> | undefined;
    return typeof e.seat === 'number' && !!m && typeof m.type === 'string';
  }
  return false;
}
