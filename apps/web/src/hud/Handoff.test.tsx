import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProfile } from '../test/renderWithProfile';
import { Handoff } from './Handoff';
import { ensureKeys, getSecrets } from '../session/profiles';
import { resetProviderCache } from '../session/providers';

describe('Handoff', () => {
  beforeEach(() => {
    // No WebRTC in jsdom: pair over the in-memory transport.
    window.history.replaceState(null, '', '/?transport=memory');
    resetProviderCache();
  });
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('offers a pairing link that opens this match, carrying no key at all', async () => {
    renderWithProfile('alice', <Handoff code="ABC234" />, { game: 'backgammon' });
    await ensureKeys('alice');
    const link = (await screen.findByTestId('pair-link')) as HTMLInputElement;
    expect(link.value).toMatch(/#\/pair\/[A-Z0-9]{8}\?next=backgammon\/join\/ABC234$/);
    const secrets = getSecrets('alice')!;
    for (const secret of [secrets.privateKey, secrets.seed, secrets.syncKey]) {
      expect(link.value).not.toContain(secret);
    }
    await waitFor(() => expect(screen.getByTestId('pair-qr').querySelector('svg')).not.toBeNull());
  });
});
