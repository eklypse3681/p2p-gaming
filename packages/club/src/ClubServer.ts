import type {
  ChipRequest,
  ClubClientMessage,
  ClubInvite,
  ClubMember,
  ClubRejectReason,
  ClubServerMessage,
  LedgerEntry,
  LobbyState,
  LobbyTable,
  MemberRole,
  MemberStatement,
  PlayerProfile,
  Room,
  Signer,
  TableStakes,
  TableTemplate,
  Transport,
  Unsubscribe,
} from '@bgf/protocol';
import {
  CLUB_PROTOCOL_VERSION,
  Emitter,
  base64UrlToBytes,
  clubChallengeBytes,
  generateId,
  randomNonce,
  verify,
} from '@bgf/protocol';
import type { ClubErrorCode } from '@bgf/club-spec';
import type {
  AuthRequest,
  ChipRequestInput,
  ClubApi,
  ClubInfo,
  ClubSession,
  ClubUpdate,
  Idempotent,
  LeaveRequest,
  MatchCancelReason,
  MatchCriteria,
  MatchPolicy,
  MatchTicket,
  Receipt,
  SeatGrant,
  Settlement,
  SitRequest,
  TableTally,
  TransferRequest,
} from '@bgf/club-spec';
import {
  CLUB_SPEC_VERSION,
  ClubError as SpecError,
  checkTally,
  criteriaCompatible,
  referenceMatchPolicy,
} from '@bgf/club-spec';
import type { ClubCapabilities } from '@bgf/club-spec';
import type { PendingChallenge } from '@bgf/table';
import { beginChallenge, cancelChallenge, verifyChallengeAnswer } from '@bgf/table';
import {
  addCommitment,
  closeCommitments,
  commitmentsOf,
  encumbered,
  expiredCommitments,
  findCommitment,
  liveCommitments,
  newNonce,
  pruneCommitments,
  signCommitment,
} from './domain/commitments.js';
import { argumentHash, recordOp, replayOf } from './domain/idempotency.js';
import { ClubError } from './domain/identity.js';
import type { ClubPolicy } from './domain/policy.js';
import { capabilitiesFor, resolvePolicy } from './domain/policy.js';
import { consumeInvite, createInvite, revokeInvite, verifyInvite } from './domain/invites.js';
import type { CreateInviteOptions } from './domain/invites.js';
import {
  HOUSE,
  appendEntry,
  balanceOf,
  mint,
  rakeFor,
  seatStack,
  settleHand,
  statementFor,
  tableAccount,
} from './domain/ledger.js';
import type { HandTransfer } from './domain/ledger.js';
import type { LedgerDraft } from './domain/ledger.js';
import { lobbyFor } from './domain/lobby.js';
import {
  activeMembers,
  approveMember,
  banMember,
  findMember,
  isAdmin,
  requestJoin,
  setRole,
} from './domain/members.js';
import type { GameRegistry } from './domain/rooms.js';
import {
  addRoom,
  addTemplate,
  findTemplate,
  removeRoom,
  removeTemplate,
  updateRoom,
  updateTemplate,
} from './domain/rooms.js';
import type { ClubState } from './domain/state.js';
import { PLATFORM_MIN_RAKE_BPS } from './platform.js';
import { validateClubMessage } from './validate.js';

/**
 * How the club runtime exposes its tables to the club server. The registry seats members and
 * reports what is open; the club moves the chips around those events.
 */
export interface TableRegistry {
  list(): LobbyTable[];
  sit(req: {
    member: ClubMember;
    template: TableTemplate;
    roomId: string;
    tableId?: string;
    /** Open a new table rather than filling a part-full one (matchmaking seats whole groups). */
    fresh?: boolean;
    buyIn: number;
  }): Promise<{ tableId: string; code: string; game: string; seat: number }>;
  leave(req: { member: ClubMember; tableId: string }): Promise<{ cashOut: number }>;
  /** Members already sitting somewhere, so nobody is matched into a second table. */
  seated?(): Set<string>;
  onChange(listener: () => void): Unsubscribe;
}

export interface ClubServerOptions {
  state: ClubState;
  /** Signs ledger entries and invites with the club's private key. */
  signer: Signer;
  tables: TableRegistry;
  /** Games available for templates (seat bounds, config normalisation). */
  games?: GameRegistry;
  now?: () => number;
  persist?: (state: ClubState) => void;
  challengeTimeoutMs?: number;
  /** Devices per member; the oldest is dropped beyond this. */
  maxDevices?: number;
  /** Platform key that chip certificates must verify against (default: built-in). */
  platformPublicKey?: string;
  /**
   * Overrides on top of whatever the club's own state says it is. Custody in particular is a
   * deployment fact the runtime knows and the club does not.
   */
  policy?: Partial<ClubPolicy>;
  /** Who gets seated with whom. Defaults to the spec's reference policy. */
  matchPolicy?: MatchPolicy;
  /** How often to look for matches. 0 disables the timer; call `runMatchmaking()` yourself. */
  matchTickMs?: number;
  /** A queued ticket is dropped after this long. 0 means never. */
  ticketTtlMs?: number;
  /** A member whose devices all went away keeps their place in the queue this long. */
  disconnectGraceMs?: number;
}

/** A queued ticket, plus the lifecycle the club tracks around it. */
interface QueueEntry {
  ticket: MatchTicket;
  /** Set when the member's last device went away; the ticket dies if they do not come back. */
  offlineSince: number | null;
}

export const DEFAULT_MATCH_TICK_MS = 500;
export const DEFAULT_TICKET_TTL_MS = 10 * 60_000;
export const DEFAULT_DISCONNECT_GRACE_MS = 30_000;

interface Connection {
  transport: Transport;
  memberId: string | null;
  session?: ClubSession;
  closed: boolean;
  unsubscribe: Unsubscribe[];
  pending?: {
    profile: PlayerProfile;
    invite?: ClubInvite;
    challenge: PendingChallenge;
    verifying: boolean;
  };
}

export const CLUB_CHALLENGE_TIMEOUT_MS = 30_000;
export const MAX_DEVICES_PER_MEMBER = 4;
const LOBBY_DEBOUNCE_MS = 25;

export interface ClubEvent {
  kind: 'joined' | 'left' | 'ledger' | 'member' | 'rooms' | 'request' | 'chat';
  memberId?: string;
  entry?: LedgerEntry;
  text?: string;
}

/**
 * The club channel: authenticates members with the keyed challenge, serves the lobby, moves chips
 * for sits/leaves/results, and exposes admin operations for the runtime and its console.
 */
export class ClubServer implements ClubApi {
  private state: ClubState;
  private readonly signer: Signer;
  private readonly tables: TableRegistry;
  private readonly games: GameRegistry;
  private readonly now: () => number;
  private readonly persist: (state: ClubState) => void;
  private readonly challengeTimeoutMs: number;
  private readonly maxDevices: number;
  private readonly platformPublicKey: string | undefined;
  private readonly connections = new Set<Connection>();
  private readonly devices = new Map<string, Connection[]>();
  private readonly events = new Emitter<ClubEvent>();
  private readonly unsubscribeTables: Unsubscribe;
  private lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly policyOverride: Partial<ClubPolicy> | undefined;
  /** Outstanding challenges for the request/response path (the transport path has its own). */
  private readonly apiChallenges = new Map<string, { profileId: string; expiresAt: number }>();
  private readonly sessions = new Map<string, string>();
  private readonly apiSubscribers = new Map<string, Set<(update: ClubUpdate) => void>>();
  /** The one queue. Lifecycle lives here; who gets grouped is `matchPolicy`'s business. */
  private readonly tickets = new Map<string, QueueEntry>();
  private readonly matchPolicy: MatchPolicy;
  private readonly ticketTtlMs: number;
  private readonly disconnectGraceMs: number;
  private matchTimer: ReturnType<typeof setInterval> | null = null;
  private matchPaused = false;
  /** The sweep in flight, so callers await it rather than racing past it. */
  private matchRunning: Promise<void> | null = null;
  private matchWanted = false;

