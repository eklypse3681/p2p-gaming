import { describe, expect, it } from 'vitest';
import {
  HOUSE,
  PLATFORM_MIN_RAKE_BPS,
  appendEntry,
  burn,
  burned,
  circulation,
  createInvite,
  decodeCertificate,
  issueCertificate,
  mint,
  minted,
  rakeFor,
  requestJoin,
  reserve,
  seatStack,
  settleHand,
  tableAccount,
  verifyCertificate,
  verifyLedger,
} from '../src/index.js';
import { clubFixture, issue, keyedProfile, platformKeys } from './helpers.js';

describe('platform certificates', () => {
  it('issue, verify, tamper, expiry, wrong club', async () => {
    const platform = await platformKeys();
    const { token, certificate } = await issueCertificate({
      clubId: 'club-1',
      currency: 'chips',
      amount: 5_000,
      privateKey: platform.privateKey,
      now: 1_000,
      expiresAt: 2_000,
    });
    expect(token.startsWith('p2pm1.')).toBe(true);
    expect(decodeCertificate(token).certificate).toEqual(certificate);
    expect(await verifyCertificate(token, platform.publicKey, 1_500)).toEqual(certificate);
    await expect(verifyCertificate(token, platform.publicKey, 3_000)).rejects.toMatchObject({
      code: 'certificate-expired',
    });
    const other = (await keyedProfile('Mallory')).keys;
    await expect(verifyCertificate(token, other.publicKey, 1_500)).rejects.toMatchObject({
      code: 'bad-certificate',
    });
    const [p, payload, sig] = token.split('.');
    const forged = `${p}.${payload!.slice(0, -1)}${payload!.endsWith('A') ? 'B' : 'A'}.${sig}`;
    await expect(verifyCertificate(forged, platform.publicKey, 1_500)).rejects.toMatchObject({
      code: 'bad-certificate',
    });
    await expect(
      issueCertificate({
        clubId: 'c',
        currency: 'chips',
        amount: 0,
        privateKey: platform.privateKey,
      }),
    ).rejects.toMatchObject({ code: 'bad-certificate' });
  });

  it('mints into the reserve once per certificate, for the right club and currency', async () => {
    const f = await clubFixture();
    const token = await issue(f.identity.id, 1_000);
    const m = await mint(f.state, token, f.clubSigner, {
      platformPublicKey: f.platformPublicKey,
      now: 5,
    });
    expect(reserve(m.state)).toBe(1_000);
    expect(minted(m.state)).toBe(1_000);
    expect(m.entry.kind).toBe('mint');
    await expect(
      mint(m.state, token, f.clubSigner, { platformPublicKey: f.platformPublicKey }),
    ).rejects.toMatchObject({ code: 'certificate-used' });
    await expect(
      mint(m.state, await issue('someone-else', 10), f.clubSigner, {
        platformPublicKey: f.platformPublicKey,
      }),
    ).rejects.toMatchObject({ code: 'wrong-club' });
    await expect(
      mint(m.state, await issue(f.identity.id, 10, 'USDC'), f.clubSigner, {
        platformPublicKey: f.platformPublicKey,
      }),
    ).rejects.toMatchObject({ code: 'bad-certificate' });
    // Against the wrong platform key the certificate is unbacked.
    await expect(mint(f.state, token, f.clubSigner)).rejects.toMatchObject({
      code: 'bad-certificate',
    });
  });
});

