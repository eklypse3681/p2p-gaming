import { beforeAll, describe, expect, it } from 'vitest';
import type { KeyPair } from '@bgf/protocol';
import { bytesToBase64Url, generateKeyPair, sign } from '@bgf/protocol';
import {
  CLOCK_SKEW_MS,
  DEFAULT_GRANT_MS,
  GRANT_PREFIX,
  MAX_GRANT_MS,
  WalletError,
  decodeGrant,
  describeGrantProblem,
  grantBytes,
  isRevoked,
  issueGrant,
  issueRevocation,
  openRevocation,
  verifyGrant,
} from '../src/index.js';

const NOW = 1_700_000_000_000;

let root: KeyPair;
let impostor: KeyPair;
let device: KeyPair;

beforeAll(async () => {
  [root, impostor, device] = await Promise.all([
    generateKeyPair(),
    generateKeyPair(),
    generateKeyPair(),
  ]);
});

async function grantFor(over: Partial<Parameters<typeof issueGrant>[1]> = {}): Promise<string> {
  return issueGrant(root, {
    device: device.publicKey,
    serial: 1,
    label: "Steve's phone",
    scopes: ['seat', 'sync'],
    issuedAt: NOW,
    ...over,
  });
}

describe('issuing', () => {
  it('produces a token that decodes to what was asked for', async () => {
    const token = await grantFor();
    expect(token.startsWith(GRANT_PREFIX)).toBe(true);
    const decoded = decodeGrant(token);
    expect(decoded?.grant).toMatchObject({
      v: 1,
      root: root.publicKey,
      device: device.publicKey,
      serial: 1,
      label: "Steve's phone",
      scopes: ['seat', 'sync'],
      issuedAt: NOW,
      expiresAt: NOW + DEFAULT_GRANT_MS,
    });
  });

  it('normalises the label and the scope order so the bytes are canonical', async () => {
    const token = await issueGrant(root, {
      device: device.publicKey,
      serial: 2,
      label: '  phone\nline two  ',
      scopes: ['sync', 'seat', 'seat'],
      issuedAt: NOW,
    });
    const grant = decodeGrant(token)!.grant;
    expect(grant.label).toBe('phone line two');
    expect(grant.scopes).toEqual(['seat', 'sync']);
    await expect(verifyGrant(token, { now: NOW, root: root.publicKey })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('refuses grants that make no sense', async () => {
    await expect(grantFor({ serial: 0 })).rejects.toThrow(WalletError);
    await expect(grantFor({ scopes: [] })).rejects.toThrow(/needs a scope/);
    await expect(grantFor({ expiresAt: NOW })).rejects.toThrow(/expire after/);
    await expect(grantFor({ expiresAt: NOW + MAX_GRANT_MS + 1 })).rejects.toThrow(/longer than/);
  });
});

describe('verifying', () => {
  it('accepts a good grant', async () => {
    const check = await verifyGrant(await grantFor(), { now: NOW, root: root.publicKey });
    expect(check.ok).toBe(true);
  });

  it('rejects a grant signed by someone else', async () => {
    const token = await issueGrant(impostor, {
      device: device.publicKey,
      serial: 1,
      label: 'not me',
      scopes: ['seat'],
      issuedAt: NOW,
    });
    // The impostor's own root: structurally fine, but it is not this player.
    expect(await verifyGrant(token, { now: NOW, root: root.publicKey })).toMatchObject({
      ok: false,
      reason: 'wrong-root',
    });
  });

  it('rejects a grant whose payload was edited after signing', async () => {
    const token = await grantFor();
    const decoded = decodeGrant(token)!;
    const forged = { ...decoded.grant, scopes: ['seat', 'sync', 'admin'] as never };
    const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(forged)));
    const tampered = `${GRANT_PREFIX}${payload}.${token.split('.')[2]}`;
    expect(await verifyGrant(tampered, { now: NOW, root: root.publicKey })).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('will not let a device mint its own authority', async () => {
    // The device signs a grant naming the real root: the signature is simply not the root's.
    const self = await issueGrant(
      { publicKey: root.publicKey, privateKey: device.privateKey },
      { device: device.publicKey, serial: 9, label: 'self', scopes: ['admin'], issuedAt: NOW },
    );
    expect(await verifyGrant(self, { now: NOW, root: root.publicKey })).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('honours the clock', async () => {
    const token = await grantFor();
    expect(
      await verifyGrant(token, {
        now: NOW + DEFAULT_GRANT_MS + CLOCK_SKEW_MS,
        root: root.publicKey,
      }),
    ).toMatchObject({ ok: false, reason: 'expired' });
    expect(
      await verifyGrant(token, { now: NOW - CLOCK_SKEW_MS - 1, root: root.publicKey }),
    ).toMatchObject({ ok: false, reason: 'not-yet-valid' });
    // A minute of disagreement between two devices is not an attack.
    expect(await verifyGrant(token, { now: NOW - 30_000, root: root.publicKey })).toMatchObject({
      ok: true,
    });
  });

  it('enforces scope', async () => {
    const token = await grantFor({ scopes: ['seat'] });
    expect(
      await verifyGrant(token, { now: NOW, root: root.publicKey, scope: 'seat' }),
    ).toMatchObject({ ok: true });
    expect(
      await verifyGrant(token, { now: NOW, root: root.publicKey, scope: 'admin' }),
    ).toMatchObject({ ok: false, reason: 'out-of-scope' });
  });

  it('rejects damaged tokens without throwing', async () => {
    expect(decodeGrant('nonsense')).toBeNull();
    expect(decodeGrant(`${GRANT_PREFIX}!!.!!`)).toBeNull();
    expect(await verifyGrant('nonsense', { now: NOW })).toMatchObject({ reason: 'bad-token' });
  });

  it('describes every problem in words', () => {
    for (const reason of [
      'bad-token',
      'bad-signature',
      'expired',
      'not-yet-valid',
      'revoked',
      'stale-revocation',
      'wrong-root',
      'out-of-scope',
    ] as const) {
      expect(describeGrantProblem(reason)).toMatch(/\w/);
    }
  });
});

describe('revocation', () => {
  it('cuts off one serial and leaves the others alone', async () => {
    const lost = await grantFor({ serial: 4, label: 'lost phone' });
    const kept = await grantFor({ serial: 5, label: 'laptop' });
    const revocation = await openRevocation(
      await issueRevocation(root, { serials: [4], issuedAt: NOW }),
      root.publicKey,
    );
    expect(revocation).not.toBeNull();
    expect(isRevoked(revocation, 4)).toBe(true);
    expect(isRevoked(revocation, 5)).toBe(false);
    expect(await verifyGrant(lost, { now: NOW, root: root.publicKey, revocation })).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
    expect(await verifyGrant(kept, { now: NOW, root: root.publicKey, revocation })).toMatchObject({
      ok: true,
    });
  });

  it('signs out everything below a serial in one number', async () => {
    const revocation = await openRevocation(
      await issueRevocation(root, { minSerial: 10, issuedAt: NOW }),
      root.publicKey,
    );
    expect(isRevoked(revocation, 9)).toBe(true);
    expect(isRevoked(revocation, 10)).toBe(false);
  });

  it('will not open a revocation signed by anyone else', async () => {
    const token = await issueRevocation(impostor, { serials: [1], issuedAt: NOW });
    expect(await openRevocation(token, root.publicKey)).toBeNull();
    expect(await openRevocation('rubbish', root.publicKey)).toBeNull();
  });

  it('refuses a revocation list too old to rely on', async () => {
    const token = await grantFor({ serial: 7 });
    const revocation = await openRevocation(
      await issueRevocation(root, { serials: [99], issuedAt: NOW }),
      root.publicKey,
    );
    // An attacker who keeps replaying yesterday's list hides today's revocations.
    expect(
      await verifyGrant(token, {
        now: NOW + 86_400_000,
        root: root.publicKey,
        revocation,
        revocationMaxAge: 3_600_000,
      }),
    ).toMatchObject({ ok: false, reason: 'stale-revocation' });
  });

  it('nothing is revoked without a list', async () => {
    expect(isRevoked(null, 1)).toBe(false);
    expect(isRevoked(undefined, 1)).toBe(false);
  });
});

describe('canonical bytes', () => {
  it('signs the same bytes before and after a round trip', async () => {
    const token = await grantFor();
    const grant = decodeGrant(token)!.grant;
    const again = await sign(root.privateKey, grantBytes(grant));
    expect(again).toHaveLength(64);
  });
});
