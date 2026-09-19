import { describe, expect, it } from 'vitest';
import type {
  ClubApi,
  ClubInfo,
  ClubSession,
  ClubUpdate,
  Idempotent,
  MatchCriteria,
  SeatGrant,
  SitRequest,
} from '@bgf/club-spec';
import { ClubError } from '@bgf/club-spec';
import type { LobbyState, PlayerProfile } from '@bgf/protocol';
import { ClubApiClient } from './ClubApiClient';
import { sampleLobby, sampleInfo } from './testing/FakeClubClient';

/**
 * The adapter is what every screen actually reads, so it is tested against a real `ClubApi`
 * rather than against another fake of itself: whatever a conforming club does, the store must
 * end up in the right shape.
 */

const me: PlayerProfile = { id: 'alice', name: 'Alice', publicKey: 'k' };

class TestClub implements ClubApi {
  readonly ops: Array<{ method: string; opId?: string; args: unknown }> = [];
  lobbyState: LobbyState = sampleLobby(me);
  failNext: ClubError | null = null;
  /** opId → the grant already issued, so a repeat returns the same seat. */
  private readonly applied = new Map<string, SeatGrant>();
  private listener: ((u: ClubUpdate) => void) | null = null;

  info(): Promise<ClubInfo> {
    return Promise.resolve(sampleInfo(this.lobbyState));
  }
  challenge(): Promise<{ nonce: string; clubId: string }> {
    return Promise.resolve({ nonce: 'n', clubId: 'club-demo-1' });
  }
  authenticate(): Promise<ClubSession> {
    return Promise.resolve({ member: this.lobbyState.me.member, token: 't' });
  }
  lobby(): Promise<LobbyState> {
    this.ops.push({ method: 'lobby', args: null });
    return Promise.resolve(this.lobbyState);
  }
  subscribe(_s: ClubSession, listener: (u: ClubUpdate) => void) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  /** Drive an update as a club would. */
  push(u: ClubUpdate): void {
    this.listener?.(u);
  }
  private guard(): void {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }
  sit(_s: ClubSession, req: SitRequest): Promise<SeatGrant> {
    this.ops.push({ method: 'sit', opId: req.opId, args: req });
    const already = this.applied.get(req.opId);
    if (already) return Promise.resolve(already);
    this.guard();
    const grant: SeatGrant = {
      tableId: req.tableId ?? 'tbl-new',
      code: 'CLUBT1',
      game: 'ofc',
      seat: 1,
      commitment: {
        tableId: req.tableId ?? 'tbl-new',
        memberId: me.id,
        amount: req.buyIn ?? 0,
        nonce: `n-${this.applied.size}`,
        issuedAt: 1,
        expiresAt: 2,
        signature: 'sig',
      },
    };
    this.applied.set(req.opId, grant);
    return Promise.resolve(grant);
  }
  leave(_s: ClubSession, req: { tableId: string } & Idempotent) {
    this.ops.push({ method: 'leave', opId: req.opId, args: req });
    return Promise.resolve({
      tableId: req.tableId,
      balances: { [me.id]: 1300 },
      entries: [{ memberId: me.id, net: 150, rake: 0 }],
      rake: 0,
      settledAt: 5,
    });
  }
  settle() {
    return Promise.reject(new ClubError('unsupported', 'players do not settle'));
  }
  statement() {
    this.ops.push({ method: 'statement', args: null });
    return Promise.resolve({
      memberId: me.id,
      balance: 1250,
      entries: [],
      head: { seq: 0, hash: '', signature: '' },
    });
  }
  transfer(_s: ClubSession, req: { to: string; amount: number } & Idempotent) {
    this.ops.push({ method: 'transfer', opId: req.opId, args: req });
    this.guard();
    return Promise.resolve({ opId: req.opId, balance: 1250 - req.amount, at: 1 });
  }
  requestChips(_s: ClubSession, req: { amount: number } & Idempotent) {
    this.ops.push({ method: 'requestChips', opId: req.opId, args: req });
    return Promise.resolve({ opId: req.opId, at: 1 });
  }
  chat(_s: ClubSession, text: string) {
    this.ops.push({ method: 'chat', args: text });
    return Promise.resolve();
  }
  queue(_s: ClubSession, criteria: MatchCriteria, req: Idempotent) {
    this.ops.push({ method: 'queue', opId: req.opId, args: criteria });
    this.guard();
    return Promise.resolve({
      id: 'tkt-1',
      memberId: me.id,
      criteria,
      queuedAt: 10,
    });
  }
  unqueue(_s: ClubSession, ticketId: string) {
    this.ops.push({ method: 'unqueue', args: ticketId });
    return Promise.resolve();
  }
  disconnect() {
    this.ops.push({ method: 'disconnect', args: null });
    return Promise.resolve();
  }
}

