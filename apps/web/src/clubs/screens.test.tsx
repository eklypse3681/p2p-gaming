import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProfile } from '../test/renderWithProfile';
import { ClubsScreen } from './ClubsScreen';
import { LobbyScreen } from './LobbyScreen';
import { ClubJoinScreen } from './ClubJoinScreen';
import { ClubChip } from './ClubChip';
import { encodeClubInvite } from './invites';
import { rememberClub, listJoinedClubs } from './clubsStore';
import { FakeClubClient, sampleLobby } from './testing/FakeClubClient';
import { ensureProfile } from '../session/profiles';
import type { ClubSession } from './session';

const cur = { code: 'chips', name: 'Chips', decimals: 0 };
/** The fake club must speak about the same player the screen renders as (`alice`'s real id). */
function alice() {
  const record = ensureProfile('alice');
  return { id: record.id, name: record.name, publicKey: record.publicKey ?? 'k' };
}
const token = encodeClubInvite({
  clubId: 'club-demo-1',
  clubName: 'The Back Room',
  address: 'club-demo-1',
  role: 'member',
  autoApprove: true,
  nonce: 'n',
});

function clubSession(client: FakeClubClient): ClubSession {
  return { clubId: 'club-demo-1', address: 'club-demo-1', client, dispose: () => client.close() };
}

describe('ClubsScreen', () => {
  beforeEach(() => localStorage.clear());

  it('lists joined clubs and joins by token', () => {
    rememberClub('alice', {
      clubId: 'c1',
      name: 'One',
      address: 'c1',
      currency: cur,
      lastSeen: 1,
      balance: 300,
    });
    renderWithProfile('alice', <ClubsScreen />, {
      route: '/clubs',
      markers: { 'club/join/:token': 'club-join-route', 'club/:clubId': 'lobby-route' },
    });
    expect(screen.getByTestId('clubs-list')).toBeInTheDocument();
    expect(screen.getByTestId('club-c1')).toHaveTextContent('300 chips');
    fireEvent.change(screen.getByTestId('club-invite-input'), {
      target: { value: `https://x/#/club/join/${token}` },
    });
    fireEvent.click(screen.getByTestId('club-join-button'));
    expect(screen.getByTestId('club-join-route')).toHaveAttribute(
      'data-params',
      expect.stringContaining(token),
    );
  });

  it('rejects a bad invite inline', () => {
    renderWithProfile('alice', <ClubsScreen />, { route: '/clubs' });
    expect(screen.getByTestId('clubs-empty')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('club-invite-input'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('club-join-button'));
    expect(screen.getByTestId('club-join-error')).toHaveTextContent(/invite/);
  });
});

describe('ClubJoinScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/?fakeclub=1');
  });

  it('connects (fake club), remembers the club and enters the lobby', async () => {
    renderWithProfile('alice', <ClubJoinScreen />, {
      route: `/club/join/${token}`,
      uiPath: 'club/join/:token',
      markers: { 'club/:clubId': 'lobby-route' },
    });
    await waitFor(() => expect(screen.getByTestId('lobby-route')).toBeInTheDocument());
    expect(listJoinedClubs('alice')[0]).toMatchObject({
      clubId: 'club-demo-1',
      name: 'The Back Room',
      invite: token,
    });
  });

  it('explains a damaged invite', () => {
    renderWithProfile('alice', <ClubJoinScreen />, {
      route: '/club/join/p2pc1.zzz',
      uiPath: 'club/join/:token',
    });
    expect(screen.getByTestId('club-join-error')).toHaveTextContent(/damaged/);
  });
});

