/**
 * The smallest club that is still a club.
 *
 * Open membership, chips settled as soon as a tally arrives, no transfers and no chat, but a
 * real keyed handshake, real commitments and real matchmaking. It exists to prove the
 * conformance suite runs against something, and to give other implementations a reference to
 * develop against before their own is finished. It is not a ledger: balances are a map.
 */

import type {
  ClubIdentity,
  ClubMember,
  LobbyState,
  LobbyTable,
  MemberStatement,
  PlayerProfile,
  Room,
  TableTemplate,
} from '@bgf/protocol';
import {
  bytesToBase64Url,
  clubChallengeBytes,
  generateId,
  generateKeyPair,
  randomNonce,
  signerFor,
  verify,
  base64UrlToBytes,
} from '@bgf/protocol';
import type {
  AuthRequest,
  ChipRequestInput,
  ClubApi,
  ClubInfo,
  ClubSession,
  ClubUpdate,
  Idempotent,
  LeaveRequest,
  Receipt,
  SeatGrant,
  SitRequest,
  TransferRequest,
  Unsubscribe,
} from '../api.js';
import { CLUB_SPEC_VERSION, type ClubCapabilities } from '../capabilities.js';
import { ClubError } from '../errors.js';
import {
  type MatchCriteria,
  type MatchTicket,
  criteriaCompatible,
  proposeMatches,
} from '../matching.js';
import {
  type SeatCommitment,
  type Settlement,
  type TableTally,
  checkTally,
} from '../settlement.js';

const COMMITMENT_TTL_MS = 5 * 60_000;

interface Seated {
  tableId: string;
  memberId: string;
  seat: number;
  stack: number;
  nonce: string;
}

interface OpRecord {
  hash: string;
  result: unknown;
}

export interface MemoryClubOptions {
  name?: string;
  /** Template members sit at. One is created when none is given. */
  template?: TableTemplate;
  now?: () => number;
}

export class MemoryClub implements ClubApi {
  readonly identity: ClubIdentity;
  private readonly signer: (bytes: Uint8Array) => Promise<Uint8Array>;
  private readonly members = new Map<string, ClubMember>();
  private readonly balances = new Map<string, number>();
  private readonly nonces = new Map<string, { profileId: string; publicKey?: string }>();
  private readonly sessions = new Map<string, string>();
  private readonly subscribers = new Map<string, Set<(u: ClubUpdate) => void>>();
  private readonly commitments = new Map<string, SeatCommitment & { settled?: boolean }>();
  private readonly seats: Seated[] = [];
  private readonly tables = new Map<string, LobbyTable>();
  private readonly tickets = new Map<string, MatchTicket>();
  private readonly ops = new Map<string, OpRecord>();
  private readonly room: Room;
  private clock: number;

  private constructor(identity: ClubIdentity, privateKey: string, opts: MemoryClubOptions) {
    this.identity = identity;
    this.signer = signerFor(privateKey);
    this.clock = opts.now?.() ?? Date.now();
    const template: TableTemplate = opts.template ?? {
      id: 'tpl-memory',
      name: 'Memory table',
      game: 'ofc',
      config: {},
      seats: 2,
      stakes: {
        chipsPerPoint: 10,
        buyIn: { min: 1, max: 1_000_000, default: 1_000 },
        rake: { basisPoints: 200 },
      },
    };
    this.room = { id: 'room-memory', name: 'Main', templates: [template] };
  }

  static async create(opts: MemoryClubOptions = {}): Promise<MemoryClub> {
    const keys = await generateKeyPair();
    const identity: ClubIdentity = {
      id: `memory-${randomNonce(6)}`,
      name: opts.name ?? 'Memory Club',
      publicKey: keys.publicKey,
      currency: { code: 'chips', name: 'Chips', decimals: 0 },
      createdAt: Date.now(),
    };
    return new MemoryClub(identity, keys.privateKey, opts);
  }

  get templateId(): string {
    return this.room.templates[0]!.id;
  }

