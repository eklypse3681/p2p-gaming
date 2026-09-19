import type { PlayerProfile } from '@bgf/protocol';
import type {
  ClubApi,
  ClubInfo,
  ClubSession,
  ClubUpdate,
  MatchCriteria,
  SeatGrant,
} from '@bgf/club-spec';
import { isClubError } from '@bgf/club-spec';
import type { ClubClientApi, ClubClientState, ClubSeat } from './types';

/**
 * Adapts any `ClubApi` implementation into the store the Clubs screens read.
 *
 * The screens are synchronous and the interface is not, so every call here is fire-and-forget:
 * it dispatches, and the answer arrives as a state change. Failures land in `state.error` with
 * the club's own code, which the screens turn into plain words.
 *
 * Idempotency is this layer's job. Each mutating call carries a fresh `opId`, and a call
 * retried after a dropped connection reuses the id it was first given, so a club that already
 * applied it moves no chips a second time.
 */

function newOpId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function seatFromGrant(grant: SeatGrant): ClubSeat {
  return {
    tableId: grant.tableId,
    code: grant.code,
    game: grant.game,
    seat: grant.seat,
    buyIn: grant.commitment.amount,
    commitment: grant.commitment,
  };
}

export interface ClubApiClientOptions {
  api: ClubApi;
  session: ClubSession;
  profile: PlayerProfile;
  info: ClubInfo;
  /** Starting lobby, when the caller already fetched one during the handshake. */
  lobby?: ClubClientState['lobby'];
}

export class ClubApiClient implements ClubClientApi {
  readonly profile: PlayerProfile;
  /** Test aid: every call this client made, in order. */
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private readonly api: ClubApi;
  private readonly session: ClubSession;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private state: ClubClientState;
  /** Operation ids kept per logical action so a retry reuses the first id. */
  private readonly opIds = new Map<string, string>();
  /**
   * Tickets the club has already matched or cancelled. A match can land before the `queue` call
   * that created the ticket has returned, and without this the late reply would put the player
   * back in a queue they have already left.
   */
  private readonly finishedTickets = new Set<string>();