function make(club = new TestClub()) {
  const lobby = club.lobbyState;
  const client = new ClubApiClient({
    api: club,
    session: { member: lobby.me.member, token: 't' },
    profile: me,
    info: sampleInfo(lobby),
    lobby,
  });
  return { club, client };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe('ClubApiClient', () => {
  it('starts from the lobby it was handed', () => {
    const { client } = make();
    expect(client.getState().status).toBe('joined');
    expect(client.getState().balance).toBe(1250);
    expect(client.getState().info?.capabilities.spec).toBe(1);
  });

  it('sitting stakes chips and records the commitment', async () => {
    const { client } = make();
    client.sit({ tableId: 'tbl-1', buyIn: 100 });
    await settled();
    const s = client.getState();
    expect(s.seat).toMatchObject({ tableId: 'tbl-1', code: 'CLUBT1', buyIn: 100 });
    expect(s.seat?.commitment?.nonce).toBe('n-0');
    expect(s.staked).toBe(100);
    expect(s.balance).toBe(1150);
  });

  it('retries a failed sit with the same operation id, so chips move once', async () => {
    const { club, client } = make();
    club.failNext = new ClubError('unavailable', 'busy');
    client.sit({ tableId: 'tbl-1', buyIn: 100 });
    await settled();
    expect(client.getState().error?.code).toBe('unavailable');
    expect(client.getState().seat).toBeNull();

    client.sit({ tableId: 'tbl-1', buyIn: 100 });
    await settled();
    const ids = club.ops.filter((o) => o.method === 'sit').map((o) => o.opId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(client.getState().seat?.tableId).toBe('tbl-1');
  });

  it('a fresh action after success gets a new operation id', async () => {
    const { club, client } = make();
    client.sit({ tableId: 'tbl-1', buyIn: 100 });
    await settled();
    client.sit({ tableId: 'tbl-1', buyIn: 100 });
    await settled();
    const ids = club.ops.filter((o) => o.method === 'sit').map((o) => o.opId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('leaving settles and reports the new balance', async () => {
    const { client } = make();
    client.sit({ tableId: 'tbl-1', buyIn: 100 });
    await settled();
    client.leave('tbl-1');
    await settled();
    const s = client.getState();
    expect(s.seat).toBeNull();
    expect(s.staked).toBe(0);
    expect(s.balance).toBe(1300);
    expect(s.settlement?.entries[0]).toMatchObject({ memberId: me.id, net: 150 });
  });

  it('turns a club failure into the shared error code', async () => {
    const { club, client } = make();
    club.failNext = new ClubError('insufficient-chips', 'not enough');
    client.transfer('bob', 10_000);
    await settled();
    expect(client.getState().error).toMatchObject({ code: 'insufficient-chips' });
  });

  it('follows the matchmaking lifecycle the club pushes', async () => {
    const { club, client } = make();
    client.queue({ game: 'ofc' });
    await settled();
    expect(client.getState().ticket?.id).toBe('tkt-1');

    club.push({
      kind: 'match',
      event: { kind: 'estimate', ticketId: 'tkt-1', estimate: { queueDepth: 4 } },
    });
    expect(client.getState().ticket?.estimate?.queueDepth).toBe(4);

    club.push({
      kind: 'match',
      event: {
        kind: 'matched',
        ticketId: 'tkt-1',
        grant: {
          tableId: 'tbl-9',
          code: 'MATCH1',
          game: 'ofc',
          seat: 0,
          commitment: {
            tableId: 'tbl-9',
            memberId: me.id,
            amount: 200,
            nonce: 'm1',
            issuedAt: 1,
            expiresAt: 2,
            signature: 's',
          },
        },
      },
    });
    const s = client.getState();
    expect(s.ticket).toBeNull();
    expect(s.seat).toMatchObject({ tableId: 'tbl-9', code: 'MATCH1', buyIn: 200 });
    expect(s.staked).toBe(200);
  });

  it('records a cancelled queue with its reason', async () => {
    const { club, client } = make();
    client.queue({ game: 'ofc' });
    await settled();
    club.push({
      kind: 'match',
      event: { kind: 'cancelled', ticketId: 'tkt-1', reason: 'expired' },
    });
    expect(client.getState().ticket).toBeNull();
    expect(client.getState().queueEnded?.reason).toBe('expired');
  });

  it('applies pushed balance, chat and closure', () => {
    const { club, client } = make();
    club.push({ kind: 'balance', balance: 42 });
    expect(client.getState().balance).toBe(42);
    club.push({ kind: 'chat', from: { id: 'bob', name: 'Bob' }, text: 'hi', at: 7 });
    expect(client.getState().chat).toHaveLength(1);
    club.push({ kind: 'closed', reason: 'bye' });
    expect(client.getState().status).toBe('disconnected');
  });

  it('closing unsubscribes and disconnects', async () => {
    const { club, client } = make();
    client.close();
    await settled();
    expect(club.ops.some((o) => o.method === 'disconnect')).toBe(true);
    expect(client.getState().status).toBe('disconnected');
  });
});
