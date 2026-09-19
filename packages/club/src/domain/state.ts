import type {
  ChipRequest,
  ClubIdentity,
  ClubInvite,
  ClubMember,
  LedgerEntry,
  Room,
} from '@bgf/protocol';
import type { CommitmentRecord } from './commitments.js';
import { ClubError } from './identity.js';
import type { OpRecord } from './idempotency.js';
import type { ClubPolicy } from './policy.js';

export const CLUB_STATE_VERSION = 1;

export interface InviteRecord {
  invite: ClubInvite;
  /** The signed token as issued (so it can be shown again). */
  token: string;
  uses: number;
  revoked?: boolean;
}

export interface ClubState {
  version: number;
  identity: ClubIdentity;
  members: ClubMember[];
  rooms: Room[];
  ledger: LedgerEntry[];
  invites: Record<string, InviteRecord>;
  requests: ChipRequest[];
  /** What this club chooses to be. Absent means the defaults in `policy.ts`. */
  policy?: Partial<ClubPolicy>;
  /** Replay records for `opId`-carrying operations. */
  ops?: OpRecord[];
  /** Stakes promised to tables, live and recently closed. */
  commitments?: CommitmentRecord[];
}

export function newClubState(identity: ClubIdentity): ClubState {
  return {
    version: CLUB_STATE_VERSION,
    identity,
    members: [],
    rooms: [],
    ledger: [],
    invites: {},
    requests: [],
  };
}

export function serializeClubState(state: ClubState): string {
  return JSON.stringify({ ...state, version: CLUB_STATE_VERSION });
}

export function deserializeClubState(text: string): ClubState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ClubError('bad-state', 'club state is not valid JSON');
  }
  if (!raw || typeof raw !== 'object')
    throw new ClubError('bad-state', 'club state is not an object');
  const s = raw as Partial<ClubState>;
  if (s.version !== CLUB_STATE_VERSION) {
    throw new ClubError('bad-state', `unsupported club state version ${String(s.version)}`);
  }
  if (
    !s.identity ||
    typeof s.identity.id !== 'string' ||
    typeof s.identity.publicKey !== 'string'
  ) {
    throw new ClubError('bad-state', 'club state has no identity');
  }
  return {
    version: CLUB_STATE_VERSION,
    identity: s.identity,
    members: Array.isArray(s.members) ? s.members : [],
    rooms: Array.isArray(s.rooms) ? s.rooms : [],
    ledger: Array.isArray(s.ledger) ? s.ledger : [],
    invites: s.invites && typeof s.invites === 'object' ? s.invites : {},
    requests: Array.isArray(s.requests) ? s.requests : [],
    ...(s.policy && typeof s.policy === 'object' ? { policy: s.policy } : {}),
    ...(Array.isArray(s.ops) ? { ops: s.ops } : {}),
    ...(Array.isArray(s.commitments) ? { commitments: s.commitments } : {}),
  };
}
