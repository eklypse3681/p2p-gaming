/**
 * A club reached over a transport, presented as the same interface as one in this process.
 *
 * `ClubClient` remains the stateful, fire-and-forget client the app screens subscribe to. This is
 * its request/response twin: every specified method becomes one correlated `call` and waits for
 * its `result`. Because the conformance suite can be pointed at it, the wire protocol is held to
 * the same standard as the implementation behind it.
 *
 * One transport carries one member, so this class opens a connection per member and routes by
 * session token. That is a client-side detail the caller never sees.
 */

import type {
  AuthRequest,
  ChipRequestInput,
  ClubApi,
  ClubInfo,
  ClubSession,
  ClubUpdate,
  Idempotent,
  LeaveRequest,
  MatchCriteria,
  MatchTicket,
  Receipt,
  SeatGrant,
  Settlement,
  SitRequest,
  TableTally,
  TransferRequest,
} from '@bgf/club-spec';
import type { ClubErrorCode } from '@bgf/club-spec';
import { CLUB_SPEC_VERSION, ClubError as SpecError } from '@bgf/club-spec';
import type {
  ClubCallMethod,
  ClubClientMessage,
  ClubRejectReason,
  ClubServerMessage,
  LobbyState,
  MemberStatement,
  PlayerProfile,
  Transport,
  Unsubscribe,
} from '@bgf/protocol';
import { CLUB_PROTOCOL_VERSION, generateId } from '@bgf/protocol';

const REJECTION_CODES: Record<ClubRejectReason, ClubErrorCode> = {
  protocol: 'version',
  version: 'version',
  unauthorized: 'unauthorized',
  'not-a-member': 'not-a-member',
  banned: 'banned',
  pending: 'pending',
};

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** One transport, one member. */
class Link {
  readonly transport: Transport;
  private readonly calls = new Map<string, Pending>();
  private readonly updates = new Set<(u: ClubUpdate) => void>();
  private readonly unsubscribe: Unsubscribe[] = [];
  private challenge: Pending | null = null;
  private welcome: Pending | null = null;
  profileId: string | null = null;
  lobby: LobbyState | null = null;
  closed = false;

  constructor(transport: Transport) {
    this.transport = transport;
    this.unsubscribe.push(transport.onMessage((raw) => this.receive(raw)));
    this.unsubscribe.push(
      transport.onStatus((status) => {
        if (status === 'closed') this.fail(new SpecError('unavailable', 'the club went away'));
      }),
    );
  }

  send(message: ClubClientMessage): void {
    if (this.closed || this.transport.status !== 'open') {
      throw new SpecError('unavailable', 'not connected to the club');
    }
    this.transport.send(message);
  }

  call<T>(method: ClubCallMethod, params?: unknown): Promise<T> {
    const id = generateId();
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.send({ type: 'call', id, method, ...(params !== undefined ? { params } : {}) });
      } catch (e) {
        this.calls.delete(id);
        reject(e);
      }
    });
  }

  awaitChallenge(): Promise<{ nonce: string; clubId: string }> {
    return new Promise((resolve, reject) => {
      this.challenge = { resolve: resolve as (v: unknown) => void, reject };
    });
  }

  awaitWelcome(): Promise<LobbyState> {
    return new Promise((resolve, reject) => {
      this.welcome = { resolve: resolve as (v: unknown) => void, reject };
    });
  }

  onUpdate(listener: (u: ClubUpdate) => void): Unsubscribe {
    this.updates.add(listener);
    return () => this.updates.delete(listener);
  }

  private receive(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as ClubServerMessage;
    switch (msg.type) {
      case 'challenge':
        this.challenge?.resolve({ nonce: msg.nonce, clubId: msg.clubId });
        this.challenge = null;
        return;
      case 'welcome':
        this.lobby = msg.lobby;
        this.welcome?.resolve(msg.lobby);
        this.welcome = null;
        return;
      case 'lobby':
        this.lobby = msg.lobby;
        return;
      case 'rejected': {
        const error = new SpecError(REJECTION_CODES[msg.reason] ?? 'unauthorized', msg.message);
        this.welcome?.reject(error);
        this.challenge?.reject(error);
        this.welcome = null;
        this.challenge = null;
        this.fail(error);
        return;
      }
      case 'result': {
        const pending = this.calls.get(msg.id);
        if (!pending) return;
        this.calls.delete(msg.id);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(new SpecError(msg.code as ClubErrorCode, msg.message));
        return;
      }
      case 'update':
        for (const l of Array.from(this.updates)) l(msg.update as ClubUpdate);
        return;
      default:
        return;
    }
  }

  private fail(error: unknown): void {
    for (const pending of this.calls.values()) pending.reject(error);
    this.calls.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new SpecError('unavailable', 'the connection was closed'));
    for (const u of this.unsubscribe) u();
    this.updates.clear();
    try {
      this.transport.close();
    } catch {
      /* already gone */
    }
  }
}

export interface RemoteClubOptions {
  /** Open a fresh transport to the club. Called once per member, plus once for `info()`. */
  connect(): Transport | Promise<Transport>;
  /** Presented on the handshake where the club admits people by invite. */
  invite?: string;
}

export class RemoteClub implements ClubApi {
  private readonly options: RemoteClubOptions;
  private readonly byProfile = new Map<string, Link>();
  private readonly byToken = new Map<string, Link>();
  private readonly profiles = new Map<string, PlayerProfile>();

  constructor(options: RemoteClubOptions) {
    this.options = options;
  }