describe('rake', () => {
  it('settles a hand into stacks and burns the rake from the winners', () => {
    const stakes = { chipsPerPoint: 10, rake: { basisPoints: 500, cap: 40 } };
    const settled = settleHand({
      tableId: 't1',
      game: 'ofc',
      hand: 3,
      transfers: [
        { from: 'b', to: 'a', points: 6 },
        { from: 'c', to: 'a', points: 6 },
        { from: 'c', to: 'b', points: 2 },
      ],
      stakes,
    });
    // a +120, b -60+20 = -40, c -60-20 = -80 → moved 120
    expect(settled.moved).toBe(120);
    expect(settled.result.lines).toEqual(
      expect.arrayContaining([
        { account: tableAccount('t1', 'a'), amount: 120 },
        { account: tableAccount('t1', 'b'), amount: -40 },
        { account: tableAccount('t1', 'c'), amount: -80 },
      ]),
    );
    expect(settled.rake).toBe(6); // 5% of 120, under the cap
    expect(settled.burn?.lines).toEqual([{ account: tableAccount('t1', 'a'), amount: -6 }]);
    expect(settled.burn?.ref).toMatchObject({
      tableId: 't1',
      hand: 3,
      basisPoints: 500,
      moved: 120,
    });
    const capped = settleHand({
      tableId: 't1',
      game: 'ofc',
      transfers: [{ from: 'b', to: 'a', points: 100 }],
      stakes,
    });
    expect(capped.rake).toBe(40);
    // Below the platform minimum the minimum applies.
    const low = settleHand({
      tableId: 't1',
      game: 'ofc',
      transfers: [{ from: 'b', to: 'a', points: 100 }],
      stakes: { chipsPerPoint: 10, rake: { basisPoints: 1 } },
    });
    expect(low.basisPoints).toBe(PLATFORM_MIN_RAKE_BPS);
    expect(low.rake).toBe(rakeFor(1_000, PLATFORM_MIN_RAKE_BPS));
    // Two winners share the rake in proportion.
    const two = settleHand({
      tableId: 't1',
      game: 'ofc',
      transfers: [
        { from: 'c', to: 'a', points: 30 },
        { from: 'c', to: 'b', points: 10 },
      ],
      stakes: { chipsPerPoint: 10 },
    });
    expect(two.burn?.lines).toEqual(
      expect.arrayContaining([
        { account: tableAccount('t1', 'a'), amount: -6 },
        { account: tableAccount('t1', 'b'), amount: -2 },
      ]),
    );
    // Points-only tables move nothing.
    const none = settleHand({
      tableId: 't1',
      game: 'ofc',
      transfers: [{ from: 'b', to: 'a', points: 6 }],
      stakes: { chipsPerPoint: 0 },
    });
    expect(none.result.lines).toEqual([]);
    expect(none.burn).toBeNull();
  });
});