  constructor(opts: ClubServerOptions) {
    this.state = opts.state;
    this.signer = opts.signer;
    this.tables = opts.tables;
    this.games = opts.games ?? {};
    this.now = opts.now ?? Date.now;
    this.persist = opts.persist ?? (() => {});
    this.challengeTimeoutMs = opts.challengeTimeoutMs ?? CLUB_CHALLENGE_TIMEOUT_MS;
    this.maxDevices = opts.maxDevices ?? MAX_DEVICES_PER_MEMBER;
    this.platformPublicKey = opts.platformPublicKey;
    this.policyOverride = opts.policy;
    this.matchPolicy = opts.matchPolicy ?? referenceMatchPolicy();
    this.ticketTtlMs = opts.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
    this.disconnectGraceMs = opts.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
    this.unsubscribeTables = this.tables.onChange(() => this.scheduleLobby());
    const every = opts.matchTickMs ?? this.matchPolicy.tickMs ?? DEFAULT_MATCH_TICK_MS;
    if (every > 0) {
      this.matchTimer = setInterval(() => void this.runMatchmaking(), every);
      (this.matchTimer as { unref?: () => void }).unref?.();
    }
  }

  getState(): ClubState {
    return this.state;
  }

  onEvent(listener: (event: ClubEvent) => void): Unsubscribe {
    return this.events.on(listener);
  }

  /** Member ids with at least one live device. */
  online(): string[] {
    return Array.from(this.devices.keys());
  }

