/**
 * The checks an implementation must pass to call itself a club.
 *
 * Each check is framework-free and gets a freshly created target, so one check's chips can never
 * explain another's result. `run.ts` executes them; `vitest.ts` binds them to a test runner.
 */

import type { ClubApi, ClubSession } from '../api.js';
import {
  CLUB_SPEC_VERSION,
  type ClubCapabilities,
  type OptionalOperation,
  describeCustody,
  describeMembership,
  describeSettlement,
  isSupported,
} from '../capabilities.js';
import type { MatchCriteria, MatchEvent } from '../matching.js';
import type { TableTally } from '../settlement.js';
import {
  assert,
  assertEqual,
  authenticate,
  balanceOf,
  buildTally,
  codeOf,
  opId,
  rejectsWith,
  seatMembers,
} from './helpers.js';
import type { Check, ConformanceTarget } from './types.js';
import { skip } from './types.js';

const STAKE = 1_000;

function capsOf(target: ConformanceTarget): Promise<ClubCapabilities> {
  return target.club.info().then((i) => i.capabilities);
}

function requireTemplate(target: ConformanceTarget): string {
  if (!target.templateId) skip('the target supplied no templateId');
  return target.templateId;
}

/** Collect match events for a session until `stop` says so, or a tick budget runs out. */
async function collectMatchEvents(
  club: ClubApi,
  session: ClubSession,
  act: () => Promise<void>,
  stop: (events: MatchEvent[]) => boolean,
  ticks = 40,
): Promise<MatchEvent[]> {
  const events: MatchEvent[] = [];
  const off = club.subscribe(session, (update) => {
    if (update.kind === 'match') events.push(update.event);
  });
  try {
    await act();
    for (let i = 0; i < ticks && !stop(events); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    off();
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------------------------

const declaration: Check[] = [
  {
    group: 'declaration',
    name: 'info() answers without authenticating',
    async run(target) {
      const info = await target.club.info();
      assert(info.identity?.id, 'info().identity.id is missing');
      assert(typeof info.identity.name === 'string', 'info().identity.name is missing');
      assert(info.identity.currency?.code, 'info().identity.currency.code is missing');
      assert(Array.isArray(info.rooms), 'info().rooms must be an array');
      assert(Number.isInteger(info.online) && info.online >= 0, 'info().online must be a count');
    },
  },
  {
    group: 'declaration',
    name: 'capabilities are well formed',
    async run(target) {
      const c = await capsOf(target);
      assertEqual(c.spec, CLUB_SPEC_VERSION, 'capabilities.spec must be the spec version');
      assert(
        c.settlement === 'immediate' || c.settlement === 'deferred',
        'capabilities.settlement must be immediate or deferred',
      );
      assert(
        ['open', 'request', 'invite'].includes(c.membership),
        'capabilities.membership must be open, request or invite',
      );
      assert(
        c.joinGrant === null || (Number.isInteger(c.joinGrant) && c.joinGrant >= 0),
        'capabilities.joinGrant must be null or a non-negative integer',
      );
      for (const flag of [
        'matchmaking',
        'transfers',
        'chipRequests',
        'chat',
        'tournaments',
      ] as const) {
        assert(typeof c[flag] === 'boolean', `capabilities.${flag} must be a boolean`);
      }
      assert(
        ['full', 'summary', 'none'].includes(c.statements),
        'capabilities.statements must be full, summary or none',
      );
      assert(
        c.minRakeBasisPoints === null ||
          (Number.isInteger(c.minRakeBasisPoints) && c.minRakeBasisPoints >= 0),
        'capabilities.minRakeBasisPoints must be null or a non-negative integer',
      );
      assert(
        c.ratingScale === null || typeof c.ratingScale === 'string',
        'capabilities.ratingScale must be null or a string',
      );
      assert(
        ['hosted', 'self-hosted', 'contract', 'local'].includes(c.custody.kind),
        'capabilities.custody.kind must be one of the four kinds',
      );
      if (c.settlement === 'deferred') {
        assert(
          Number.isInteger(c.commitmentTtlMs) && (c.commitmentTtlMs ?? 0) > 0,
          'a deferred club must declare commitmentTtlMs',
        );
      }
    },
  },
  {
    group: 'declaration',
    name: 'the club can be described in plain language',
    async run(target) {
      const c = await capsOf(target);
      const custody = describeCustody(c.custody);
      assert(custody.title.length > 0 && custody.detail.length > 0, 'custody description is empty');
      assert(describeSettlement(c).length > 0, 'settlement description is empty');
      assert(describeMembership(c).length > 0, 'membership description is empty');
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Honesty of capabilities
// ---------------------------------------------------------------------------------------------

/** `tournaments` has no operation on ClubApi yet, so it cannot be exercised. */
const EXERCISABLE: OptionalOperation[] = [
  'transfer',
  'request-chips',
  'chat',
  'statement',
  'matchmaking',
];

async function callOptional(
  target: ConformanceTarget,
  op: OptionalOperation,
  session: ClubSession,
): Promise<void> {
  const { club } = target;
  switch (op) {
    case 'transfer': {
      const other = target.members[1];
      assert(other, 'a second member is needed to exercise transfer');
      await club.transfer(session, { opId: opId('t'), to: other.profile.id, amount: 1 });
      return;
    }
    case 'request-chips':
      await club.requestChips(session, { opId: opId('r'), amount: 1 });
      return;
    case 'chat':
      await club.chat(session, 'hello');
      return;
    case 'statement':
      await club.statement(session);
      return;
    case 'matchmaking':
      await club.queue(session, { game: 'backgammon' }, { opId: opId('q') });
      return;
    case 'tournaments':
      skip('tournaments has no operation on ClubApi');
  }
}

const honesty: Check[] = [
  {
    group: 'capabilities',
    name: 'operations it does not offer are refused with unsupported',
    async run(target) {
      const caps = await capsOf(target);
      const missing = EXERCISABLE.filter((op) => !isSupported(caps, op));
      if (missing.length === 0) skip('this club offers every exercisable operation');
      const member = target.members[0]!;
      await target.fund(member.profile.id, 100);
      const session = await authenticate(target.club, member);
      for (const op of missing) {
        await rejectsWith(
          () => callOptional(target, op, session),
          'unsupported',
          `${op} is not declared`,
        );
      }
    },
  },
  {
    group: 'capabilities',
    name: 'operations it offers are never refused as unsupported',
    async run(target) {
      const caps = await capsOf(target);
      const offered = EXERCISABLE.filter((op) => isSupported(caps, op));
      if (offered.length === 0) skip('this club offers no optional operations');
      const member = target.members[0]!;
      await target.fund(member.profile.id, 1_000);
      const session = await authenticate(target.club, member);
      for (const op of offered) {
        try {
          await callOptional(target, op, session);
        } catch (e) {
          if (codeOf(e) === 'unsupported') {
            throw new Error(`${op} is declared but answered "unsupported"`);
          }
        }
      }
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

const auth: Check[] = [
  {
    group: 'auth',
    name: 'a correct signature authenticates',
    async run(target) {
      const member = target.members[0]!;
      const session = await authenticate(target.club, member);
      assertEqual(session.member.id, member.profile.id, 'the session names the wrong member');
      assert(typeof session.token === 'string' && session.token.length > 0, 'no session token');
    },
  },
  {
    group: 'auth',
    name: 'a wrong signature is unauthorized',
    async run(target) {
      const member = target.members[0]!;
      const other = target.members[1];
      assert(other, 'a second member is needed');
      const { nonce, clubId } = await target.club.challenge(member.profile.id);
      void clubId;
      // Signed by somebody else's key: the right shape, the wrong holder.
      const { bytesToBase64Url, clubChallengeBytes } = await import('@bgf/protocol');
      const signature = bytesToBase64Url(
        await other.signer(clubChallengeBytes({ clubId, profileId: member.profile.id, nonce })),
      );
      await rejectsWith(
        () =>
          target.club.authenticate({
            profile: member.profile,
            signature,
            nonce,
            spec: CLUB_SPEC_VERSION,
          }),
        'unauthorized',
        'a signature from the wrong key',
      );
    },
  },
  {
    group: 'auth',
    name: 'a stranger is admitted only where membership is open',
    async run(target) {
      const caps = await capsOf(target);
      const stranger = target.strangers?.[0];
      if (!stranger) skip('the target supplied no stranger');
      if (caps.membership === 'open') {
        const session = await authenticate(target.club, stranger);
        assertEqual(session.member.id, stranger.profile.id, 'an open club should admit anyone');
        return;
      }
      await rejectsWith(
        () => authenticate(target.club, stranger),
        ['not-a-member', 'pending'],
        `membership is "${caps.membership}" so a stranger`,
      );
    },
  },
  {
    group: 'auth',
    name: 'a banned member is refused',
    async run(target) {
      if (!target.ban) skip('the target cannot ban');
      const member = target.members[0]!;
      await authenticate(target.club, member);
      await target.ban(member.profile.id);
      await rejectsWith(() => authenticate(target.club, member), 'banned', 'a banned member');
    },
  },
  {
    group: 'auth',
    name: 'an unservable spec version is refused',
    async run(target) {
      const member = target.members[0]!;
      await rejectsWith(
        () => authenticate(target.club, member, { spec: CLUB_SPEC_VERSION + 1_000 }),
        'version',
        'a spec version from the future',
      );
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------------------------

const idempotency: Check[] = [
  {
    group: 'idempotency',
    name: 'sit replayed with one opId seats once and stakes once',
    async run(target) {
      const templateId = requireTemplate(target);
      const member = target.members[0]!;
      await target.fund(member.profile.id, STAKE * 4);
      const session = await authenticate(target.club, member);
      const before = await balanceOf(target.club, session);
      const id = opId('sit');
      const first = await target.club.sit(session, { opId: id, templateId, buyIn: STAKE });
      const after = await balanceOf(target.club, session);
      const second = await target.club.sit(session, { opId: id, templateId, buyIn: STAKE });
      const afterReplay = await balanceOf(target.club, session);
      assertEqual(second.tableId, first.tableId, 'the replay seated at a different table');
      assertEqual(second.seat, first.seat, 'the replay took a different seat');
      assertEqual(
        second.commitment.nonce,
        first.commitment.nonce,
        'the replay issued a second commitment',
      );
      assertEqual(afterReplay, after, 'the replay staked the chips a second time');
      assert(before >= after, 'sitting should never increase the balance');
    },
  },
  {
    group: 'idempotency',
    name: 'the same opId with different arguments is a conflict',
    async run(target) {
      const templateId = requireTemplate(target);
      const member = target.members[0]!;
      await target.fund(member.profile.id, STAKE * 6);
      const session = await authenticate(target.club, member);
      const id = opId('sit');
      await target.club.sit(session, { opId: id, templateId, buyIn: STAKE });
      await rejectsWith(
        () => target.club.sit(session, { opId: id, templateId, buyIn: STAKE * 2 }),
        'conflict',
        'the same opId with a different buy-in',
      );
    },
  },
  {
    group: 'idempotency',
    name: 'transfer replayed moves chips once',
    async run(target) {
      const caps = await capsOf(target);
      if (!caps.transfers) skip('this club does not offer transfers');
      const [from, to] = target.members;
      assert(from && to, 'two members are needed');
      await target.fund(from.profile.id, 1_000);
      const fromSession = await authenticate(target.club, from);
      const toSession = await authenticate(target.club, to);
      const fromBefore = await balanceOf(target.club, fromSession);
      const toBefore = await balanceOf(target.club, toSession);
      const id = opId('transfer');
      await target.club.transfer(fromSession, { opId: id, to: to.profile.id, amount: 250 });
      await target.club.transfer(fromSession, { opId: id, to: to.profile.id, amount: 250 });
      assertEqual(
        await balanceOf(target.club, fromSession),
        fromBefore - 250,
        'the sender was debited twice',
      );
      assertEqual(
        await balanceOf(target.club, toSession),
        toBefore + 250,
        'the recipient was credited twice',
      );
    },
  },
  {
    group: 'idempotency',
    name: 'settle replayed applies once',
    async run(target) {
      requireTemplate(target);
      const { sessions, grants, tableId } = await seatMembers(target, 2, STAKE);
      const [a, b] = target.members;
      const tally = buildTally({
        tableId,
        nonces: grants.map((g) => g.commitment.nonce),
        gross: [
          { memberId: a!.profile.id, net: 300 },
          { memberId: b!.profile.id, net: -300 },
        ],
        rake: 6,
      });
      await target.club.settle(tally);
      const afterFirst = [
        await balanceOf(target.club, sessions[0]!),
        await balanceOf(target.club, sessions[1]!),
      ];
      await target.club.settle(tally);
      const afterSecond = [
        await balanceOf(target.club, sessions[0]!),
        await balanceOf(target.club, sessions[1]!),
      ];
      assertEqual(afterSecond[0], afterFirst[0], 'the replayed tally paid the winner twice');
      assertEqual(afterSecond[1], afterFirst[1], 'the replayed tally charged the loser twice');
    },
  },
  {
    group: 'idempotency',
    name: 'leave replayed is safe',
    async run(target) {
      requireTemplate(target);
      const { sessions, tableId } = await seatMembers(target, 1, STAKE);
      const session = sessions[0]!;
      const id = opId('leave');
      await target.club.leave(session, { opId: id, tableId });
      const after = await balanceOf(target.club, session);
      await target.club.leave(session, { opId: id, tableId });
      assertEqual(await balanceOf(target.club, session), after, 'leaving twice paid out twice');
    },
  },
  {
    group: 'idempotency',
    name: 'queue replayed returns the same ticket',
    async run(target) {
      const caps = await capsOf(target);
      if (!caps.matchmaking) skip('this club does not offer matchmaking');
      const member = target.members[0]!;
      await target.fund(member.profile.id, STAKE * 4);
      const session = await authenticate(target.club, member);
      const criteria: MatchCriteria = { game: 'ofc' };
      const id = opId('queue');
      const first = await target.club.queue(session, criteria, { opId: id });
      const second = await target.club.queue(session, criteria, { opId: id });
      assertEqual(second.id, first.id, 'the replay created a second ticket');
    },
  },
  {
    group: 'idempotency',
    name: 'requestChips replayed records once',
    async run(target) {
      const caps = await capsOf(target);
      if (!caps.chipRequests) skip('this club does not offer chip requests');
      const member = target.members[0]!;
      const session = await authenticate(target.club, member);
      const before = await balanceOf(target.club, session);
      const id = opId('req');
      await target.club.requestChips(session, { opId: id, amount: 500 });
      await target.club.requestChips(session, { opId: id, amount: 500 });
      assertEqual(
        await balanceOf(target.club, session),
        before,
        'asking for chips must not move any by itself',
      );
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Conservation
// ---------------------------------------------------------------------------------------------

const conservation: Check[] = [
  {
    group: 'conservation',
    name: 'chips are conserved through sit, settle and leave',
    async run(target) {
      requireTemplate(target);
      const funded = STAKE * 4;
      const { sessions, grants, tableId } = await seatMembers(target, 2, STAKE);
      const [a, b] = target.members;
      const rake = 8;
      const win = 400;
      const tally = buildTally({
        tableId,
        nonces: grants.map((g) => g.commitment.nonce),
        gross: [
          { memberId: a!.profile.id, net: win },
          { memberId: b!.profile.id, net: -win },
        ],
        rake,
      });
      await target.club.settle(tally);
      await target.club.leave(sessions[0]!, { opId: opId('leave'), tableId });
      await target.club.leave(sessions[1]!, { opId: opId('leave'), tableId });
      const endA = await balanceOf(target.club, sessions[0]!);
      const endB = await balanceOf(target.club, sessions[1]!);
      // Everything staked came back, adjusted by the result, less the rake that was destroyed.
      assertEqual(endA, funded + win - rake, 'the winner did not end with stake plus winnings');
      assertEqual(endB, funded - win, 'the loser did not end with stake less losses');
      assertEqual(
        endA + endB,
        funded * 2 - rake,
        'the table did not conserve chips: everything but the rake should have come back',
      );
    },
  },
  {
    group: 'conservation',
    name: 'invalid tallies are refused and move nothing',
    async run(target) {
      requireTemplate(target);
      const { sessions, grants, tableId } = await seatMembers(target, 2, STAKE);
      const [a, b] = target.members;
      const nonces = grants.map((g) => g.commitment.nonce);
      const before = [
        await balanceOf(target.club, sessions[0]!),
        await balanceOf(target.club, sessions[1]!),
      ];
      const base = {
        tableId,
        nonces,
        gross: [
          { memberId: a!.profile.id, net: 200 },
          { memberId: b!.profile.id, net: -200 },
        ],
      };
      const bad: Array<{ what: string; tally: TableTally }> = [
        {
          what: 'a tally that does not conserve',
          tally: (() => {
            const t = buildTally(base);
            return { ...t, entries: t.entries.map((e) => ({ ...e, net: e.net + 5 })) };
          })(),
        },
        {
          what: 'a tally whose declared rake differs from its entries',
          tally: { ...buildTally({ ...base, rake: 4 }), rake: 9 },
        },
        {
          what: 'a tally with a negative rake',
          tally: (() => {
            const t = buildTally(base);
            return {
              ...t,
              entries: [{ ...t.entries[0]!, rake: -5, net: t.entries[0]!.net + 5 }, t.entries[1]!],
              rake: -5,
            };
          })(),
        },
        {
          what: 'a tally losing more than the stake',
          tally: buildTally({
            ...base,
            gross: [
              { memberId: a!.profile.id, net: STAKE * 3 },
              { memberId: b!.profile.id, net: -STAKE * 3 },
            ],
          }),
        },
        {
          what: 'a tally naming an unknown commitment',
          tally: { ...buildTally(base), nonces: ['not-a-real-nonce'] },
        },
        {
          what: 'a tally naming one member twice',
          tally: (() => {
            const t = buildTally(base);
            return {
              ...t,
              entries: [
                { memberId: a!.profile.id, net: 100, rake: 0 },
                { memberId: a!.profile.id, net: -100, rake: 0 },
              ],
            };
          })(),
        },
      ];
      for (const { what, tally } of bad) {
        await rejectsWith(
          () => target.club.settle(tally),
          ['tally-invalid', 'commitment-exceeded', 'commitment-stale', 'invalid'],
          what,
        );
      }
      assertEqual(
        await balanceOf(target.club, sessions[0]!),
        before[0]!,
        'a refused tally moved the first member’s chips',
      );
      assertEqual(
        await balanceOf(target.club, sessions[1]!),
        before[1]!,
        'a refused tally moved the second member’s chips',
      );
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Commitments and settlement modes
// ---------------------------------------------------------------------------------------------

const commitments: Check[] = [
  {
    group: 'commitments',
    name: 'a member cannot lose more than their stake',
    async run(target) {
      requireTemplate(target);
      const { grants, tableId } = await seatMembers(target, 2, STAKE);
      const [a, b] = target.members;
      const tally = buildTally({
        tableId,
        nonces: grants.map((g) => g.commitment.nonce),
        gross: [
          { memberId: a!.profile.id, net: STAKE + 1 },
          { memberId: b!.profile.id, net: -(STAKE + 1) },
        ],
      });
      await rejectsWith(
        () => target.club.settle(tally),
        ['commitment-exceeded', 'tally-invalid'],
        'losing one chip more than the stake',
      );
    },
  },
  {
    group: 'commitments',
    name: 'a settled commitment cannot be settled again',
    async run(target) {
      requireTemplate(target);
      const { grants, tableId } = await seatMembers(target, 2, STAKE);
      const [a, b] = target.members;
      const nonces = grants.map((g) => g.commitment.nonce);
      await target.club.settle(
        buildTally({
          tableId,
          nonces,
          gross: [
            { memberId: a!.profile.id, net: 100 },
            { memberId: b!.profile.id, net: -100 },
          ],
          rake: 2,
        }),
      );
      await rejectsWith(
        () =>
          target.club.settle(
            buildTally({
              tableId,
              nonces,
              gross: [
                { memberId: a!.profile.id, net: 50 },
                { memberId: b!.profile.id, net: -50 },
              ],
              rake: 1,
            }),
          ),
        ['commitment-stale', 'tally-invalid'],
        'a second tally against spent commitments',
      );
    },
  },
  {
    group: 'commitments',
    name: 'an expired commitment returns the stake and frees the seat',
    async run(target) {
      const caps = await capsOf(target);
      if (caps.settlement !== 'deferred') skip('only deferred clubs expire commitments');
      if (!target.advance) skip('the target cannot advance its clock');
      requireTemplate(target);
      const { sessions, grants, tableId } = await seatMembers(target, 1, STAKE);
      const session = sessions[0]!;
      const balanceWhileStaked = await balanceOf(target.club, session);
      await target.advance((caps.commitmentTtlMs ?? 60_000) + 1_000);
      const after = await balanceOf(target.club, session);
      assertEqual(after, balanceWhileStaked, 'an expired stake was not returned intact');
      // The seat is free again: the same member can sit anew.
      const again = await target.club.sit(session, {
        opId: opId('sit'),
        tableId,
        buyIn: STAKE,
      });
      assert(
        again.commitment.nonce !== grants[0]!.commitment.nonce,
        'sitting again reused the expired commitment',
      );
    },
  },
];

const settlementModes: Check[] = [
  {
    group: 'settlement',
    name: 'a deferred club moves no chips between sitting and settling',
    async run(target) {
      const caps = await capsOf(target);
      if (caps.settlement !== 'deferred') skip('this club settles immediately');
      requireTemplate(target);
      const member = target.members[0]!;
      await target.fund(member.profile.id, STAKE * 4);
      const session = await authenticate(target.club, member);
      const before = await balanceOf(target.club, session);
      await target.club.sit(session, {
        opId: opId('sit'),
        templateId: target.templateId!,
        buyIn: STAKE,
      });
      assertEqual(
        await balanceOf(target.club, session),
        before,
        'a deferred club debited the stake at sit time',
      );
    },
  },
  {
    group: 'settlement',
    name: 'an immediate club stakes the chips when the member sits',
    async run(target) {
      const caps = await capsOf(target);
      if (caps.settlement !== 'immediate') skip('this club settles on leaving');
      requireTemplate(target);
      const member = target.members[0]!;
      await target.fund(member.profile.id, STAKE * 4);
      const session = await authenticate(target.club, member);
      const before = await balanceOf(target.club, session);
      await target.club.sit(session, {
        opId: opId('sit'),
        templateId: target.templateId!,
        buyIn: STAKE,
      });
      assertEqual(
        await balanceOf(target.club, session),
        before - STAKE,
        'an immediate club did not move the stake onto the table',
      );
    },
  },
  {
    group: 'settlement',
    name: 'a stake larger than the balance is refused',
    async run(target) {
      requireTemplate(target);
      const member = target.members[0]!;
      const session = await authenticate(target.club, member);
      const balance = await balanceOf(target.club, session);
      await rejectsWith(
        () =>
          target.club.sit(session, {
            opId: opId('sit'),
            templateId: target.templateId!,
            buyIn: balance + 1_000_000,
          }),
        ['insufficient-chips', 'invalid'],
        'staking more than the member holds',
      );
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------------------------------------

const matchmaking: Check[] = [
  {
    group: 'matchmaking',
    name: 'two compatible members are matched to one table',
    async run(target) {
      const caps = await capsOf(target);
      if (!caps.matchmaking) skip('this club does not offer matchmaking');
      const templateId = requireTemplate(target);
      const [a, b] = target.members;
      assert(a && b, 'two members are needed');
      await target.fund(a.profile.id, STAKE * 4);
      await target.fund(b.profile.id, STAKE * 4);
      const sa = await authenticate(target.club, a);
      const sb = await authenticate(target.club, b);
      const criteria: MatchCriteria = {
        game: (await target.club.info()).rooms[0]?.templates[0]?.game ?? 'ofc',
        templateIds: [templateId],
      };

      const eventsA: MatchEvent[] = [];
      const offA = target.club.subscribe(sa, (u) => {
        if (u.kind === 'match') eventsA.push(u.event);
      });
      const eventsB = await collectMatchEvents(
        target.club,
        sb,
        async () => {
          await target.club.queue(sa, criteria, { opId: opId('q') });
          await target.club.queue(sb, criteria, { opId: opId('q') });
        },
        (events) => events.some((e) => e.kind === 'matched'),
      );
      offA();
      const matchedA = eventsA.find((e) => e.kind === 'matched');
      const matchedB = eventsB.find((e) => e.kind === 'matched');
      assert(matchedA?.kind === 'matched', 'the first member was never matched');
      assert(matchedB?.kind === 'matched', 'the second member was never matched');
      assertEqual(
        matchedB.grant.tableId,
        matchedA.grant.tableId,
        'the two members were matched to different tables',
      );
      assert(
        matchedA.grant.seat !== matchedB.grant.seat,
        'the two members were given the same seat',
      );
    },
  },
  {
    group: 'matchmaking',
    name: 'the club seats whoever its policy chooses',
    async run(target) {
      const caps = await capsOf(target);
      if (!caps.matchmaking) skip('this club does not offer matchmaking');
      if (!target.withPolicy) skip('this club cannot be given a policy');
      const [a, b, c] = target.members;
      assert(a && b && c, 'three members are needed');
      // A policy that will only ever seat the last two members, never the first.
      const chosen = new Set([b.profile.id, c.profile.id]);
      let asked = 0;
      const scoped = await target.withPolicy({
        group: ({ tickets, template }) => {
          asked++;
          const picked = tickets.filter((t) => chosen.has(t.memberId));
          return picked.length >= template.seats ? [picked.slice(0, template.seats)] : [];
        },
      });
      try {
        const templateId = requireTemplate(scoped);
        const game = (await scoped.club.info()).rooms[0]?.templates[0]?.game ?? 'ofc';
        const criteria: MatchCriteria = { game, templateIds: [templateId] };
        for (const m of [a, b, c]) await scoped.fund(m.profile.id, STAKE * 4);
        const sa = await authenticate(scoped.club, a);
        const sb = await authenticate(scoped.club, b);
        const sc = await authenticate(scoped.club, c);

        const seenA: MatchEvent[] = [];
        const offA = scoped.club.subscribe(sa, (u) => {
          if (u.kind === 'match') seenA.push(u.event);
        });
        const seenC = await collectMatchEvents(
          scoped.club,
          sc,
          async () => {
            await scoped.club.queue(sa, criteria, { opId: opId('q') });
            await scoped.club.queue(sb, criteria, { opId: opId('q') });
            await scoped.club.queue(sc, criteria, { opId: opId('q') });
          },
          (events) => events.some((e) => e.kind === 'matched'),
        );
        offA();
        assert(asked > 0, 'the club never asked the policy');
        assert(
          seenC.some((e) => e.kind === 'matched'),
          'a member the policy chose was not seated',
        );
        assert(
          !seenA.some((e) => e.kind === 'matched'),
          'a member the policy did not choose was seated anyway',
        );
      } finally {
        await scoped.close();
      }
    },
  },
  {
    group: 'matchmaking',
    name: 'incompatible criteria never match',
    async run(target) {
      const caps = await capsOf(target);
      if (!caps.matchmaking) skip('this club does not offer matchmaking');
      const [a, b] = target.members;
      assert(a && b, 'two members are needed');
      await target.fund(a.profile.id, STAKE * 4);
      await target.fund(b.profile.id, STAKE * 4);
      const sa = await authenticate(target.club, a);
      const sb = await authenticate(target.club, b);
      const events = await collectMatchEvents(
        target.club,
        sa,
        async () => {
          await target.club.queue(sa, { game: 'backgammon' }, { opId: opId('q') });
          await target.club.queue(sb, { game: 'ofc' }, { opId: opId('q') });
        },
        (e) => e.some((x) => x.kind === 'matched'),
        20,
      );
      assert(
        !events.some((e) => e.kind === 'matched'),
        'members wanting different games were matched anyway',
      );
    },
  },
  {
    group: 'matchmaking',
    name: 'unqueue cancels a ticket',
    async run(target) {
      const caps = await capsOf(target);
      if (!caps.matchmaking) skip('this club does not offer matchmaking');
      const member = target.members[0]!;
      await target.fund(member.profile.id, STAKE * 4);
      const session = await authenticate(target.club, member);
      let ticketId = '';
      const events = await collectMatchEvents(
        target.club,
        session,
        async () => {
          const ticket = await target.club.queue(session, { game: 'ofc' }, { opId: opId('q') });
          ticketId = ticket.id;
          await target.club.unqueue(session, ticket.id);
        },
        (e) => e.some((x) => x.kind === 'cancelled'),
      );
      const cancelled = events.find((e) => e.kind === 'cancelled');
      assert(cancelled?.kind === 'cancelled', 'no cancellation was reported');
      assertEqual(cancelled.ticketId, ticketId, 'the wrong ticket was cancelled');
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Statements and isolation
// ---------------------------------------------------------------------------------------------

const statements: Check[] = [
  {
    group: 'statements',
    name: 'a statement reconciles with the balance',
    async run(target) {
      const caps = await capsOf(target);
      if (caps.statements === 'none') skip('this club keeps no statements');
      const member = target.members[0]!;
      await target.fund(member.profile.id, 750);
      const session = await authenticate(target.club, member);
      const statement = await target.club.statement(session);
      assertEqual(statement.memberId, member.profile.id, 'the statement names the wrong member');
      assertEqual(
        statement.balance,
        await balanceOf(target.club, session),
        'the statement balance disagrees with the lobby',
      );
    },
  },
  {
    group: 'statements',
    name: 'a statement holds the member’s own entries and no others',
    async run(target) {
      const caps = await capsOf(target);
      if (caps.statements !== 'full') skip('this club does not keep full statements');
      const [a, b] = target.members;
      assert(a && b, 'two members are needed');
      await target.fund(a.profile.id, 900);
      await target.fund(b.profile.id, 900);
      const sa = await authenticate(target.club, a);
      const statement = await target.club.statement(sa);
      for (const entry of statement.entries) {
        assert(
          entry.lines.some((l) => l.account === a.profile.id),
          'a statement contained an entry the member was not part of',
        );
      }
      assert(statement.entries.length > 0, 'a funded member should have at least one entry');
    },
  },
];

const isolation: Check[] = [
  {
    group: 'isolation',
    name: 'a transfer debits the caller, never the named member',
    async run(target) {
      const caps = await capsOf(target);
      if (!caps.transfers) skip('this club does not offer transfers');
      const [a, b] = target.members;
      assert(a && b, 'two members are needed');
      await target.fund(a.profile.id, 1_000);
      await target.fund(b.profile.id, 1_000);
      const sa = await authenticate(target.club, a);
      const sb = await authenticate(target.club, b);
      const aBefore = await balanceOf(target.club, sa);
      const bBefore = await balanceOf(target.club, sb);
      await target.club.transfer(sa, { opId: opId('t'), to: b.profile.id, amount: 100 });
      assertEqual(await balanceOf(target.club, sa), aBefore - 100, 'the caller was not debited');
      assertEqual(
        await balanceOf(target.club, sb),
        bBefore + 100,
        'the recipient was not credited',
      );
    },
  },
  {
    group: 'isolation',
    name: 'a session only ever reports its own statement',
    async run(target) {
      const caps = await capsOf(target);
      if (caps.statements === 'none') skip('this club keeps no statements');
      const [a, b] = target.members;
      assert(a && b, 'two members are needed');
      await target.fund(a.profile.id, 400);
      await target.fund(b.profile.id, 400);
      const sa = await authenticate(target.club, a);
      const sb = await authenticate(target.club, b);
      assertEqual(
        (await target.club.statement(sa)).memberId,
        a.profile.id,
        'a session was given another member’s statement',
      );
      assertEqual(
        (await target.club.statement(sb)).memberId,
        b.profile.id,
        'a session was given another member’s statement',
      );
    },
  },
  {
    group: 'isolation',
    name: 'leaving a table you never sat at is refused',
    async run(target) {
      requireTemplate(target);
      const { tableId } = await seatMembers(target, 1, STAKE);
      const other = target.members[1];
      assert(other, 'a second member is needed');
      const session = await authenticate(target.club, other);
      await rejectsWith(
        () => target.club.leave(session, { opId: opId('leave'), tableId }),
        ['not-seated', 'unknown-table'],
        'leaving somebody else’s table',
      );
    },
  },
];

export const CLUB_CONFORMANCE_CHECKS: Check[] = [
  ...declaration,
  ...honesty,
  ...auth,
  ...idempotency,
  ...conservation,
  ...commitments,
  ...settlementModes,
  ...matchmaking,
  ...statements,
  ...isolation,
];
