import type { RandomnessMode } from '@bgf/protocol';
import type { EntropySource } from '@bgf/table';
import { cryptoProvider, drandProvider, randomOrgProvider } from '@bgf/entropy';
import type { EntropySourceId, Settings } from './settings';

/**
 * What a host chooses for a table's randomness: where the bytes come from and how they are
 * bound to actions. Stored per player as defaults (`Settings`) and overridable per table.
 */
export interface RandomnessChoice {
  source: EntropySourceId;
  mode: RandomnessMode;
  randomOrgKey: string;
  fallback: boolean;
}

export function randomnessFromSettings(s: Settings): RandomnessChoice {
  return normalizeRandomness({
    source: s.entropySource,
    mode: s.randomnessMode,
    randomOrgKey: s.randomOrgKey,
    fallback: s.entropyFallback,
  });
}

/** Beacon mode needs the drand beacon; anything else falls back to per-draw. */
export function normalizeRandomness(c: RandomnessChoice): RandomnessChoice {
  if (c.mode === 'beacon' && c.source !== 'drand') return { ...c, mode: 'per-draw' };
  return c;
}

/** Why a choice cannot be used as is (null when it can). */
export function randomnessProblem(c: RandomnessChoice): string | null {
  if (c.mode === 'beacon' && c.source !== 'drand') return 'Beacon mode needs the drand beacon';
  if (c.source === 'random.org' && !c.randomOrgKey.trim()) return 'random.org needs an API key';
  return null;
}

/** Provider id as it appears in the audit (`options.randomness.provider`). */
export function providerIdFor(source: EntropySourceId): string {
  return source;
}

export function sourceLabel(id: string): string {
  switch (id) {
    case 'crypto':
      return 'This device';
    case 'random.org':
      return 'random.org';
    case 'drand':
      return 'drand beacon';
    default:
      return id;
  }
}

export function modeLabel(mode: RandomnessMode | undefined): string {
  switch (mode) {
    case 'seeded':
      return 'Seeded (commit & reveal)';
    case 'beacon':
      return 'Beacon (future rounds)';
    default:
      return 'Per draw';
  }
}

export function describeRandomness(c: Pick<RandomnessChoice, 'source' | 'mode'>): string {
  return `${sourceLabel(c.source)} · ${modeLabel(c.mode)}`;
}

/**
 * Safety of a mode/source pair. `per-draw` and `beacon` never let the host know a value early;
 * `seeded` lets a *playing* host know the whole segment, so it is only safe with a dealer.
 * `crypto` is never verifiable by others whatever the mode.
 */
export type RandomnessSafety = 'safe' | 'trusted-host' | 'unverifiable';

export function randomnessSafety(
  c: Pick<RandomnessChoice, 'source' | 'mode'>,
  dealer: boolean,
): RandomnessSafety {
  if (c.source === 'crypto') return 'unverifiable';
  if (c.mode === 'seeded' && !dealer) return 'trusted-host';
  return 'safe';
}

export function safetyText(safety: RandomnessSafety): string {
  switch (safety) {
    case 'safe':
      return 'Nobody, the host included, can know a value before it is drawn; every draw is verifiable.';
    case 'trusted-host':
      return 'The host knows the seed, hence every card or roll of the hand, while it is played. Fine among friends; use a dealer or another mode otherwise.';
    default:
      return 'Draws come from this device and cannot be verified by anyone else.';
  }
}

export interface BuiltEntropy {
  source: EntropySource;
  provider: string;
  mode: RandomnessMode;
  fallback: boolean;
}

/** Instantiate the provider a choice names. */
export function buildEntropy(
  raw: RandomnessChoice,
  opts: { fetch?: typeof fetch } = {},
): BuiltEntropy {
  const c = normalizeRandomness(raw);
  let source: EntropySource;
  if (c.source === 'random.org') {
    source = randomOrgProvider({
      apiKey: c.randomOrgKey.trim(),
      ...(opts.fetch ? { fetch: opts.fetch as never } : {}),
    });
  } else if (c.source === 'drand') {
    source = drandProvider(opts.fetch ? { fetch: opts.fetch as never } : {});
  } else {
    source = cryptoProvider();
  }
  return { source, provider: providerIdFor(c.source), mode: c.mode, fallback: c.fallback };
}

/** `options.randomness` as declared on the table for every seat to read. */
export function randomnessOptions(c: Pick<RandomnessChoice, 'source' | 'mode'>): {
  mode: RandomnessMode;
  provider: string;
} {
  return {
    mode: normalizeRandomness({ ...c, randomOrgKey: '', fallback: false }).mode,
    provider: c.source,
  };
}