  /**
   * Test seam: put chips in a member's hands. Balances are keyed by id independently of the
   * roster, so funding somebody before they have ever authenticated is fine.
   */
  async fund(memberId: string, amount: number): Promise<void> {
    this.balances.set(memberId, (this.balances.get(memberId) ?? 0) + amount);
    this.pushBalance(memberId);
  }

  async ban(memberId: string): Promise<void> {
    const member = this.members.get(memberId);
    if (member) this.members.set(memberId, { ...member, status: 'banned' });
  }

  advance(ms: number): void {
    this.clock += ms;
  }

  private now(): number {
    return this.clock;
  }

  // -------------------------------------------------------------------------------------------

  private capabilities(): ClubCapabilities {
    return {
      spec: CLUB_SPEC_VERSION,
      settlement: 'immediate',
      membership: 'open',
      joinGrant: null,
      matchmaking: true,
      transfers: false,
      chipRequests: false,
      chat: false,
      tournaments: false,
      statements: 'summary',
      minRakeBasisPoints: 200,
      ratingScale: null,
      custody: { kind: 'local', note: 'An in-process club used by the conformance suite.' },
    };
  }

  async info(): Promise<ClubInfo> {
    return {
      identity: this.identity,
      capabilities: this.capabilities(),
      rooms: [this.room],
      online: this.subscribers.size,
    };
  }

  async challenge(profileId: string): Promise<{ nonce: string; clubId: string }> {
    const nonce = randomNonce(16);
    this.nonces.set(nonce, { profileId });
    return { nonce, clubId: this.identity.id };
  }

  async authenticate(req: AuthRequest): Promise<ClubSession> {
    if (req.spec > CLUB_SPEC_VERSION) {
      throw new ClubError('version', `this club serves spec ${CLUB_SPEC_VERSION}`);
    }
    const pending = this.nonces.get(req.nonce);
    if (!pending || pending.profileId !== req.profile.id) {
      throw new ClubError('unauthorized', 'unknown or mismatched challenge');
    }
    this.nonces.delete(req.nonce);
    const publicKey = req.profile.publicKey;
    if (!publicKey) throw new ClubError('unauthorized', 'a keyed profile is required');
    const known = this.members.get(req.profile.id);
    if (known && known.publicKey !== publicKey) {
      throw new ClubError('unauthorized', 'that member id belongs to a different key');
    }
    let ok = false;
    try {
      ok = await verify(
        publicKey,
        clubChallengeBytes({
          clubId: this.identity.id,
          profileId: req.profile.id,
          nonce: req.nonce,
        }),
        base64UrlToBytes(req.signature),
      );
    } catch {
      ok = false;
    }
    if (!ok) throw new ClubError('unauthorized', 'the challenge was not signed with the right key');
    if (known?.status === 'banned')
      throw new ClubError('banned', 'you were removed from this club');
    const member = known ?? this.join(req.profile);
    const token = generateId();
    this.sessions.set(token, member.id);
    return { member, token };
  }

  private join(profile: PlayerProfile): ClubMember {
    const member: ClubMember = {
      id: profile.id,
      name: profile.name,
      ...(profile.avatar ? { avatar: profile.avatar } : {}),
      publicKey: profile.publicKey!,
      role: this.members.size === 0 ? 'owner' : 'member',
      status: 'active',
      joinedAt: this.now(),
    };
    this.members.set(member.id, member);
    this.balances.set(member.id, this.balances.get(member.id) ?? 0);
    return member;
  }

  private memberOf(session: ClubSession): ClubMember {
    const id = this.sessions.get(session.token);
    const member = id ? this.members.get(id) : undefined;
    if (!member) throw new ClubError('unauthorized', 'unknown session');
    if (member.status === 'banned') throw new ClubError('banned', 'you were removed');
    return member;
  }

