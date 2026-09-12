import type { Die, DiceRoll } from './types.js';

/** Source of randomness for dice. Swappable so tests are deterministic and so a commit-reveal
 *  protocol between peers can be plugged in later without touching the server. */
export interface DiceSource {
  rollDie(): Die;
}

export function rollDice(src: DiceSource): DiceRoll {
  return [src.rollDie(), src.rollDie()];
}

/** Cryptographically random dice (browser + Node 19+). */
export function cryptoDice(): DiceSource {
  return {
    rollDie(): Die {
      const buf = new Uint8Array(1);
      // Rejection sampling avoids modulo bias.
      for (;;) {
        globalThis.crypto.getRandomValues(buf);
        const v = buf[0]!;
        if (v < 252) return ((v % 6) + 1) as Die;
      }
    },
  };
}

/** Deterministic dice from a fixed script (loops). */
export function scriptedDice(values: number[]): DiceSource {
  let i = 0;
  return {
    rollDie(): Die {
      const v = values[i % values.length]!;
      i++;
      return v as Die;
    },
  };
}

/** Deterministic seeded PRNG dice (mulberry32). */
export function seededDice(seed: number): DiceSource {
  let a = seed >>> 0;
  return {
    rollDie(): Die {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return (Math.floor(r * 6) + 1) as Die;
    },
  };
}
