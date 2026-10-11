import { sealCompact } from './crypto';
import type { Envelope } from './envelope';

type View = Extract<Envelope, { t: 'view' }>;
type Delta = Extract<Envelope, { t: 'delta' }>;
type Snap = View['snapshot'];

/** The most a push's own message may take (the rest of the 4 KB goes to ids and keys). */
export const MAX_PUSH_MESSAGE = 3600;

/** Kept out of a delta: the move log (only the new moves go) and the audit trail (it follows). */
const HEAVY = ['actions', 'actionMeta', 'entropyAudit'] as const;

/** Marks a saved copy built from a delta: the next whole copy from the mailbox replaces it. */
export const FROM_PUSH = 'fromPush';

const actionsOf = (s: Snap) => (Array.isArray(s.actions) ? (s.actions as unknown[]) : []);

/** The change from `prev` (the position last mailed) to `view`, as a push carries it. */
export function deltaOf(prev: Snap, view: View): Delta | null {
  const before = actionsOf(prev);
  const after = actionsOf(view.snapshot);
  if (after.length < before.length) return null;
  const snapshot = { ...view.snapshot } as Snap;
  for (const k of HEAVY) delete (snapshot as Record<string, unknown>)[k];
  return {
    v: 1,
    t: 'delta',
    game: view.game,
    base: { seq: prev.seq, actions: before.length },
    snapshot,
    actions: after.slice(before.length),
    ...(view.live ? { live: true } : {}),
    ...(view.errors ? { errors: view.errors } : {}),
  };
}

/** Rebuild the position from a saved copy and a delta; null when the copy is not its base. */
export function applyDelta(saved: Snap, d: Delta): Snap | null {
  const actions = actionsOf(saved);
  if (saved.id !== d.snapshot.id || saved.seq !== d.base.seq || actions.length !== d.base.actions) {
    return null;
  }
  const out: Record<string, unknown> = {
    ...d.snapshot,
    actions: [...actions, ...d.actions],
    [FROM_PUSH]: true,
  };
  for (const k of ['actionMeta', 'entropyAudit'] as const) {
    if (saved[k] !== undefined) out[k] = saved[k];
  }
  return out as Snap;
}

/**
 * What the push itself carries for a message: the change since `prev` when there is one, else
 * the whole message, compressed and sealed; undefined when even that does not fit (the device
 * then collects it from the mailbox).
 */
export async function pushPayload(
  key: string,
  matchId: string,
  envelope: Envelope,
  prev?: Snap,
): Promise<string | undefined> {
  const tries: Envelope[] = [];
  if (envelope.t === 'view' && prev) {
    const d = deltaOf(prev, envelope);
    if (d) tries.push(d);
  }
  tries.push(envelope);
  try {
    for (const e of tries) {
      const sealed = await sealCompact(key, matchId, e);
      if (sealed.length <= MAX_PUSH_MESSAGE) return sealed;
    }
  } catch {
    /* no compression here: the push goes without the message, which waits in the mailbox */
  }
  return undefined;
}
