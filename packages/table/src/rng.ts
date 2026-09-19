import type { Rng } from './definition.js';

function shuffleWith<T>(int: (n: number) => number, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Cryptographically random values (browser and Node 19+), rejection-sampled to avoid bias. */
export function cryptoRng(): Rng {
  const int = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`rng.int needs a positive integer bound, got ${maxExclusive}`);
    }
    if (maxExclusive === 1) return 0;
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    for (;;) {
      globalThis.crypto.getRandomValues(buf);
      const v = buf[0]!;
      if (v < limit) return v % maxExclusive;
    }
  };
  return { int, shuffle: (items) => shuffleWith(int, items) };
}

/** Deterministic mulberry32 stream; identical seeds give identical games. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`rng.int needs a positive integer bound, got ${maxExclusive}`);
    }
    return Math.floor(next() * maxExclusive);
  };
  return { int, shuffle: (items) => shuffleWith(int, items) };
}

/** Replays a fixed script of values (looping); `int(n)` returns `script[i] % n`. */
export function scriptedRng(script: readonly number[]): Rng {
  if (script.length === 0) throw new RangeError('scriptedRng needs at least one value');
  let i = 0;
  const int = (maxExclusive: number): number => {
    const v = script[i % script.length]!;
    i++;
    return ((v % maxExclusive) + maxExclusive) % maxExclusive;
  };
  return { int, shuffle: (items) => shuffleWith(int, items) };
}
