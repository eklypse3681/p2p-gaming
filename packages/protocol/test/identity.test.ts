import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  challengeBytes,
  generateKeyPair,
  looksLikePublicKey,
  randomNonce,
  sign,
  signerFor,
  verify,
} from '../src/index.js';

describe('identity keys', () => {
  it('signs and verifies a challenge; tampering or a different key fails', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    expect(looksLikePublicKey(a.publicKey)).toBe(true);
    expect(a.publicKey).not.toBe(b.publicKey);
    const bytes = challengeBytes({ matchId: 'm1', profileId: 'p1', nonce: randomNonce() });
    const sig = await sign(a.privateKey, bytes);
    expect(sig.length).toBe(64);
    expect(await verify(a.publicKey, bytes, sig)).toBe(true);
    expect(await verify(b.publicKey, bytes, sig)).toBe(false);
    const tampered = challengeBytes({ matchId: 'm2', profileId: 'p1', nonce: 'x' });
    expect(await verify(a.publicKey, tampered, sig)).toBe(false);
    const flipped = new Uint8Array(sig);
    flipped[3] = flipped[3]! ^ 0xff;
    expect(await verify(a.publicKey, bytes, flipped)).toBe(false);
    expect(await verify('not-a-key', bytes, sig)).toBe(false);
    expect(await verify(a.publicKey, bytes, new Uint8Array(3))).toBe(false);
  });

  it('challenge bytes are deterministic and domain separated', () => {
    const c = { matchId: 'm', profileId: 'p', nonce: 'n' };
    expect(challengeBytes(c)).toEqual(challengeBytes({ ...c }));
    expect(new TextDecoder().decode(challengeBytes(c))).toContain('p2p-gaming seat');
    expect(challengeBytes(c)).not.toEqual(challengeBytes({ ...c, nonce: 'n2' }));
  });

  it('base64url round trips and a signer is bound to its key', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    expect(bytesToBase64Url(bytes)).not.toMatch(/[+/=]/);
    expect(() => base64UrlToBytes('a+b')).toThrow();
    const k = await generateKeyPair();
    const msg = challengeBytes({ matchId: 'm', profileId: 'p', nonce: 'n' });
    expect(await verify(k.publicKey, msg, await signerFor(k.privateKey)(msg))).toBe(true);
    expect(randomNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomNonce()).not.toBe(randomNonce());
  });
});
