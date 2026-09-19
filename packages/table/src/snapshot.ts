import type { ActionMeta, TableSnapshot } from '@bgf/protocol';
import type { GameDefinition } from './definition.js';

export const MAX_CHAT_HISTORY = 200;

/**
 * Replays a snapshot's action log from its initial state and returns a snapshot whose `state`
 * is the replayed result. Throws (from the reducer) when the log is inconsistent, and refuses
 * a seat's view, which is not replayable.
 */
export function verifySnapshot<S, A, C, V, Cfg>(
  def: GameDefinition<S, A, C, V, Cfg>,
  snapshot: TableSnapshot<S, A, Cfg>,
): TableSnapshot<S, A, Cfg> {
  if (snapshot.view) throw new Error('a redacted view cannot be verified');
  if (snapshot.gameId !== def.id) {
    throw new Error(`snapshot is for game ${snapshot.gameId}, not ${def.id}`);
  }
  const state = snapshot.actions.reduce((s, a) => def.reduce(s, a), snapshot.initialState);
  return {
    ...snapshot,
    seats: snapshot.seats.map((p) => p ?? null),
    options: { ...(snapshot.options ?? {}) },
    actions: snapshot.actions.slice(),
    chat: (snapshot.chat ?? []).slice(-MAX_CHAT_HISTORY),
    ...(snapshot.actionMeta ? { actionMeta: { ...snapshot.actionMeta } } : {}),
    ...(snapshot.entropyAudit ? { entropyAudit: snapshot.entropyAudit } : {}),
    state,
  };
}

/**
 * What a seat is allowed to receive. Games without hidden information hand out the full
 * snapshot; hidden-information games get `state`/`initialState` through `view` and the action
 * log through `viewAction`, flagged so that copy is never mistaken for an authoritative one.
 */
export function viewSnapshot<S, A, C, V, Cfg>(
  def: GameDefinition<S, A, C, V, Cfg>,
  snapshot: TableSnapshot<S, A, Cfg>,
  seat: number | null,
): TableSnapshot<S | V, A, Cfg> {
  if (!def.hiddenInformation) return snapshot;
  const redactAction = def.viewAction ?? (() => null);
  const actions: A[] = [];
  // Actions the seat may not see are dropped, so the attribution metadata is re-keyed to the
  // indexes of the filtered log.
  const actionMeta: Record<number, ActionMeta> = {};
  let hasMeta = false;
  snapshot.actions.forEach((a, i) => {
    const r = redactAction(a, seat);
    if (r === null) return;
    const meta = snapshot.actionMeta?.[i];
    if (meta) {
      actionMeta[actions.length] = meta;
      hasMeta = true;
    }
    actions.push(r);
  });
  return {
    ...snapshot,
    initialState: def.view(snapshot.initialState, seat),
    state: def.view(snapshot.state, seat),
    actions,
    ...(hasMeta ? { actionMeta } : snapshot.actionMeta ? { actionMeta: {} } : {}),
    view: true,
  };
}
