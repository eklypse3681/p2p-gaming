import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('idb-keyval', async () => {
  const { createIdbKeyvalMock } = await import('../test/idbKeyvalMock');
  return createIdbKeyvalMock();
});
const hostNewMatch = vi.fn();
vi.mock('../session/session', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../session/session');
  return { ...actual, hostNewMatch: (...args: unknown[]) => hostNewMatch(...args) };
});
const hostOfcTable = vi.fn();
vi.mock('../games/ofc/session', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../games/ofc/session');
  return {
    ...actual,
    hostOfcTable: (...args: unknown[]) => hostOfcTable(...args),
    ofcDeps: () => ({ provider: { name: 'memory' } }),
  };
});
vi.mock('../session/providers', () => ({
  getProvider: () => ({ name: 'memory' }),
  getTransportName: () => 'memory',
}));

import { HostScreen as BackgammonHost } from '../games/backgammon/HostScreen';
import { HostScreen as OfcHost } from '../games/ofc/HostScreen';
import { renderWithProfile } from '../test/renderWithProfile';
import { createProfile, resetProfilesForTests } from '../session/profiles';
import { resetSettingsCacheForTests, updateSettings } from '../session/settings';

const fakeSession = {
  matchId: 'm1',
  code: 'ABC234',
  role: 'host',
  client: { getState: () => ({ status: 'joined' }), subscribe: () => () => {} },
  provider: { name: 'memory' },
  dispose: () => {},
};

describe('host screens: table options', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSettingsCacheForTests();
    resetProfilesForTests();
    createProfile('Alice');
    hostNewMatch.mockReset();
    hostNewMatch.mockResolvedValue(fakeSession);
    hostOfcTable.mockReset();
    hostOfcTable.mockResolvedValue({ ...fakeSession, matchId: 't1' });
  });

  it('backgammon: defaults from settings, dealer toggle and a per-table override reach the session', async () => {
    updateSettings('alice', { entropySource: 'drand', randomnessMode: 'per-draw' });
    renderWithProfile('alice', <BackgammonHost />, {
      game: 'backgammon',
      route: '/host',
      markers: { 'game/:matchId': 'game-route' },
    });
    expect(screen.getByTestId('host-randomness-summary')).toHaveTextContent(
      'drand beacon · Per draw',
    );
    expect(screen.getByTestId('host-randomness-summary')).toHaveAttribute('data-safety', 'safe');
    await userEvent.click(screen.getByTestId('host-randomness-change'));
    await userEvent.click(screen.getByTestId('host-mode-beacon'));
    await userEvent.click(screen.getByTestId('host-as-dealer'));
    await userEvent.click(screen.getByTestId('create-match-button'));
    await waitFor(() => expect(hostNewMatch).toHaveBeenCalled());
    expect(hostNewMatch.mock.calls[0]![0]).toMatchObject({
      dealer: true,
      randomness: { source: 'drand', mode: 'beacon', fallback: false },
    });
    await waitFor(() => expect(screen.getByTestId('game-route')).toBeInTheDocument());
  });

  it('backgammon: seeded with a playing host is flagged, with a dealer it is safe', async () => {
    renderWithProfile('alice', <BackgammonHost />, { game: 'backgammon', route: '/host' });
    await userEvent.click(screen.getByTestId('host-randomness-change'));
    await userEvent.click(screen.getByTestId('host-source-random-org'));
    await userEvent.click(screen.getByTestId('host-mode-seeded'));
    expect(screen.getByTestId('host-randomness-safety')).toHaveAttribute(
      'data-safety',
      'trusted-host',
    );
    await userEvent.click(screen.getByTestId('host-as-dealer'));
    expect(screen.getByTestId('host-randomness-safety')).toHaveAttribute('data-safety', 'safe');
    // random.org without a key cannot be used: the form refuses to submit.
    await userEvent.click(screen.getByTestId('create-match-button'));
    expect(screen.getByTestId('host-error')).toHaveTextContent(/API key/);
    expect(hostNewMatch).not.toHaveBeenCalled();
    await userEvent.type(screen.getByTestId('host-random-org-key'), 'abc-key');
    await userEvent.click(screen.getByTestId('create-match-button'));
    await waitFor(() => expect(hostNewMatch).toHaveBeenCalled());
    expect(hostNewMatch.mock.calls[0]![0]).toMatchObject({
      dealer: true,
      randomness: { source: 'random.org', mode: 'seeded', randomOrgKey: 'abc-key' },
    });
  });

  it('OFC: dealer and randomness reach hostOfcTable; beacon is disabled without drand', async () => {
    renderWithProfile('alice', <OfcHost />, {
      game: 'ofc',
      route: '/host',
      markers: { 'game/:matchId': 'game-route' },
    });
    await userEvent.click(screen.getByTestId('host-randomness-change'));
    expect(screen.getByTestId('host-mode-beacon')).toBeDisabled();
    await userEvent.click(screen.getByTestId('host-source-drand'));
    expect(screen.getByTestId('host-mode-beacon')).not.toBeDisabled();
    await userEvent.click(screen.getByTestId('host-mode-seeded'));
    await userEvent.click(screen.getByTestId('host-as-dealer'));
    await userEvent.click(screen.getByTestId('create-table-button'));
    await waitFor(() => expect(hostOfcTable).toHaveBeenCalled());
    expect(hostOfcTable.mock.calls[0]![0]).toMatchObject({
      dealer: true,
      randomness: { source: 'drand', mode: 'seeded' },
    });
  });
});
