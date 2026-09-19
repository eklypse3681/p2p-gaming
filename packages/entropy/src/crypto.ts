import type { EntropyBatch, EntropyProvider } from './types.js';
import { EntropyError } from './types.js';

function webCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new EntropyError('unsupported', 'crypto.getRandomValues is not available');
  }
  return c;
}

/** The platform CSPRNG. No proof: nobody but the host can check these bytes. */
export function cryptoProvider(): EntropyProvider {
  const make = (bytes: number): EntropyBatch => {
    const out = new Uint8Array(bytes);
    const c = webCrypto();
    // getRandomValues caps a single call at 65 536 bytes.
    for (let off = 0; off < out.length; off += 65536) {
      c.getRandomValues(out.subarray(off, Math.min(out.length, off + 65536)));
    }
    return { provider: 'crypto', bytes: out, proof: { kind: 'none' }, fetchedAt: Date.now() };
  };
  return {
    id: 'crypto',
    name: 'This device (crypto.getRandomValues)',
    fetch: async (bytes) => make(bytes),
    fetchSync: (bytes) => make(bytes),
    draw: async (bytes) => make(bytes),
  };
}
