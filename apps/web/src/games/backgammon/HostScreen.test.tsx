import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('idb-keyval', async () => {
  const { createIdbKeyvalMock } = await import('../../test/idbKeyvalMock');
  return createIdbKeyvalMock();
});
const hostNewMatch = vi.fn();
vi.mock('../../session/session', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../session/session');
  return { ...actual, hostNewMatch: (...args: unknown[]) => hostNewMatch(...args) };
});
const getProvider = vi.fn(() => ({ name: 'memory' }));
vi.mock('../../session/providers', () => ({
  getProvider: (...args: unknown[]) => getProvider(...(args as [])),
  getTransportName: () => 'memory',
}));

import { HostScreen } from './HostScreen';
import { renderWithProfile } from '../../test/renderWithProfile';
import { createProfile, resetProfilesForTests } from '../../session/profiles';

function renderHost() {
  return renderWithProfile('alice', <HostScreen />, {
    game: 'backgammon',
    route: '/host',
    markers: { 'game/:matchId': 'game-route' },
  });
}

describe('HostScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProfilesForTests();
    createProfile('Alice');
    hostNewMatch.mockReset();
    hostNewMatch.mockResolvedValue({
      matchId: 'm1',
      code: 'ABC234',
      role: 'host',
      client: { getState: () => ({ status: 'joined' }), subscribe: () => () => {} },
      provider: { name: 'memory' },
      dispose: () => {},
    });
  });

  it('defaults to enforced rules, hosts as the route player and lands on the game route', async () => {
    renderHost();
    expect(screen.getByTestId('host-as')).toHaveTextContent('Alice');
    expect(screen.getByTestId('rules-enforced')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('rules-free')).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(screen.getByTestId('length-3'));
    await userEvent.click(screen.getByTestId('create-match-button'));
    await waitFor(() => expect(hostNewMatch).toHaveBeenCalled());
    expect(hostNewMatch.mock.calls[0]![0]).toMatchObject({
      profile: { name: 'Alice' },
      config: { length: 3, rules: 'enforced' },
      hostSeat: 'white',
      homeSide: 'left',
    });
    await waitFor(() =>
      expect(screen.getByTestId('game-route')).toHaveAttribute(
        'data-params',
        '{"profile":"alice","matchId":"m1"}',
      ),
    );
    expect(getProvider).toHaveBeenCalledWith('alice', 'backgammon');
  });

  it('table layout defaults to home boards on the left and can be switched', async () => {
    renderHost();
    expect(screen.getByTestId('home-side-left')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('home-side-right')).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(screen.getByTestId('home-side-right'));
    expect(screen.getByTestId('home-side-right')).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByTestId('create-match-button'));
    await waitFor(() => expect(hostNewMatch).toHaveBeenCalled());
    expect(hostNewMatch.mock.calls[0]![0]).toMatchObject({ homeSide: 'right' });
  });

  it('free board is selectable', async () => {
    renderHost();
    await userEvent.click(screen.getByTestId('rules-free'));
    expect(screen.getByTestId('rules-free')).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByTestId('seat-black'));
    await userEvent.click(screen.getByTestId('create-match-button'));
    await waitFor(() => expect(hostNewMatch).toHaveBeenCalled());
    expect(hostNewMatch.mock.calls[0]![0]).toMatchObject({
      config: { rules: 'free' },
      hostSeat: 'black',
    });
  });
});
