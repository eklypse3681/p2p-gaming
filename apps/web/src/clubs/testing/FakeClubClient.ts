import type {
  ClubIdentity,
  ClubMember,
  ClubRejectReason,
  LobbyState,
  LobbyTable,
  MemberStatement,
  PlayerProfile,
  Room,
} from '@bgf/protocol';
import type { ClubCapabilities, ClubInfo, MatchCriteria, MatchTicket } from '@bgf/club-spec';
import type { ClubClientApi, ClubClientState, ClubStatus } from '../types';

/** What the demo club declares: everything on, hosted, immediate settlement. */
export function sampleCapabilities(overrides: Partial<ClubCapabilities> = {}): ClubCapabilities {
  return {
    spec: 1,
    settlement: 'immediate',
    membership: 'invite',
    joinGrant: null,
    matchmaking: true,
    transfers: true,
    chipRequests: true,
    chat: true,
    tournaments: false,
    statements: 'full',
    minRakeBasisPoints: null,
    ratingScale: null,
    custody: { kind: 'hosted', operator: 'The Back Room' },
    ...overrides,
  };
}

export function sampleInfo(lobby: LobbyState, capabilities?: Partial<ClubCapabilities>): ClubInfo {
  return {
    identity: lobby.club,
    capabilities: sampleCapabilities(capabilities),
    rooms: lobby.rooms,
    online: lobby.online.length,
  };
}

/** A club with two rooms and one open table, enough to exercise every screen. */
export function sampleLobby(me: PlayerProfile, overrides: Partial<LobbyState> = {}): LobbyState {
  const club: ClubIdentity = {
    id: 'club-demo-1',
    name: 'The Back Room',
    publicKey: 'demo-key',
    currency: { code: 'chips', name: 'House chips', decimals: 0 },
    createdAt: 1_700_000_000_000,
    tagline: 'Friday night Pineapple and a little backgammon.',
  };
  const member: ClubMember = {
    id: me.id,
    name: me.name,
    avatar: me.avatar,
    publicKey: me.publicKey ?? 'k',
    role: 'member',
    status: 'active',
    joinedAt: 1_700_000_100_000,
  };
  const rooms: Room[] = [
    {
      id: 'main',
      name: 'Main room',
      description: 'Regular stakes, dealer-hosted.',
      templates: [
        {
          id: 'pine-27',
          name: 'Pineapple 2-7',
          game: 'ofc',
          config: { variant: 'pineapple27', seats: 3 },
          seats: 3,
          stakes: { chipsPerPoint: 1, buyIn: { min: 50, max: 500, default: 100 } },
          randomness: { mode: 'seeded', provider: 'drand' },
          alwaysOpen: true,
        },
        {
          id: 'bg-5',
          name: 'Backgammon 5-point',
          game: 'backgammon',
          config: { length: 5, crawford: true, jacoby: false },
          seats: 2,
          stakes: { chipsPerPoint: 5 },
        },
      ],
    },
    {
      id: 'high',
      name: 'High stakes',
      templates: [
        {
          id: 'pine-high',
          name: 'Pineapple ×10',
          game: 'ofc',
          config: { variant: 'pineapple', seats: 2 },
          seats: 2,
          stakes: { chipsPerPoint: 10, buyIn: { min: 500, max: 5000, default: 1000 } },
        },
      ],
    },
  ];
  const tables: LobbyTable[] = [
    {
      id: 'tbl-1',
      roomId: 'main',
      templateId: 'pine-27',
      templateName: 'Pineapple 2-7',
      game: 'ofc',
      code: 'CLUBT1',
      seats: [{ name: 'Bob', memberId: 'bob' }, null, null],
      status: 'open',
      stacks: [100, 0, 0],
    },
  ];
  return {
    club,
    rooms,
    tables,
    me: { member, balance: 1250 },
    online: ['bob', me.id],
    ...overrides,
  };
}

