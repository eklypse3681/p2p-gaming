import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('idb-keyval', async () => {
  const { createIdbKeyvalMock } = await import('../test/idbKeyvalMock');
  return createIdbKeyvalMock();
});

import { AppRoutes } from './App';
import { SessionRegistryProvider } from '../session/SessionRegistry';
import { ToastProvider } from '../hud/Toast';
import { createProfile, resetProfilesForTests } from '../session/profiles';
import { setMatchStoreForTests } from '../session/matchStore';

function renderAt(entry: string) {
  return render(
    <ToastProvider>
      <SessionRegistryProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppRoutes />
        </MemoryRouter>
      </SessionRegistryProvider>
    </ToastProvider>,
  );
}

describe('app routes', () => {
  beforeEach(() => {
    localStorage.clear();
    setMatchStoreForTests();
    resetProfilesForTests();
    createProfile('Alice');
  });

  it('shows the picker at the root and the games hub for a player', async () => {
    renderAt('/');
    expect(await screen.findByTestId('picker-screen')).toBeInTheDocument();
  });

  it('the games hub lists registered games and a placeholder', async () => {
    renderAt('/alice/');
    const hub = await screen.findByTestId('games-hub');
    expect(hub).toHaveAttribute('data-profile', 'alice');
    expect(screen.getByTestId('game-card-backgammon')).toHaveTextContent('Backgammon');
    expect(screen.getByTestId('game-card-ofc')).toHaveTextContent('Open Face Chinese Poker');
    expect(screen.getByTestId('game-card-soon')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('app-bar')).toHaveAttribute('data-game', '');
  });

  it('mounts a game home under #/<profile>/<game>/ with the game in the app bar', async () => {
    renderAt('/alice/backgammon/');
    expect(await screen.findByTestId('home-screen')).toHaveAttribute('data-game', 'backgammon');
    expect(screen.getByTestId('app-bar')).toHaveAttribute('data-game', 'backgammon');
    expect(screen.getByTestId('nav-game')).toHaveTextContent('Backgammon');
  });

  it('mounts the OFC home and host screens under #/<profile>/ofc/', async () => {
    renderAt('/alice/ofc/');
    expect(await screen.findByTestId('home-screen')).toHaveAttribute('data-game', 'ofc');
    expect(screen.getByTestId('app-bar')).toHaveAttribute('data-game', 'ofc');
    expect(screen.getByTestId('nav-game')).toHaveTextContent('Open Face Chinese Poker');
    renderAt('/alice/ofc/host');
    expect(await screen.findByTestId('rules-editor')).toBeInTheDocument();
  });

  it('redirects old profile-level game addresses to backgammon', async () => {
    renderAt('/alice/host');
    expect(await screen.findByTestId('host-screen')).toBeInTheDocument();
    expect(screen.getByTestId('app-bar')).toHaveAttribute('data-game', 'backgammon');
  });

  it('redirects old history addresses and keeps the query', async () => {
    renderAt('/alice/history?match=m1');
    expect(await screen.findByTestId('history-screen')).toBeInTheDocument();
  });

  it('redirects an unknown game sub-path to the game home', async () => {
    renderAt('/alice/backgammon/nope/x');
    expect(await screen.findByTestId('home-screen')).toBeInTheDocument();
  });

  it('serves the demo at #/backgammon/demo and redirects #/demo to it', async () => {
    renderAt('/backgammon/demo');
    expect(await screen.findByTestId('demo-screen')).toBeInTheDocument();
    renderAt('/demo');
    expect((await screen.findAllByTestId('demo-screen')).length).toBeGreaterThan(0);
  });

  it('a game-typed invite link opens the picker in joining mode', async () => {
    renderAt('/backgammon/join/abc234');
    expect(await screen.findByTestId('picker-joining')).toHaveTextContent('Backgammon');
  });

  it('a profile-level settings route needs no game', async () => {
    renderAt('/alice/settings');
    expect(await screen.findByTestId('settings-screen')).toBeInTheDocument();
    expect(screen.getByTestId('app-bar')).toHaveAttribute('data-game', '');
  });
});