  async lobby(session: ClubSession): Promise<LobbyState> {
    const member = this.memberOf(session);
    return {
      club: this.identity,
      rooms: [this.room],
      tables: [...this.tables.values()],
      me: { member, balance: this.balances.get(member.id) ?? 0 },
      online: [...this.subscribers.keys()].sort(),
    };
  }

  subscribe(session: ClubSession, listener: (update: ClubUpdate) => void): Unsubscribe {
    const member = this.memberOf(session);
    const set = this.subscribers.get(member.id) ?? new Set();
    set.add(listener);
    this.subscribers.set(member.id, set);
    return () => {
      const live = this.subscribers.get(member.id);
      live?.delete(listener);
      if (live && live.size === 0) this.subscribers.delete(member.id);
    };
  }

  private push(memberId: string, update: ClubUpdate): void {
    for (const l of this.subscribers.get(memberId) ?? []) l(update);
  }

  private pushBalance(memberId: string): void {
    this.push(memberId, { kind: 'balance', balance: this.balances.get(memberId) ?? 0 });
  }

  /** opId first, always: a replay must never fall through to a freshness check. */
  private once<T>(opId: string, args: unknown, fn: () => T): T {
    const hash = JSON.stringify(args);
    const seen = this.ops.get(opId);
    if (seen) {
      if (seen.hash !== hash)
        throw new ClubError('conflict', 'that opId was used with different arguments');
      return seen.result as T;
    }
    const result = fn();
    this.ops.set(opId, { hash, result });
    return result;
  }

  private async onceAsync<T>(opId: string, args: unknown, fn: () => Promise<T>): Promise<T> {
    const hash = JSON.stringify(args);
    const seen = this.ops.get(opId);
    if (seen) {
      if (seen.hash !== hash)
        throw new ClubError('conflict', 'that opId was used with different arguments');
      return seen.result as T;
    }
    const result = await fn();
    this.ops.set(opId, { hash, result });
    return result;
  }

  // -------------------------------------------------------------------------------------------

  async sit(session: ClubSession, req: SitRequest): Promise<SeatGrant> {
    const member = this.memberOf(session);
    return this.onceAsync(
      req.opId,
      {
        op: 'sit',
        member: member.id,
        tableId: req.tableId,
        templateId: req.templateId,
        buyIn: req.buyIn,
      },
      async () => {
        this.expire();
        const template = this.room.templates[0]!;
        if (req.templateId && req.templateId !== template.id) {
          throw new ClubError('unknown-template', 'no such table type');
        }
        const buyIn = req.buyIn ?? template.stakes.buyIn?.default ?? 0;
        const balance = this.balances.get(member.id) ?? 0;
        if (buyIn > balance) throw new ClubError('insufficient-chips', 'not enough chips');
        const table = this.tableFor(req.tableId, template);
        if (this.seats.some((s) => s.tableId === table.id && s.memberId === member.id)) {
          throw new ClubError('seat-taken', 'you are already at that table');
        }
        const seat = table.seats.findIndex((s) => s === null);
        if (seat < 0) throw new ClubError('seat-taken', 'that table is full');
        this.balances.set(member.id, balance - buyIn);
        table.seats[seat] = { name: member.name, memberId: member.id };
        table.stacks[seat] = buyIn;
        const commitment = await this.commit(table.id, member.id, buyIn);
        this.seats.push({
          tableId: table.id,
          memberId: member.id,
          seat,
          stack: buyIn,
          nonce: commitment.nonce,
        });
        this.pushBalance(member.id);
        return {
          tableId: table.id,
          code: `MEM-${table.id}`,
          game: template.game,
          seat,
          commitment,
        };
      },
    );
  }

  private tableFor(tableId: string | undefined, template: TableTemplate): LobbyTable {
    if (tableId) {
      const existing = this.tables.get(tableId);
      if (!existing) throw new ClubError('unknown-table', 'no such table');
      return existing;
    }
    const open = [...this.tables.values()].find((t) => t.seats.some((s) => s === null));
    if (open) return open;
    const table: LobbyTable = {
      id: `table-${this.tables.size + 1}`,
      roomId: this.room.id,
      templateId: template.id,
      templateName: template.name,
      game: template.game,
      code: `MEM-${this.tables.size + 1}`,
      seats: new Array(template.seats).fill(null),
      status: 'open',
      stacks: new Array(template.seats).fill(0),
    };
    this.tables.set(table.id, table);
    return table;
  }

