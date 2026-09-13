import { describe, expect, it } from 'vitest';
import {
  SYNC_ADDRESS_PREFIX,
  constantTimeEqual,
  hasWebCrypto,
  hmacSha256Hex,
  randomNonce,
  sha256Hex,
  syncAddress,
} from './crypto';

describe('sync crypto', () => {
  it('has WebCrypto and hashes like the spec', async () => {
    expect(hasWebCrypto()).toBe(true);
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // RFC 4231 test case 2
    expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('derives a stable address from the key without revealing it', async () => {
    const a = await syncAddress('secret-key');
    expect(a.startsWith(SYNC_ADDRESS_PREFIX)).toBe(true);
    expect(a).toHaveLength(SYNC_ADDRESS_PREFIX.length + 24);
    expect(a).toBe(await syncAddress('secret-key'));
    expect(a).not.toBe(await syncAddress('secret-key2'));
    expect(a).not.toContain('secret');
  });

  it('nonces are random hex and comparisons are length-safe', () => {
    const n1 = randomNonce();
    const n2 = randomNonce();
    expect(n1).toMatch(/^[0-9a-f]{32}$/);
    expect(n1).not.toBe(n2);
    expect(constantTimeEqual('abcd', 'abcd')).toBe(true);
    expect(constantTimeEqual('abcd', 'abce')).toBe(false);
    expect(constantTimeEqual('abcd', 'abc')).toBe(false);
  });
});
