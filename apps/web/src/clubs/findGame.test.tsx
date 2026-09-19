import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProfile } from '../test/renderWithProfile';
import { ensureProfile } from '../session/profiles';
import { LobbyScreen } from './LobbyScreen';
import { FakeClubClient } from './testing/FakeClubClient';
import { rememberClub } from './clubsStore';
import { getQueue, rememberQueue } from './queueStore';
import type { ClubSession } from './session';

const cur = { code: 'chips', name: 'Chips', decimals: 0 };

function alice() {
  const record = ensureProfile('alice');
  return { id: record.id, name: record.name, publicKey: record.publicKey ?? 'k' };
}

function clubSession(client: FakeClubClient): ClubSession {
  return { clubId: 'club-demo-1', address: 'club-demo-1', client, dispose: () => client.close() };
}

function mount(client: FakeClubClient) {
  return renderWithProfile('alice', <LobbyScreen />, {
    route: '/club/club-demo-1',
    uiPath: 'club/:clubId',
    clubSessions: [['alice', clubSession(client)]],
    markers: { 'ofc/join/:code': 'ofc-join-route' },
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  rememberClub('alice', {
    clubId: 'club-demo-1',
    name: 'The Back Room',
    address: 'club-demo-1',
    currency: cur,
    lastSeen: 1,
  });
});

describe('finding a game', () => {
  it('queues with the criteria the player chose', () => {
    const client = new FakeClubClient({ profile: alice() });
    mount(client);
    expect(screen.getByTestId('find-game')).toHaveAttribute('data-queued', 'false');
    fireEvent.click(screen.getByTestId('criteria-game-ofc'));
    fireEvent.click(screen.getByTestId('criteria-seats-3'));
    fireEvent.change(screen.getByTestId('criteria-stakes'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('criteria-software'));
    fireEvent.click(screen.getByTestId('queue-button'));
    expect(client.calls.at(-1)).toEqual({
      method: 'queue',
      args: [{ game: 'ofc', seats: [3], stakes: { max: 5 }, allowSoftware: false }],
    });
  });

  it('shows the wait, the depth and a running clock while queued', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = new FakeClubClient({ profile: alice() });
      mount(client);
      fireEvent.click(screen.getByTestId('queue-button'));
      await waitFor(() =>
        expect(screen.getByTestId('find-game')).toHaveAttribute('data-queued', 'true'),
      );
      expect(screen.getByTestId('queue-status')).toHaveTextContent(/Open Face Chinese|ofc/i);
      expect(screen.getByTestId('queue-depth')).toHaveTextContent('3 waiting');
      expect(screen.getByTestId('queue-elapsed')).toHaveTextContent('0s');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByTestId('queue-elapsed')).toHaveTextContent(/[1-9]s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelling leaves the queue and says so', async () => {
    const client = new FakeClubClient({ profile: alice() });
    mount(client);
    fireEvent.click(screen.getByTestId('queue-button'));
    await waitFor(() => expect(screen.getByTestId('cancel-queue')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('cancel-queue'));
    await waitFor(() =>
      expect(screen.getByTestId('find-game')).toHaveAttribute('data-queued', 'false'),
    );
    expect(screen.getByTestId('queue-ended')).toHaveTextContent('You left the queue.');
    expect(client.calls.some((c) => c.method === 'unqueue')).toBe(true);
    expect(getQueue('alice', 'club-demo-1')).toBeUndefined();
  });

  it('a match sends the player straight to the table', async () => {
    const client = new FakeClubClient({ profile: alice() });
    mount(client);
    fireEvent.click(screen.getByTestId('queue-button'));
    await waitFor(() => expect(screen.getByTestId('cancel-queue')).toBeInTheDocument());
    act(() => client.matchNow({ tableId: 'tbl-1', buyIn: 100 }));
    await waitFor(() => expect(screen.getByTestId('ofc-join-route')).toBeInTheDocument());
    expect(getQueue('alice', 'club-demo-1')).toBeUndefined();
  });

  it('remembers the ticket so a reload re-queues', async () => {
    const client = new FakeClubClient({ profile: alice() });
    const view = mount(client);
    fireEvent.click(screen.getByTestId('queue-button'));
    await waitFor(() => expect(screen.getByTestId('cancel-queue')).toBeInTheDocument());
    expect(getQueue('alice', 'club-demo-1')?.criteria.game).toBe('ofc');
    view.unmount();

    // Coming back with a fresh client (as a reload would): the club is asked again.
    const reloaded = new FakeClubClient({ profile: alice() });
    mount(reloaded);
    await waitFor(() => expect(reloaded.calls.some((c) => c.method === 'queue')).toBe(true));
    expect(reloaded.calls.find((c) => c.method === 'queue')?.args[0]).toMatchObject({
      game: 'ofc',
    });
  });

  it('drops a remembered ticket when the club does not do matchmaking', async () => {
    rememberQueue('alice', {
      clubId: 'club-demo-1',
      ticketId: 't1',
      criteria: { game: 'ofc' },
      queuedAt: Date.now(),
    });
    const client = new FakeClubClient({
      profile: alice(),
      capabilities: { matchmaking: false },
    });
    mount(client);
    await waitFor(() => expect(getQueue('alice', 'club-demo-1')).toBeUndefined());
    expect(client.calls.some((c) => c.method === 'queue')).toBe(false);
  });
});
