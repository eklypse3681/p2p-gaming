import { describe } from 'vitest';
import type { ConformanceMember, ConformanceTarget } from '@bgf/club-spec/conformance';
import type { MatchPolicy } from '@bgf/club-spec';
import { runClubConformance } from '@bgf/club-spec/conformance';
import type { SettlementMode } from '@bgf/club-spec';
import type { LedgerEntry, PlayerProfile, TableTemplate } from '@bgf/protocol';
import { createMemoryPair } from '@bgf/protocol';
import { ClubServer, HOUSE, RemoteClub, addRoom, addTemplate } from '../src/index.js';
import type { ClubState } from '../src/index.js';
import { GAMES, clubFixture, fakeRegistry, keyedProfile } from './helpers.js';

/**
 * The reference implementation held to the specification, in both settlement modes. Members are
 * pre-seated on the roster so the suite can authenticate without knowing about invites; a
 * stranger is left off it so the `not-a-member` path is exercised too.
 */
interface Built {
  server: ClubServer;
  members: ConformanceMember[];
  strangers: ConformanceMember[];
  templateId: string;
  ownerId: string;
  fund(memberId: string, amount: number): Promise<void>;
  ban(memberId: string): Promise<void>;
  advance(ms: number): Promise<void>;
}

async function build(settlement: SettlementMode, matchPolicy?: MatchPolicy): Promise<Built> {
  const fixture = await clubFixture({ reserve: 10_000_000 });
  const { state: withRoom, room } = addRoom(fixture.state, { name: 'Main' });
  const { state: withTemplate, template } = addTemplate(
    withRoom,
    room.id,
    {
      name: 'Conformance table',
      game: 'ofc',
      config: {},
      seats: 2,
      stakes: {
        chipsPerPoint: 10,
        buyIn: { min: 1, max: 1_000_000, default: 1_000 },
        rake: { basisPoints: 200 },
      },
    } satisfies Omit<TableTemplate, 'id'>,
    GAMES,
  );

  const people = await Promise.all([keyedProfile('Ada'), keyedProfile('Bob'), keyedProfile('Cy')]);
  const stranger = await keyedProfile('Mallory');

  // Seat the three on the roster directly: the suite authenticates, it does not negotiate invites.
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
  const registry = fakeRegistry(() => template);
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
    ...(matchPolicy ? { matchPolicy } : {}),
    policy: {
      settlement,
      membership: 'invite',
      commitmentTtlMs: 60_000,
      custody: { kind: 'hosted', operator: 'Conformance Host' },
    },
  });

  const members: ConformanceMember[] = people.map((p) => ({
    profile: p.profile as PlayerProfile,
    signer: p.signer,
  }));

  return {
    server,
    members,
    strangers: [{ profile: stranger.profile as PlayerProfile, signer: stranger.signer }],
    templateId: template.id,
    ownerId: fixture.owner.profile.id,
    fund: async (memberId, amount) => {
      await server.admin.grant(memberId, amount, fixture.owner.profile.id, 'conformance stake');
    },
    ban: async (memberId) => {
      server.admin.ban(memberId, fixture.owner.profile.id);
    },
    advance: async (ms) => {
      clock += ms;
      // Touch the club so expiry is noticed without waiting for a member to act.
      await server.info();
      for (const m of members) {
        await server
          .lobby({ member: { id: m.profile.id } as never, token: 'none' })
          .catch(() => undefined);
      }
    },
  };
}

/** The reference implementation, called directly. */
async function targetFor(
  settlement: SettlementMode,
  matchPolicy?: MatchPolicy,
): Promise<ConformanceTarget> {
  const built = await build(settlement, matchPolicy);
  return {
    club: built.server,
    members: built.members,
    strangers: built.strangers,
    templateId: built.templateId,
    fund: built.fund,
    ban: built.ban,
    advance: built.advance,
    withPolicy: (policy) => targetFor(settlement, policy),
    close: async () => built.server.close(),
  };
}

/** The same club, reached over the wire, so the protocol is held to the spec too. */
async function remoteTargetFor(settlement: SettlementMode): Promise<ConformanceTarget> {
  const built = await build(settlement);
  const remote = new RemoteClub({
    connect: () => {
      const [serverEnd, clientEnd] = createMemoryPair('club');
      built.server.accept(serverEnd);
      return clientEnd;
    },
  });
  for (const m of [...built.members, ...built.strangers]) remote.register(m.profile);
  return {
    club: remote,
    members: built.members,
    strangers: built.strangers,
    templateId: built.templateId,
    fund: built.fund,
    ban: built.ban,
    advance: built.advance,
    close: async () => {
      remote.closeAll();
      built.server.close();
    },
  };
}

/** The chip economy must still verify after the suite has finished with it. */
export function ledgerOf(state: ClubState): LedgerEntry[] {
  return state.ledger.filter((e) => e.lines.some((l) => l.account !== HOUSE));
}

describe('ClubServer (immediate settlement)', () =>
  runClubConformance({
    name: 'ClubServer (immediate)',
    create: () => targetFor('immediate'),
  }));

describe('ClubServer (deferred settlement)', () =>
  runClubConformance({
    name: 'ClubServer (deferred)',
    create: () => targetFor('deferred'),
  }));

describe('RemoteClub over a transport (immediate settlement)', () =>
  runClubConformance({
    name: 'RemoteClub (immediate)',
    create: () => remoteTargetFor('immediate'),
  }));
