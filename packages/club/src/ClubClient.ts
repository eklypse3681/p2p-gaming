import type {
  ChipRequest,
  ClubClientMessage,
  ClubRejectReason,
  ClubServerMessage,
  LobbyState,
  MemberStatement,
  PlayerProfile,
  Signer,
  Transport,
  Unsubscribe,
} from '@bgf/protocol';
import { CLUB_PROTOCOL_VERSION, bytesToBase64Url, clubChallengeBytes } from '@bgf/protocol';

export type ClubConnectionStatus = 'connecting' | 'joined' | 'rejected' | 'disconnected';

export interface ClubChat {
  from: { id: string; name: string };
  text: string;
  at: number;
}

export interface ClubClientState {
  status: ClubConnectionStatus;
  rejectReason: ClubRejectReason | null;
  rejectMessage: string | null;
  lobby: LobbyState | null;
  statement: MemberStatement | null;
  balance: number | null;
  chat: ClubChat[];
  requests: ChipRequest[];
  /** The seat the club last handed us: join that table by `code`. */
  seat: { tableId: string; code: string; game: string; seat: number; buyIn: number } | null;
  latencyMs: number | null;
  error: { code: string; message: string; at: number } | null;
}

export interface ClubClientOptions {
  transport: Transport;
  profile: PlayerProfile;
  signer?: Signer;
  invite?: string;
  pingIntervalMs?: number;
  now?: () => number;
}

const MAX_CHAT = 200;

/** A member's end of the club channel. */
export class ClubClient {
  readonly profile: PlayerProfile;
  private state: ClubClientState;
  private readonly listeners = new Set<() => void>();
  private readonly transport: Transport;
  private readonly signer: Signer | undefined;
  private readonly invite: string | undefined;
  private readonly now: () => number;
  private readonly unsubscribe: Unsubscribe[] = [];
  private helloSent = false;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ClubClientOptions) {
    this.profile = opts.profile;
    this.transport = opts.transport;
    this.signer = opts.signer;
    this.invite = opts.invite;
    this.now = opts.now ?? Date.now;
    this.state = {
      status: 'connecting',
      rejectReason: null,
      rejectMessage: null,
      lobby: null,
      statement: null,
      balance: null,
      chat: [],
      requests: [],
      seat: null,
      latencyMs: null,
      error: null,
    };
    this.unsubscribe.push(this.transport.onMessage((raw) => void this.receive(raw)));
    this.unsubscribe.push(
      this.transport.onStatus((status) => {
        if (status === 'open') this.sendHello();
        if (status === 'closed' && this.state.status !== 'rejected') {
          this.setState({ status: 'disconnected' });
        }
      }),
    );
    if (this.transport.status === 'open') this.sendHello();
    const interval = opts.pingIntervalMs ?? 10_000;
    if (interval > 0) {
      this.pingTimer = setInterval(() => this.sendRaw({ type: 'ping', t: this.now() }), interval);
    }
  }

  getState(): ClubClientState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): boolean {
    return this.sendRaw({ type: 'lobby' });
  }
  sit(req: { tableId?: string; templateId?: string; buyIn?: number }): boolean {
    this.setState({ seat: null });
    return this.sendRaw({ type: 'sit', ...req });
  }
  leave(tableId: string): boolean {
    return this.sendRaw({ type: 'leave', tableId });
  }
  statement(): boolean {
    return this.sendRaw({ type: 'statement' });
  }
  transfer(to: string, amount: number, note?: string): boolean {
    return this.sendRaw({ type: 'transfer', to, amount, ...(note ? { note } : {}) });
  }
  requestChips(amount: number, note?: string): boolean {
    return this.sendRaw({ type: 'request-chips', amount, ...(note ? { note } : {}) });
  }
  chat(text: string): boolean {
    return this.sendRaw({ type: 'chat', text });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.sendRaw({ type: 'bye' });
    for (const u of this.unsubscribe) u();
    try {
      this.transport.close();
    } catch {
      /* ignore */
    }
    if (this.state.status !== 'rejected') this.setState({ status: 'disconnected' });
    this.listeners.clear();
  }

  private setState(patch: Partial<ClubClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of Array.from(this.listeners)) l();
  }

  private sendRaw(message: ClubClientMessage): boolean {
    if (this.closed || this.transport.status !== 'open') return false;
    try {
      this.transport.send(message);
      return true;
    } catch {
      return false;
    }
  }

  private sendHello(): void {
    if (this.helloSent || this.closed) return;
    const hello: ClubClientMessage = {
      type: 'hello',
      protocol: CLUB_PROTOCOL_VERSION,
      profile: this.profile,
      ...(this.invite ? { invite: this.invite } : {}),
    };
    if (this.sendRaw(hello)) this.helloSent = true;
  }

  private async answer(msg: Extract<ClubServerMessage, { type: 'challenge' }>): Promise<void> {
    if (!this.signer) {
      this.setState({
        status: 'rejected',
        rejectReason: 'unauthorized',
        rejectMessage: 'this player has no key to answer the club challenge',
      });
      return;
    }
    try {
      const bytes = clubChallengeBytes({
        clubId: msg.clubId,
        profileId: this.profile.id,
        nonce: msg.nonce,
      });
      const signature = bytesToBase64Url(await this.signer(bytes));
      this.sendRaw({ type: 'auth', signature });
    } catch (e) {
      this.setState({
        status: 'rejected',
        rejectReason: 'unauthorized',
        rejectMessage: e instanceof Error ? e.message : 'could not sign the challenge',
      });
    }
  }

  private async receive(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string')
      return;
    const msg = raw as ClubServerMessage;
    switch (msg.type) {
      case 'challenge':
        await this.answer(msg);
        return;
      case 'welcome':
        this.setState({
          status: 'joined',
          lobby: msg.lobby,
          balance: msg.lobby.me.balance,
          error: null,
        });
        return;
      case 'rejected':
        this.setState({ status: 'rejected', rejectReason: msg.reason, rejectMessage: msg.message });
        return;
      case 'lobby':
        this.setState({ lobby: msg.lobby, balance: msg.lobby.me.balance });
        return;
      case 'seat':
        this.setState({
          seat: {
            tableId: msg.tableId,
            code: msg.code,
            game: msg.game,
            seat: msg.seat,
            buyIn: msg.buyIn,
          },
        });
        return;
      case 'statement':
        this.setState({ statement: msg.statement, balance: msg.statement.balance });
        return;
      case 'balance':
        this.setState({ balance: msg.balance });
        return;
      case 'chip-request': {
        const others = this.state.requests.filter((r) => r.id !== msg.request.id);
        this.setState({ requests: [...others, msg.request] });
        return;
      }
      case 'chat':
        this.setState({
          chat: [...this.state.chat, { from: msg.from, text: msg.text, at: msg.at }].slice(
            -MAX_CHAT,
          ),
        });
        return;
      case 'error':
        this.setState({ error: { code: msg.code, message: msg.message, at: this.now() } });
        return;
      case 'pong':
        this.setState({ latencyMs: Math.max(0, this.now() - msg.t) });
        return;
      default:
        return;
    }
  }
}