export interface FakeClubOptions {
  profile: PlayerProfile;
  lobby?: LobbyState;
  /** Start in this status instead of `joined`. */
  status?: ClubStatus;
  rejectReason?: ClubRejectReason;
  /** Resolve `sit` with this seat (default: the first free seat of the table / a new table). */
  seatCode?: string;
  /** What this club declares about itself. */
  capabilities?: Partial<ClubCapabilities>;
  /**
   * Seat a queued player automatically after this long. Off in tests (they drive `matchNow`);
   * the `?fakeclub=1` dev flag turns it on so matchmaking can be walked end to end.
   */
  autoMatchMs?: number;
}

/** In-memory `ClubClientApi`: every call updates state synchronously and records itself. */
export class FakeClubClient implements ClubClientApi {
  readonly profile: PlayerProfile;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private state: ClubClientState;
  private readonly listeners = new Set<() => void>();
  private nextTable = 2;

  constructor(opts: FakeClubOptions) {
    this.profile = opts.profile;
    const lobby = opts.lobby ?? sampleLobby(opts.profile);
    const status = opts.status ?? 'joined';
    this.state = {
      status,
      rejectReason: status === 'rejected' ? (opts.rejectReason ?? 'not-a-member') : null,
      info: sampleInfo(lobby, opts.capabilities),
      lobby: status === 'joined' ? lobby : null,
      statement: null,
      balance: status === 'joined' ? lobby.me.balance : null,
      staked: 0,
      chat: [],
      error:
        status === 'rejected'
          ? { code: opts.rejectReason ?? 'not-a-member', message: 'not admitted', at: Date.now() }
          : null,
      seat: null,
      ticket: null,
      queueEnded: null,
      settlement: null,
    };
    this.seatCode = opts.seatCode;
    this.autoMatchMs = opts.autoMatchMs ?? 0;
  }
  private readonly seatCode: string | undefined;
  private readonly autoMatchMs: number;
  private autoMatchTimer: ReturnType<typeof setTimeout> | null = null;
  private nextTicket = 1;

  private get deferred(): boolean {
    return this.state.info?.capabilities.settlement === 'deferred';
  }

