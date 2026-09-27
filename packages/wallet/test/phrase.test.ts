import { describe, expect, it } from 'vitest';
import {
  PHRASE_WORDS,
  WalletError,
  generateSeed,
  isPhraseWord,
  openWallet,
  phraseToSeed,
  playerIdFor,
  seedToPhrase,
} from '../src/index.js';

const FIXED = new Uint8Array(32).map((_, i) => i);

describe('recovery phrase', () => {
  it('writes a seed as 24 words and reads it back exactly', () => {
    const seed = generateSeed();
    const words = seedToPhrase(seed);
    expect(words).toHaveLength(PHRASE_WORDS);
    expect(Array.from(phraseToSeed(words))).toEqual(Array.from(seed));
  });

  it('forgives spacing, case and line breaks', () => {
    const seed = generateSeed();
    const messy = `  ${seedToPhrase(seed).join('\n').toUpperCase()}  `;
    expect(Array.from(phraseToSeed(messy))).toEqual(Array.from(seed));
  });

  it('catches a mistyped or swapped word instead of restoring someone else', () => {
    const words = seedToPhrase(generateSeed());
    const swapped = [...words];
    [swapped[3], swapped[4]] = [swapped[4]!, swapped[3]!];
    if (swapped.join(' ') !== words.join(' ')) {
      expect(() => phraseToSeed(swapped)).toThrow(WalletError);
    }
    expect(() => phraseToSeed([...words.slice(0, 23), 'notaword'])).toThrow(/check each one/);
    expect(() => phraseToSeed(words.slice(0, 12))).toThrow(/24 words/);
  });

  it('knows its words', () => {
    expect(isPhraseWord('abandon')).toBe(true);
    expect(isPhraseWord(' Zoo ')).toBe(true);
    expect(isPhraseWord('amongfriends')).toBe(false);
  });

  it('restores the same player id, which is pinned like the keys', async () => {
    expect(playerIdFor(FIXED)).toBe(playerIdFor(FIXED));
    expect(playerIdFor(FIXED)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await openWallet(FIXED)).playerId).toBe(playerIdFor(FIXED));
    expect(playerIdFor(generateSeed())).not.toBe(playerIdFor(FIXED));
  });
});
