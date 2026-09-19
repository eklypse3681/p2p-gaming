import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import {
  buildEntropy,
  describeRandomness,
  normalizeRandomness,
  randomnessFromSettings,
  randomnessOptions,
  randomnessProblem,
  randomnessSafety,
} from './entropy';

describe('randomness choice', () => {
  it('defaults to this device, per draw', () => {
    const c = randomnessFromSettings(DEFAULT_SETTINGS);
    expect(c).toEqual({ source: 'crypto', mode: 'per-draw', randomOrgKey: '', fallback: false });
    expect(describeRandomness(c)).toBe('This device · Per draw');
    expect(randomnessOptions(c)).toEqual({ mode: 'per-draw', provider: 'crypto' });
  });

  it('beacon mode needs drand: normalised away otherwise, reported as a problem', () => {
    const c = normalizeRandomness({
      source: 'random.org',
      mode: 'beacon',
      randomOrgKey: 'k',
      fallback: false,
    });
    expect(c.mode).toBe('per-draw');
    expect(
      randomnessProblem({ source: 'crypto', mode: 'beacon', randomOrgKey: '', fallback: false }),
    ).toMatch(/drand/);
    expect(
      randomnessProblem({
        source: 'random.org',
        mode: 'seeded',
        randomOrgKey: ' ',
        fallback: false,
      }),
    ).toMatch(/API key/);
    expect(
      randomnessProblem({ source: 'drand', mode: 'beacon', randomOrgKey: '', fallback: false }),
    ).toBeNull();
  });

  it('rates safety: seeded is only safe with a dealer, this device is never verifiable', () => {
    expect(randomnessSafety({ source: 'drand', mode: 'per-draw' }, false)).toBe('safe');
    expect(randomnessSafety({ source: 'drand', mode: 'beacon' }, false)).toBe('safe');
    expect(randomnessSafety({ source: 'random.org', mode: 'seeded' }, false)).toBe('trusted-host');
    expect(randomnessSafety({ source: 'random.org', mode: 'seeded' }, true)).toBe('safe');
    expect(randomnessSafety({ source: 'crypto', mode: 'seeded' }, true)).toBe('unverifiable');
  });

  it('builds the provider a choice names', () => {
    expect(
      buildEntropy({ source: 'crypto', mode: 'per-draw', randomOrgKey: '', fallback: true }),
    ).toMatchObject({ provider: 'crypto', mode: 'per-draw', fallback: true });
    expect(
      buildEntropy({ source: 'random.org', mode: 'seeded', randomOrgKey: 'k', fallback: false })
        .source.id,
    ).toBe('random.org');
    expect(
      buildEntropy({ source: 'drand', mode: 'beacon', randomOrgKey: '', fallback: false }).source
        .id,
    ).toBe('drand');
  });
});