describe('LobbyScreen', () => {
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

  function mount(client: FakeClubClient) {
    return renderWithProfile('alice', <LobbyScreen />, {
      route: '/club/club-demo-1',
      uiPath: 'club/:clubId',
      clubSessions: [['alice', clubSession(client)]],
      markers: { 'ofc/join/:code': 'ofc-join-route', 'backgammon/join/:code': 'bg-join-route' },
    });
  }

  it('renders the club, balance, rooms, templates and tables', () => {
    const client = new FakeClubClient({ profile: alice() });
    mount(client);
    expect(screen.getByTestId('club-name')).toHaveTextContent('The Back Room');
    expect(screen.getByTestId('club-balance')).toHaveTextContent('1,250 chips');
    expect(screen.getByTestId('room-main')).toBeInTheDocument();
    expect(screen.getByTestId('template-pine-27')).toHaveTextContent(/1 chips per point/);
    expect(screen.getByTestId('template-pine-27')).toHaveTextContent(/buy-in 50 chips–500 chips/);
    expect(screen.getByTestId('lobby-table-tbl-1')).toHaveTextContent('Bob · 100 chips');
    expect(screen.getByTestId('club-role')).toHaveTextContent(/member · 2 online/);
  });

  it('sitting navigates to the game join route with the club context and records the seat', async () => {
    const client = new FakeClubClient({ profile: alice() });
    mount(client);
    fireEvent.click(screen.getByTestId('sit-tbl-1'));
    expect(client.calls.at(-1)).toEqual({
      method: 'sit',
      args: [{ tableId: 'tbl-1', buyIn: 100 }],
    });
    await waitFor(() => expect(screen.getByTestId('ofc-join-route')).toBeInTheDocument());
    expect(screen.getByTestId('ofc-join-route')).toHaveAttribute(
      'data-params',
      expect.stringContaining('CLUBT1'),
    );
    expect(client.getState().seat?.tableId).toBe('tbl-1');
  });

  it('returning to the lobby while seated does not bounce back to the table', async () => {
    const client = new FakeClubClient({ profile: alice() });
    client.sit({ tableId: 'tbl-1', buyIn: 100 });
    mount(client);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('ofc-join-route')).toBeNull();
    expect(screen.getByTestId('lobby-table-tbl-1')).toHaveTextContent('Return');
  });

  it('opening a template validates the buy-in range', () => {
    const client = new FakeClubClient({ profile: alice() });
    mount(client);
    fireEvent.change(screen.getByTestId('buyin-pine-27'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('open-template-pine-27'));
    expect(screen.getByTestId('lobby-error')).toHaveTextContent(/between 50 chips and 500 chips/);
    expect(client.calls.some((c) => c.method === 'sit')).toBe(false);
  });

  it('statement, transfer, request and chat drive the client', async () => {
    const client = new FakeClubClient({ profile: alice() });
    mount(client);
    fireEvent.click(screen.getByTestId('statement-button'));
    await waitFor(() =>
      expect(screen.getByTestId('statement-entry-2')).toHaveTextContent('+250 chips'),
    );
    expect(screen.getByTestId('statement-balance')).toHaveTextContent('Balance now: 1,250 chips');
    expect(screen.queryByText(/signed|verify/i)).toBeNull();
    fireEvent.change(screen.getByTestId('request-amount'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('request-chips-button'));
    expect(client.calls.some((c) => c.method === 'requestChips' && c.args[0] === 50)).toBe(true);
    fireEvent.change(screen.getByTestId('transfer-to'), { target: { value: 'bob' } });
    fireEvent.change(screen.getByTestId('transfer-amount'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('transfer-button'));
    expect(
      client.calls.some((c) => c.method === 'transfer' && c.args[0] === 'bob' && c.args[1] === 25),
    ).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId('club-balance')).toHaveTextContent('1,225 chips'),
    );
    fireEvent.change(screen.getByTestId('club-chat-input'), { target: { value: 'gg' } });
    fireEvent.click(screen.getByTestId('club-chat-send'));
    await waitFor(() => expect(screen.getByTestId('club-chat-message')).toHaveTextContent('gg'));
  });

  it('explains rejected memberships', () => {
    for (const reason of ['pending', 'not-a-member', 'banned'] as const) {
      const client = new FakeClubClient({
        profile: alice(),
        status: 'rejected',
        rejectReason: reason,
      });
      const view = mount(client);
      expect(screen.getByTestId('club-rejected')).toHaveTextContent(
        reason === 'pending' ? /approve/ : reason === 'banned' ? /banned/ : /not a member/,
      );
      view.unmount();
    }
  });

  it('shows a reconnect control when the club drops', async () => {
    const client = new FakeClubClient({ profile: alice() });
    mount(client);
    act(() => client.patch({ status: 'disconnected' }));
    await waitFor(() => expect(screen.getByTestId('club-connecting')).toHaveTextContent(/lost/));
    expect(screen.getByTestId('club-reconnect')).toBeInTheDocument();
  });

  it('asks for an invite when the club is unknown', () => {
    localStorage.clear();
    renderWithProfile('alice', <LobbyScreen />, { route: '/club/nope', uiPath: 'club/:clubId' });
    expect(screen.getByText(/Unknown club/)).toBeInTheDocument();
  });
});

