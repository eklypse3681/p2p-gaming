import type {
  Board,
  CubeOwner,
  Destination,
  DiceRoll,
  GamePhase,
  Player,
  RelPoint,
  ResultKind,
  SubMove,
} from '@bgf/engine';
import {
  RuleError,
  applyPlay,
  boardsEqual,
  destinationsFrom,
  emptyBoard,
  turnOptions,
} from '@bgf/engine';
import type {
  ClientMessage,
  MatchSnapshot,
  PlayerProfile,
  ServerMessage,
  Transport,
  Unsubscribe,
} from '@bgf/protocol';
import { PROTOCOL_VERSION, isServerMessage } from '@bgf/protocol';
import type { MatchStore } from './store.js';
import type { ClientState, GameClientApi, TurnDraft } from './types.js';

export interface GameClientOptions {
  transport: Transport;
  profile: PlayerProfile;
  /** Our persisted copy of the match, offered to the server so the newest state wins. */
  resumeSnapshot?: MatchSnapshot;
  /** Every received snapshot is saved here (fire and forget). */
  store?: MatchStore;
  /** Minimum interval between `preview` messages. Default 120ms; 0 disables throttling. */
  previewThrottleMs?: number;
  /** Ping interval for latency measurement. Default 10s; 0 disables. */
  pingIntervalMs?: number;
  /** Clock (tests). */
  now?: () => number;
  /** Where to report store failures; default console.warn. */
  onStoreError?: (error: unknown) => void;
}

interface TurnBasis {
  board: Board;
  dice: DiceRoll;
  turnCount: number;
}

const MAX_CHAT_HISTORY = 200;

function emptyDraft(board: Board): TurnDraft {
  return {
    played: [],
    board,
    next: [],
    remaining: [],
    complete: false,
    maxMoves: 0,
    pending: false,
  };
}

function sameStep(a: SubMove, b: SubMove): boolean {
  return a.from === b.from && a.to === b.to && a.die === b.die;
}

/** The `moving` phase that a draft applies to: either the live phase or the one suspended by a resignation offer. */
function movingPhase(phase: GamePhase | undefined): Extract<GamePhase, { kind: 'moving' }> | null {
  if (!phase) return null;
  if (phase.kind === 'moving') return phase;
  if (phase.kind === 'resign-offered' && phase.prior.kind === 'moving') return phase.prior;
  return null;
}

/**
 * The client half of the protocol. Identical on host and guest: it only ever talks to a
 * `Transport`. Exposes a `useSyncExternalStore`-friendly state and local turn drafting that
 * is validated with the engine before anything is sent.
 */
export class GameClient implements GameClientApi {
  readonly profile: PlayerProfile;

  private state: ClientState;
  private readonly listeners = new Set<() => void>();
  private readonly transport: Transport;
  private readonly store: MatchStore | undefined;
  private readonly resumeSnapshot: MatchSnapshot | undefined;
  private readonly previewThrottleMs: number;
  private readonly pingIntervalMs: number;
  private readonly now: () => number;
  private readonly onStoreError: (error: unknown) => void;
  private readonly unsubscribe: Unsubscribe[] = [];

  private basis: TurnBasis | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewDirty = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private helloSent = false;
  private closed = false;

  constructor(opts: GameClientOptions) {
    this.profile = opts.profile;
    this.transport = opts.transport;
    this.store = opts.store;
    this.resumeSnapshot = opts.resumeSnapshot;
    this.previewThrottleMs = opts.previewThrottleMs ?? 120;
    this.pingIntervalMs = opts.pingIntervalMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.onStoreError = opts.onStoreError ?? ((e) => console.warn('[GameClient] store error', e));
    this.state = {
      status: 'connecting',
      rejectReason: null,
      seat: null,
      snapshot: null,
      lastAction: null,
      opponentPreview: null,
      presence: { white: false, black: false },
      chat: [],
      latencyMs: null,
      error: null,
      draft: emptyDraft(emptyBoard()),
    };

    this.unsubscribe.push(this.transport.onMessage((m) => this.handle(m)));
    this.unsubscribe.push(
      this.transport.onStatus((status, reason) => {
        if (status === 'open') this.sendHello();
        if (status === 'closed') this.onTransportClosed(reason);
      }),
    );
    if (this.transport.status === 'open') this.sendHello();
    else if (this.transport.status === 'closed') this.onTransportClosed('closed');
  }

  // ---------------------------------------------------------------------------------------------
  // Store API
  // ---------------------------------------------------------------------------------------------

