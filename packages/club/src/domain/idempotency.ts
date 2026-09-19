/**
 * Remembering what an operation already did.
 *
 * The spec requires every mutation to carry an `opId` and to be replay-safe: the same id returns
 * the original answer and moves no chips a second time, and the same id with different arguments
 * is a conflict. The record lives in club state so it survives a restart, bounded so it cannot
 * grow without limit.
 */

import { ClubError } from './identity.js';
import { canonicalJson, hashText } from './canonical.js';
import type { ClubState } from './state.js';

export const MAX_OP_RECORDS = 10_000;

export interface OpRecord {
  opId: string;
  /** Hash of the arguments, so a reused id with different arguments is caught. */
  hash: string;
  /** Whatever the operation returned, as stored JSON. */
  result: unknown;
  at: number;
}

export function argumentHash(args: unknown): string {
  return hashText(canonicalJson(args));
}

export function findOp(state: ClubState, opId: string): OpRecord | undefined {
  return state.ops?.find((o) => o.opId === opId);
}

/**
 * The result of a previous run of this operation, or undefined if it is new.
 * Throws `conflict` when the id has been used for something else.
 */
export function replayOf<T>(state: ClubState, opId: string, hash: string): T | undefined {
  const seen = findOp(state, opId);
  if (!seen) return undefined;
  if (seen.hash !== hash) {
    throw new ClubError('conflict', 'that operation id was already used with different arguments');
  }
  return seen.result as T;
}

export function recordOp(state: ClubState, record: OpRecord): ClubState {
  const ops = [...(state.ops ?? []), record];
  return { ...state, ops: ops.length > MAX_OP_RECORDS ? ops.slice(-MAX_OP_RECORDS) : ops };
}
