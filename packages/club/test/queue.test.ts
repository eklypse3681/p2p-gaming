import { describe, expect, it } from 'vitest';
import type { ClubSession, MatchEvent, MatchPolicy, MatchTicket } from '@bgf/club-spec';
import { CLUB_SPEC_VERSION, proposeMatches } from '@bgf/club-spec';
import type { PlayerProfile, TableTemplate } from '@bgf/protocol';
import { bytesToBase64Url, clubChallengeBytes } from '@bgf/protocol';
import { ClubServer, addRoom, addTemplate } from '../src/index.js';
import type { ClubState } from '../src/index.js';
import { GAMES, clubFixture, fakeRegistry, keyedProfile } from './helpers.js';

/**
 * The matchmaking queue, which belongs to the club: tickets in, `MatchEvent`s out, with the
 * lifecycle — idempotency, one ticket per member, expiry, a disconnect grace, pause and drain —
 * handled here whatever policy is injected.
 */

const TEMPLATE: Omit<TableTemplate, 'id'> = {
  name: 'Three-handed',
  game: 'ofc',
  config: {},
  seats: 3,
  stakes: {
    chipsPerPoint: 10,
    buyIn: { min: 1, max: 1_000_000, default: 1_000 },
    rake: { basisPoints: 200 },
  },
};

async function build(
  opts: { policy?: MatchPolicy; ticketTtlMs?: number; disconnectGraceMs?: number } = {},
) {
  const fixture = await clubFixture({ reserve: 10_000_000 });
  const { state: withRoom, room } = addRoom(fixture.state, { name: 'Main' });
  const { state: withTemplate, template } = addTemplate(withRoom, room.id, TEMPLATE, GAMES);
  const people = await Promise.all(
    ['Ada', 'Bob', 'Cy', 'Dee'].map((n) => keyedProfile(n)),
  );
  let state: ClubState = {
    ...withTemplate,
    members: [
      ...withTemplate.members,
      ...people.map((p) => ({
        id: p.profile.id,
        name: p.profile.name,
        publicKey: p.profile.publicKey!,
        role: 'member' as const,
        status: 'active' as const,
        joinedAt: 1_000,
      })),
    ],
  };

  let clock = 1_700_000_000_000;
  const registry = fakeRegistry(() => template as TableTemplate);
  const server = new ClubServer({
    state,
    signer: fixture.clubSigner,
    tables: registry,
    games: GAMES,
    now: () => clock,
    persist: (s) => {
      state = s;
    },
    platformPublicKey: fixture.platformPublicKey,
    // Matchmaking is driven by hand in these tests, so the timer stays off.
    matchTickMs: 0,
    ...(opts.policy ? { matchPolicy: opts.policy } : {}),
    ...(opts.ticketTtlMs !== undefined ? { ticketTtlMs: opts.ticketTtlMs } : {}),
    ...(opts.disconnectGraceMs !== undefined ? { disconnectGraceMs: opts.disconnectGraceMs } : {}),
    policy: { membership: 'invite', custody: { kind: 'local' } },
  });

  const sessions = new Map<string, ClubSession>();
  const events = new Map<string, MatchEvent[]>();
  for (const p of people) {
    const { nonce } = await server.challenge(p.profile.id);
    const session = await server.authenticate({
      profile: p.profile as PlayerProfile,
      nonce,
      spec: CLUB_SPEC_VERSION,
      signature: bytesToBase64Url(
        await p.signer(
          clubChallengeBytes({ clubId: fixture.identity.id, profileId: p.profile.id, nonce }),
        ),
      ),
    });
    sessions.set(p.profile.id, session);
    events.set(p.profile.id, []);
    server.subscribe(session, (u) => {
      if (u.kind === 'match') events.get(p.profile.id)!.push(u.event);
    });
    await server.admin.grant(p.profile.id, 100_000, fixture.owner.profile.id, 'stake');
  }

  const ids = people.map((p) => p.profile.id);
  return {
    server,
    registry,
    ids,
    sessions,
    events,
    templateId: template.id,
    advance: (ms: number) => {
      clock += ms;
    },
    queue: (id: string, opId: string, game = 'ofc') =>
      server.queue(sessions.get(id)!, { game }, { opId }),
    close: () => server.close(),
  };
}