  getState(): ClientState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of Array.from(this.listeners)) l();
  }

  // ---------------------------------------------------------------------------------------------
  // Transport plumbing
  // ---------------------------------------------------------------------------------------------

  private send(message: ClientMessage): boolean {
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
    const hello: ClientMessage = {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      profile: this.profile,
    };
    if (this.resumeSnapshot) hello.snapshot = this.resumeSnapshot;
    if (this.send(hello)) this.helloSent = true;
  }

  private onTransportClosed(reason?: string): void {
    this.stopPing();
    this.cancelPreview();
    if (this.state.status === 'rejected') return;
    this.setState({
      status: 'disconnected',
      presence: { white: false, black: false },
      error:
        reason && reason !== 'closed'
          ? { code: 'disconnected', message: reason, at: this.now() }
          : this.state.error,
    });
  }

  private startPing(): void {
    if (this.pingIntervalMs <= 0 || this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping', t: this.now() });
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private persist(snapshot: MatchSnapshot): void {
    if (!this.store) return;
    try {
      void this.store.put(snapshot).catch((e: unknown) => this.onStoreError(e));
    } catch (e) {
      this.onStoreError(e);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Inbound messages
  // ---------------------------------------------------------------------------------------------

  private handle(raw: unknown): void {
    if (this.closed || !isServerMessage(raw)) return;
    const msg = raw as ServerMessage;
    switch (msg.type) {
      case 'welcome': {
        const draft = this.syncDraft(msg.snapshot, msg.seat);
        this.setState({
          status: 'joined',
          rejectReason: null,
          seat: msg.seat,
          snapshot: msg.snapshot,
          chat: msg.snapshot.chat ?? [],
          presence: { ...this.state.presence, [msg.seat]: true },
          opponentPreview: null,
          draft,
        });
        this.persist(msg.snapshot);
        this.startPing();
        return;
      }
      case 'rejected':
        this.setState({
          status: 'rejected',
          rejectReason: msg.reason,
          error: { code: `rejected:${msg.reason}`, message: msg.message, at: this.now() },
        });
        return;
      case 'state': {
        const seat = this.state.seat;
        const draft = seat ? this.syncDraft(msg.snapshot, seat) : this.state.draft;
        this.setState({
          snapshot: msg.snapshot,
          chat: msg.snapshot.chat ?? this.state.chat,
          lastAction: msg.action
            ? { action: msg.action, by: msg.by ?? null, seq: msg.snapshot.seq }
            : this.state.lastAction,
          opponentPreview: null,
          draft,
        });
        this.persist(msg.snapshot);
        return;
      }
      case 'preview':
        if (msg.seat !== this.state.seat) {
          this.setState({ opponentPreview: msg.play.length > 0 ? msg.play : null });
        }
        return;
      case 'presence':
        this.setState({ presence: { ...this.state.presence, [msg.seat]: msg.connected } });
        return;
      case 'chat': {
        const chat = [...this.state.chat, msg.message].slice(-MAX_CHAT_HISTORY);
        const snapshot = this.state.snapshot ? { ...this.state.snapshot, chat } : null;
        this.setState({ chat, snapshot });
        if (snapshot) this.persist(snapshot);
        return;
      }
      case 'error':
        this.setState({ error: { code: msg.code, message: msg.message, at: this.now() } });
        if (this.state.draft.pending)
          this.setState({ draft: { ...this.state.draft, pending: false } });
        return;
      case 'pong':
        this.setState({ latencyMs: Math.max(0, this.now() - msg.t) });
        return;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Match commands
  // ---------------------------------------------------------------------------------------------

  startGame(): void {
    this.send({ type: 'start-game' });
  }
  openingRoll(): void {
    this.send({ type: 'opening-roll' });
  }
  roll(): void {
    this.send({ type: 'roll' });
  }
  double(): void {
    this.send({ type: 'double' });
  }
  take(): void {
    this.send({ type: 'take' });
  }
  drop(): void {
    this.send({ type: 'drop' });
  }
  offerResign(stakes: ResultKind): void {
    this.send({ type: 'offer-resign', stakes });
  }
  acceptResign(): void {
    this.send({ type: 'accept-resign' });
  }
  declineResign(): void {
    this.send({ type: 'decline-resign' });
  }
  sendChat(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.send({ type: 'chat', text: trimmed });
  }

  // ---- free-board mode (the server validates; nothing is drafted locally) ----

  freeRoll(): void {
    this.send({ type: 'free-roll' });
  }
  freeMove(checker: Player, from: RelPoint, to: RelPoint): void {
    this.send({ type: 'free-move', checker, from, to });
  }
  setCube(value: number, owner: CubeOwner): void {
    this.send({ type: 'free-cube', value, owner });
  }
  resetBoard(): void {
    this.send({ type: 'free-reset' });
  }
  recordResult(winner: Player, kind: ResultKind): void {
    this.send({ type: 'free-result', winner, kind });
  }

  // ---------------------------------------------------------------------------------------------
  // Turn drafting
  // ---------------------------------------------------------------------------------------------

  /**
   * Reconcile the local draft with a new authoritative snapshot. The draft survives only while
   * the snapshot still shows *me* moving with the same dice from the same starting position
   * (e.g. across a declined resignation); anything else resets it.
   */
  private syncDraft(snapshot: MatchSnapshot, seat: Player): TurnDraft {
    const game = snapshot.match.game;
    const phase = movingPhase(game?.phase);
    if (game && phase && phase.player === seat) {
      const basis = this.basis;
      if (
        basis &&
        basis.turnCount === game.turnCount &&
        basis.dice[0] === phase.dice[0] &&
        basis.dice[1] === phase.dice[1] &&
        boardsEqual(basis.board, game.board)
      ) {
        return this.state.draft;
      }
      this.basis = { board: game.board, dice: phase.dice, turnCount: game.turnCount };
      return this.computeDraft([], seat);
    }
    this.basis = null;
    this.cancelPreview();
    return emptyDraft(game?.board ?? this.state.snapshot?.match.game?.board ?? emptyBoard());
  }

  private computeDraft(played: SubMove[], seat: Player | null = this.state.seat): TurnDraft {
    const basis = this.basis;
    if (!basis || !seat) return emptyDraft(emptyBoard());
    const opts = turnOptions(basis.board, seat, basis.dice, played);
    return {
      played,
      board: applyPlay(basis.board, seat, played),
      next: opts.next,
      remaining: opts.remaining,
      complete: opts.complete,
      maxMoves: opts.maxMoves,
      pending: false,
    };
  }

  private requireDrafting(): TurnBasis {
    if (this.closed) throw new RuleError('closed', 'the client is closed');
    if (!this.basis || !this.state.seat)
      throw new RuleError('not-moving', 'it is not your turn to move');
    if (this.state.draft.pending) throw new RuleError('pending', 'a play is already being sent');
    return this.basis;
  }

  stage(moves: SubMove | SubMove[]): void {
    this.requireDrafting();
    const list = Array.isArray(moves) ? moves : [moves];
    if (list.length === 0) return;
    let draft = this.state.draft;
    for (const m of list) {
      const legal = draft.next.find((n) => sameStep(n, m));
      if (!legal) {
        throw new RuleError('illegal-move', `${m.from}/${m.to} with a ${m.die} is not legal now`);
      }
      draft = this.computeDraft([...draft.played, legal]);
    }
    this.setState({ draft });
    this.schedulePreview();
  }

  unstage(): void {
    this.requireDrafting();
    const { played } = this.state.draft;
    if (played.length === 0) return;
    this.setState({ draft: this.computeDraft(played.slice(0, -1)) });
    this.schedulePreview();
  }

  clearDraft(): void {
    if (!this.basis) return;
    if (this.state.draft.pending) return;
    if (this.state.draft.played.length === 0) return;
    this.setState({ draft: this.computeDraft([]) });
    this.flushPreview(true);
  }

  commit(): void {
    this.requireDrafting();
    const draft = this.state.draft;
    if (!draft.complete) throw new RuleError('incomplete', 'the play is not complete');
    this.cancelPreview();
    this.send({ type: 'preview', play: [] });
    this.send({ type: 'play', play: draft.played });
    this.setState({ draft: { ...draft, pending: true } });
  }

  destinations(from: RelPoint): Destination[] {
    const basis = this.basis;
    const seat = this.state.seat;
    if (!basis || !seat || this.state.draft.pending) return [];
    return destinationsFrom(basis.board, seat, basis.dice, this.state.draft.played, from);
  }

  // ---- preview throttling (leading + trailing edge) ----

  private schedulePreview(): void {
    this.previewDirty = true;
    if (this.previewThrottleMs <= 0) {
      this.flushPreview(false);
      return;
    }
    if (this.previewTimer) return;
    this.flushPreview(false);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      if (this.previewDirty) this.schedulePreview();
    }, this.previewThrottleMs);
  }

  private flushPreview(immediate: boolean): void {
    if (immediate) this.cancelPreview();
    this.previewDirty = false;
    if (this.state.status !== 'joined') return;
    this.send({ type: 'preview', play: this.state.draft.played });
  }

  private cancelPreview(): void {
    this.previewDirty = false;
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
  }

  // ---------------------------------------------------------------------------------------------

  close(): void {
    if (this.closed) return;
    this.send({ type: 'bye' });
    this.closed = true;
    this.basis = null;
    this.stopPing();
    this.cancelPreview();
    for (const u of this.unsubscribe) u();
    this.transport.close();
    if (this.state.status !== 'rejected') {
      this.setState({ status: 'disconnected', presence: { white: false, black: false } });
    }
    this.listeners.clear();
  }
}