  private async commit(tableId: string, memberId: string, amount: number): Promise<SeatCommitment> {
    const body = {
      tableId,
      memberId,
      amount,
      nonce: randomNonce(12),
      issuedAt: this.now(),
      expiresAt: this.now() + COMMITMENT_TTL_MS,
    };
    const signature = bytesToBase64Url(
      await this.signer(new TextEncoder().encode(JSON.stringify(body))),
    );
    const commitment: SeatCommitment = { ...body, signature };
    this.commitments.set(commitment.nonce, commitment);
    return commitment;
  }

  private expire(): void {
    for (const c of this.commitments.values()) {
      if (c.settled || c.expiresAt > this.now()) continue;
      c.settled = true;
      this.release(c.tableId, c.memberId);
    }
  }

  private release(tableId: string, memberId: string): number {
    const index = this.seats.findIndex((s) => s.tableId === tableId && s.memberId === memberId);
    if (index < 0) return 0;
    const seated = this.seats[index]!;
    this.seats.splice(index, 1);
    const table = this.tables.get(tableId);
    if (table) {
      table.seats[seated.seat] = null;
      table.stacks[seated.seat] = 0;
    }
    const stack = seated.stack;
    this.balances.set(memberId, (this.balances.get(memberId) ?? 0) + stack);
    this.pushBalance(memberId);
    return stack;
  }

  async leave(session: ClubSession, req: LeaveRequest): Promise<Settlement | null> {
    const member = this.memberOf(session);
    return this.onceAsync(
      req.opId,
      { op: 'leave', member: member.id, tableId: req.tableId },
      async () => {
        const seated = this.seats.find(
          (s) => s.tableId === req.tableId && s.memberId === member.id,
        );
        if (!seated) throw new ClubError('not-seated', 'you are not at that table');
        for (const c of this.commitments.values()) {
          if (c.tableId === req.tableId && c.memberId === member.id) c.settled = true;
        }
        const stack = this.release(req.tableId, member.id);
        const settlement: Settlement = {
          tableId: req.tableId,
          balances: { [member.id]: this.balances.get(member.id) ?? 0 },
          entries: [{ memberId: member.id, net: 0, rake: 0 }],
          rake: 0,
          settledAt: this.now(),
        };
        void stack;
        this.push(member.id, { kind: 'settled', settlement });
        return settlement;
      },
    );
  }

  async settle(tally: TableTally): Promise<Settlement> {
    return this.onceAsync(tally.opId, { op: 'settle', tally }, async () => {
      const live = tally.nonces
        .map((n) => this.commitments.get(n))
        .filter((c): c is SeatCommitment & { settled?: boolean } => !!c);
      if (live.some((c) => c.settled)) {
        throw new ClubError('commitment-stale', 'those chips were already settled');
      }
      const problems = checkTally(tally, live);
      if (problems.length > 0) {
        const exceeds = problems.find((p) => p.code === 'exceeds-commitment');
        throw new ClubError(
          exceeds ? 'commitment-exceeded' : 'tally-invalid',
          `the tally was refused: ${problems.map((p) => p.code).join(', ')}`,
          problems,
        );
      }
      const balances: Record<string, number> = {};
      for (const entry of tally.entries) {
        const seated = this.seats.find(
          (s) => s.tableId === tally.tableId && s.memberId === entry.memberId,
        );
        if (!seated) throw new ClubError('not-seated', `${entry.memberId} is not at that table`);
        // The stake is on the table, so the result and the rake both land on the stack.
        seated.stack += entry.net;
        const table = this.tables.get(tally.tableId);
        if (table) table.stacks[seated.seat] = seated.stack;
      }
      for (const nonce of tally.nonces) {
        const c = this.commitments.get(nonce);
        if (c) c.settled = true;
      }
      for (const entry of tally.entries) {
        balances[entry.memberId] = this.balances.get(entry.memberId) ?? 0;
      }
      const settlement: Settlement = {
        tableId: tally.tableId,
        balances,
        entries: tally.entries,
        rake: tally.rake,
        settledAt: this.now(),
      };
      for (const entry of tally.entries) {
        this.push(entry.memberId, { kind: 'settled', settlement });
      }
      return settlement;
    });
  }