  private async open(): Promise<Link> {
    const transport = await this.options.connect();
    const link = new Link(transport);
    if (transport.status !== 'open') {
      await new Promise<void>((resolve) => {
        const off = transport.onStatus((status) => {
          if (status !== 'connecting') {
            off();
            resolve();
          }
        });
      });
    }
    return link;
  }

  /**
   * Capabilities are readable by anyone, so this works before joining. Once a member is
   * authenticated their connection answers it too, and reusing that costs nothing where opening
   * a fresh one costs a WebRTC handshake.
   */
  async info(): Promise<ClubInfo> {
    const live = [...this.byToken.values()].find((l) => !l.closed);
    if (live) return live.call<ClubInfo>('info');
    const link = await this.open();
    try {
      return await link.call<ClubInfo>('info');
    } finally {
      link.close();
    }
  }

  async challenge(profileId: string): Promise<{ nonce: string; clubId: string }> {
    const existing = this.byProfile.get(profileId);
    if (existing) existing.close();
    const link = await this.open();
    link.profileId = profileId;
    this.byProfile.set(profileId, link);
    const profile = this.profiles.get(profileId);
    const waiting = link.awaitChallenge();
    link.send({
      type: 'hello',
      protocol: CLUB_PROTOCOL_VERSION,
      profile: profile ?? { id: profileId, name: profileId },
      spec: CLUB_SPEC_VERSION,
      ...(this.options.invite ? { invite: this.options.invite } : {}),
    });
    return waiting;
  }

  /**
   * The handshake needs the full profile, which `challenge(profileId)` is not given. Register it
   * first and the hello carries the real thing.
   */
  register(profile: PlayerProfile): void {
    this.profiles.set(profile.id, profile);
  }

  async authenticate(req: AuthRequest): Promise<ClubSession> {
    if (req.spec > CLUB_SPEC_VERSION) {
      // The handshake already went out carrying the spec this adapter speaks; a request made
      // against a later one cannot be carried honestly, so it is refused here rather than
      // being quietly downgraded on the wire.
      throw new SpecError('version', `this client speaks club spec ${CLUB_SPEC_VERSION}`);
    }
    this.profiles.set(req.profile.id, req.profile);
    let link = this.byProfile.get(req.profile.id);
    if (!link || link.closed) {
      // The caller asked for a challenge before registering the profile; redo it properly.
      await this.challenge(req.profile.id);
      link = this.byProfile.get(req.profile.id)!;
      throw new SpecError('unauthorized', 'the challenge was answered on a stale connection');
    }
    const waiting = link.awaitWelcome();
    link.send({ type: 'auth', signature: req.signature });
    const lobby = await waiting;
    const token = generateId();
    this.byToken.set(token, link);
    return { member: lobby.me.member, token };
  }

  private linkFor(session: ClubSession): Link {
    const link = this.byToken.get(session.token);
    if (!link || link.closed) throw new SpecError('unauthorized', 'unknown or expired session');
    return link;
  }

  async lobby(session: ClubSession): Promise<LobbyState> {
    return this.linkFor(session).call<LobbyState>('lobby');
  }

  subscribe(session: ClubSession, listener: (update: ClubUpdate) => void): Unsubscribe {
    return this.linkFor(session).onUpdate(listener);
  }

  sit(session: ClubSession, req: SitRequest): Promise<SeatGrant> {
    return this.linkFor(session).call<SeatGrant>('sit', req);
  }

  leave(session: ClubSession, req: LeaveRequest): Promise<Settlement | null> {
    return this.linkFor(session).call<Settlement | null>('leave', req);
  }

  /**
   * Settling is the table runtime's business, not a member's, but it still travels a member's
   * connection here so the whole interface is reachable over one wire.
   */
  async settle(tally: TableTally): Promise<Settlement> {
    const link = [...this.byToken.values()].find((l) => !l.closed);
    if (!link) throw new SpecError('unauthorized', 'no connection to the club');
    return link.call<Settlement>('settle', tally);
  }

  statement(
    session: ClubSession,
    opts: { since?: number; limit?: number } = {},
  ): Promise<MemberStatement> {
    return this.linkFor(session).call<MemberStatement>('statement', opts);
  }

  transfer(session: ClubSession, req: TransferRequest): Promise<Receipt> {
    return this.linkFor(session).call<Receipt>('transfer', req);
  }

  requestChips(session: ClubSession, req: ChipRequestInput): Promise<Receipt> {
    return this.linkFor(session).call<Receipt>('requestChips', req);
  }

  async chat(session: ClubSession, text: string): Promise<void> {
    await this.linkFor(session).call<void>('chat', { text });
  }

  queue(session: ClubSession, criteria: MatchCriteria, req: Idempotent): Promise<MatchTicket> {
    return this.linkFor(session).call<MatchTicket>('queue', { criteria, opId: req.opId });
  }

  async unqueue(session: ClubSession, ticketId: string): Promise<void> {
    await this.linkFor(session).call<void>('unqueue', { ticketId });
  }

  async disconnect(session: ClubSession): Promise<void> {
    const link = this.byToken.get(session.token);
    this.byToken.delete(session.token);
    if (!link) return;
    if (link.profileId) this.byProfile.delete(link.profileId);
    link.close();
  }

  /** Drop every connection this adapter opened. */
  closeAll(): void {
    for (const link of this.byProfile.values()) link.close();
    this.byProfile.clear();
    this.byToken.clear();
  }
}
