import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformApp } from './PlatformApp';
import { FakeEventSource, installFakeApi } from '../test/fakeApi';
import { body, fakeDetail, fakeMe, fakeSummary, platformStatus } from '../test/platformFixtures';

describe('ClubsPage', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('platform-session-token', 'tok-1');
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.location.hash = '#/clubs';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists my clubs and creates a new one', async () => {
    let me = fakeMe();
    let created: Record<string, unknown> | null = null;
    installFakeApi({
      'GET /api/me': () => me,
      'POST /api/clubs': (init) => {
        created = body(init);
        const club = fakeSummary({
          id: 'c2',
          name: String(created.name),
          tagline: String(created.tagline),
          currency: created.currency as (typeof me.clubs)[0]['currency'],
          reserve: 0,
          circulation: 0,
          minted: 0,
          members: 1,
          pendingMembers: 0,
          tables: 0,
        });
        me = { ...me, clubs: [...me.clubs, { ...club, role: 'owner' }] };
        return club;
      },
      'GET /api/clubs/c2': () =>
        fakeDetail({ id: 'c2', name: 'Deuce Night', tables: [], members: [] }),
    });
    render(<PlatformApp status={platformStatus()} />);
    const card = await screen.findByTestId('club-card-c1');
    expect(card).toHaveTextContent('Thursday Club');
    expect(card).toHaveTextContent('Pineapple on Thursdays');
    expect(card).toHaveAttribute('data-role', 'owner');
    expect(card).toHaveTextContent('1 member · 0 online · 1 table');
    expect(card).toHaveTextContent('5,000.00 USDC');

    await userEvent.type(screen.getByTestId('club-name'), 'Deuce Night');
    await userEvent.type(screen.getByTestId('club-tagline'), '2-7 only');
    await userEvent.clear(screen.getByTestId('currency-code'));
    await userEvent.type(screen.getByTestId('currency-code'), '🪙');
    await userEvent.clear(screen.getByTestId('currency-name'));
    await userEvent.type(screen.getByTestId('currency-name'), 'Coins');
    await userEvent.clear(screen.getByTestId('currency-decimals'));
    await userEvent.type(screen.getByTestId('currency-decimals'), '0');
    await userEvent.click(screen.getByTestId('create-club'));
    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toEqual({
      name: 'Deuce Night',
      tagline: '2-7 only',
      currency: { code: '🪙', name: 'Coins', decimals: 0 },
    });
    await waitFor(() => expect(window.location.hash).toBe('#/clubs/c2'));
    expect(await screen.findByTestId('club-page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Deuce Night');
  });

  it('shows an empty state and the create error from the server', async () => {
    installFakeApi({
      'GET /api/me': () => fakeMe({ clubs: [] }),
      'POST /api/clubs': () => {
        throw Object.assign(new Error('a club needs a name'), { status: 400, code: 'bad-club' });
      },
    });
    render(<PlatformApp status={platformStatus()} />);
    expect(await screen.findByTestId('no-clubs')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('club-name'), 'x');
    await userEvent.click(screen.getByTestId('create-club'));
    expect(await screen.findByTestId('create-club-error')).toHaveTextContent('a club needs a name');
  });
});
