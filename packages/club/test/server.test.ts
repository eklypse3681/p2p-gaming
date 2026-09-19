import { describe, expect, it } from 'vitest';
import type { LobbyTable, TableTemplate } from '@bgf/protocol';
import { ClubServer, addRoom, addTemplate, verifyLedger } from '../src/index.js';
import type { ClubState } from '../src/index.js';
import {
  GAMES,
  clubFixture,
  connect,
  fakeRegistry,
  flush,
  issue,
  keyedProfile,
} from './helpers.js';

async function table(opts: { reserve?: number } = {}) {
  const f = await clubFixture({ reserve: opts.reserve ?? 10_000 });
  const { state: s1, room } = addRoom(f.state, { name: 'Main' });
  const { state: s2, template } = addTemplate(
    s1,
    room.id,
    {
      name: 'Pineapple',
      game: 'ofc',
      config: {},
      seats: 3,
      stakes: {
        chipsPerPoint: 10,
        buyIn: { min: 100, max: 1_000, default: 500 },
        rake: { basisPoints: 300 },
      },
    },
    GAMES,
  );
  const registry = fakeRegistry(() => template);
  const persisted: ClubState[] = [];
  const server = new ClubServer({
    state: s2,
    signer: f.clubSigner,
    tables: registry,
    games: GAMES,
    now: () => 2_000,
    persist: (s) => persisted.push(s),
    platformPublicKey: f.platformPublicKey,
  });
  const ownerClient = connect(server, f.owner.profile, f.owner.signer);
  await flush();
  const { token } = await server.admin.createInvite({ by: f.owner.profile.id });
  return { f, server, registry, template, room, ownerClient, invite: token, persisted };
}