  getState(): ClubClientState {
    return this.state;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Tests: push a new state (e.g. simulate a drop or an incoming lobby). */
  patch(patch: Partial<ClubClientState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }
  private emit(): void {
    for (const l of Array.from(this.listeners)) l();
  }
  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  refresh(): void {
    this.record('refresh');
    this.emit();
  }
  sit(opts: { tableId?: string; templateId?: string; buyIn?: number }): void {
    this.record('sit', opts);
    const lobby = this.state.lobby;
    if (!lobby) return;
    let table = opts.tableId ? lobby.tables.find((t) => t.id === opts.tableId) : undefined;
    if (!table) {
      const tpl = lobby.rooms.flatMap((r) => r.templates).find((t) => t.id === opts.templateId);
      if (!tpl) {
        this.patch({
          error: { code: 'unknown-template', message: 'no such template', at: Date.now() },
        });
        return;
      }
      table = {
        id: `tbl-${this.nextTable++}`,
        roomId: lobby.rooms.find((r) => r.templates.includes(tpl))!.id,
        templateId: tpl.id,
        templateName: tpl.name,
        game: tpl.game,
        code: this.seatCode ?? `CLUB${String(this.nextTable).padStart(2, '0')}`,
        seats: new Array(tpl.seats).fill(null),
        status: 'open',
        stacks: new Array(tpl.seats).fill(0),
      };
      lobby.tables = [...lobby.tables, table];
    }
    const seat = table.seats.findIndex((s) => s === null);
    if (seat < 0) {
      this.patch({ error: { code: 'table-full', message: 'that table is full', at: Date.now() } });
      return;
    }
    const buyIn = opts.buyIn ?? 0;
    table.seats[seat] = { name: this.profile.name, memberId: this.profile.id };
    table.stacks[seat] = buyIn;
    const balance = (this.state.balance ?? 0) - buyIn;
    this.patch({
      lobby: { ...lobby, tables: [...lobby.tables], me: { ...lobby.me, balance } },
      balance,
      staked: this.state.staked + buyIn,
      seat: { tableId: table.id, code: table.code, game: table.game, seat, buyIn },
    });
  }
  leave(tableId: string): void {
    this.record('leave', tableId);
    const staked = this.state.seat?.tableId === tableId ? this.state.seat.buyIn : 0;
    const balance = (this.state.balance ?? 0) + staked;
    this.patch({
      seat: this.state.seat?.tableId === tableId ? null : this.state.seat,
      staked: Math.max(0, this.state.staked - staked),
      balance,
      ...(this.deferred && staked
        ? {
            settlement: {
              tableId,
              balances: { [this.profile.id]: balance },
              entries: [{ memberId: this.profile.id, net: 0, rake: 0 }],
              rake: 0,
              settledAt: Date.now(),
            },
          }
        : {}),
    });
  }

  queue(criteria: MatchCriteria): void {
    this.record('queue', criteria);
    const ticket: MatchTicket = {
      id: `tkt-${this.nextTicket++}`,
      memberId: this.profile.id,
      criteria,
      queuedAt: Date.now(),
      estimate: { queueDepth: 3, waitMs: 20_000 },
    };
    this.patch({ ticket, queueEnded: null });
    if (this.autoMatchMs > 0) {
      this.autoMatchTimer = setTimeout(() => this.matchNow(), this.autoMatchMs);
    }
  }

  unqueue(ticketId?: string): void {
    this.record('unqueue', ticketId ?? this.state.ticket?.id);
    if (this.autoMatchTimer) clearTimeout(this.autoMatchTimer);
    this.autoMatchTimer = null;
    this.patch({ ticket: null, queueEnded: { reason: 'member', at: Date.now() } });
  }

  /** Tests: complete the queued ticket by seating the player at a table. */
  matchNow(opts: { tableId?: string; templateId?: string; buyIn?: number } = {}): void {
    const ticket = this.state.ticket;
    if (!ticket) return;
    this.patch({ ticket: null, queueEnded: { reason: 'matched', at: Date.now() } });
    this.sit({ tableId: opts.tableId ?? 'tbl-1', buyIn: opts.buyIn ?? 100, ...opts });
  }
  statement(): void {
    this.record('statement');
    const lobby = this.state.lobby;
    if (!lobby) return;
    const me = this.profile.id;
    const statement: MemberStatement = {
      memberId: me,
      balance: this.state.balance ?? 0,
      entries: [
        {
          seq: 1,
          at: 1_700_000_200_000,
          kind: 'grant',
          lines: [
            { account: 'house', amount: -1000 },
            { account: me, amount: 1000 },
          ],
          ref: { note: 'Welcome stack' },
          prevHash: '',
          hash: 'h1',
          signature: 's1',
        },
        {
          seq: 2,
          at: 1_700_000_300_000,
          kind: 'result',
          lines: [
            { account: me, amount: 250 },
            { account: 'bob', amount: -250 },
          ],
          ref: { tableId: 'tbl-0', hand: 3, game: 'ofc' },
          prevHash: 'h1',
          hash: 'h2',
          signature: 's2',
        },
      ],
      head: { seq: 2, hash: 'h2', signature: 's2' },
    };
    this.patch({ statement });
  }
  transfer(to: string, amount: number, note?: string): void {
    this.record('transfer', to, amount, note);
    const balance = (this.state.balance ?? 0) - amount;
    this.patch({ balance });
  }
  requestChips(amount: number, note?: string): void {
    this.record('requestChips', amount, note);
  }
  chat(text: string): void {
    this.record('chat', text);
    this.patch({
      chat: [
        ...this.state.chat,
        { from: { id: this.profile.id, name: this.profile.name }, text, at: Date.now() },
      ],
    });
  }
  close(): void {
    this.record('close');
    if (this.autoMatchTimer) clearTimeout(this.autoMatchTimer);
    this.autoMatchTimer = null;
    this.patch({ status: 'disconnected' });
  }
}
