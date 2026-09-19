import { describe, expect, it } from 'vitest';
import { base64UrlToBytes } from '@bgf/protocol';
import {
  ClubError,
  GENESIS_HASH,
  HOUSE,
  addRoom,
  addTemplate,
  appendEntry,
  approveMember,
  balanceOf,
  balances,
  banMember,
  clubIdFor,
  consumeInvite,
  createClub,
  createInvite,
  deserializeClubState,
  entryHash,
  formatAmount,
  houseBalance,
  lobbyFor,
  removeTemplate,
  requestJoin,
  serializeClubState,
  setRole,
  statementFor,
  updateTemplate,
  verifyInvite,
  verifyLedger,
  verifyStatement,
  tableAccount,
} from '../src/index.js';
import { GAMES, clubFixture, keyedProfile } from './helpers.js';

describe('identity', () => {
  it('derives the club id from the public key and validates the currency', async () => {
    const f = await clubFixture();
    expect(f.identity.id).toBe(clubIdFor(f.clubKeys.publicKey));
    expect(f.identity.id).toHaveLength(43);
    expect(base64UrlToBytes(f.identity.id)).toHaveLength(32);
    expect(() => createClub({ name: '  ', keys: f.clubKeys })).toThrow(ClubError);
    expect(() => createClub({ name: 'x', keys: f.clubKeys, currency: { decimals: 12 } })).toThrow(
      /decimals/,
    );
    expect(formatAmount(1250, { code: 'c', name: 'c', decimals: 2 })).toBe('12.50');
    expect(formatAmount(-5, { code: 'c', name: 'c', decimals: 0 })).toBe('-5');
  });
});

describe('invites', () => {
  it('signs, verifies, expires and counts uses', async () => {
    const f = await clubFixture();
    const { state, token, invite } = await createInvite(
      f.state,
      f.clubSigner,
      { maxUses: 1, expiresAt: 5_000 },
      1_000,
    );
    expect(token.startsWith('p2pc1.')).toBe(true);
    const verified = await verifyInvite(token, f.identity.publicKey, f.identity.id, 2_000);
    expect(verified.nonce).toBe(invite.nonce);
    await expect(
      verifyInvite(token, f.identity.publicKey, f.identity.id, 6_000),
    ).rejects.toMatchObject({ code: 'invite-expired' });
    await expect(
      verifyInvite(token, f.identity.publicKey, 'other-club', 2_000),
    ).rejects.toMatchObject({ code: 'wrong-club' });
    const tampered = token.slice(0, -2) + 'AA';
    await expect(
      verifyInvite(tampered, f.identity.publicKey, f.identity.id, 2_000),
    ).rejects.toMatchObject({ code: 'bad-invite' });
    const used = consumeInvite(state, invite);
    expect(() => consumeInvite(used, invite)).toThrow(/used up/);
    await expect(createInvite(f.state, f.clubSigner, { role: 'owner' })).rejects.toMatchObject({
      code: 'bad-invite',
    });
  });
});

describe('membership', () => {
  it('joins by invite, refreshes known members, and enforces roles', async () => {
    const f = await clubFixture();
    const alice = await keyedProfile('Alice');
    const bob = await keyedProfile('Bob');
    const { state: s1, invite } = await createInvite(f.state, f.clubSigner, { autoApprove: false });
    const j1 = requestJoin(s1, alice.profile, invite, 5);
    expect(j1.member.status).toBe('pending');
    expect(j1.created).toBe(true);
    expect(() => requestJoin(j1.state, bob.profile)).toThrow(/invite/);
    expect(() => approveMember(j1.state, alice.profile.id, alice.profile.id)).toThrow(
      /owner or an admin/,
    );
    const s2 = approveMember(j1.state, alice.profile.id, f.owner.profile.id);
    expect(s2.members.find((m) => m.id === alice.profile.id)?.status).toBe('active');
    // A known member with a different key is refused; the same key refreshes the name.
    expect(() => requestJoin(s2, { ...alice.profile, publicKey: bob.profile.publicKey })).toThrow(
      /different key/,
    );
    const renamed = requestJoin(s2, { ...alice.profile, name: 'Alicia' });
    expect(renamed.member.name).toBe('Alicia');
    expect(renamed.created).toBe(false);
    const s3 = setRole(renamed.state, alice.profile.id, 'admin', f.owner.profile.id);
    expect(() => setRole(s3, f.owner.profile.id, 'member', alice.profile.id)).toThrow(
      /transfer ownership/,
    );
    expect(() => banMember(s3, f.owner.profile.id, alice.profile.id)).toThrow(/owner cannot/);
    const { state: s4 } = await createInvite(s3, f.clubSigner, {});
    const s5 = requestJoin(s4, bob.profile, Object.values(s4.invites)[0]!.invite).state;
    const s6 = banMember(s5, bob.profile.id, alice.profile.id);
    expect(s6.members.find((m) => m.id === bob.profile.id)?.status).toBe('banned');
    const handed = setRole(s6, alice.profile.id, 'owner', f.owner.profile.id);
    expect(handed.members.find((m) => m.id === alice.profile.id)?.role).toBe('owner');
    expect(handed.members.find((m) => m.id === f.owner.profile.id)?.role).toBe('admin');
  });
});

