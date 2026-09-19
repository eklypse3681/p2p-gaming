import { describe, expect, it } from 'vitest';
import type { Listener, PlayerProfile, TransportProvider } from '@bgf/protocol';
import { createMemoryPair, generateKeyPair, signerFor } from '@bgf/protocol';
import type { LobbyTable, TableTemplate } from '@bgf/protocol';
import type { ClubState, TableRegistry } from '@bgf/club';
import {
  ClubServer,
  addRoom,
  addTemplate,
  createClub,
  issueCertificate,
  mint,
  newClubState,
} from '@bgf/club';
import { connectClub } from './session';
import type { ClubSession } from './session';

/**
 * Matchmaking, end to end, through the same path the app takes.
 *
 * A real `ClubServer` behind a transport, reached by `connectClub` exactly as the Clubs screens
 * reach a club runtime: handshake, capabilities, then two members queueing and being seated at
 * one table. This is the test that would have caught the gap where the web app's `queue` went
 * nowhere, so it drives the production wiring and never the fake.
 */

const GAMES = { ofc: { minSeats: 2, maxSeats: 3 }, backgammon: { minSeats: 2, maxSeats: 2 } };

/** A transport provider that hands every join straight to a club running in this process. */
function providerFor(server: ClubServer): TransportProvider {
  const listener: Listener = { address: 'club', onConnection: () => () => {}, close: () => {} };
  return {
    name: 'memory-club',
    host: async () => listener,
    join: async () => {
      const [serverEnd, clientEnd] = createMemoryPair('club');
      server.accept(serverEnd);
      return clientEnd;
    },
  };
}

/** Enough of a table runtime to hand out seats, so the club has something to seat people at. */
function registry(): TableRegistry {
  const tables: LobbyTable[] = [];
  return {
    list: () => tables,
    async sit(req) {
      let table =
        tables.find((t) => t.id === req.tableId) ??
        tables.find((t) => t.templateId === req.template.id && t.seats.some((s) => s === null));
      if (!table) {
        table = {
          id: `t-${tables.length + 1}`,
          roomId: req.roomId,
          templateId: req.template.id,
          templateName: req.template.name,
          game: req.template.game,
          code: `TABLE${tables.length + 1}`,
          seats: new Array(req.template.seats).fill(null),
          status: 'open',
          stacks: new Array(req.template.seats).fill(0),
        };
        tables.push(table);
      }
      const seat = table.seats.findIndex((s) => s === null);
      if (seat < 0) throw new Error('table full');
      table.seats[seat] = { name: req.member.name, memberId: req.member.id };
      table.stacks[seat] = req.buyIn;
      return { tableId: table.id, code: table.code, game: table.game, seat };
    },
    async leave() {
      return { cashOut: 0 };
    },
    onChange: () => () => {},
  };
}

async function player(
  name: string,
): Promise<{ profile: PlayerProfile; signer: ReturnType<typeof signerFor> }> {
  const keys = await generateKeyPair();
  return {
    profile: { id: `id-${name.toLowerCase()}`, name, publicKey: keys.publicKey },
    signer: signerFor(keys.privateKey),
  };
}

/** An open club with chips to hand out and one two-seat table on offer. */
async function openClub(): Promise<{ server: ClubServer; templateId: string }> {
  const clubKeys = await generateKeyPair();
  const platform = await generateKeyPair();
  const clubSigner = signerFor(clubKeys.privateKey);
  const identity = createClub({
    name: 'The Commons',
    keys: clubKeys,
    currency: { code: 'chips', name: 'Chips', decimals: 0 },
  });

  const { state: withRoom, room } = addRoom(newClubState(identity), { name: 'Main' });
  const { state: withTemplate, template } = addTemplate(
    withRoom,
    room.id,
    {
      name: 'Heads-up pineapple',
      game: 'ofc',
      config: {},
      seats: 2,
      stakes: {
        chipsPerPoint: 10,
        buyIn: { min: 100, max: 10_000, default: 1_000 },
        rake: { basisPoints: 200 },
      },
    } satisfies Omit<TableTemplate, 'id'>,
    GAMES,
  );

  const certificate = await issueCertificate({
    clubId: identity.id,
    currency: 'chips',
    amount: 1_000_000,
    privateKey: platform.privateKey,
  });
  const minted = await mint(withTemplate, certificate.token, clubSigner, {
    platformPublicKey: platform.publicKey,
    now: 1_000,
  });

  let state: ClubState = minted.state;
  const server = new ClubServer({
    state,
    signer: clubSigner,
    tables: registry(),
    games: GAMES,
    persist: (s) => {
      state = s;
    },
    platformPublicKey: platform.publicKey,
    policy: {
      membership: 'open',
      joinGrant: 5_000,
      matchmaking: true,
      custody: { kind: 'hosted', operator: 'The Commons' },
    },
  });
  return { server, templateId: template.id };
}

