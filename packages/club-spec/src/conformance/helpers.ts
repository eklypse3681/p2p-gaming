/** Small utilities the checks share: assertions, authentication, balances, tally building. */

import { bytesToBase64Url, clubChallengeBytes } from '@bgf/protocol';
import type { ClubApi, ClubSession } from '../api.js';
import { CLUB_SPEC_VERSION } from '../capabilities.js';
import type { ClubErrorCode } from '../errors.js';
import type { TableTally, TallyEntry } from '../settlement.js';
import type { ConformanceMember, ConformanceTarget } from './types.js';

export class CheckFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckFailure';
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new CheckFailure(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

/** Read the `code` off whatever an implementation threw. */
export function codeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Run `fn`, requiring it to reject with one of `codes`. Returns the error. */
export async function rejectsWith(
  fn: () => Promise<unknown>,
  codes: ClubErrorCode | ClubErrorCode[],
  what: string,
): Promise<unknown> {
  const wanted = Array.isArray(codes) ? codes : [codes];
  let error: unknown;
  let resolved = false;
  try {
    await fn();
    resolved = true;
  } catch (e) {
    error = e;
  }
  if (resolved)
    throw new CheckFailure(`${what}: expected ${wanted.join(' or ')}, but it succeeded`);
  const code = codeOf(error);
  if (!code) {
    throw new CheckFailure(
      `${what}: expected a ClubError with code ${wanted.join(' or ')}, got ${String(error)}`,
    );
  }
  if (!wanted.includes(code as ClubErrorCode)) {
    throw new CheckFailure(`${what}: expected ${wanted.join(' or ')}, got "${code}"`);
  }
  return error;
}

/** Full challenge/response authentication for one member. */
export async function authenticate(
  club: ClubApi,
  member: ConformanceMember,
  opts: { spec?: number; invite?: string } = {},
): Promise<ClubSession> {
  const { nonce, clubId } = await club.challenge(member.profile.id);
  const signature = bytesToBase64Url(
    await member.signer(clubChallengeBytes({ clubId, profileId: member.profile.id, nonce })),
  );
  return club.authenticate({
    profile: member.profile,
    signature,
    nonce,
    spec: opts.spec ?? CLUB_SPEC_VERSION,
    ...(opts.invite ? { invite: opts.invite } : {}),
  });
}

export async function balanceOf(club: ClubApi, session: ClubSession): Promise<number> {
  const lobby = await club.lobby(session);
  return lobby.me.balance;
}

let counter = 0;
export function opId(prefix = 'op'): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A conserving tally: `net` is what each member ends with, rake taken from the winners. */
export function buildTally(input: {
  tableId: string;
  nonces: string[];
  /** Signed nets *before* rake; must sum to zero. */
  gross: Array<{ memberId: string; net: number }>;
  rake?: number;
  handCount?: number;
  at?: number;
}): TableTally {
  const rake = input.rake ?? 0;
  const winners = input.gross.filter((g) => g.net > 0);
  const moved = winners.reduce((a, w) => a + w.net, 0);
  const entries: TallyEntry[] = input.gross.map((g) => ({
    memberId: g.memberId,
    net: g.net,
    rake: 0,
  }));
  if (rake > 0) {
    assert(moved > 0, 'a tally cannot rake when nothing was won');
    let allocated = 0;
    for (const w of winners) {
      const share = Math.floor((rake * w.net) / moved);
      const entry = entries.find((e) => e.memberId === w.memberId)!;
      entry.rake = share;
      entry.net -= share;
      allocated += share;
    }
    const remainder = rake - allocated;
    if (remainder > 0) {
      const top = entries.find((e) => e.memberId === winners[0]!.memberId)!;
      top.rake += remainder;
      top.net -= remainder;
    }
  }
  const at = input.at ?? Date.now();
  return {
    tableId: input.tableId,
    opId: opId('tally'),
    nonces: input.nonces,
    entries,
    rake,
    handCount: input.handCount ?? 1,
    from: at,
    to: at,
  };
}

/** Seat `count` members at one table and return their sessions and grants. */
export async function seatMembers(
  target: ConformanceTarget,
  count: number,
  stake: number,
): Promise<{
  sessions: ClubSession[];
  grants: Awaited<ReturnType<ClubApi['sit']>>[];
  tableId: string;
}> {
  const { club, templateId } = target;
  assert(templateId, 'the target supplied no templateId');
  const sessions: ClubSession[] = [];
  const grants: Awaited<ReturnType<ClubApi['sit']>>[] = [];
  let tableId: string | undefined;
  for (let i = 0; i < count; i++) {
    const member = target.members[i];
    assert(member, `the target supplied fewer than ${count} members`);
    await target.fund(member.profile.id, stake * 4);
    const session = await authenticate(club, member);
    const grant = await club.sit(session, {
      opId: opId('sit'),
      ...(tableId ? { tableId } : { templateId }),
      buyIn: stake,
    });
    tableId ??= grant.tableId;
    assertEqual(grant.tableId, tableId, 'every member should be seated at the same table');
    sessions.push(session);
    grants.push(grant);
  }
  return { sessions, grants, tableId: tableId! };
}
