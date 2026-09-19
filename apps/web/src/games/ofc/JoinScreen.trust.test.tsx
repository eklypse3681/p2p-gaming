import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('idb-keyval', async () => {
  const { createIdbKeyvalMock } = await import('../../test/idbKeyvalMock');
  return createIdbKeyvalMock();
});
vi.mock('../../session/providers', () => ({
  getProvider: () => ({ name: 'memory' }),
  getTransportName: () => 'memory',
}));

import { JoinScreen } from './JoinScreen';
import { JoinScreen as BackgammonJoinScreen } from '../backgammon/JoinScreen';
import { renderWithProfile } from '../../test/renderWithProfile';
import { createProfile, resetProfilesForTests } from '../../session/profiles';

describe('join screens disclose trust before joining', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProfilesForTests();
    createProfile('Bob');
  });

  it('OFC: a player-hosted table means the host can see hidden cards; tapping shows why', async () => {
    renderWithProfile('bob', <JoinScreen />, { game: 'ofc', route: '/join' });
    const badge = await screen.findByTestId('trust-badge');
    expect(badge).toHaveAttribute('data-level', 'host-sees-hidden');
    expect(screen.getByTestId('join-trust')).toHaveTextContent('Dealer-hosted');
    await userEvent.click(badge);
    expect(screen.getByTestId('trust-details')).toHaveTextContent('Pineapple discards');
  });

  it('backgammon: open information', async () => {
    renderWithProfile('bob', <BackgammonJoinScreen />, { game: 'backgammon', route: '/join' });
    const badge = await screen.findByTestId('trust-badge');
    expect(badge).toHaveAttribute('data-level', 'open');
    expect(screen.getByTestId('join-trust')).toHaveTextContent('Nothing at this table is hidden');
  });
});
