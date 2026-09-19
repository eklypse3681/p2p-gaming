import { describe, expect, it } from 'vitest';
import { describeTrust, trustDeclarationOf, trustTitle } from '../src/trust.js';
import { TableServer } from '../src/TableServer.js';
import { scriptedRng } from '../src/rng.js';
import type { GameDefinition } from '../src/definition.js';

const open = { hiddenInformation: false, trust: { hiddenInformation: false, hostCanSee: [] } };
const hidden = {
  hiddenInformation: true,
  trust: {
    hiddenInformation: true,
    hostCanSee: ['pending cards', 'discards'],
    notes: 'Deck drawn just in time.',
  },
};

describe('describeTrust', () => {
  const modes = ['per-draw', 'seeded', 'beacon'] as const;
  const providers = { 'per-draw': 'random.org', seeded: 'random.org', beacon: 'drand' } as const;

  it('open-information games are open whoever hosts a seat, dealer when nobody does', () => {
    for (const mode of modes) {
      const player = describeTrust(open, {
        hostSeat: 0,
        randomness: { mode, provider: providers[mode] },
      });
      expect(player.level).toBe('open');
      expect(player.title).toBe('Open information');
      const dealer = describeTrust(open, {
        hostSeat: null,
        randomness: { mode, provider: providers[mode] },
      });
      expect(dealer.level).toBe('dealer');
    }
  });

  it('hidden-information games hosted by a player disclose what the host can see', () => {
    const d = describeTrust(hidden, {
      hostSeat: 1,
      randomness: { mode: 'per-draw', provider: 'random.org' },
    });
    expect(d.level).toBe('host-sees-hidden');
    expect(d.title).toBe('Host can see hidden cards');
    expect(d.details.join(' ')).toContain('can see pending cards');
    expect(d.details.join(' ')).toContain('discards');
    expect(d.details.join(' ')).toContain('nobody, host included, knows a card early');
    expect(d.details.at(-1)).toBe('Deck drawn just in time.');
  });

  it('seeded randomness warns for a playing host and reassures for a dealer', () => {
    const player = describeTrust(hidden, {
      hostSeat: 0,
      randomness: { mode: 'seeded', provider: 'random.org' },
    });
    expect(player.details.join(' ')).toMatch(/host knows the seed/);
    const dealer = describeTrust(hidden, {
      hostSeat: null,
      randomness: { mode: 'seeded', provider: 'drand' },
    });
    expect(dealer.level).toBe('dealer');
    expect(dealer.details.join(' ')).toMatch(/dealer holds each hand's seed/);
    expect(dealer.details.join(' ')).toMatch(/no player at the table can see another/);
  });

  it('beacon mode is fair for everyone; crypto is honest about verifiability', () => {
    const beacon = describeTrust(hidden, {
      hostSeat: 0,
      randomness: { mode: 'beacon', provider: 'drand' },
    });
    expect(beacon.details.join(' ')).toMatch(/bound to a future drand round/);
    const crypto = describeTrust(hidden, {
      hostSeat: 0,
      randomness: { mode: 'per-draw', provider: 'crypto' },
    });
    expect(crypto.details.join(' ')).toMatch(/cannot be verified by others/);
    const none = describeTrust(hidden, { hostSeat: 0 });
    expect(none.details.join(' ')).toMatch(/cannot be verified by others/);
  });

  it('falls back to hiddenInformation when a definition declares no trust block', () => {
    expect(trustDeclarationOf({ hiddenInformation: true })).toEqual({
      hiddenInformation: true,
      hostCanSee: [],
    });
    expect(describeTrust({ hiddenInformation: true }, { hostSeat: 0 }).level).toBe(
      'host-sees-hidden',
    );
    expect(describeTrust({}, { hostSeat: 0 }).level).toBe('open');
    expect(trustTitle('dealer')).toBe('Dealer-hosted');
  });
});

type S = { secret: number; guesses: number[] };
type A = { type: 'deal'; secret: number } | { type: 'guess'; seat: number; n: number };
type C = { type: 'guess'; n: number };
const toy: GameDefinition<S, A, C, { guesses: number[] }> = {
  id: 'toy',
  minSeats: 2,
  maxSeats: 3,
  hiddenInformation: true,
  trust: { hiddenInformation: true, hostCanSee: ['the secret number'] },
  init: (_c, ctx) => ({ secret: ctx.rng.int(10), guesses: [] }),
  validateCommand: (raw) =>
    typeof raw === 'object' && raw !== null && (raw as C).type === 'guess' ? (raw as C) : null,
  command: (_s, seat, c) => ({ type: 'guess', seat, n: c.n }),
  reduce: (s, a) => (a.type === 'guess' ? { ...s, guesses: [...s.guesses, a.n] } : s),
  view: (s, seat) => (seat === null ? { guesses: s.guesses } : { guesses: s.guesses }),
};

describe('TableServer options.trust', () => {
  const host = { id: 'h', name: 'Host' };
  it('is written for a player host and a dealer host', () => {
    const player = new TableServer({
      def: toy,
      config: {},
      code: 'T1',
      host,
      seats: 2,
      rng: scriptedRng([3]),
    });
    const t1 = player.getSnapshot().options.trust as { level: string; details: string[] };
    expect(t1.level).toBe('host-sees-hidden');
    expect(t1.details.join(' ')).toContain('the secret number');
    const dealer = new TableServer({
      def: toy,
      config: {},
      code: 'T2',
      host,
      hostSeat: null,
      seats: 2,
      rng: scriptedRng([3]),
    });
    expect((dealer.getSnapshot().options.trust as { level: string }).level).toBe('dealer');
  });

  it('is filled in when an older snapshot without it is resumed', () => {
    const server = new TableServer({
      def: toy,
      config: {},
      code: 'T3',
      host,
      seats: 2,
      rng: scriptedRng([3]),
    });
    const snapshot = server.getSnapshot();
    const { trust: _drop, ...options } = snapshot.options as Record<string, unknown>;
    const resumed = new TableServer({
      def: toy,
      code: 'T3',
      host,
      snapshot: { ...snapshot, options },
      rng: scriptedRng([3]),
    });
    expect((resumed.getSnapshot().options.trust as { level: string }).level).toBe(
      'host-sees-hidden',
    );
  });
});