describe('ledger', () => {
  it('chains, signs, verifies and detects tampering', async () => {
    const f = await clubFixture({ reserve: 10_000 });
    const alice = await keyedProfile('Alice');
    const { state: s1, invite } = await createInvite(f.state, f.clubSigner, {});
    const s2 = requestJoin(s1, alice.profile, invite).state;
    const g = await appendEntry(
      s2,
      {
        kind: 'grant',
        lines: [
          { account: HOUSE, amount: -500 },
          { account: alice.profile.id, amount: 500 },
        ],
        ref: { by: f.owner.profile.id },
      },
      f.clubSigner,
      { now: 10 },
    );
    expect(g.entry.seq).toBe(2); // the mint is entry 1
    expect(g.entry.prevHash).toBe(s2.ledger[0]!.hash);
    expect(g.entry.hash).toBe(entryHash(g.entry.prevHash, g.entry));
    expect(s2.ledger[0]!.prevHash).toBe(GENESIS_HASH);
    const t = await appendEntry(
      g.state,
      {
        kind: 'transfer',
        lines: [
          { account: alice.profile.id, amount: -200 },
          { account: f.owner.profile.id, amount: 200 },
        ],
      },
      f.clubSigner,
      { now: 11 },
    );
    expect(balanceOf(t.state, alice.profile.id)).toBe(300);
    expect(balanceOf(t.state, f.owner.profile.id)).toBe(200);
    expect(houseBalance(t.state)).toBe(9_500);
    expect(balances(t.state).get(HOUSE)).toBe(9_500);
    const verified = await verifyLedger(t.state.ledger, f.identity.publicKey, {
      platformPublicKey: f.platformPublicKey,
    });
    expect(verified.ok).toBe(true);
    expect(verified.totals).toEqual({
      minted: 10_000,
      burned: 0,
      reserve: 9_500,
      circulation: 500,
    });
    const tampered = t.state.ledger.map((e, i) =>
      i === 1
        ? {
            ...e,
            lines: [
              { account: HOUSE, amount: -900 },
              { account: alice.profile.id, amount: 900 },
            ],
          }
        : e,
    );
    expect(
      (
        await verifyLedger(tampered, f.identity.publicKey, {
          platformPublicKey: f.platformPublicKey,
        })
      ).problem?.reason,
    ).toBe('hash mismatch');
    const otherKeys = (await keyedProfile('Mallory')).keys;
    expect(
      (
        await verifyLedger(t.state.ledger, otherKeys.publicKey, {
          platformPublicKey: f.platformPublicKey,
        })
      ).problem?.reason,
    ).toBe('bad signature');
    const stmt = statementFor(t.state, alice.profile.id);
    expect(stmt.entries).toHaveLength(2); // grant + transfer; the mint does not touch her
    expect(stmt.balance).toBe(300);
    expect(await verifyStatement(stmt, f.identity.publicKey)).toBe(true);
    expect(await verifyStatement({ ...stmt, balance: 999 }, f.identity.publicKey)).toBe(false);
  });

  it('refuses unbalanced, negative, inactive and out-of-bounds entries', async () => {
    const f = await clubFixture({ reserve: 2_000 });
    const alice = await keyedProfile('Alice');
    const { state: s1, invite } = await createInvite(f.state, f.clubSigner, { autoApprove: false });
    const pending = requestJoin(s1, alice.profile, invite).state;
    await expect(
      appendEntry(
        pending,
        {
          kind: 'grant',
          lines: [
            { account: HOUSE, amount: -5 },
            { account: alice.profile.id, amount: 6 },
          ],
        },
        f.clubSigner,
      ),
    ).rejects.toMatchObject({ code: 'unbalanced' });
    await expect(
      appendEntry(
        pending,
        {
          kind: 'grant',
          lines: [
            { account: HOUSE, amount: -5 },
            { account: alice.profile.id, amount: 5 },
          ],
        },
        f.clubSigner,
      ),
    ).rejects.toMatchObject({ code: 'inactive-member' });
    const active = approveMember(pending, alice.profile.id, f.owner.profile.id);
    await expect(
      appendEntry(
        active,
        {
          kind: 'transfer',
          lines: [
            { account: alice.profile.id, amount: -5 },
            { account: f.owner.profile.id, amount: 5 },
          ],
        },
        f.clubSigner,
      ),
    ).rejects.toMatchObject({ code: 'insufficient' });
    await expect(
      appendEntry(
        active,
        {
          kind: 'grant',
          lines: [
            { account: HOUSE, amount: -5 },
            { account: 'nobody', amount: 5 },
          ],
        },
        f.clubSigner,
      ),
    ).rejects.toMatchObject({ code: 'no-member' });
    const funded = (
      await appendEntry(
        active,
        {
          kind: 'grant',
          lines: [
            { account: HOUSE, amount: -100 },
            { account: alice.profile.id, amount: 100 },
          ],
        },
        f.clubSigner,
      )
    ).state;
    await expect(
      appendEntry(
        funded,
        {
          kind: 'buy-in',
          lines: [
            { account: alice.profile.id, amount: -80 },
            { account: tableAccount('t1'), amount: 80 },
          ],
        },
        f.clubSigner,
        { buyInBounds: { min: 10, max: 50 } },
      ),
    ).rejects.toMatchObject({ code: 'bad-buy-in' });
    const seated = (
      await appendEntry(
        funded,
        {
          kind: 'buy-in',
          lines: [
            { account: alice.profile.id, amount: -40 },
            { account: tableAccount('t1'), amount: 40 },
          ],
        },
        f.clubSigner,
        { buyInBounds: { min: 10, max: 50 } },
      )
    ).state;
    await expect(
      appendEntry(
        seated,
        {
          kind: 'cash-out',
          lines: [
            { account: tableAccount('t1'), amount: -50 },
            { account: alice.profile.id, amount: 50 },
          ],
        },
        f.clubSigner,
      ),
    ).rejects.toMatchObject({ code: 'insufficient' });
    await expect(
      appendEntry(
        seated,
        {
          kind: 'adjust',
          lines: [
            { account: alice.profile.id, amount: 10 },
            { account: HOUSE, amount: -10 },
          ],
          ref: { by: alice.profile.id },
        },
        f.clubSigner,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Adjustments may not credit the house (that would be printing chips); they may hand some out.
    await expect(
      appendEntry(
        seated,
        {
          kind: 'adjust',
          lines: [
            { account: alice.profile.id, amount: -1000 },
            { account: HOUSE, amount: 1000 },
          ],
          ref: { by: f.owner.profile.id, note: 'test' },
        },
        f.clubSigner,
      ),
    ).rejects.toMatchObject({ code: 'bad-entry' });
    const adjusted = await appendEntry(
      seated,
      {
        kind: 'adjust',
        lines: [
          { account: alice.profile.id, amount: 25 },
          { account: HOUSE, amount: -25 },
        ],
        ref: { by: f.owner.profile.id, note: 'comp' },
      },
      f.clubSigner,
    );
    expect(balanceOf(adjusted.state, alice.profile.id)).toBe(85);
    // The reserve cannot be overdrawn: the club must mint more first.
    await expect(
      appendEntry(
        adjusted.state,
        {
          kind: 'grant',
          lines: [
            { account: HOUSE, amount: -5_000 },
            { account: alice.profile.id, amount: 5_000 },
          ],
        },
        f.clubSigner,
      ),
    ).rejects.toMatchObject({ code: 'reserve' });
  });
});

describe('rooms and templates', () => {
  it('validates templates against the game registry', async () => {
    const f = await clubFixture();
    const { state: s1, room } = addRoom(f.state, { name: 'Main' });
    const base = {
      name: 'Pineapple',
      game: 'ofc',
      config: {},
      seats: 3,
      stakes: { chipsPerPoint: 1, buyIn: { min: 10, max: 100, default: 50 } },
    };
    const { state: s2, template } = addTemplate(s1, room.id, base, GAMES);
    expect(template.id).toBeTruthy();
    expect(() => addTemplate(s2, room.id, { ...base, seats: 4 }, GAMES)).toThrow(/seats/);
    expect(() => addTemplate(s2, room.id, { ...base, game: 'poker' }, GAMES)).toThrow(
      /unknown game/,
    );
    expect(() =>
      addTemplate(
        s2,
        room.id,
        { ...base, stakes: { chipsPerPoint: 1, buyIn: { min: 50, max: 10, default: 20 } } },
        GAMES,
      ),
    ).toThrow(/buy-in/);
    const s3 = updateTemplate(s2, template.id, { name: 'Pineapple 2-7' }, GAMES);
    expect(s3.rooms[0]!.templates[0]!.name).toBe('Pineapple 2-7');
    const s4 = removeTemplate(s3, template.id);
    expect(s4.rooms[0]!.templates).toHaveLength(0);
    expect(() => removeTemplate(s4, template.id)).toThrow(/no such template/);
  });
});

describe('lobby and serialisation', () => {
  it('projects a member view and round-trips state', async () => {
    const f = await clubFixture();
    const lobby = lobbyFor(f.state, [], f.owner.profile.id, [f.owner.profile.id]);
    expect(lobby.me.member.role).toBe('owner');
    expect(lobby.me.balance).toBe(0);
    expect(lobby.reserve).toBe(0);
    expect(() => lobbyFor(f.state, [], 'ghost', [])).toThrow(/no such member/);
    const text = serializeClubState(f.state);
    const back = deserializeClubState(text);
    expect(back).toEqual(f.state);
    expect(() => deserializeClubState('{"version":9}')).toThrow(/version/);
    expect(() => deserializeClubState('nope')).toThrow(/JSON/);
  });
});