describe('the club queue', () => {
  it('seats a group once a table can be filled, and tells each member', async () => {
    const club = await build();
    for (const [i, id] of club.ids.slice(0, 2).entries()) await club.queue(id, `op-${i}`);
    await club.server.runMatchmaking();
    expect(club.server.matchTickets()).toHaveLength(2); // two of three seats

    await club.queue(club.ids[2]!, 'op-2');
    await club.server.runMatchmaking();
    expect(club.server.matchTickets()).toHaveLength(0);

    const grants = club.ids.slice(0, 3).map((id) => {
      const matched = club.events.get(id)!.find((e) => e.kind === 'matched');
      expect(matched?.kind).toBe('matched');
      return matched as Extract<MatchEvent, { kind: 'matched' }>;
    });
    expect(new Set(grants.map((g) => g.grant.tableId)).size).toBe(1);
    expect(new Set(grants.map((g) => g.grant.seat)).size).toBe(3);
    club.close();
  });

  it('is idempotent on the operation id and holds one ticket per member', async () => {
    const club = await build();
    const first = await club.queue(club.ids[0]!, 'same');
    const second = await club.queue(club.ids[0]!, 'same');
    expect(second.id).toBe(first.id);
    expect(club.server.matchTickets()).toHaveLength(1);

    // A different operation replaces the ticket rather than adding one.
    const third = await club.queue(club.ids[0]!, 'other', 'backgammon');
    expect(third.id).not.toBe(first.id);
    expect(club.server.matchTickets()).toHaveLength(1);
    expect(club.server.ticketForMember(club.ids[0]!)?.criteria.game).toBe('backgammon');
    club.close();
  });

  it('cancels on unqueue, and only for the member who owns the ticket', async () => {
    const club = await build();
    const ticket = await club.queue(club.ids[0]!, 'op-a');
    // Somebody else's ticket is not theirs to cancel.
    await club.server.unqueue(club.sessions.get(club.ids[1]!)!, ticket.id);
    expect(club.server.matchTickets()).toHaveLength(1);

    await club.server.unqueue(club.sessions.get(club.ids[0]!)!, ticket.id);
    expect(club.server.matchTickets()).toHaveLength(0);
    const cancelled = club.events.get(club.ids[0]!)!.find((e) => e.kind === 'cancelled');
    expect(cancelled).toMatchObject({ kind: 'cancelled', reason: 'member' });
    club.close();
  });

  it('expires a ticket, and keeps a disconnected member their place until the grace runs out', async () => {
    const club = await build({ ticketTtlMs: 10_000, disconnectGraceMs: 5_000 });
    await club.queue(club.ids[0]!, 'op-a');
    // The member's API session goes away: the grace clock starts rather than the ticket dying.
    await club.server.disconnect(club.sessions.get(club.ids[0]!)!);
    club.advance(4_000);
    await club.server.runMatchmaking();
    expect(club.server.matchTickets()).toHaveLength(1);

    club.advance(4_000); // past the grace
    await club.server.runMatchmaking();
    expect(club.server.matchTickets()).toHaveLength(0);
    club.close();
  });

  it('pauses, resumes and drains', async () => {
    const club = await build();
    club.server.pauseMatchmaking();
    expect(club.server.matchmakingRunning).toBe(false);
    for (const [i, id] of club.ids.slice(0, 3).entries()) await club.queue(id, `op-${i}`);
    await club.server.runMatchmaking();
    expect(club.server.matchTickets()).toHaveLength(3); // nothing seated while paused

    club.server.resumeMatchmaking();
    expect(club.server.matchmakingRunning).toBe(true);
    await club.server.runMatchmaking();
    expect(club.server.matchTickets()).toHaveLength(0);

    for (const [i, id] of club.ids.slice(0, 3).entries()) await club.queue(id, `again-${i}`);
    expect(club.server.drainMatchmaking()).toBe(3);
    expect(club.server.matchTickets()).toHaveLength(0);
    club.close();
  });

  it('will not match somebody who is already sitting at a table', async () => {
    const club = await build();
    for (const [i, id] of club.ids.slice(0, 3).entries()) await club.queue(id, `op-${i}`);
    await club.server.runMatchmaking();
    expect(club.server.matchTickets()).toHaveLength(0);

    // All three are now seated. Queueing again gets them nowhere until they stand up, however
    // many others turn up: the club reads who is seated from the registry, not from a table
    // snapshot, which keeps a departed player's identity so its hands stay replayable.
    for (const [i, id] of club.ids.slice(0, 3).entries()) await club.queue(id, `again-${i}`);
    await club.queue(club.ids[3]!, 'again-3');
    await club.server.runMatchmaking();
    expect(club.server.matchTickets()).toHaveLength(4);
    club.close();
  });

  it('asks the policy it was given, and refuses a group the policy should not have proposed', async () => {
    let asked = 0;
    const onlyFirstThree: MatchPolicy = {
      group: ({ tickets, template }) => {
        asked++;
        // Deliberately careless: hands back a group of the right size even when it repeats a
        // member, which the club must reject rather than seat.
        if (tickets.length < template.seats) return [];
        const repeat = [tickets[0]!, tickets[0]!, tickets[0]!] as MatchTicket[];
        return [repeat, ...proposeMatches(tickets, template.seats)];
      },
    };
    const club = await build({ policy: onlyFirstThree });
    for (const [i, id] of club.ids.slice(0, 3).entries()) await club.queue(id, `op-${i}`);
    await club.server.runMatchmaking();
    expect(asked).toBeGreaterThan(0);
    // The careless group was dropped; the sound one was seated.
    expect(club.server.matchTickets()).toHaveLength(0);
    const seats = club.registry.tables.flatMap((t) => t.seats.filter(Boolean));
    expect(new Set(seats.map((s) => s!.memberId)).size).toBe(3);
    club.close();
  });
});