  accept(transport: Transport): void {
    if (this.closed) {
      transport.close();
      return;
    }
    const conn: Connection = { transport, memberId: null, closed: false, unsubscribe: [] };
    this.connections.add(conn);
    conn.unsubscribe.push(transport.onMessage((raw) => void this.handle(conn, raw)));
    conn.unsubscribe.push(
      transport.onStatus((status) => {
        if (status === 'closed') this.detach(conn);
      }),
    );
    if (transport.status === 'closed') this.detach(conn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
    if (this.matchTimer) clearInterval(this.matchTimer);
    this.matchTimer = null;
    this.drainMatchmaking('unavailable');
    this.unsubscribeTables();
    for (const conn of Array.from(this.connections)) this.closeConnection(conn);
    this.events.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Runtime hooks: results and fees flow in from the tables the registry runs
  // ---------------------------------------------------------------------------------------------

  /**
   * Record a hand's outcome. `transfers` are member-to-member point transfers (the engine's
   * pairwise nets); chips move between the seat stacks at the template's chips-per-point and
   * the rake is burned from the winners. Points-only tables record nothing.
   */
  async recordResult(input: {
    tableId: string;
    game: string;
    hand?: number;
    transfers: HandTransfer[];
    stakes: TableStakes;
  }): Promise<{ result: LedgerEntry | null; burn: LedgerEntry | null }> {
    const settled = settleHand({ ...input, at: this.now() });
    if (settled.result.lines.length === 0) return { result: null, burn: null };
    // The result and its rake burn are one serialised step: a cash-out slipping in between
    // would empty the winner's stack before the rake could be taken from it.
    return this.serialised(async () => {
      const result = await this.appendNow(settled.result);
      const burn = settled.burn ? await this.appendNow(settled.burn) : null;
      return { result, burn };
    });
  }

  async recordFee(input: {
    account: string;
    amount: number;
    tableId?: string;
    note?: string;
  }): Promise<LedgerEntry> {
    if (input.amount <= 0) throw new ClubError('bad-entry', 'fees are positive');
    return this.append({
      kind: 'fee',
      lines: [
        { account: input.account, amount: -input.amount },
        { account: HOUSE, amount: input.amount },
      ],
      ref: {
        ...(input.tableId ? { tableId: input.tableId } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Admin surface (console / runtime; never over the member channel)
  // ---------------------------------------------------------------------------------------------

  readonly admin = {
    /** Mint chips into the reserve from a platform certificate token. */
    mint: async (token: string, by: string): Promise<LedgerEntry> => {
      this.requireAdmin(by);
      return this.serialised(async () => {
        const { state, entry } = await mint(this.state, token, this.signer, {
          now: this.now(),
          ...(this.platformPublicKey ? { platformPublicKey: this.platformPublicKey } : {}),
        });
        this.setState(state);
        this.events.emit({ kind: 'ledger', entry });
        return entry;
      });
    },
    grant: async (
      memberId: string,
      amount: number,
      by: string,
      note?: string,
    ): Promise<LedgerEntry> => {
      this.requireAdmin(by);
      if (amount <= 0) throw new ClubError('bad-entry', 'grants are positive');
      return this.append({
        kind: 'grant',
        lines: [
          { account: HOUSE, amount: -amount },
          { account: memberId, amount },
        ],
        ref: { by, ...(note ? { note } : {}) },
      });
    },
    redeem: async (
      memberId: string,
      amount: number,
      by: string,
      note?: string,
    ): Promise<LedgerEntry> => {
      this.requireAdmin(by);
      if (amount <= 0) throw new ClubError('bad-entry', 'redemptions are positive');
      return this.append({
        kind: 'redeem',
        lines: [
          { account: memberId, amount: -amount },
          { account: HOUSE, amount },
        ],
        ref: { by, ...(note ? { note } : {}) },
      });
    },
    adjust: async (
      memberId: string,
      amount: number,
      by: string,
      note: string,
    ): Promise<LedgerEntry> => {
      this.requireAdmin(by);
      if (amount === 0) throw new ClubError('bad-entry', 'nothing to adjust');
      return this.append({
        kind: 'adjust',
        lines: [
          { account: memberId, amount },
          { account: HOUSE, amount: -amount },
        ],
        ref: { by, note },
      });
    },
    approve: (memberId: string, by: string): void => {
      this.setState(approveMember(this.state, memberId, by));
      this.events.emit({ kind: 'member', memberId });
    },
    ban: (memberId: string, by: string): void => {
      this.setState(banMember(this.state, memberId, by));
      for (const conn of this.devices.get(memberId) ?? [])
        this.reject(conn, 'banned', 'you were removed from the club');
      this.events.emit({ kind: 'member', memberId });
    },
    setRole: (memberId: string, role: MemberRole, by: string): void => {
      this.setState(setRole(this.state, memberId, role, by));
      this.events.emit({ kind: 'member', memberId });
    },
    createInvite: async (
      opts: CreateInviteOptions & { by: string },
    ): Promise<{ token: string; invite: ClubInvite }> => {
      this.requireAdmin(opts.by);
      const { state, token, invite } = await createInvite(
        this.state,
        this.signer,
        opts,
        this.now(),
      );
      this.setState(state);
      return { token, invite };
    },
    revokeInvite: (nonce: string, by: string): void => {
      this.requireAdmin(by);
      this.setState(revokeInvite(this.state, nonce));
    },
    requests: {
      list: (): ChipRequest[] => this.state.requests,
      resolve: async (
        id: string,
        by: string,
        decision: 'granted' | 'declined',
        note?: string,
      ): Promise<ChipRequest> => {
        this.requireAdmin(by);
        const request = this.state.requests.find((r) => r.id === id);
        if (!request) throw new ClubError('no-request', 'no such request');
        if (request.status !== 'pending') throw new ClubError('resolved', 'already resolved');
        if (decision === 'granted')
          await this.admin.grant(request.memberId, request.amount, by, note ?? request.note);
        const resolved: ChipRequest = {
          ...request,
          status: decision,
          resolvedBy: by,
          resolvedAt: this.now(),
        };
        this.setState({
          ...this.state,
          requests: this.state.requests.map((r) => (r.id === id ? resolved : r)),
        });
        this.sendToMember(request.memberId, { type: 'chip-request', request: resolved });
        this.events.emit({ kind: 'request', memberId: request.memberId });
        return resolved;
      },
    },
    rooms: {
      add: (input: { name: string; description?: string; id?: string }, by: string): Room => {
        this.requireAdmin(by);
        const { state, room } = addRoom(this.state, input);
        this.setState(state);
        this.events.emit({ kind: 'rooms' });
        return room;
      },
      update: (
        roomId: string,
        patch: Partial<Pick<Room, 'name' | 'description'>>,
        by: string,
      ): void => {
        this.requireAdmin(by);
        this.setState(updateRoom(this.state, roomId, patch));
        this.events.emit({ kind: 'rooms' });
      },
      remove: (roomId: string, by: string): void => {
        this.requireAdmin(by);
        this.setState(removeRoom(this.state, roomId));
        this.events.emit({ kind: 'rooms' });
      },
      addTemplate: (
        roomId: string,
        input: Omit<TableTemplate, 'id'> & { id?: string },
        by: string,
      ): TableTemplate => {
        this.requireAdmin(by);
        const { state, template } = addTemplate(this.state, roomId, input, this.games);
        this.setState(state);
        this.events.emit({ kind: 'rooms' });
        return template;
      },
      updateTemplate: (
        templateId: string,
        patch: Partial<Omit<TableTemplate, 'id'>>,
        by: string,
      ): void => {
        this.requireAdmin(by);
        this.setState(updateTemplate(this.state, templateId, patch, this.games));
        this.events.emit({ kind: 'rooms' });
      },
      removeTemplate: (templateId: string, by: string): void => {
        this.requireAdmin(by);
        this.setState(removeTemplate(this.state, templateId));
        this.events.emit({ kind: 'rooms' });
      },
    },
  };

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  private requireAdmin(by: string): void {
    if (!isAdmin(findMember(this.state, by)))
      throw new ClubError('forbidden', 'only the owner or an admin may do that');
  }

  private setState(state: ClubState): void {
    this.state = state;
    this.persist(state);
    this.scheduleLobby();
  }

  /** Ledger writes are serialised: signing is asynchronous, and two concurrent appends reading
   *  the same base state would otherwise lose one of the entries. */
  private ledgerChain: Promise<unknown> = Promise.resolve();

  private serialised<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.ledgerChain.then(fn, fn);
    this.ledgerChain = next.catch(() => undefined);
    return next;
  }

  private append(
    draft: LedgerDraft,
    opts?: { buyInBounds?: { min: number; max: number } },
  ): Promise<LedgerEntry> {
    return this.serialised(() => this.appendNow(draft, opts));
  }

  private async appendNow(
    draft: LedgerDraft,
    opts?: { buyInBounds?: { min: number; max: number } },
  ): Promise<LedgerEntry> {
    const { state, entry } = await appendEntry(
      this.state,
      { ...draft, at: this.now() },
      this.signer,
      {
        ...(opts?.buyInBounds ? { buyInBounds: opts.buyInBounds } : {}),
        now: this.now(),
      },
    );
    this.setState(state);
    for (const line of entry.lines) {
      if (line.account !== HOUSE && !line.account.startsWith('table:')) {
        this.sendToMember(line.account, {
          type: 'balance',
          balance: balanceOf(this.state, line.account),
        });
      }
    }
    this.events.emit({ kind: 'ledger', entry });
    return entry;
  }

  private scheduleLobby(): void {
    if (this.closed || this.lobbyTimer) return;
    this.lobbyTimer = setTimeout(() => {
      this.lobbyTimer = null;
      this.broadcastLobby();
    }, LOBBY_DEBOUNCE_MS);
  }

  private broadcastLobby(): void {
    if (this.closed) return;
    const tables = this.tables.list();
    const online = this.online();
    for (const [memberId, conns] of this.devices) {
      let lobby;
      try {
        lobby = lobbyFor(this.state, tables, memberId, online);
      } catch {
        continue;
      }
      for (const conn of conns) this.send(conn, { type: 'lobby', lobby });
    }
  }

  private send(conn: Connection, message: ClubServerMessage): void {
    if (conn.closed || conn.transport.status === 'closed') return;
    try {
      conn.transport.send(message);
    } catch {
      /* the status handler cleans up */
    }
  }

  private sendToMember(memberId: string, message: ClubServerMessage): void {
    for (const conn of this.devices.get(memberId) ?? []) this.send(conn, message);
  }

  private broadcast(message: ClubServerMessage): void {
    for (const conns of this.devices.values()) for (const conn of conns) this.send(conn, message);
  }

  private reject(conn: Connection, reason: ClubRejectReason, message: string): void {
    this.send(conn, { type: 'rejected', reason, message });
    this.closeConnection(conn);
  }

  private closeConnection(conn: Connection): void {
    if (conn.closed) return;
    this.detach(conn);
    try {
      conn.transport.close();
    } catch {
      /* ignore */
    }
  }

  private detach(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.pending) cancelChallenge(conn.pending.challenge);
    conn.pending = undefined;
    if (conn.session) {
      this.sessions.delete(conn.session.token);
      conn.session = undefined;
    }
    for (const u of conn.unsubscribe) u();
    conn.unsubscribe = [];
    this.connections.delete(conn);
    const memberId = conn.memberId;
    if (memberId === null) return;
    const remaining = (this.devices.get(memberId) ?? []).filter((c) => c !== conn);
    if (remaining.length > 0) {
      this.devices.set(memberId, remaining);
      return;
    }
    this.devices.delete(memberId);
    this.noteMemberOffline(memberId);
    this.events.emit({ kind: 'left', memberId });
    this.scheduleLobby();
  }

  private async handle(conn: Connection, raw: unknown): Promise<void> {
    if (conn.closed || this.closed) return;
    const result = validateClubMessage(raw);
    if (!result.ok) {
      if (conn.memberId === null) this.reject(conn, 'protocol', `expected hello: ${result.reason}`);
      else this.send(conn, { type: 'error', code: 'bad-message', message: result.reason });
      return;
    }
    const msg = result.message;
    if (conn.memberId === null) {
      if (conn.pending) {
        if (msg.type !== 'auth') {
          this.reject(conn, 'unauthorized', 'answer the challenge first');
          return;
        }
        await this.handleAuth(conn, msg.signature);
        return;
      }
      if (msg.type === 'call' && msg.method === 'info') {
        // `info` is answerable to anyone: a client has to read the capabilities before it can
        // decide whether it wants to join at all.
        this.send(conn, { type: 'result', id: msg.id, ok: true, value: await this.info() });
        return;
      }
      if (msg.type !== 'hello') {
        this.reject(conn, 'protocol', 'first message must be hello');
        return;
      }
      await this.handleHello(conn, msg);
      return;
    }
    if (msg.type === 'hello' || msg.type === 'auth') {
      this.send(conn, { type: 'error', code: 'already-joined', message: 'hello already received' });
      return;
    }
    await this.handleMember(conn, conn.memberId, msg);
  }

  private async handleHello(
    conn: Connection,
    msg: Extract<ClubClientMessage, { type: 'hello' }>,
  ): Promise<void> {
    if (msg.protocol !== CLUB_PROTOCOL_VERSION) {
      this.reject(
        conn,
        'protocol',
        `club protocol ${msg.protocol} not supported (server is ${CLUB_PROTOCOL_VERSION})`,
      );
      return;
    }
    if (msg.spec !== undefined && msg.spec > CLUB_SPEC_VERSION) {
      this.reject(conn, 'version', `this club serves club spec ${CLUB_SPEC_VERSION}`);
      return;
    }
    const profile = msg.profile;
    if (!profile.publicKey) {
      this.reject(conn, 'unauthorized', 'a keyed player is required to enter a club');
      return;
    }
    let invite: ClubInvite | undefined;
    if (msg.invite) {
      try {
        invite = await verifyInvite(
          msg.invite,
          this.state.identity.publicKey,
          this.state.identity.id,
          this.now(),
        );
      } catch (e) {
        this.reject(conn, 'not-a-member', e instanceof Error ? e.message : 'bad invite');
        return;
      }
    }
    if (conn.closed) return;
    const known = findMember(this.state, profile.id);
    if (known && known.publicKey !== profile.publicKey) {
      this.reject(conn, 'unauthorized', 'that member id belongs to a different key');
      return;
    }
    if (!known && !invite && this.policy().membership === 'invite') {
      this.reject(conn, 'not-a-member', 'an invite is needed to join this club');
      return;
    }
    const challenge = beginChallenge({
      publicKey: profile.publicKey,
      timeoutMs: this.challengeTimeoutMs,
      onTimeout: () => {
        if (!conn.closed && conn.memberId === null)
          this.reject(conn, 'unauthorized', 'no answer to the challenge');
      },
    });
    conn.pending = { profile, invite, challenge, verifying: false };
    this.send(conn, { type: 'challenge', nonce: challenge.nonce, clubId: this.state.identity.id });
  }

  private async handleAuth(conn: Connection, signature: string): Promise<void> {
    const pending = conn.pending;
    if (!pending || pending.verifying) return;
    pending.verifying = true;
    const ok = await verifyChallengeAnswer(
      pending.challenge,
      clubChallengeBytes({
        clubId: this.state.identity.id,
        profileId: pending.profile.id,
        nonce: pending.challenge.nonce,
      }),
      signature,
    );
    if (conn.closed || this.closed) return;
    cancelChallenge(pending.challenge);
    conn.pending = undefined;
    if (!ok) {
      this.reject(conn, 'unauthorized', 'the challenge was not signed with the right key');
      return;
    }
    let member: ClubMember;
    try {
      member = await this.joinRoster(pending.profile, pending.invite);
    } catch (e) {
      const code = e instanceof ClubError ? e.code : 'unauthorized';
      this.reject(
        conn,
        code === 'not-a-member' ? 'not-a-member' : 'unauthorized',
        e instanceof Error ? e.message : 'refused',
      );
      return;
    }
    if (member.status === 'banned') {
      this.reject(conn, 'banned', 'you were removed from this club');
      return;
    }
    if (member.status === 'pending') {
      this.reject(conn, 'pending', 'your membership is waiting for approval');
      return;
    }
    conn.memberId = member.id;
    const list = this.devices.get(member.id) ?? [];
    const first = list.length === 0;
    this.devices.set(member.id, [...list, conn]);
    while ((this.devices.get(member.id)?.length ?? 0) > this.maxDevices) {
      this.closeConnection(this.devices.get(member.id)![0]!);
    }
    this.send(conn, {
      type: 'welcome',
      lobby: lobbyFor(this.state, this.tables.list(), member.id, this.online()),
    });
    if (first) {
      this.noteMemberOnline(member.id);
      this.events.emit({ kind: 'joined', memberId: member.id });
      this.scheduleLobby();
    }
  }

  private async handleMember(
    conn: Connection,
    memberId: string,
    msg: ClubClientMessage,
  ): Promise<void> {
    const member = findMember(this.state, memberId);
    if (!member || member.status !== 'active') {
      this.reject(
        conn,
        member?.status === 'banned' ? 'banned' : 'unauthorized',
        'membership is no longer active',
      );
      return;
    }
    try {
      switch (msg.type) {
        case 'lobby':
          this.send(conn, {
            type: 'lobby',
            lobby: lobbyFor(this.state, this.tables.list(), memberId, this.online()),
          });
          return;
        case 'statement':
          this.send(conn, { type: 'statement', statement: statementFor(this.state, memberId) });
          return;
        case 'ping':
          this.send(conn, { type: 'pong', t: msg.t });
          return;
        case 'bye':
          this.closeConnection(conn);
          return;
        case 'chat': {
          const at = this.now();
          this.broadcast({
            type: 'chat',
            from: { id: member.id, name: member.name },
            text: msg.text,
            at,
          });
          this.events.emit({ kind: 'chat', memberId, text: msg.text });
          return;
        }
        case 'transfer': {
          const to = findMember(this.state, msg.to);
          if (!to || to.status !== 'active')
            throw new ClubError('no-member', 'no such active member');
          if (to.id === memberId) throw new ClubError('bad-entry', 'cannot transfer to yourself');
          await this.append({
            kind: 'transfer',
            lines: [
              { account: memberId, amount: -msg.amount },
              { account: to.id, amount: msg.amount },
            ],
            ref: { by: memberId, ...(msg.note ? { note: msg.note } : {}) },
          });
          return;
        }
        case 'request-chips': {
          const request: ChipRequest = {
            id: generateId(),
            memberId,
            amount: msg.amount,
            ...(msg.note ? { note: msg.note } : {}),
            at: this.now(),
            status: 'pending',
          };
          this.setState({ ...this.state, requests: [...this.state.requests, request] });
          this.send(conn, { type: 'chip-request', request });
          this.events.emit({ kind: 'request', memberId });
          return;
        }
        case 'sit': {
          const grant = await this.sit(this.sessionOf(conn, member), {
            opId: generateId(),
            ...(msg.tableId ? { tableId: msg.tableId } : {}),
            ...(msg.templateId ? { templateId: msg.templateId } : {}),
            ...(msg.buyIn !== undefined ? { buyIn: msg.buyIn } : {}),
          });
          this.send(conn, {
            type: 'seat',
            tableId: grant.tableId,
            code: grant.code,
            game: grant.game,
            seat: grant.seat,
            buyIn: grant.commitment.amount,
          });
          return;
        }
        case 'leave':
          await this.leave(this.sessionOf(conn, member), {
            opId: generateId(),
            tableId: msg.tableId,
          });
          return;
        case 'call':
          await this.handleCall(conn, member, msg);
          return;
        default:
          return;
      }
    } catch (e) {
      this.send(conn, {
        type: 'error',
        code: legacyCode(e),
        message: e instanceof Error ? e.message : 'refused',
      });
    }
  }

  /**
   * Move whatever a member has on a table back to their balance (leaving, or a seat the member
   * never took). The stack is read inside the serialised section so a result landing in between
   * cannot make the cash-out overdraw the table account. Returns the entry, or null if the
   * stack was empty.
   */
  async cashOut(tableId: string, memberId: string): Promise<LedgerEntry | null> {
    const entry = await this.serialised(() => this.cashOutNow(tableId, memberId));
    this.scheduleLobby();
    return entry;
  }

  /** The same, for callers that already hold the ledger lock. */
  private async cashOutNow(tableId: string, memberId: string): Promise<LedgerEntry | null> {
    const stack = seatStack(this.state, tableId, memberId);
    if (stack <= 0) return null;
    return this.appendNow({
      kind: 'cash-out',
      lines: [
        { account: tableAccount(tableId, memberId), amount: -stack },
        { account: memberId, amount: stack },
      ],
      ref: { tableId },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // ClubApi: the specified interface. The transport path above funnels into these same methods,
  // so an in-process caller and a remote one get identical behaviour.
  // ---------------------------------------------------------------------------------------------

  policy(): ClubPolicy {
    return resolvePolicy(this.state.policy, this.policyOverride);
  }

  capabilities(): ClubCapabilities {
    return capabilitiesFor(this.policy());
  }

  async info(): Promise<ClubInfo> {
    return {
      identity: this.state.identity,
      capabilities: this.capabilities(),
      rooms: this.state.rooms,
      online: this.online().length,
    };
  }

  async challenge(profileId: string): Promise<{ nonce: string; clubId: string }> {
    const nonce = randomNonce(16);
    this.apiChallenges.set(nonce, {
      profileId,
      expiresAt: this.now() + this.challengeTimeoutMs,
    });
    return { nonce, clubId: this.state.identity.id };
  }

  async authenticate(req: AuthRequest): Promise<ClubSession> {
    return this.api(async () => {
      if (req.spec > CLUB_SPEC_VERSION) {
        throw new SpecError('version', `this club serves club spec ${CLUB_SPEC_VERSION}`);
      }
      const pending = this.apiChallenges.get(req.nonce);
      if (!pending || pending.profileId !== req.profile.id) {
        throw new SpecError('unauthorized', 'unknown or mismatched challenge');
      }
      this.apiChallenges.delete(req.nonce);
      if (pending.expiresAt < this.now()) {
        throw new SpecError('unauthorized', 'the challenge expired');
      }
      const member = await this.admit(req.profile, req.signature, req.nonce, req.invite);
      return this.openSession(member);
    });
  }

  /**
   * Put a profile on the roster and pay the welcome grant if this is their first arrival.
   *
   * Both doors into the club come through here — the in-process `authenticate` and the
   * transport handshake — because they must agree. They did not once, and a member arriving
   * over a connection was quietly left with nothing.
   */
  private async joinRoster(profile: PlayerProfile, invite?: ClubInvite): Promise<ClubMember> {
    const membership = this.policy().membership;
    const known = findMember(this.state, profile.id);
    if (!known && !invite && membership === 'invite') {
      throw new SpecError('not-a-member', 'an invite is needed to join this club');
    }
    let state = this.state;
    if (invite && !findMember(state, profile.id)) state = consumeInvite(state, invite);
    const joined = requestJoin(state, profile, invite, this.now(), { membership });
    this.setState(joined.state);
    const member = joined.member;
    if (joined.created) {
      this.events.emit({ kind: 'member', memberId: member.id });
      const grant = this.policy().joinGrant;
      if (grant && member.status === 'active') {
        await this.append({
          kind: 'grant',
          lines: [
            { account: HOUSE, amount: -grant },
            { account: member.id, amount: grant },
          ],
          ref: { note: 'welcome grant' },
          // A club with an empty reserve cannot pay, and that must not block the door.
        }).catch(() => undefined);
      }
    }
    return member;
  }

  /** Verify a signed challenge and seat the profile on the roster according to policy. */
  private async admit(
    profile: PlayerProfile,
    signature: string,
    nonce: string,
    inviteToken?: string,
  ): Promise<ClubMember> {
    if (!profile.publicKey) throw new SpecError('unauthorized', 'a keyed player is required');
    const known = findMember(this.state, profile.id);
    if (known && known.publicKey !== profile.publicKey) {
      throw new SpecError('unauthorized', 'that member id belongs to a different key');
    }
    const ok = await verifyDetached(
      profile.publicKey,
      clubChallengeBytes({ clubId: this.state.identity.id, profileId: profile.id, nonce }),
      signature,
    );
    if (!ok) throw new SpecError('unauthorized', 'the challenge was not signed with the right key');

    let invite: ClubInvite | undefined;
    if (inviteToken) {
      try {
        invite = await verifyInvite(
          inviteToken,
          this.state.identity.publicKey,
          this.state.identity.id,
          this.now(),
        );
      } catch (e) {
        throw new SpecError('not-a-member', e instanceof Error ? e.message : 'bad invite');
      }
    }
    const member = await this.joinRoster(profile, invite);
    if (member.status === 'banned')
      throw new SpecError('banned', 'you were removed from this club');
    if (member.status === 'pending') {
      throw new SpecError('pending', 'your membership is waiting for approval');
    }
    return member;
  }

  /** The session behind a transport connection, created on first use. */
  private sessionOf(conn: Connection, member: ClubMember): ClubSession {
    if (!conn.session || this.sessions.get(conn.session.token) !== member.id) {
      conn.session = this.openSession(member);
    }
    return conn.session;
  }

  private openSession(member: ClubMember): ClubSession {
    const token = generateId();
    this.sessions.set(token, member.id);
    return { member, token };
  }

  private memberOf(session: ClubSession): ClubMember {
    const id = this.sessions.get(session.token);
    const member = id ? findMember(this.state, id) : undefined;
    if (!member) throw new SpecError('unauthorized', 'unknown or expired session');
    if (member.status === 'banned')
      throw new SpecError('banned', 'you were removed from this club');
    if (member.status !== 'active') throw new SpecError('pending', 'membership is not active');
    return member;
  }

  /** Map whatever the domain threw onto the spec's shared vocabulary. */
  private async api<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toSpecError(e);
    }
  }

  /** Replay-safe mutation: the opId is consulted before anything else happens. */
  private mutate<T>(opId: string, args: unknown, fn: () => Promise<T>): Promise<T> {
    return this.api(() =>
      this.serialised(async () => {
        if (typeof opId !== 'string' || !opId) {
          throw new SpecError('invalid', 'every mutating call needs an opId');
        }
        const hash = argumentHash(args);
        const replay = replayOf<T>(this.state, opId, hash);
        if (replay !== undefined) return replay;
        const result = await fn();
        this.setState(recordOp(this.state, { opId, hash, result, at: this.now() }));
        return result;
      }),
    );
  }

  async lobby(session: ClubSession): Promise<LobbyState> {
    return this.api(async () => {
      const member = this.memberOf(session);
      await this.reclaimExpired();
      return lobbyFor(this.state, this.tables.list(), member.id, this.online());
    });
  }

  subscribe(session: ClubSession, listener: (update: ClubUpdate) => void): Unsubscribe {
    const member = this.memberOf(session);
    const set = this.apiSubscribers.get(member.id) ?? new Set();
    set.add(listener);
    this.apiSubscribers.set(member.id, set);
    return () => {
      const live = this.apiSubscribers.get(member.id);
      live?.delete(listener);
      if (live && live.size === 0) this.apiSubscribers.delete(member.id);
    };
  }

  /** Reach every device of a member, in-process subscribers and transports alike. */
  private pushUpdate(memberId: string, update: ClubUpdate): void {
    for (const l of this.apiSubscribers.get(memberId) ?? []) {
      try {
        l(update);
      } catch {
        /* a subscriber's own fault, never the club's */
      }
    }
    this.sendToMember(memberId, { type: 'update', update });
  }

  async sit(session: ClubSession, req: SitRequest): Promise<SeatGrant> {
    const member = this.memberOf(session);
    // Reclaiming touches the table registry, which may call back into the ledger, so it happens
    // before the lock is taken rather than inside it.
    await this.reclaimExpired();
    return this.mutate(
      req.opId,
      {
        op: 'sit',
        member: member.id,
        tableId: req.tableId ?? null,
        templateId: req.templateId ?? null,
        buyIn: req.buyIn ?? null,
      },
      () => this.seatMember(member, req),
    );
  }

  /** The real seating work, shared by `sit` and by matchmaking. Assumes the ledger lock is held. */
  private async seatMember(
    member: ClubMember,
    req: Omit<SitRequest, 'opId'> & { fresh?: boolean },
  ): Promise<SeatGrant> {
    let templateId = req.templateId;
    let roomId: string | undefined;
    if (!templateId && req.tableId) {
      const table = this.tables.list().find((t) => t.id === req.tableId);
      if (!table) throw new SpecError('unknown-table', 'that table is gone');
      templateId = table.templateId;
      roomId = table.roomId;
    }
    if (!templateId) {
      throw specError('invalid', 'sitting needs a table or a table type', 'bad-sit');
    }
    const found = findTemplate(this.state, templateId);
    if (!found) {
      throw specError('unknown-template', 'that table type no longer exists', 'no-template');
    }
    const { template } = found;
    roomId ??= found.room.id;

    const bounds = template.stakes.buyIn;
    const buyIn = req.buyIn ?? bounds?.default ?? 0;
    if (bounds && (buyIn < bounds.min || buyIn > bounds.max)) {
      throw specError(
        'invalid',
        `the buy-in must be between ${bounds.min} and ${bounds.max}`,
        'bad-buy-in',
      );
    }
    const deferred = this.policy().settlement === 'deferred';
    const available =
      balanceOf(this.state, member.id) -
      (deferred ? encumbered(this.state, member.id, this.now()) : 0);
    if (available < buyIn) {
      throw specError('insufficient-chips', 'not enough chips for that stake', 'insufficient');
    }

    const seat = await this.tables.sit({
      member,
      template,
      roomId,
      ...(req.tableId ? { tableId: req.tableId } : {}),
      ...(req.fresh ? { fresh: true } : {}),
      buyIn,
    });

    try {
      if (!deferred && buyIn > 0) {
        await this.appendNow(
          {
            kind: 'buy-in',
            lines: [
              { account: member.id, amount: -buyIn },
              { account: tableAccount(seat.tableId, member.id), amount: buyIn },
            ],
            ref: { tableId: seat.tableId, game: seat.game },
          },
          bounds ? { buyInBounds: { min: bounds.min, max: bounds.max } } : undefined,
        );
      }
    } catch (e) {
      await this.tables.leave({ member, tableId: seat.tableId }).catch(() => ({ cashOut: 0 }));
      throw e;
    }

    const commitment = await signCommitment(
      {
        tableId: seat.tableId,
        memberId: member.id,
        amount: buyIn,
        nonce: newNonce(),
        issuedAt: this.now(),
        expiresAt: this.now() + this.policy().commitmentTtlMs,
      },
      this.signer,
    );
    this.setState(addCommitment(this.state, commitment));
    this.scheduleLobby();
    return {
      tableId: seat.tableId,
      code: seat.code,
      game: seat.game,
      seat: seat.seat,
      commitment,
    };
  }

  async leave(session: ClubSession, req: LeaveRequest): Promise<Settlement | null> {
    const member = this.memberOf(session);
    const args = { op: 'leave', member: member.id, tableId: req.tableId };
    const replay = replayOf<Settlement>(this.state, req.opId, argumentHash(args));
    if (replay !== undefined) return replay;
    const everSat = commitmentsOf(this.state).some(
      (c) => c.tableId === req.tableId && c.memberId === member.id,
    );
    if (!everSat) throw new SpecError('not-seated', 'you are not at that table');
    // Standing up is the registry's business and it may settle the table on the way out, which
    // reaches back into the ledger. Do it before taking the lock, never while holding it.
    await this.tables.leave({ member, tableId: req.tableId }).catch(() => ({ cashOut: 0 }));
    return this.mutate(req.opId, args, async () => {
      const live = liveCommitments(this.state, this.now()).filter(
        (c) => c.tableId === req.tableId && c.memberId === member.id,
      );
      this.setState(
        closeCommitments(
          this.state,
          live.map((c) => c.nonce),
          'left',
          this.now(),
        ),
      );
      const entry = await this.cashOutNow(req.tableId, member.id);
      this.scheduleLobby();
      const settlement: Settlement = {
        tableId: req.tableId,
        balances: { [member.id]: balanceOf(this.state, member.id) },
        entries: [{ memberId: member.id, net: 0, rake: 0 }],
        rake: 0,
        settledAt: this.now(),
        ...(entry ? { seq: entry.seq } : {}),
      };
      this.pushUpdate(member.id, { kind: 'settled', settlement });
      return settlement;
    });
  }

  /**
   * Settle a session at a table. In `deferred` mode this is the only thing that moves chips and
   * it works on member balances; in `immediate` mode the stakes are already on the table, so the
   * same nets land on the seat stacks and `leave` pays them out.
   */
  async settle(tally: TableTally): Promise<Settlement> {
    return this.mutate(tally.opId, { op: 'settle', tally }, async () => {
      const named = tally.nonces.map((n) => findCommitment(this.state, n));
      if (named.some((c) => c?.settled)) {
        throw new SpecError('commitment-stale', 'those stakes have already been settled');
      }
      const live = named.filter((c): c is NonNullable<typeof c> => !!c && !c.settled);
      const problems = checkTally(tally, live);
      if (problems.length > 0) {
        const exceeds = problems.find((p) => p.code === 'exceeds-commitment');
        throw new SpecError(
          exceeds ? 'commitment-exceeded' : 'tally-invalid',
          `the tally was refused: ${problems.map((p) => p.code).join(', ')}`,
          problems,
        );
      }
      const deferred = this.policy().settlement === 'deferred';
      const accountFor = (memberId: string): string =>
        deferred ? memberId : tableAccount(tally.tableId, memberId);

      // Gross is what changed hands before the rake came out of the winners.
      const gross = tally.entries.map((e) => ({
        memberId: e.memberId,
        amount: e.net + e.rake,
      }));
      const moved = gross.filter((g) => g.amount > 0).reduce((a, g) => a + g.amount, 0);
      const minimum = rakeFor(moved, PLATFORM_MIN_RAKE_BPS);
      if (tally.rake < minimum) {
        throw new SpecError(
          'tally-invalid',
          `this club rakes at least ${PLATFORM_MIN_RAKE_BPS} basis points (${minimum} on ${moved})`,
        );
      }
      const ref = { tableId: tally.tableId };
      const resultLines = gross
        .filter((g) => g.amount !== 0)
        .map((g) => ({ account: accountFor(g.memberId), amount: g.amount }));
      let seq: number | undefined;
      if (resultLines.length > 0) {
        const entry = await this.appendNow({ kind: 'result', lines: resultLines, ref });
        seq = entry.seq;
      }
      const burnLines = tally.entries
        .filter((e) => e.rake > 0)
        .map((e) => ({ account: accountFor(e.memberId), amount: -e.rake }));
      if (burnLines.length > 0) {
        await this.appendNow({
          kind: 'burn',
          lines: burnLines,
          ref: { ...ref, basisPoints: PLATFORM_MIN_RAKE_BPS, moved },
        });
      }
      this.setState(closeCommitments(this.state, tally.nonces, 'settled', this.now()));
      this.setState(pruneCommitments(this.state, this.now()));

      const balances: Record<string, number> = {};
      for (const entry of tally.entries) {
        balances[entry.memberId] = balanceOf(this.state, entry.memberId);
      }
      const settlement: Settlement = {
        tableId: tally.tableId,
        balances,
        entries: tally.entries,
        rake: tally.rake,
        settledAt: this.now(),
        ...(seq !== undefined ? { seq } : {}),
      };
      for (const entry of tally.entries) {
        this.pushUpdate(entry.memberId, { kind: 'settled', settlement });
      }
      this.scheduleLobby();
      return settlement;
    });
  }

  /** Stakes whose time ran out go back to their owners and their seats are freed. */
  private async reclaimExpired(): Promise<void> {
    const expired = expiredCommitments(this.state, this.now());
    if (expired.length === 0) return;
    const deferred = this.policy().settlement === 'deferred';
    this.setState(
      closeCommitments(
        this.state,
        expired.map((c) => c.nonce),
        'expired',
        this.now(),
      ),
    );
    for (const c of expired) {
      const member = findMember(this.state, c.memberId);
      if (member) {
        await this.tables.leave({ member, tableId: c.tableId }).catch(() => ({ cashOut: 0 }));
      }
      if (!deferred) await this.cashOut(c.tableId, c.memberId).catch(() => null);
      this.pushUpdate(c.memberId, { kind: 'balance', balance: balanceOf(this.state, c.memberId) });
    }
    this.scheduleLobby();
  }

  async statement(
    session: ClubSession,
    opts: { since?: number; limit?: number } = {},
  ): Promise<MemberStatement> {
    return this.api(async () => {
      const member = this.memberOf(session);
      const depth = this.policy().statements;
      if (depth === 'none') throw new SpecError('unsupported', 'this club keeps no statements');
      const full = statementFor(this.state, member.id);
      if (depth === 'summary') {
        return { ...full, entries: [], ...(full.history ? { history: full.history } : {}) };
      }
      if (opts.since === undefined && opts.limit === undefined) return full;
      const since = opts.since ?? 0;
      const entries = full.entries.filter((e) => e.at >= since);
      const limited = opts.limit ? entries.slice(-opts.limit) : entries;
      return {
        ...full,
        entries: limited,
        ...(full.history
          ? { history: full.history.filter((h) => limited.some((e) => e.seq === h.seq)) }
          : {}),
      };
    });
  }

  async transfer(session: ClubSession, req: TransferRequest): Promise<Receipt> {
    const member = this.memberOf(session);
    if (!this.policy().transfers) {
      throw new SpecError('unsupported', 'this club does not move chips between members');
    }
    return this.mutate(
      req.opId,
      { op: 'transfer', from: member.id, to: req.to, amount: req.amount },
      async () => {
        if (!Number.isInteger(req.amount) || req.amount <= 0) {
          throw new SpecError('invalid', 'transfers are positive whole chips');
        }
        const to = findMember(this.state, req.to);
        if (!to || to.status !== 'active') {
          throw new SpecError('unknown-member', 'no such active member');
        }
        if (to.id === member.id) throw new SpecError('invalid', 'you cannot pay yourself');
        const entry = await this.appendNow({
          kind: 'transfer',
          lines: [
            { account: member.id, amount: -req.amount },
            { account: to.id, amount: req.amount },
          ],
          ref: { by: member.id, ...(req.note ? { note: req.note } : {}) },
        });
        return {
          opId: req.opId,
          balance: balanceOf(this.state, member.id),
          seq: entry.seq,
          at: this.now(),
        };
      },
    );
  }

  async requestChips(session: ClubSession, req: ChipRequestInput): Promise<Receipt> {
    const member = this.memberOf(session);
    if (!this.policy().chipRequests) {
      throw new SpecError('unsupported', 'this club does not take chip requests');
    }
    return this.mutate(
      req.opId,
      { op: 'request-chips', member: member.id, amount: req.amount },
      async () => {
        if (!Number.isInteger(req.amount) || req.amount <= 0) {
          throw new SpecError('invalid', 'chip requests are positive whole chips');
        }
        const request: ChipRequest = {
          id: generateId(),
          memberId: member.id,
          amount: req.amount,
          ...(req.note ? { note: req.note } : {}),
          at: this.now(),
          status: 'pending',
        };
        this.setState({ ...this.state, requests: [...this.state.requests, request] });
        this.pushUpdate(member.id, { kind: 'chip-request', request });
        this.sendToMember(member.id, { type: 'chip-request', request });
        this.events.emit({ kind: 'request', memberId: member.id });
        return { opId: req.opId, balance: balanceOf(this.state, member.id), at: this.now() };
      },
    );
  }

  async chat(session: ClubSession, text: string): Promise<void> {
    const member = this.memberOf(session);
    if (!this.policy().chat) throw new SpecError('unsupported', 'this club has no lobby chat');
    const trimmed = text.trim();
    if (!trimmed) throw new SpecError('invalid', 'nothing to say');
    const at = this.now();
    const from = { id: member.id, name: member.name };
    this.broadcast({ type: 'chat', from, text: trimmed, at });
    for (const memberId of this.apiSubscribers.keys()) {
      this.pushUpdate(memberId, { kind: 'chat', from, text: trimmed, at });
    }
    this.events.emit({ kind: 'chat', memberId: member.id, text: trimmed });
  }

  async queue(
    session: ClubSession,
    criteria: MatchCriteria,
    req: Idempotent,
  ): Promise<MatchTicket> {
    const member = this.memberOf(session);
    if (!this.policy().matchmaking) {
      throw new SpecError('unsupported', 'this club does not run matchmaking');
    }
    const ticket = await this.mutate(
      req.opId,
      { op: 'queue', member: member.id, criteria },
      async () => {
        if (!criteria || typeof criteria.game !== 'string' || !criteria.game) {
          throw new SpecError('invalid', 'queueing needs a game');
        }
        // One ticket per member: queueing again replaces whatever they had.
        for (const entry of [...this.tickets.values()]) {
          if (entry.ticket.memberId === member.id) this.dropTicket(entry.ticket.id, 'member');
        }
        const at = this.now();
        const t: MatchTicket = {
          id: generateId(),
          memberId: member.id,
          criteria,
          queuedAt: at,
          ...(this.ticketTtlMs > 0 ? { expiresAt: at + this.ticketTtlMs } : {}),
          estimate: { queueDepth: this.depthFor(criteria) + 1 },
        };
        this.tickets.set(t.id, { ticket: t, offlineSince: null });
        this.matchPolicy.onQueued?.(t);
        this.pushUpdate(member.id, { kind: 'match', event: { kind: 'queued', ticket: t } });
        return t;
      },
    );
    await this.runMatchmaking();
    return ticket;
  }

  async unqueue(session: ClubSession, ticketId: string): Promise<void> {
    const member = this.memberOf(session);
    const entry = this.tickets.get(ticketId);
    if (!entry || entry.ticket.memberId !== member.id) return;
    this.dropTicket(ticketId, 'member');
  }

  // ---------------------------------------------------------------------------------------------
  // The queue: lifecycle here, policy injected
  // ---------------------------------------------------------------------------------------------

  /** Tickets waiting right now. */
  matchTickets(): MatchTicket[] {
    return [...this.tickets.values()].map((e) => e.ticket);
  }

  ticketForMember(memberId: string): MatchTicket | undefined {
    return [...this.tickets.values()].find((e) => e.ticket.memberId === memberId)?.ticket;
  }

  get matchmakingRunning(): boolean {
    return !this.matchPaused && !this.closed;
  }

  pauseMatchmaking(): void {
    this.matchPaused = true;
  }

  resumeMatchmaking(): void {
    if (this.closed) return;
    this.matchPaused = false;
    void this.runMatchmaking();
  }

  /** Cancel every ticket, e.g. before the club shuts down. Returns how many went. */
  drainMatchmaking(reason: MatchCancelReason = 'unavailable'): number {
    const n = this.tickets.size;
    for (const id of [...this.tickets.keys()]) this.dropTicket(id, reason);
    return n;
  }

  /**
   * Look for matches. Two sweeps never run at once; a call made while one is in flight waits for
   * it and then gets a fresh one, so `queue()` followed by a tick cannot miss the ticket that was
   * just added.
   */
  async runMatchmaking(): Promise<void> {
    if (this.closed) return;
    this.matchWanted = true;
    if (this.matchRunning) return this.matchRunning;
    this.matchRunning = (async () => {
      try {
        while (this.matchWanted && !this.closed) {
          this.matchWanted = false;
          await this.matchPass();
        }
      } finally {
        this.matchRunning = null;
      }
    })();
    return this.matchRunning;
  }

  /** One sweep: retire dead tickets, then fill what tables we can. */
  private async matchPass(): Promise<void> {
    this.retireTickets();
    if (this.matchPaused || this.tickets.size === 0) return;
    const seated = this.tables.seated?.() ?? new Set<string>();
    let formed = 0;
    for (const room of this.state.rooms) {
      for (const template of room.templates) {
        if (this.tickets.size === 0) break;
        const eligible = [...this.tickets.values()]
          .map((e) => e.ticket)
          .filter((t) => !seated.has(t.memberId) && matchesTemplate(t.criteria, template));
        if (eligible.length < template.seats) continue;
        const groups = this.matchPolicy.group({
          tickets: eligible,
          template: { id: template.id, game: template.game, seats: template.seats },
          now: this.now(),
        });
        for (const group of groups) {
          if (!this.groupIsSeatable(group, seated)) continue;
          const tableId = await this.seatGroup(group, template.id);
          if (tableId) {
            formed++;
            for (const t of group) seated.add(t.memberId);
            this.matchPolicy.onMatched?.(group, { id: tableId, templateId: template.id });
          }
        }
      }
    }
    if (formed === 0) this.publishEstimates();
  }

  /** A policy may hand back stale or overlapping tickets; the club is what keeps it honest. */
  private groupIsSeatable(group: readonly MatchTicket[], seated: ReadonlySet<string>): boolean {
    if (group.length === 0) return false;
    const members = new Set<string>();
    for (const t of group) {
      if (!this.tickets.has(t.id)) return false;
      if (seated.has(t.memberId)) return false;
      if (members.has(t.memberId)) return false;
      members.add(t.memberId);
      const member = findMember(this.state, t.memberId);
      if (!member || member.status !== 'active') return false;
    }
    for (const a of group) {
      for (const b of group) {
        if (a !== b && !criteriaCompatible(a.criteria, b.criteria)) return false;
      }
    }
    return true;
  }

  /** Seat a whole group at one fresh table. Returns the table id, or null if nobody sat. */
  private async seatGroup(group: readonly MatchTicket[], templateId: string): Promise<string | null> {
    for (const ticket of group) this.tickets.delete(ticket.id);
    let tableId: string | undefined;
    for (const ticket of group) {
      const member = findMember(this.state, ticket.memberId);
      if (!member || member.status !== 'active') continue;
      try {
        const grant = await this.serialised(() =>
          // A group fills a table, so it opens its own rather than squeezing into one that is
          // already part full — which would leave the rest of the group with nowhere to sit.
          this.seatMember(member, tableId ? { tableId } : { templateId, fresh: true }),
        );
        tableId ??= grant.tableId;
        this.pushUpdate(member.id, {
          kind: 'match',
          event: { kind: 'matched', ticketId: ticket.id, grant },
        });
      } catch {
        this.matchPolicy.onDequeued?.(ticket.id, 'unavailable');
        this.pushUpdate(member.id, {
          kind: 'match',
          event: { kind: 'cancelled', ticketId: ticket.id, reason: 'unavailable' },
        });
      }
    }
    return tableId ?? null;
  }

  /** Drop tickets whose member has gone, whose time is up, or who stayed offline past the grace. */
  private retireTickets(): void {
    const at = this.now();
    for (const entry of [...this.tickets.values()]) {
      const { ticket } = entry;
      const member = findMember(this.state, ticket.memberId);
      if (!member || member.status !== 'active') {
        this.dropTicket(ticket.id, 'left');
        continue;
      }
      if (ticket.expiresAt !== undefined && at >= ticket.expiresAt) {
        this.dropTicket(ticket.id, 'expired');
        continue;
      }
      if (entry.offlineSince !== null && at - entry.offlineSince >= this.disconnectGraceMs) {
        this.dropTicket(ticket.id, 'left');
      }
    }
  }

  /** A member's last device went away: start the grace clock rather than dropping them. */
  private noteMemberOffline(memberId: string): void {
    for (const entry of this.tickets.values()) {
      if (entry.ticket.memberId === memberId && entry.offlineSince === null) {
        entry.offlineSince = this.now();
      }
    }
  }

  private noteMemberOnline(memberId: string): void {
    for (const entry of this.tickets.values()) {
      if (entry.ticket.memberId === memberId) entry.offlineSince = null;
    }
  }

  private dropTicket(ticketId: string, reason: MatchCancelReason): boolean {
    const entry = this.tickets.get(ticketId);
    if (!entry) return false;
    this.tickets.delete(ticketId);
    this.matchPolicy.onDequeued?.(ticketId, reason);
    this.pushUpdate(entry.ticket.memberId, {
      kind: 'match',
      event: { kind: 'cancelled', ticketId, reason },
    });
    return true;
  }

  private depthFor(criteria: MatchCriteria): number {
    let n = 0;
    for (const e of this.tickets.values()) {
      if (criteriaCompatible(e.ticket.criteria, criteria)) n++;
    }
    return n;
  }

  private publishEstimates(): void {
    const at = this.now();
    for (const entry of this.tickets.values()) {
      this.pushUpdate(entry.ticket.memberId, {
        kind: 'match',
        event: {
          kind: 'estimate',
          ticketId: entry.ticket.id,
          estimate: {
            queueDepth: this.depthFor(entry.ticket.criteria),
            waitMs: at - entry.ticket.queuedAt,
          },
        },
      });
    }
  }

  /**
   * Serve one correlated request from a member's transport. Every spec method is reachable this
   * way, so a remote caller and an in-process one are holding the same interface.
   */
  private async handleCall(
    conn: Connection,
    member: ClubMember,
    msg: Extract<ClubClientMessage, { type: 'call' }>,
  ): Promise<void> {
    const session = this.sessionOf(conn, member);
    const params = (msg.params ?? {}) as Record<string, unknown>;
    try {
      let value: unknown;
      switch (msg.method) {
        case 'info':
          value = await this.info();
          break;
        case 'lobby':
          value = await this.lobby(session);
          break;
        case 'sit':
          value = await this.sit(session, params as unknown as SitRequest);
          break;
        case 'leave':
          value = await this.leave(session, params as unknown as LeaveRequest);
          break;
        case 'settle':
          value = await this.settle(params as unknown as TableTally);
          break;
        case 'statement':
          value = await this.statement(session, params as { since?: number; limit?: number });
          break;
        case 'transfer':
          value = await this.transfer(session, params as unknown as TransferRequest);
          break;
        case 'requestChips':
          value = await this.requestChips(session, params as unknown as ChipRequestInput);
          break;
        case 'chat':
          await this.chat(session, String(params.text ?? ''));
          break;
        case 'queue':
          value = await this.queue(session, params.criteria as MatchCriteria, {
            opId: String(params.opId ?? ''),
          });
          break;
        case 'unqueue':
          await this.unqueue(session, String(params.ticketId ?? ''));
          break;
        default:
          throw new SpecError('invalid', `unknown method ${String(msg.method)}`);
      }
      this.send(conn, {
        type: 'result',
        id: msg.id,
        ok: true,
        ...(value === undefined ? {} : { value }),
      });
    } catch (e) {
      const error = toSpecError(e);
      this.send(conn, {
        type: 'result',
        id: msg.id,
        ok: false,
        code: error.code,
        message: error.message,
      });
    }
  }

  async disconnect(session: ClubSession): Promise<void> {
    const memberId = this.sessions.get(session.token);
    this.sessions.delete(session.token);
    if (!memberId) return;
    this.apiSubscribers.delete(memberId);
    // The member has gone for good on this session, but a queued ticket survives a brief
    // disconnect: start the grace clock rather than dropping them to the back of the queue.
    this.noteMemberOffline(memberId);
  }
}

/** Could this queued member be seated at a table of this type? */
function matchesTemplate(criteria: MatchCriteria, template: TableTemplate): boolean {
  if (criteria.game !== template.game) return false;
  if (criteria.templateIds?.length && !criteria.templateIds.includes(template.id)) return false;
  if (criteria.seats?.length && !criteria.seats.includes(template.seats)) return false;
  const band = criteria.stakes;
  if (band) {
    const per = template.stakes.chipsPerPoint;
    if (band.min !== undefined && per < band.min) return false;
    if (band.max !== undefined && per > band.max) return false;
  }
  return true;
}

/** Domain codes are this implementation's own; the spec's are what a client reacts to. */
const SPEC_CODES: Record<string, ClubErrorCode> = {
  insufficient: 'insufficient-chips',
  reserve: 'insufficient-chips',
  'no-member': 'unknown-member',
  'inactive-member': 'unknown-member',
  'no-table': 'unknown-table',
  'no-template': 'unknown-template',
  'no-room': 'unknown-template',
  'not-a-member': 'not-a-member',
  forbidden: 'unauthorized',
  unauthorized: 'unauthorized',
  conflict: 'conflict',
  'no-request': 'invalid',
  resolved: 'invalid',
};

export function toSpecError(e: unknown): SpecError {
  if (e instanceof SpecError) return e;
  if (e instanceof ClubError) {
    const code = SPEC_CODES[e.code] ?? 'invalid';
    // The club's own code rides along so the legacy wire keeps reporting exactly what it did.
    return new SpecError(code, e.message, { domainCode: e.code });
  }
  if (e instanceof Error) return new SpecError('invalid', e.message);
  return new SpecError('invalid', String(e));
}

/** A spec error that still remembers this club's own code, for the legacy wire. */
function specError(code: ClubErrorCode, message: string, domainCode: string): SpecError {
  return new SpecError(code, message, { domainCode });
}

/**
 * The code the fire-and-forget wire has always reported: this club's own, not the spec's
 * shared one, so clients written against the older protocol keep working unchanged.
 */
function legacyCode(e: unknown): string {
  if (e instanceof ClubError) return e.code;
  if (e instanceof SpecError) {
    const detail = e.detail as { domainCode?: string } | undefined;
    return detail?.domainCode ?? e.code;
  }
  return 'internal';
}

/** Verify a base64url signature over `bytes`, never throwing on malformed input. */
async function verifyDetached(
  publicKey: string,
  bytes: Uint8Array,
  signature: string,
): Promise<boolean> {
  try {
    return await verify(publicKey, bytes, base64UrlToBytes(signature));
  } catch {
    return false;
  }
}

export { activeMembers };