describe('ledger economy invariants', () => {
  async function session() {
    const f = await clubFixture({ reserve: 10_000 });
    const alice = await keyedProfile('Alice');
    const bob = await keyedProfile('Bob');
    const { state: s1, invite } = await createInvite(f.state, f.clubSigner, {});
    let state = requestJoin(s1, alice.profile, invite).state;
    state = requestJoin(state, bob.profile, invite).state;
    const sign = f.clubSigner;
    const opts = { platformPublicKey: f.platformPublicKey };
    const grant = async (id: string, amount: number) =>
      (state = (
        await appendEntry(
          state,
          {
            kind: 'grant',
            lines: [
              { account: HOUSE, amount: -amount },
              { account: id, amount },
            ],
            ref: { by: f.owner.profile.id },
          },
          sign,
        )
      ).state);
    await grant(alice.profile.id, 1_000);
    await grant(bob.profile.id, 1_000);
    const buyIn = async (id: string, amount: number) =>
      (state = (
        await appendEntry(
          state,
          {
            kind: 'buy-in',
            lines: [
              { account: id, amount: -amount },
              { account: tableAccount('t1', id), amount },
            ],
            ref: { tableId: 't1' },
          },
          sign,
          { buyInBounds: { min: 100, max: 1_000 } },
        )
      ).state);
    await buyIn(alice.profile.id, 500);
    await buyIn(bob.profile.id, 500);
    return { f, alice, bob, get: () => state, set: (s: typeof state) => (state = s), sign, opts };
  }

  it('holds minted − burned = circulation + reserve through a whole session', async () => {
    const s = await session();
    const stakes = { chipsPerPoint: 10, rake: { basisPoints: 300 } };
    for (let hand = 1; hand <= 5; hand++) {
      const winner = hand % 2 ? s.alice : s.bob;
      const loser = hand % 2 ? s.bob : s.alice;
      const settled = settleHand({
        tableId: 't1',
        game: 'ofc',
        hand,
        transfers: [{ from: loser.profile.id, to: winner.profile.id, points: 4 }],
        stakes,
      });
      s.set((await appendEntry(s.get(), settled.result, s.sign)).state);
      s.set(
        (await burn(s.get(), { lines: settled.burn!.lines, ref: settled.burn!.ref }, s.sign)).state,
      );
      const v = await verifyLedger(s.get().ledger, s.f.identity.publicKey, s.opts);
      expect(v.ok, v.problem?.reason).toBe(true);
      expect(minted(s.get()) - burned(s.get())).toBe(circulation(s.get()) + reserve(s.get()));
    }
    expect(burned(s.get())).toBe(5); // 3% of 40 chips per hand, floored
    for (const who of [s.alice, s.bob]) {
      const stack = seatStack(s.get(), 't1', who.profile.id);
      s.set(
        (
          await appendEntry(
            s.get(),
            {
              kind: 'cash-out',
              lines: [
                { account: tableAccount('t1', who.profile.id), amount: -stack },
                { account: who.profile.id, amount: stack },
              ],
              ref: { tableId: 't1' },
            },
            s.sign,
          )
        ).state,
      );
    }
    s.set(
      (
        await appendEntry(
          s.get(),
          {
            kind: 'redeem',
            lines: [
              { account: s.alice.profile.id, amount: -100 },
              { account: HOUSE, amount: 100 },
            ],
            ref: { by: s.f.owner.profile.id },
          },
          s.sign,
        )
      ).state,
    );
    const final = await verifyLedger(s.get().ledger, s.f.identity.publicKey, s.opts);
    expect(final.ok).toBe(true);
    expect(final.totals).toEqual({ minted: 10_000, burned: 5, reserve: 8_100, circulation: 1_895 });
  });

  it('the verifier rejects unbacked house credits, missing or thin rake, and reused certificates', async () => {
    const s = await session();
    const clubOnly = { kind: 'grant' as const };
    void clubOnly;
    // An entry crafted to credit the house outside mint/redeem/fee: build it by hand and sign it.
    const forgeHouseCredit = async () => {
      const base = s.get();
      const draft = {
        kind: 'result' as const,
        lines: [
          { account: HOUSE, amount: 50 },
          { account: s.alice.profile.id, amount: -50 },
        ],
      };
      // appendEntry refuses it; emulate a rogue runtime by bypassing validation.
      const { entryHash } = await import('../src/index.js');
      const last = base.ledger[base.ledger.length - 1]!;
      const body = { seq: last.seq + 1, at: 9, kind: draft.kind, lines: draft.lines };
      const hash = entryHash(last.hash, body);
      const { bytesToBase64Url } = await import('@bgf/protocol');
      const { utf8Bytes } = await import('@bgf/table');
      const signature = bytesToBase64Url(await s.sign(utf8Bytes(hash)));
      return [...base.ledger, { ...body, prevHash: last.hash, hash, signature }];
    };
    const rogue = await forgeHouseCredit();
    expect((await verifyLedger(rogue, s.f.identity.publicKey, s.opts)).problem?.reason).toMatch(
      /house credited/,
    );

    const stakes = { chipsPerPoint: 10 };
    const settled = settleHand({
      tableId: 't1',
      game: 'ofc',
      hand: 1,
      transfers: [{ from: s.bob.profile.id, to: s.alice.profile.id, points: 20 }],
      stakes,
    });
    const withResult = (await appendEntry(s.get(), settled.result, s.sign)).state;
    // Result without its burn.
    expect(
      (await verifyLedger(withResult.ledger, s.f.identity.publicKey, s.opts)).problem?.reason,
    ).toMatch(/not raked/);
    // Burn that is too small.
    const thin = (
      await burn(
        withResult,
        {
          lines: [{ account: tableAccount('t1', s.alice.profile.id), amount: -1 }],
          ref: settled.burn!.ref,
        },
        s.sign,
      )
    ).state;
    expect(
      (await verifyLedger(thin.ledger, s.f.identity.publicKey, s.opts)).problem?.reason,
    ).toMatch(/not raked/);
    // Proper burn verifies.
    const good = (
      await burn(withResult, { lines: settled.burn!.lines, ref: settled.burn!.ref }, s.sign)
    ).state;
    expect((await verifyLedger(good.ledger, s.f.identity.publicKey, s.opts)).ok).toBe(true);

    // A reused certificate: replay the mint entry's token into a second mint by hand.
    const first = s.get().ledger[0]!;
    const { entryHash } = await import('../src/index.js');
    const { bytesToBase64Url } = await import('@bgf/protocol');
    const { utf8Bytes } = await import('@bgf/table');
    const last = good.ledger[good.ledger.length - 1]!;
    const body = {
      seq: last.seq + 1,
      at: 10,
      kind: 'mint' as const,
      lines: first.lines,
      ref: first.ref,
    };
    const hash = entryHash(last.hash, body);
    const replayed = [
      ...good.ledger,
      {
        ...body,
        prevHash: last.hash,
        hash,
        signature: bytesToBase64Url(await s.sign(utf8Bytes(hash))),
      },
    ];
    expect((await verifyLedger(replayed, s.f.identity.publicKey, s.opts)).problem?.reason).toBe(
      'certificate reused',
    );
  });
});
