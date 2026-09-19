import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import type { ClubCapabilities, ClubCustody } from '@bgf/club-spec';
import { renderWithProfile } from '../test/renderWithProfile';
import { ensureProfile } from '../session/profiles';
import { LobbyScreen } from './LobbyScreen';
import { ClubDisclosure, ClubDisclosureBadge } from './ClubDisclosure';
import { FakeClubClient, sampleCapabilities } from './testing/FakeClubClient';
import { rememberClub } from './clubsStore';
import { friendlyClubError, clubErrorRetryable } from './errors';
import type { ClubSession } from './session';

const cur = { code: 'chips', name: 'Chips', decimals: 0 };

function alice() {
  const record = ensureProfile('alice');
  return { id: record.id, name: record.name, publicKey: record.publicKey ?? 'k' };
}

function clubSession(client: FakeClubClient): ClubSession {
  return { clubId: 'club-demo-1', address: 'club-demo-1', client, dispose: () => client.close() };
}

function mountLobby(client: FakeClubClient) {
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

describe('capability gating', () => {
  it('offers only what the club declares', () => {
    const client = new FakeClubClient({
      profile: alice(),
      capabilities: {
        transfers: false,
        chipRequests: false,
        chat: false,
        statements: 'none',
        matchmaking: false,
      },
    });
    mountLobby(client);
    expect(screen.queryByTestId('transfer-button')).toBeNull();
    expect(screen.queryByTestId('request-chips-button')).toBeNull();
    expect(screen.queryByTestId('statement-button')).toBeNull();
    expect(screen.queryByTestId('club-chat')).toBeNull();
    expect(screen.queryByTestId('find-game')).toBeNull();
    // What is not optional is still there.
    expect(screen.getByTestId('lobby-table-tbl-1')).toBeInTheDocument();
    expect(screen.getByTestId('club-disclosure')).toBeInTheDocument();
  });

  it('shows everything a fully featured club offers', () => {
    const client = new FakeClubClient({ profile: alice() });
    mountLobby(client);
    for (const id of [
      'transfer-button',
      'request-chips-button',
      'statement-button',
      'club-chat',
      'find-game',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });
});

describe('club disclosure', () => {
  const cases: Array<[ClubCustody, RegExp]> = [
    [{ kind: 'hosted', operator: 'P2P Gaming' }, /P2P Gaming runs this club's books/],
    [{ kind: 'self-hosted', operator: 'Steve' }, /trusting them personally/],
    [{ kind: 'contract', chain: 'Base', address: '0xabc' }, /contract on Base/],
    [{ kind: 'local' }, /not real/],
  ];

  it.each(cases)('explains %o', (custody, detail) => {
    const caps: ClubCapabilities = sampleCapabilities({ custody });
    renderWithProfile('alice', <ClubDisclosure capabilities={caps} />, { route: '/x' });
    const panel = screen.getByTestId('club-disclosure');
    expect(panel).toHaveAttribute('data-custody', custody.kind);
    expect(screen.getByTestId('disclosure-custody')).toHaveTextContent(detail);
  });

  it('says when chips move and how you get in', () => {
    renderWithProfile(
      'alice',
      <ClubDisclosure
        capabilities={sampleCapabilities({
          settlement: 'deferred',
          commitmentTtlMs: 600_000,
          membership: 'open',
          joinGrant: 5000,
          minRakeBasisPoints: 250,
        })}
      />,
      { route: '/x' },
    );
    expect(screen.getByTestId('disclosure-settlement')).toHaveTextContent(
      /staked when you sit and settle when you leave, within 10 minutes/,
    );
    expect(screen.getByTestId('disclosure-membership')).toHaveTextContent(
      /Anyone can join and play straight away\. You start with 5000\./,
    );
    expect(screen.getByTestId('disclosure-rake')).toHaveTextContent(/2\.50%/);
  });

  it('badge opens the same details', () => {
    renderWithProfile('alice', <ClubDisclosureBadge capabilities={sampleCapabilities()} />, {
      route: '/x',
    });
    expect(screen.queryByTestId('club-disclosure-details')).toBeNull();
    fireEvent.click(screen.getByTestId('club-disclosure-badge'));
    expect(screen.getByTestId('club-disclosure-details')).toBeInTheDocument();
  });
});

describe('the shared error vocabulary', () => {
  it('says something useful for every spec code', () => {
    const codes = [
      'unauthorized',
      'not-a-member',
      'pending',
      'banned',
      'unsupported',
      'version',
      'unknown-table',
      'unknown-template',
      'unknown-member',
      'insufficient-chips',
      'commitment-exceeded',
      'commitment-stale',
      'tally-invalid',
      'not-seated',
      'seat-taken',
      'conflict',
      'invalid',
      'rate-limited',
      'unavailable',
    ];
    for (const code of codes) {
      const text = friendlyClubError(code, 'RAW');
      expect(text, code).not.toBe('RAW');
      expect(text.length, code).toBeGreaterThan(10);
    }
    expect(friendlyClubError('something-new', 'the club said this')).toBe('the club said this');
  });

  it('only offers a retry where retrying could work', () => {
    expect(clubErrorRetryable('unavailable')).toBe(true);
    expect(clubErrorRetryable('rate-limited')).toBe(true);
    expect(clubErrorRetryable('seat-taken')).toBe(true);
    expect(clubErrorRetryable('insufficient-chips')).toBe(false);
    expect(clubErrorRetryable('banned')).toBe(false);
  });

  it('shows a retry control in the lobby for a retryable failure only', () => {
    const client = new FakeClubClient({ profile: alice() });
    const view = mountLobby(client);
    act(() => client.patch({ error: { code: 'unavailable', message: 'busy', at: Date.now() } }));
    expect(screen.getByTestId('club-error')).toHaveAttribute('data-code', 'unavailable');
    expect(screen.getByTestId('club-error-retry')).toBeInTheDocument();
    view.unmount();

    const other = new FakeClubClient({ profile: alice() });
    mountLobby(other);
    act(() =>
      other.patch({ error: { code: 'insufficient-chips', message: 'no', at: Date.now() } }),
    );
    expect(screen.getByTestId('club-error')).toHaveTextContent('Not enough chips');
    expect(screen.queryByTestId('club-error-retry')).toBeNull();
  });
});

describe('deferred settlement', () => {
  it('separates staked chips from available ones', () => {
    const client = new FakeClubClient({
      profile: alice(),
      capabilities: { settlement: 'deferred', commitmentTtlMs: 300_000 },
    });
    client.sit({ tableId: 'tbl-1', buyIn: 100 });
    mountLobby(client);
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByTestId('club-balance')).toHaveTextContent('1,150 chips');
    expect(screen.getByTestId('club-staked')).toHaveTextContent(
      /100 chips staked · settles when you leave/,
    );
  });

  it('says nothing about staking when the club settles every hand', () => {
    const client = new FakeClubClient({ profile: alice() });
    client.sit({ tableId: 'tbl-1', buyIn: 100 });
    mountLobby(client);
    expect(screen.getByText('My chips')).toBeInTheDocument();
    expect(screen.queryByTestId('club-staked')).toBeNull();
  });
});