describe('ClubChip', () => {
  beforeEach(() => {
    localStorage.clear();
    rememberClub('alice', {
      clubId: 'club-demo-1',
      name: 'The Back Room',
      address: 'club-demo-1',
      currency: cur,
      lastSeen: 1,
      balance: 900,
    });
  });

  it('renders nothing without a club context', () => {
    renderWithProfile('alice', <ClubChip />, { route: '/x' });
    expect(screen.queryByTestId('club-chip')).toBeNull();
  });

  it('shows the club, balance and stack from the live session', () => {
    const me = alice();
    const client = new FakeClubClient({ profile: me, lobby: sampleLobby(me) });
    client.sit({ tableId: 'tbl-1', buyIn: 100 });
    renderWithProfile('alice', <ClubChip />, {
      route: '/x?club=club-demo-1&table=tbl-1',
      clubSessions: [['alice', clubSession(client)]],
      markers: { 'club/:clubId': 'lobby-route' },
    });
    expect(screen.getByTestId('club-chip')).toHaveTextContent('The Back Room');
    expect(screen.getByTestId('club-chip-balance')).toHaveTextContent('1,150 chips');
    expect(screen.getByTestId('club-chip-stack')).toHaveTextContent('100 chips');
    fireEvent.click(screen.getByTestId('back-to-lobby'));
    expect(screen.getByTestId('lobby-route')).toBeInTheDocument();
  });

  it('leaving cashes out: shows progress, then returns to the lobby once the seat clears', async () => {
    const me = alice();
    const client = new FakeClubClient({ profile: me, lobby: sampleLobby(me) });
    client.sit({ tableId: 'tbl-1', buyIn: 100 });
    renderWithProfile('alice', <ClubChip />, {
      route: '/x?club=club-demo-1&table=tbl-1',
      clubSessions: [['alice', clubSession(client)]],
      markers: { 'club/:clubId': 'lobby-route' },
    });
    fireEvent.click(screen.getByTestId('leave-table'));
    expect(client.calls.at(-1)).toEqual({ method: 'leave', args: ['tbl-1'] });
    expect(screen.getByTestId('cashing-out')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('lobby-route')).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('shows a plain rake line on templates that carry one', () => {
    const me = alice();
    const lobby = sampleLobby(me);
    Object.assign(lobby.rooms[0]!.templates[0]!, { rake: { percent: 2, cap: 5 } });
    const client = new FakeClubClient({ profile: me, lobby });
    rememberClub('alice', {
      clubId: 'club-demo-1',
      name: 'The Back Room',
      address: 'club-demo-1',
      currency: cur,
      lastSeen: 1,
    });
    renderWithProfile('alice', <LobbyScreen />, {
      route: '/club/club-demo-1',
      uiPath: 'club/:clubId',
      clubSessions: [['alice', clubSession(client)]],
    });
    expect(screen.getByTestId('template-pine-27')).toHaveTextContent(/2% rake, cap 5 chips/);
  });
});
