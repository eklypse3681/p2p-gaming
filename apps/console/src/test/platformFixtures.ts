import type { StatusResponse } from '../api/client';
import type { ClubDetail, ClubSummary, Me, PurchaseRow } from '../platform/api';

export const CURRENCY = { code: 'USDC', name: 'Club dollars', decimals: 2 };

/** `/api/status` as the platform server answers it (no dealer fields). */
export function platformStatus(over: Record<string, unknown> = {}): StatusResponse {
  return {
    ok: true,
    mode: 'platform',
    version: '0.1.0',
    dev: true,
    appUrl: 'http://app/',
    uptimeMs: 1,
    clubs: 1,
    tables: 0,
    consoleBuilt: true,
    platformPublicKey: 'PLATFORM_KEY',
    store: { kind: 'memory', dataDir: null, pendingWrites: 0 },
    signedIn: null,
    ...over,
  } as unknown as StatusResponse;
}

export function dealerStatus(): StatusResponse {
  return {
    ok: true,
    version: '0.1.0',
    dataDir: '/tmp/dealer',
    host: '127.0.0.1',
    port: 7777,
    uptimeMs: 1,
    tables: 0,
    running: 0,
    consoleBuilt: true,
    dealer: { id: 'd', name: 'House' },
    settings: {
      appUrl: 'http://app/',
      dealerName: 'House',
      defaultEntropy: 'crypto',
      randomOrgApiKey: '',
      hasRandomOrgKey: false,
      defaultRandomness: 'per-draw',
      consoleToken: '',
    },
  };
}

export function fakeSummary(over: Partial<ClubSummary> = {}): ClubSummary {
  return {
    id: 'c1',
    name: 'Thursday Club',
    tagline: 'Pineapple on Thursdays',
    currency: CURRENCY,
    publicKey: 'CLUB_KEY',
    ownerId: 'm1',
    status: 'active',
    createdAt: 1_700_000_000_000,
    members: 1,
    pendingMembers: 1,
    online: 0,
    reserve: 500_000,
    circulation: 120_000,
    minted: 620_000,
    burned: 0,
    tables: 1,
    rooms: 0,
    ...over,
  };
}

export function fakeMe(over: Partial<Me> = {}): Me {
  return {
    profileId: 'm1',
    name: 'Ann',
    publicKey: 'ANN_KEY',
    operator: false,
    clubs: [{ ...fakeSummary(), role: 'owner' }],
    ...over,
  };
}

export function fakeDetail(over: Partial<ClubDetail> = {}): ClubDetail {
  const { members: _m, online: _o, tables: _t, rooms: _r, ...summary } = fakeSummary();
  return {
    ...summary,
    role: 'owner',
    rooms: [],
    tables: [
      {
        id: 't1',
        roomId: 'r0',
        templateId: 'tp0',
        templateName: 'Pineapple 1/2',
        game: 'ofc',
        code: 'CLUB01',
        seats: [{ name: 'Ann', memberId: 'm1' }, null],
        status: 'open',
        stacks: [20_000, 0],
      },
    ],
    members: [
      {
        id: 'm1',
        name: 'Ann',
        publicKey: 'ANN_KEY',
        role: 'owner',
        status: 'active',
        joinedAt: 1_700_000_000_000,
      },
      {
        id: 'm2',
        name: 'Bob',
        publicKey: 'BOB_KEY',
        role: 'member',
        status: 'pending',
        joinedAt: 1_700_000_100_000,
      },
    ],
    requests: [],
    invites: [],
    online: ['m1'],
    purchases: [],
    games: ['backgammon', 'ofc'],
    minRakeBps: 200,
    ...over,
  };
}

export function fakePurchase(over: Partial<PurchaseRow> = {}): PurchaseRow {
  return {
    id: 'p1',
    clubId: 'c1',
    amount: 100_000,
    priceCents: null,
    method: 'manual',
    reference: 'INV-1',
    status: 'pending',
    certificate: null,
    requestedBy: 'm1',
    createdAt: 1_700_000_200_000,
    paidAt: null,
    ...over,
  };
}

export function body(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

export function authHeader(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.authorization;
}