  async statement(session: ClubSession): Promise<MemberStatement> {
    const member = this.memberOf(session);
    return {
      memberId: member.id,
      balance: this.balances.get(member.id) ?? 0,
      entries: [],
      head: { seq: 0, hash: '', signature: '' },
    };
  }

  async transfer(_session: ClubSession, _req: TransferRequest): Promise<Receipt> {
    throw new ClubError('unsupported', 'this club does not move chips between members');
  }

  async requestChips(_session: ClubSession, _req: ChipRequestInput): Promise<Receipt> {
    throw new ClubError('unsupported', 'this club does not take chip requests');
  }

  async chat(_session: ClubSession, _text: string): Promise<void> {
    throw new ClubError('unsupported', 'this club has no chat');
  }

  async queue(
    session: ClubSession,
    criteria: MatchCriteria,
    req: Idempotent,
  ): Promise<MatchTicket> {
    const member = this.memberOf(session);
    const ticket = this.once(req.opId, { op: 'queue', member: member.id, criteria }, () => {
      const t: MatchTicket = {
        id: generateId(),
        memberId: member.id,
        criteria,
        queuedAt: this.now(),
      };
      this.tickets.set(t.id, t);
      this.push(member.id, { kind: 'match', event: { kind: 'queued', ticket: t } });
      return t;
    });
    await this.match();
    return ticket;
  }

  async unqueue(session: ClubSession, ticketId: string): Promise<void> {
    const member = this.memberOf(session);
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.memberId !== member.id) return;
    this.tickets.delete(ticketId);
    this.push(member.id, {
      kind: 'match',
      event: { kind: 'cancelled', ticketId, reason: 'member' },
    });
  }

  private async match(): Promise<void> {
    const template = this.room.templates[0]!;
    const eligible = [...this.tickets.values()].filter((t) =>
      criteriaCompatible(t.criteria, { game: template.game, templateIds: [template.id] }),
    );
    for (const group of proposeMatches(eligible, template.seats)) {
      let tableId: string | undefined;
      for (const ticket of group) {
        this.tickets.delete(ticket.id);
        const member = this.members.get(ticket.memberId);
        if (!member) continue;
        const buyIn = Math.min(
          template.stakes.buyIn?.default ?? 0,
          this.balances.get(member.id) ?? 0,
        );
        const table = this.tableFor(tableId, template);
        tableId ??= table.id;
        const seat = table.seats.findIndex((s) => s === null);
        if (seat < 0) continue;
        this.balances.set(member.id, (this.balances.get(member.id) ?? 0) - buyIn);
        table.seats[seat] = { name: member.name, memberId: member.id };
        table.stacks[seat] = buyIn;
        const commitment = await this.commit(table.id, member.id, buyIn);
        this.seats.push({
          tableId: table.id,
          memberId: member.id,
          seat,
          stack: buyIn,
          nonce: commitment.nonce,
        });
        this.pushBalance(member.id);
        this.push(member.id, {
          kind: 'match',
          event: {
            kind: 'matched',
            ticketId: ticket.id,
            grant: {
              tableId: table.id,
              code: table.code,
              game: template.game,
              seat,
              commitment,
            },
          },
        });
      }
    }
  }

  async disconnect(session: ClubSession): Promise<void> {
    const id = this.sessions.get(session.token);
    this.sessions.delete(session.token);
    if (id) this.subscribers.delete(id);
  }
}