function connect(
  server: ClubServer,
  who: { profile: PlayerProfile; signer: ReturnType<typeof signerFor> },
): Promise<ClubSession> {
  return connectClub(
    {
      slug: 'tester',
      clubId: 'commons',
      address: 'commons',
      profile: who.profile,
      signer: who.signer,
    },
    {},
    { provider: providerFor(server), attempts: 1, timeoutMs: 5_000 },
  );
}

/** Wait for a predicate over the store, which fills asynchronously as the club answers. */
async function until(
  session: ClubSession,
  predicate: (s: ReturnType<ClubSession['client']['getState']>) => boolean,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate(session.client.getState())) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('matchmaking through the app’s own wiring', () => {
  it('two queued members are matched to one table, each with their own seat', async () => {
    const { server } = await openClub();
    const ada = await connect(server, await player('Ada'));
    const bob = await connect(server, await player('Bob'));

    // The handshake carried the club's declaration, which is what the screens gate on.
    const info = ada.client.getState().info;
    expect(info?.capabilities.matchmaking).toBe(true);
    expect(info?.capabilities.membership).toBe('open');
    expect(info?.capabilities.custody).toEqual({ kind: 'hosted', operator: 'The Commons' });
    expect(ada.client.getState().balance).toBe(5_000);

    ada.client.queue({ game: 'ofc' });
    await until(ada, (s) => s.ticket !== null, 'Ada to be queued');
    expect(ada.client.getState().ticket?.memberId).toBe('id-ada');

    bob.client.queue({ game: 'ofc' });

    await until(ada, (s) => s.seat !== null, 'Ada to be seated');
    await until(bob, (s) => s.seat !== null, 'Bob to be seated');

    const seatA = ada.client.getState().seat!;
    const seatB = bob.client.getState().seat!;
    expect(seatA.tableId).toBe(seatB.tableId);
    expect(seatA.seat).not.toBe(seatB.seat);
    expect(seatA.code).toBe(seatB.code);
    expect(seatA.buyIn).toBeGreaterThan(0);

    // A match ends the queue on both sides.
    expect(ada.client.getState().ticket).toBeNull();
    expect(bob.client.getState().ticket).toBeNull();
    expect(ada.client.getState().queueEnded?.reason).toBe('matched');

    ada.dispose();
    bob.dispose();
    server.close();
  }, 20_000);

  it('a member who cancels is never matched', async () => {
    const { server } = await openClub();
    const ada = await connect(server, await player('Ada'));
    const bob = await connect(server, await player('Bob'));

    ada.client.queue({ game: 'ofc' });
    await until(ada, (s) => s.ticket !== null, 'Ada to be queued');
    ada.client.unqueue();
    await until(ada, (s) => s.ticket === null, 'Ada to leave the queue');

    bob.client.queue({ game: 'ofc' });
    await until(bob, (s) => s.ticket !== null, 'Bob to be queued');
    await new Promise((r) => setTimeout(r, 150));

    expect(bob.client.getState().seat).toBeNull();
    expect(ada.client.getState().seat).toBeNull();
    expect(ada.client.getState().queueEnded?.reason).toBe('member');

    ada.dispose();
    bob.dispose();
    server.close();
  }, 20_000);

  it('incompatible criteria never match', async () => {
    const { server } = await openClub();
    const ada = await connect(server, await player('Ada'));
    const bob = await connect(server, await player('Bob'));

    ada.client.queue({ game: 'ofc' });
    bob.client.queue({ game: 'backgammon' });
    await until(ada, (s) => s.ticket !== null, 'Ada to be queued');
    await until(bob, (s) => s.ticket !== null, 'Bob to be queued');
    await new Promise((r) => setTimeout(r, 150));

    expect(ada.client.getState().seat).toBeNull();
    expect(bob.client.getState().seat).toBeNull();

    ada.dispose();
    bob.dispose();
    server.close();
  }, 20_000);
});
