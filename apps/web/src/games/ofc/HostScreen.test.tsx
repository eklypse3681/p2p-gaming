import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('idb-keyval', async () => {
  const { createIdbKeyvalMock } = await import('../../test/idbKeyvalMock');
  return createIdbKeyvalMock();
});
const hostOfcTable = vi.fn();
vi.mock('./session', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./session');
  return {
    ...actual,
    hostOfcTable: (...args: unknown[]) => hostOfcTable(...args),
    ofcDeps: () => ({ provider: { name: 'memory' } }),
  };
});
vi.mock('../../session/providers', () => ({
  getProvider: () => ({ name: 'memory' }),
  getTransportName: () => 'memory',
}));

import { HostScreen } from './HostScreen';
import { renderWithProfile } from '../../test/renderWithProfile';
import { createProfile, resetProfilesForTests } from '../../session/profiles';

describe('OFC HostScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProfilesForTests();
    createProfile('Alice');
    hostOfcTable.mockReset();
    hostOfcTable.mockResolvedValue({
      matchId: 't1',
      code: 'ABC234',
      role: 'host',
      client: { getState: () => ({ status: 'joined' }), subscribe: () => () => {} },
      provider: { name: 'memory' },
      dispose: () => {},
    });
  });

  it('hosts with the edited rules and lands on the game route', async () => {
    renderWithProfile('alice', <HostScreen />, {
      game: 'ofc',
      route: '/host',
      markers: { 'game/:matchId': 'game-route' },
    });
    expect(screen.getByTestId('host-screen')).toHaveAttribute('data-game', 'ofc');
    expect(screen.getByTestId('host-as')).toHaveTextContent('Alice');
    await userEvent.click(screen.getByTestId('rules-preset-pineapple27'));
    await userEvent.click(screen.getByTestId('seats-3'));
    await userEvent.click(screen.getByTestId('scoring-buyin'));
    expect(screen.getByTestId('host-rules-summary')).toHaveTextContent(
      'Pineapple 2-7 · 3 players · buy-in 100',
    );
    await userEvent.click(screen.getByTestId('create-table-button'));
    await waitFor(() => expect(hostOfcTable).toHaveBeenCalled());
    expect(hostOfcTable.mock.calls[0]![0]).toMatchObject({
      profile: { name: 'Alice' },
      config: { variant: 'pineapple27', seats: 3, scoring: { mode: 'buyin', buyIn: 100 } },
    });
    await waitFor(() =>
      expect(screen.getByTestId('game-route')).toHaveAttribute(
        'data-params',
        '{"profile":"alice","matchId":"t1"}',
      ),
    );
  });
});

describe('OFC HostScreen trust disclosure', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProfilesForTests();
    createProfile('Alice');
  });

  it('discloses that a playing host can see hidden cards, and flips to dealer-hosted', async () => {
    renderWithProfile('alice', <HostScreen />, { game: 'ofc', route: '/host' });
    const panel = await screen.findByTestId('trust-panel');
    expect(panel).toHaveAttribute('data-level', 'host-sees-hidden');
    expect(panel).toHaveTextContent('Host can see hidden cards');
    expect(panel).toHaveTextContent('Pineapple discards');
    expect(panel).toHaveTextContent('Fantasyland');
    // Hosting is never blocked: the create button stays enabled.
    expect(screen.getByTestId('create-table-button')).toBeEnabled();
    await userEvent.click(screen.getByTestId('host-as-dealer'));
    await waitFor(() =>
      expect(screen.getByTestId('trust-panel')).toHaveAttribute('data-level', 'dealer'),
    );
    expect(screen.getByTestId('trust-panel')).toHaveTextContent('no player at the table');
  });
});
