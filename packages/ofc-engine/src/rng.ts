/** Randomness source. Injected so tests are deterministic and a commit-reveal scheme can plug in. */
export interface Rng {
  /** Uniform integer in [0, n). */
  int(n: number): number;
  shuffle<T>(items: readonly T[]): T[];
}

function shuffleWith<T>(int: (n: number) => number, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function cryptoRng(): Rng {
  const int = (n: number): number => {
    if (n <= 0) throw new RangeError('n must be positive');
    if (n === 1) return 0;
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      globalThis.crypto.getRandomValues(buf);
      const v = buf[0]!;
      if (v < limit) return v % n;
    }
  };
  return { int, shuffle: (items) => shuffleWith(int, items) };
}

/** Deterministic mulberry32 PRNG. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => {
    if (n <= 0) throw new RangeError('n must be positive');
    return Math.floor(next() * n);
  };
  return { int, shuffle: (items) => shuffleWith(int, items) };
}
