import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LedgerEntry } from '@bgf/protocol';
import { PlatformApp } from './PlatformApp';
import type { MatchmakingStatus } from './api';
import { FakeEventSource, installFakeApi } from '../test/fakeApi';
import { fakeDetail, fakeMe, platformStatus } from '../test/platformFixtures';

const HOUSE = { clubId: 'house', name: 'The House', joinGrant: 10_000, faucet: 2_500 };

function queue(over: Partial<MatchmakingStatus> = {}): MatchmakingStatus {
  return {
    running: true,
    queued: 2,
    depthByGame: { ofc: 2 },
    medianWaitMs: 4_200,
    matchesPerMinute: 18,
    matchesTotal: 1_255,
    expiredTotal: 3,
    cancelledTotal: 1,
    oldestWaitMs: 65_000,
    house: true,
    tickets: [
      { id: 'tk1', memberId: 'm1', game: 'ofc', queuedAt: 1, waitMs: 65_000 },
      { id: 'tk2', memberId: 'm2', game: 'ofc', queuedAt: 2, waitMs: 4_200 },
    ],
    ...over,
  };
}

function grant(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    seq: 9,
    at: 1_700_000_000_000,
    kind: 'grant',
    lines: [
      { account: 'house', amount: -10_000 },
      { account: 'm1', amount: 10_000 },
    ],
    ref: { note: 'join grant', by: 'house-owner' },
    prevHash: 'a',
    hash: 'b',
    signature: 'sig',
    ...over,
  };
}

describe('HousePage', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('platform-session-token', 'tok-1');
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    window.location.hash = '#/house';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the queue, the live tables, grants and ratings, and pauses and drains matchmaking', async () => {
    let mm = queue();
    let clubFetches = 0;
    const calls: string[] = [];
    installFakeApi({
      'GET /api/me': () => fakeMe({ operator: true }),
      'GET /api/clubs/house': () => {
        clubFetches++;
        return fakeDetail({ id: 'house', name: 'The House' });
      },
      'GET /api/clubs/house/matchmaking': () => mm,
      'GET /api/clubs/house/ratings': () => ({ ofc: { m1: 1_612.4, m2: 1_388 } }),
      'GET /api/clubs/house/ledger': (_init, url) => {
        calls.push(`ledger:${url.searchParams.get('kind')}`);
        return { total: 42, entries: [grant(), grant({ seq: 8, ref: { note: 'faucet:471' } })] };
      },
      'POST /api/clubs/house/matchmaking/pause': () => {
        calls.push('pause');
        mm = queue({ running: false });
        return mm;
      },
      'POST /api/clubs/house/matchmaking/drain': () => {
        calls.push('drain');
        mm = queue({ running: false, queued: 0, tickets: [], depthByGame: {}, drained: 2 });
        return mm;
      },
    });
    render(<PlatformApp status={platformStatus({ house: HOUSE })} />);

    expect(await screen.findByTestId('house-page')).toBeInTheDocument();
    expect(await screen.findByTestId('nav-house')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The House' })).toBeInTheDocument();
    expect(screen.getByTestId('house-club-link')).toHaveAttribute('href', '#/clubs/house');

    // The queue, as the matchmaker reports it.
    expect(await screen.findByTestId('queued')).toHaveTextContent('2');
    expect(screen.getByTestId('matches-per-minute')).toHaveTextContent('18');
    expect(screen.getByTestId('matches-total')).toHaveTextContent('1,255');
    expect(screen.getByTestId('matchmaker-state')).toHaveTextContent('running');
    expect(screen.getByTestId('depth-ofc')).toHaveTextContent('Open Face Chinese Poker: 2');
    expect(screen.getByTestId('ticket-tk1')).toHaveTextContent('Ann');
    expect(screen.getByTestId('ticket-tk1')).toHaveTextContent('waiting 1m 05s');
    expect(screen.getByTestId('ticket-tk2')).toHaveTextContent('waiting 4.2s');

    // Club figures, tables, grants and ratings.
    expect(screen.getByTestId('house-members')).toHaveTextContent('2');
    expect(screen.getByTestId('house-online')).toHaveTextContent('1');
    expect(screen.getByTestId('house-faucet')).toHaveTextContent('25.00 USDC');
    expect(screen.getByTestId('house-tables-count')).toHaveTextContent('1 open · 1 seated');
    expect(screen.getByTestId('house-table-t1')).toHaveTextContent('Pineapple 1/2');
    expect(screen.getByTestId('house-table-t1')).toHaveTextContent('200.00 USDC on the table');
    expect(await screen.findByTestId('grants-total')).toHaveTextContent('42 total');
    expect(screen.getByTestId('grant-9')).toHaveTextContent('Ann · 100.00 USDC · join grant');
    expect(screen.getByTestId('grant-8')).toHaveTextContent('faucet');
    expect(calls).toContain('ledger:grant');
    expect(await screen.findByTestId('ratings-ofc')).toHaveTextContent('Ann');
    expect(screen.getByTestId('ratings-ofc')).toHaveTextContent('1612');

    // Controls.
    await userEvent.click(screen.getByTestId('toggle-matchmaking'));
    await waitFor(() => expect(screen.getByTestId('matchmaker-state')).toHaveTextContent('paused'));
    expect(screen.getByTestId('toggle-matchmaking')).toHaveTextContent('Resume');
    await userEvent.click(screen.getByTestId('drain-queue'));
    await waitFor(() => expect(screen.getByTestId('queued')).toHaveTextContent('0'));
    expect(screen.getByTestId('drain-queue')).toBeDisabled();
    expect(calls).toEqual(expect.arrayContaining(['pause', 'drain']));

    // A club event reloads the club, its tables and its grants.
    const es = FakeEventSource.instances.find((i) => i.url.includes('/clubs/house/events'));
    expect(es).toBeDefined();
    es!.onopen?.();
    const before = clubFetches;
    es!.emit({ seq: 2, clubId: 'house', type: 'sit', message: 'Ann sat', at: Date.now() });
    await waitFor(() => expect(clubFetches).toBeGreaterThan(before), { timeout: 3_000 });
    await waitFor(() =>
      expect(screen.getByTestId('house-live')).toHaveAttribute('data-live', 'open'),
    );
  });

  it('says so when the platform hosts no house club, and hides the nav link', async () => {
    installFakeApi({ 'GET /api/me': () => fakeMe({ operator: true }) });
    render(<PlatformApp status={platformStatus()} />);
    expect(await screen.findByRole('heading', { name: 'No house club' })).toBeInTheDocument();
    expect(screen.queryByTestId('nav-house')).not.toBeInTheDocument();
    expect(screen.queryByTestId('matchmaking-panel')).not.toBeInTheDocument();
  });

  it('keeps the house page away from members who are not operators', async () => {
    installFakeApi({
      'GET /api/me': () => fakeMe({ operator: false }),
      'GET /api/clubs/c1': () => fakeDetail(),
    });
    render(<PlatformApp status={platformStatus({ house: HOUSE })} />);
    expect(await screen.findByTestId('clubs-page')).toBeInTheDocument();
    expect(screen.queryByTestId('house-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-house')).not.toBeInTheDocument();
  });
});
