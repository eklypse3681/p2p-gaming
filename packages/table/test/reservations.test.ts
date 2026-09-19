import { describe, expect, it } from 'vitest';
import type { PlayerProfile } from '@bgf/protocol';
import { createMemoryPair, generateKeyPair, signerFor } from '@bgf/protocol';
import type { GameDefinition } from '../src/index.js';
import { TableClient, TableServer } from '../src/index.js';

interface S {
  n: number;
}
type A = { type: 'inc' };
type C = { type: 'inc' };
const toy: GameDefinition<S, A, C> = {
  id: 'toy',
  minSeats: 2,
  maxSeats: 3,
  init: () => ({ n: 0 }),
  validateCommand: (raw) =>
    typeof raw === 'object' && raw !== null && (raw as C).type === 'inc' ? (raw as C) : null,
  command: () => ({ type: 'inc' }),
  reduce: (s) => ({ n: s.n + 1 }),
  view: (s) => s,
};

async function keyed(id: string, name = id) {
  const keys = await generateKeyPair();
  const profile: PlayerProfile = { id, name, publicKey: keys.publicKey };
  return { profile, signer: signerFor(keys.privateKey), keys };
}

function connect(
  server: TableServer<S, A, C>,
  profile: PlayerProfile,
  signer?: ReturnType<typeof signerFor>,
) {
  const [se, ce] = createMemoryPair('res');
  server.accept(se);
  return new TableClient<S>({ transport: ce, profile, signer, pingIntervalMs: 0 });
}

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 2));
};

async function dealerTable(options: Record<string, unknown> = {}, now?: () => number) {
  const dealer = await keyed('dealer', 'House');
  const server = new TableServer<S, A, C>({
    def: toy,
    config: {},
    code: 'RSV001',
    host: dealer.profile,
    hostSeat: null,
    seats: 3,
    options,
    ...(now ? { now } : {}),
  });
  return { server, dealer };
}

describe('seat reservations', () => {
  it('a reserved seat admits the reserved key and nobody else', async () => {
    const { server } = await dealerTable();
    const alice = await keyed('alice');
    const other = await keyed('alice'); // same profile id, different key
    const bob = await keyed('bob');
    server.reserveSeat(1, { profileId: 'alice', publicKey: alice.profile.publicKey! });
    expect(Object.keys(server.reservations())).toEqual(['1']);

    const impostor = connect(server, other.profile, other.signer);
    const stranger = connect(server, bob.profile, bob.signer);
    await settle();
    expect(impostor.getState().status).toBe('rejected');
    expect(impostor.getState().rejectReason).toBe('unauthorized');
    // Bob is not refused outright: seat 0 is free on an ordinary table, only seat 1 is held.
    expect(stranger.getState().status).toBe('joined');
    expect(stranger.getState().seat).toBe(0);

    const real = connect(server, alice.profile, alice.signer);
    await settle();
    expect(real.getState().status).toBe('joined');
    expect(real.getState().seat).toBe(1);
    expect(server.reservations()).toEqual({});
    expect(server.getSnapshot().seats[1]?.publicKey).toBe(alice.profile.publicKey);
    impostor.close();
    stranger.close();
    real.close();
    server.close();
  });

  it('an unkeyed hello cannot take a reserved seat', async () => {
    const { server } = await dealerTable();
    const alice = await keyed('alice');
    server.reserveSeat(0, { profileId: 'alice', publicKey: alice.profile.publicKey! });
    const legacy = connect(server, { id: 'alice', name: 'alice' });
    await settle();
    expect(legacy.getState().status).toBe('rejected');
    legacy.close();
    server.close();
  });

  it('invitation-only tables refuse every unreserved seat', async () => {
    const { server } = await dealerTable({ invitationOnly: true });
    const bob = await keyed('bob');
    const alice = await keyed('alice');
    const uninvited = connect(server, bob.profile, bob.signer);
    await settle();
    expect(uninvited.getState().status).toBe('rejected');
    expect(uninvited.getState().rejectReason).toBe('unauthorized');
    expect(server.connectedSeats()).toEqual([]);

    server.reserveSeat(2, { profileId: 'alice', publicKey: alice.profile.publicKey! });
    const invited = connect(server, alice.profile, alice.signer);
    await settle();
    expect(invited.getState().status).toBe('joined');
    expect(invited.getState().seat).toBe(2);
    // Once seated the key is bound: a second device of the same player still gets in.
    const phone = connect(server, alice.profile, alice.signer);
    await settle();
    expect(phone.getState().seat).toBe(2);
    uninvited.close();
    invited.close();
    phone.close();
    server.close();
  });

  it('release and expiry free the seat again', async () => {
    let now = 1_000_000;
    const { server } = await dealerTable({}, () => now);
    const alice = await keyed('alice');
    const bob = await keyed('bob');
    server.reserveSeat(0, {
      profileId: 'alice',
      publicKey: alice.profile.publicKey!,
      expiresAt: now + 1_000,
    });
    server.reserveSeat(1, { profileId: 'bob', publicKey: bob.profile.publicKey! });
    expect(Object.keys(server.reservations()).sort()).toEqual(['0', '1']);
    server.releaseSeat(1);
    expect(Object.keys(server.reservations())).toEqual(['0']);
    now += 2_000;
    expect(server.reservations()).toEqual({});
    // Reserving a seat held for someone else, or a taken seat, is refused.
    server.reserveSeat(0, { profileId: 'bob', publicKey: bob.profile.publicKey! });
    expect(() =>
      server.reserveSeat(0, { profileId: 'alice', publicKey: alice.profile.publicKey! }),
    ).toThrow(/reserved for another/);
    const client = connect(server, bob.profile, bob.signer);
    await settle();
    expect(client.getState().seat).toBe(0);
    expect(() =>
      server.reserveSeat(0, { profileId: 'alice', publicKey: alice.profile.publicKey! }),
    ).toThrow(/taken by another/);
    client.close();
    server.close();
  });
});
