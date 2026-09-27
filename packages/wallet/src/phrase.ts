/**
 * The recovery phrase: the 32-byte seed written as 24 English words (BIP-39's list and checksum).
 * It is the seed itself, not a password for it, so anyone holding the words holds the player.
 * The checksum catches a mistyped or swapped word before it can restore the wrong player.
 */
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { WalletError } from './errors.js';
import { checkSeed } from './seed.js';

export const PHRASE_WORDS = 24;

export function seedToPhrase(seed: Uint8Array): string[] {
  checkSeed(seed);
  return entropyToMnemonic(seed, wordlist).split(' ');
}

/** Tolerates any spacing, case and line breaks; throws `bad-seed` for anything else. */
export function phraseToSeed(phrase: string | readonly string[]): Uint8Array {
  const words = (typeof phrase === 'string' ? phrase.split(/\s+/) : [...phrase])
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (words.length !== PHRASE_WORDS) {
    throw new WalletError('bad-seed', `a recovery phrase is ${PHRASE_WORDS} words`);
  }
  const joined = words.join(' ');
  if (!validateMnemonic(joined, wordlist)) {
    throw new WalletError('bad-seed', 'those words are not a recovery phrase; check each one');
  }
  return mnemonicToEntropy(joined, wordlist);
}

/** Whether a single word is on the list, for checking as the person types. */
export function isPhraseWord(word: string): boolean {
  return wordlist.includes(word.trim().toLowerCase());
}
