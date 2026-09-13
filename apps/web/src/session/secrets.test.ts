import { beforeEach, describe, expect, it } from 'vitest';
import {
  SecretsError,
  checkPassword,
  decryptSecrets,
  encryptSecrets,
  forgetUnlocked,
  isEncryptedSecrets,
  readUnlocked,
  rememberUnlocked,
} from './secrets';

const FAST = 1000; // PBKDF2 iterations for tests

describe('encrypted secrets', () => {
  beforeEach(() => sessionStorage.clear());

  it('round-trips with the right password and refuses the wrong one', async () => {
    const plain = { privateKey: 'priv-abc', syncKey: 'sync-xyz' };
    const enc = await encryptSecrets(plain, 'correct horse', FAST);
    expect(isEncryptedSecrets(enc)).toBe(true);
    expect(enc.alg).toBe('pbkdf2-aes-gcm');
    expect(enc.iterations).toBe(FAST);
    expect(JSON.stringify(enc)).not.toContain('priv-abc');
    expect(await decryptSecrets(enc, 'correct horse')).toEqual(plain);
    await expect(decryptSecrets(enc, 'battery staple')).rejects.toMatchObject({
      code: 'wrong-password',
    });
    // Tampered ciphertext fails authentication.
    const tampered = { ...enc, ciphertext: enc.ciphertext.slice(0, -2) + 'AA' };
    await expect(decryptSecrets(tampered, 'correct horse')).rejects.toBeInstanceOf(SecretsError);
  });

  it('different encryptions of the same secrets differ (fresh salt and iv)', async () => {
    const a = await encryptSecrets({ syncKey: 'k' }, 'pw', FAST);
    const b = await encryptSecrets({ syncKey: 'k' }, 'pw', FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('validates shapes and password strength', () => {
    expect(isEncryptedSecrets({ alg: 'nope' })).toBe(false);
    expect(isEncryptedSecrets(null)).toBe(false);
    expect(() => checkPassword('abc')).toThrow(SecretsError);
    expect(() => checkPassword('abcd')).not.toThrow();
  });

  it('keeps the unlocked copy per tab in sessionStorage', () => {
    expect(readUnlocked('steve')).toBeNull();
    rememberUnlocked('steve', { privateKey: 'p', syncKey: 's' });
    expect(readUnlocked('steve')).toEqual({ privateKey: 'p', syncKey: 's' });
    forgetUnlocked('steve');
    expect(readUnlocked('steve')).toBeNull();
    sessionStorage.setItem('p2p:unlocked:steve', '{broken');
    expect(readUnlocked('steve')).toBeNull();
  });
});
