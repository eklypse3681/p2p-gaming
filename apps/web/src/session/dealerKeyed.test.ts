import { describe, expect, it } from 'vitest';
import { generateKeyPair, memoryProvider, signerFor } from '@bgf/protocol';
import { defaultConfig, ofcDefinition } from '@bgf/ofc-engine';
import { hostTable, joinTable } from './tableSession';

describe('dealer hosting with a keyed profile', () => {
  it('the dealer device is welcomed after the challenge and guests fill the seats', async () => {
    const keys = await generateKeyPair();
    const profile = { id: 'dealer-1', name: 'Dana', publicKey: keys.publicKey };
    const signer = signerFor(keys.privateKey);
    const provider = memoryProvider();
    const config = defaultConfig({ variant: 'pineapple', seats: 2 });
    const dealer = await hostTable(
      ofcDefinition,
      {
        profile,
        signer,
        config,
        seats: 2,
        dealer: true,
        randomness: { source: 'crypto', mode: 'seeded', randomOrgKey: '', fallback: false },
      },
      { provider, joinTimeoutMs: 3000 },
    );
    expect(dealer.client.getState().role).toBe('dealer');
    const gk = await generateKeyPair();
    const guest = await joinTable(
      ofcDefinition,
      {
        code: dealer.code,
        profile: { id: 'g1', name: 'Bob', publicKey: gk.publicKey },
        signer: signerFor(gk.privateKey),
      },
      { provider, joinTimeoutMs: 3000 },
    );
    expect(guest.client.getState().seat).toBe(0);
    expect(guest.client.getState().dealer?.profile.name).toBe('Dana');
    guest.dispose();
    dealer.dispose();
  }, 15_000);
});