  constructor(opts: ClubApiClientOptions) {
    this.api = opts.api;
    this.session = opts.session;
    this.profile = opts.profile;
    this.state = {
      status: 'joined',
      rejectReason: null,
      info: opts.info,
      lobby: opts.lobby ?? null,
      statement: null,
      balance: opts.lobby?.me.balance ?? null,
      staked: 0,
      chat: [],
      error: null,
      seat: null,
      ticket: null,
      queueEnded: null,
      settlement: null,
    };
    this.unsubscribe = this.api.subscribe(this.session, (u) => this.onUpdate(u));
    if (!opts.lobby) void this.refreshNow();
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

  /** Tests and the reconnect path: push state directly. */
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

  private fail(e: unknown, fallback: string): void {
    const code = isClubError(e) ? e.code : 'unavailable';
    const message = e instanceof Error ? e.message : fallback;
    this.patch({ error: { code, message, at: Date.now() } });
  }

  /** An id that survives retries of the same logical action. */
  private opIdFor(key: string): string {
    const existing = this.opIds.get(key);
    if (existing) return existing;
    const id = newOpId();
    this.opIds.set(key, id);
    return id;
  }

  private settleOpId(key: string): void {
    this.opIds.delete(key);
  }

  private onUpdate(u: ClubUpdate): void {
    switch (u.kind) {
      case 'lobby':
        this.patch({ lobby: u.lobby, balance: u.lobby.me.balance });
        return;
      case 'balance':
        this.patch({ balance: u.balance });
        return;
      case 'table': {
        const lobby = this.state.lobby;
        if (!lobby) return;
        const tables = lobby.tables.some((t) => t.id === u.table.id)
          ? lobby.tables.map((t) => (t.id === u.table.id ? u.table : t))
          : [...lobby.tables, u.table];
        this.patch({ lobby: { ...lobby, tables } });
        return;
      }
      case 'match': {
        const e = u.event;
        if (e.kind === 'queued') this.patch({ ticket: e.ticket, queueEnded: null });
        else if (e.kind === 'estimate') {
          const t = this.state.ticket;
          if (t && t.id === e.ticketId) this.patch({ ticket: { ...t, estimate: e.estimate } });
        } else if (e.kind === 'matched') {
          this.finishedTickets.add(e.ticketId);
          const seat = seatFromGrant(e.grant);
          this.patch({
            ticket: null,
            seat,
            staked: this.state.staked + seat.buyIn,
            queueEnded: { reason: 'matched', at: Date.now() },
          });
        } else {
          this.finishedTickets.add(e.ticketId);
          this.patch({ ticket: null, queueEnded: { reason: e.reason, at: Date.now() } });
        }
        return;
      }
      case 'settled': {
        const mine = u.settlement.balances[this.profile.id];
        this.patch({
          settlement: u.settlement,
          staked: 0,
          ...(mine !== undefined ? { balance: mine } : {}),
        });
        return;
      }
      case 'chat':
        this.patch({ chat: [...this.state.chat, { from: u.from, text: u.text, at: u.at }] });
        return;
      case 'chip-request':
        return;
      case 'closed':
        this.patch({ status: 'disconnected' });
        return;
    }
  }

  private async refreshNow(): Promise<void> {
    try {
      const lobby = await this.api.lobby(this.session);
      this.patch({ lobby, balance: lobby.me.balance });
    } catch (e) {
      this.fail(e, 'Could not read the lobby');
    }
  }

  refresh(): void {
    this.record('refresh');
    void this.refreshNow();
  }

  sit(opts: { tableId?: string; templateId?: string; buyIn?: number }): void {
    this.record('sit', opts);
    const key = `sit:${opts.tableId ?? opts.templateId ?? '?'}`;
    void (async () => {
      try {
        const grant = await this.api.sit(this.session, { ...opts, opId: this.opIdFor(key) });
        this.settleOpId(key);
        const seat = seatFromGrant(grant);
        const balance =
          this.state.balance !== null ? this.state.balance - seat.buyIn : this.state.balance;
        this.patch({ seat, staked: this.state.staked + seat.buyIn, balance, error: null });
      } catch (e) {
        this.fail(e, 'Could not take that seat');
      }
    })();
  }

  leave(tableId: string): void {
    this.record('leave', tableId);
    const key = `leave:${tableId}`;
    void (async () => {
      try {
        const settlement = await this.api.leave(this.session, {
          tableId,
          opId: this.opIdFor(key),
        });
        this.settleOpId(key);
        const mine = settlement?.balances[this.profile.id];
        this.patch({
          seat: this.state.seat?.tableId === tableId ? null : this.state.seat,
          staked: 0,
          ...(settlement ? { settlement } : {}),
          ...(mine !== undefined ? { balance: mine } : {}),
        });
      } catch (e) {
        this.fail(e, 'Could not leave that table');
      }
    })();
  }

  statement(): void {
    this.record('statement');
    void (async () => {
      try {
        const statement = await this.api.statement(this.session);
        this.patch({ statement });
      } catch (e) {
        this.fail(e, 'Could not read your statement');
      }
    })();
  }

  transfer(to: string, amount: number, note?: string): void {
    this.record('transfer', to, amount, note);
    const key = `transfer:${to}:${amount}:${note ?? ''}`;
    void (async () => {
      try {
        const receipt = await this.api.transfer(this.session, {
          to,
          amount,
          note,
          opId: this.opIdFor(key),
        });
        this.settleOpId(key);
        this.patch({
          error: null,
          ...(receipt.balance !== undefined ? { balance: receipt.balance } : {}),
        });
      } catch (e) {
        this.fail(e, 'Could not send those chips');
      }
    })();
  }

  requestChips(amount: number, note?: string): void {
    this.record('requestChips', amount, note);
    const key = `request:${amount}:${note ?? ''}`;
    void (async () => {
      try {
        await this.api.requestChips(this.session, { amount, note, opId: this.opIdFor(key) });
        this.settleOpId(key);
        this.patch({ error: null });
      } catch (e) {
        this.fail(e, 'Could not ask for chips');
      }
    })();
  }

  chat(text: string): void {
    this.record('chat', text);
    void (async () => {
      try {
        await this.api.chat(this.session, text);
      } catch (e) {
        this.fail(e, 'Could not send that message');
      }
    })();
  }

  queue(criteria: MatchCriteria): void {
    this.record('queue', criteria);
    const key = `queue:${JSON.stringify(criteria)}`;
    void (async () => {
      try {
        const ticket = await this.api.queue(this.session, criteria, { opId: this.opIdFor(key) });
        this.settleOpId(key);
        // The club may already have matched or cancelled this ticket while the reply was in
        // flight; its update is the newer truth.
        if (this.finishedTickets.has(ticket.id)) return;
        this.patch({ ticket, queueEnded: null, error: null });
      } catch (e) {
        this.fail(e, 'Could not join the queue');
      }
    })();
  }

  unqueue(ticketId?: string): void {
    const id = ticketId ?? this.state.ticket?.id;
    this.record('unqueue', id);
    if (!id) return;
    void (async () => {
      try {
        await this.api.unqueue(this.session, id);
        this.finishedTickets.add(id);
        this.patch({ ticket: null, queueEnded: { reason: 'member', at: Date.now() } });
      } catch (e) {
        this.fail(e, 'Could not leave the queue');
      }
    })();
  }

  close(): void {
    this.record('close');
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.api.disconnect(this.session).catch(() => {});
    this.patch({ status: 'disconnected' });
  }
}
