import type { EntropySource } from '@bgf/table';
import { cryptoProvider, drandProvider, randomOrgProvider } from '@bgf/entropy';

export type EntropySourceName = 'crypto' | 'random.org' | 'drand';

export interface DealerEntropyOptions {
  source: EntropySourceName;
  /** random.org API key (or `RANDOM_ORG_API_KEY`). */
  apiKey?: string;
  /** Use this machine's generator when the oracle fails (flagged in the audit). Default false. */
  fallback?: boolean;
}

export function isEntropySourceName(value: unknown): value is EntropySourceName {
  return value === 'crypto' || value === 'random.org' || value === 'drand';
}

/** Build the just-in-time entropy source the table server will draw from. */
export function entropySourceFor(opts: DealerEntropyOptions): EntropySource {
  switch (opts.source) {
    case 'crypto':
      return cryptoProvider();
    case 'random.org': {
      const apiKey = opts.apiKey ?? process.env.RANDOM_ORG_API_KEY;
      if (!apiKey) throw new Error('random.org needs an API key (--api-key or RANDOM_ORG_API_KEY)');
      return randomOrgProvider({ apiKey });
    }
    case 'drand':
      return drandProvider();
  }
}