describe('club server and client', () => {
  it('welcomes members by invite, refuses strangers and pending members, and shows the lobby', async () => {
    const t = await table();
    expect(t.ownerClient.getState().status).toBe('joined');
    expect(t.ownerClient.getState().lobby?.reserve).toBe(10_000);
    const alice = await keyedProfile('Alice');
    const a = connect(t.server, alice.profile, alice.signer, t.invite);
    await flush();
    expect(a.getState().status).toBe('joined');
    expect(a.getState().lobby?.me.member.role).toBe('member');
    expect(a.getState().lobby?.reserve).toBeUndefined();
    expect(a.getState().lobby?.rooms[0]?.templates[0]?.stakes.rake).toEqual({ basisPoints: 300 });
    expect(a.getState().lobby?.online).toContain(alice.profile.id);
    const stranger = await keyedProfile('Mallory');
    const m = connect(t.server, stranger.profile, stranger.signer);
    await flush();
    expect(m.getState().status).toBe('rejected');
    expect(m.getState().rejectReason).toBe('not-a-member');
    const { token: slow } = await t.server.admin.createInvite({
      by: t.f.owner.profile.id,
      autoApprove: false,
    });
    const carol = await keyedProfile('Carol');
    const c = connect(t.server, carol.profile, carol.signer, slow);
    await flush();
    expect(c.getState().rejectReason).toBe('pending');
    t.server.admin.approve(carol.profile.id, t.f.owner.profile.id);
    const c2 = connect(t.server, carol.profile, carol.signer);
    await flush();
    expect(c2.getState().status).toBe('joined');
    // A forged signature (wrong key for the member id) is refused.
    const fake = connect(t.server, { ...alice.profile }, carol.signer);
    await flush();
    expect(fake.getState().rejectReason).toBe('unauthorized');
    for (const x of [a, c2]) x.close();
    t.server.close();
  });

  it('moves chips for sit, results and leave, and the ledger verifies', async () => {
    const t = await table();
    const alice = await keyedProfile('Alice');
    const bob = await keyedProfile('Bob');
    const a = connect(t.server, alice.profile, alice.signer, t.invite);
    const b = connect(t.server, bob.profile, bob.signer, t.invite);
    await flush();
    await t.server.admin.grant(alice.profile.id, 1_000, t.f.owner.profile.id);
    await t.server.admin.grant(bob.profile.id, 1_000, t.f.owner.profile.id);
    await flush();
    expect(a.getState().balance).toBe(1_000);
    a.sit({ templateId: t.template.id });
    await flush();
    expect(a.getState().seat).toMatchObject({ code: 'CODE1', game: 'ofc', seat: 0, buyIn: 500 });
    expect(a.getState().balance).toBe(500);
    expect(t.registry.sitCalls).toHaveLength(1);
    b.sit({ tableId: 't-1', buyIn: 300 });
    await flush();
    expect(b.getState().seat).toMatchObject({ tableId: 't-1', seat: 1, buyIn: 300 });
    expect(b.getState().lobby?.tables[0]?.seats.filter(Boolean)).toHaveLength(2);
    // Too small a buy-in is refused before anyone is seated.
    const carol = await keyedProfile('Carol');
    const c = connect(t.server, carol.profile, carol.signer, t.invite);
    await flush();
    c.sit({ tableId: 't-1', buyIn: 50 });
    await flush();
    expect(c.getState().error?.code).toBe('bad-buy-in');
    c.sit({ tableId: 't-1', buyIn: 200 });
    await flush();
    expect(c.getState().error?.code).toBe('insufficient');
    // A hand: bob loses 6 points to alice at 10 chips/point, 3% rake.
    const { result, burn } = await t.server.recordResult({
      tableId: 't-1',
      game: 'ofc',
      hand: 1,
      transfers: [{ from: bob.profile.id, to: alice.profile.id, points: 6 }],
      stakes: t.template.stakes,
    });
    expect(result?.kind).toBe('result');
    expect(burn?.lines).toEqual([{ account: 'table:t-1:' + alice.profile.id, amount: -1 }]);
    a.leave('t-1');
    await flush();
    expect(a.getState().balance).toBe(500 + 560 - 1);
    b.leave('t-1');
    await flush();
    expect(b.getState().balance).toBe(700 + 240);
    a.transfer(bob.profile.id, 59, 'thanks');
    await flush();
    expect(a.getState().balance).toBe(1_000);
    expect(b.getState().balance).toBe(999);
    a.statement();
    await flush();
    expect(a.getState().statement?.entries.map((e) => e.kind)).toEqual([
      'grant',
      'buy-in',
      'cash-out',
      'transfer',
    ]);
    expect(a.getState().statement?.history?.map((h) => [h.amount, h.balance])).toEqual([
      [1_000, 1_000],
      [-500, 500],
      [559, 1_059],
      [-59, 1_000],
    ]);
    expect(a.getState().statement?.history?.[1]?.description).toBe('Buy-in at table t-1');
    expect(a.getState().statement?.history?.[3]?.description).toMatch(
      /^Transfer to id-bob \(thanks\)/,
    );
    const v = await verifyLedger(t.server.getState().ledger, t.f.identity.publicKey, {
      platformPublicKey: t.f.platformPublicKey,
    });
    expect(v.ok, v.problem?.reason).toBe(true);
    expect(v.totals?.burned).toBe(1);
    expect(t.persisted.length).toBeGreaterThan(5);
    for (const x of [a, b, c]) x.close();
    t.server.close();
  });

  it('mints from a certificate, handles chip requests, chat and multi-device', async () => {
    const t = await table({ reserve: 100 });
    const alice = await keyedProfile('Alice');
    const a1 = connect(t.server, alice.profile, alice.signer, t.invite);
    await flush();
    const a2 = connect(t.server, alice.profile, alice.signer);
    await flush();
    expect(a1.getState().status).toBe('joined');
    expect(a2.getState().status).toBe('joined');
    expect(t.server.online()).toEqual([expect.any(String), alice.profile.id].sort());
    await expect(
      t.server.admin.grant(alice.profile.id, 500, t.f.owner.profile.id),
    ).rejects.toMatchObject({ code: 'reserve' });
    await t.server.admin.mint(await issue(t.f.identity.id, 5_000), t.f.owner.profile.id);
    await flush();
    expect(t.ownerClient.getState().lobby?.reserve).toBe(5_100);
    await expect(
      t.server.admin.mint(await issue(t.f.identity.id, 5), alice.profile.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    a1.requestChips(250, 'buy-in please');
    await flush();
    const req = a1.getState().requests[0]!;
    expect(req.status).toBe('pending');
    await t.server.admin.requests.resolve(req.id, t.f.owner.profile.id, 'granted');
    await flush();
    expect(a1.getState().requests[0]?.status).toBe('granted');
    expect(a2.getState().balance).toBe(250); // the other device sees the balance too
    a2.chat('hello');
    await flush();
    expect(a1.getState().chat[0]).toMatchObject({ from: { id: alice.profile.id }, text: 'hello' });
    expect(t.ownerClient.getState().chat).toHaveLength(1);
    a1.close();
    await flush();
    expect(t.server.online()).toContain(alice.profile.id);
    a2.close();
    await flush();
    expect(t.server.online()).not.toContain(alice.profile.id);
    t.server.close();
  });

  it('refuses a template with rake below the platform minimum', async () => {
    const t = await table();
    expect(() =>
      t.server.admin.rooms.addTemplate(
        t.room.id,
        {
          name: 'Cheap',
          game: 'ofc',
          config: {},
          seats: 2,
          stakes: { chipsPerPoint: 1, rake: { basisPoints: 50 } },
        } as Omit<TableTemplate, 'id'>,
        t.f.owner.profile.id,
      ),
    ).toThrow(/rake must be at least/);
    const tables: LobbyTable[] = t.registry.tables;
    expect(tables).toEqual([]);
    t.server.close();
  });
});
