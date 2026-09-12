import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { createIdbKeyvalMock } from '../../test/idbKeyvalMock';

vi.mock('idb-keyval', async () => {
  const { createIdbKeyvalMock } = await import('../../test/idbKeyvalMock');
  return createIdbKeyvalMock();
});
import * as idbMocked from 'idb-keyval';
const mock = idbMocked as unknown as ReturnType<typeof createIdbKeyvalMock>;

import { HomeScreen } from './HomeScreen';
import { renderWithProfile } from '../../test/renderWithProfile';
import { createProfile, resetProfilesForTests } from '../../session/profiles';
import { setMatchStoreForTests } from '../../session/matchStore';

function renderHome(slug = 'alice') {
  return renderWithProfile(slug, <HomeScreen />, {
    game: 'backgammon',
    markers: { host: 'host-route', 'join/:code': 'join-route' },
  });
}

describe('HomeScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    mock.dbs.clear();
    setMatchStoreForTests();
    resetProfilesForTests();
    createProfile('Alice');
  });

  it('is scoped to the game in the route', () => {
    renderHome();
    expect(screen.getByTestId('home-screen')).toHaveAttribute('data-game', 'backgammon');
  });

  it('shows who is playing, the main actions and an empty continue list', async () => {
    renderHome();
    expect(screen.getByTestId('home-screen')).toHaveAttribute('data-profile', 'alice');
    expect(screen.getByTestId('playing-as')).toHaveTextContent('Alice');
    expect(screen.getByTestId('host-button')).toBeInTheDocument();
    expect(screen.getByTestId('join-button')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('no-saved')).toBeInTheDocument());
  });

  it("hosting goes to this player's host route", async () => {
    renderHome();
    await userEvent.click(screen.getByTestId('host-button'));
    expect(screen.getByTestId('host-route')).toHaveAttribute('data-params', '{"profile":"alice"}');
  });

  it('validates the join code and accepts a pasted invite link', async () => {
    renderHome();
    await userEvent.type(screen.getByTestId('join-code-input'), 'xx');
    await userEvent.click(screen.getByTestId('join-button'));
    expect(screen.getByTestId('join-error')).toBeInTheDocument();
    await userEvent.clear(screen.getByTestId('join-code-input'));
    await userEvent.type(
      screen.getByTestId('join-code-input'),
      'https://example.test/#/join/abc234',
    );
    await userEvent.click(screen.getByTestId('join-button'));
    expect(screen.getByTestId('join-route')).toHaveAttribute(
      'data-params',
      '{"profile":"alice","code":"ABC234"}',
    );
  });
});
