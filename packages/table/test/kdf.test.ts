import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, hkdfSha256, hmacSha256, sha256, utf8Bytes } from '../src/index.js';

describe('sha256 / hmac / hkdf', () => {
  it('SHA-256 matches FIPS 180-4 vectors', () => {
    expect(bytesToHex(sha256(utf8Bytes('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(bytesToHex(sha256(utf8Bytes('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      bytesToHex(sha256(utf8Bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    // Multi-block with the length straddling the padding boundary.
    expect(bytesToHex(sha256(new Uint8Array(1000).fill(0x61)))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });

  it('HMAC-SHA-256 matches RFC 4231 test cases', () => {
    expect(bytesToHex(hmacSha256(new Uint8Array(20).fill(0x0b), utf8Bytes('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
    expect(
      bytesToHex(hmacSha256(utf8Bytes('Jefe'), utf8Bytes('what do ya want for nothing?'))),
    ).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    // Key longer than a block (case 6).
    expect(
      bytesToHex(
        hmacSha256(
          new Uint8Array(131).fill(0xaa),
          utf8Bytes('Test Using Larger Than Block-Size Key - Hash Key First'),
        ),
      ),
    ).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  });

  it('HKDF-SHA-256 matches RFC 5869 test case 1', () => {
    const ikm = hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    const salt = hexToBytes('000102030405060708090a0b0c');
    const info = hexToBytes('f0f1f2f3f4f5f6f7f8f9');
    expect(bytesToHex(hkdfSha256(ikm, salt, info, 42))).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
});
