import type {
  Action,
  Board,
  CubeOwner,
  Destination,
  DiceRoll,
  GamePhase,
  MatchConfig,
  MatchState,
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
import type { MatchSnapshot, PlayerProfile, Signer, Transport } from '@bgf/protocol';
import { TableClient } from '@bgf/table';
import type { TableClientState } from '@bgf/table';
import {
  chatFromTable,
  seatIndex,
  seatPlayer,
  toMatchSnapshot,
  toTableSnapshot,
} from '@bgf/server';
import type { BackgammonCommand, BackgammonTableSnapshot } from '@bgf/server';
import type { MatchStore } from './store.js';
import type { ClientState, GameClientApi, TurnDraft } from './types.js';

export interface GameClientOptions {
  transport: Transport;
  profile: PlayerProfile;
  /**
   * Signs the server's seat challenge with this player's private key. Required to take a seat
   * bound to `profile.publicKey`; without it only legacy unkeyed seats can be joined.
   */
  signer?: Signer;
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

type TableState = TableClientState<MatchState, Action, MatchConfig>;

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
 * The backgammon client: a colour-speaking wrapper around the generic `TableClient` that adds
 * local turn drafting (validated with the engine before anything is sent) and the match
 * commands. Identical on host and guest.
 */
export class GameClient implements GameClientApi {
  readonly profile: PlayerProfile;

  private state: ClientState;
  private readonly listeners = new Set<() => void>();
  private readonly table: TableClient<MatchState, Action, MatchConfig, MatchState>;
  private readonly previewThrottleMs: number;
  private readonly now: () => number;
  private lastTable: TableState;

  private basis: TurnBasis | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewDirty = false;
  private closed = false;

  constructor(opts: GameClientOptions) {
    this.profile = opts.profile;
    this.previewThrottleMs = opts.previewThrottleMs ?? 120;
    this.now = opts.now ?? Date.now;
    const store = opts.store;
    this.table = new TableClient<MatchState, Action, MatchConfig, MatchState>({
      transport: opts.transport,
      profile: opts.profile,
      signer: opts.signer,
      resumeSnapshot: opts.resumeSnapshot ? toTableSnapshot(opts.resumeSnapshot) : undefined,
      store: store ? { put: (s) => store.put(toMatchSnapshot(s)) } : undefined,
      pingIntervalMs: opts.pingIntervalMs,
      now: opts.now,
      onStoreError: opts.onStoreError ?? ((e) => console.warn('[GameClient] store error', e)),
    });
    this.lastTable = this.table.getState();
    this.state = this.project(this.lastTable, null, emptyDraft(emptyBoard()));
    this.table.subscribe(() => this.onTableChange());
    // The transport may already have moved on (e.g. closed) before we subscribed.
    if (this.table.getState() !== this.lastTable) this.onTableChange();
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
  // Table → backgammon state
  // ---------------------------------------------------------------------------------------------

  /** Build the colour-keyed client state from the generic table state. */
  private project(t: TableState, snapshot: MatchSnapshot | null, draft: TurnDraft): ClientState {
    const seat = t.seat === null ? null : seatPlayer(t.seat);
    const opponentSeat = t.seat === null ? null : 1 - t.seat;
    const preview = opponentSeat === null ? undefined : t.previews[opponentSeat];
    const opponentPreview =
      Array.isArray(preview) && preview.length > 0 ? (preview as SubMove[]) : null;
    return {
      status: t.status,
      rejectReason: t.rejectReason,
      seat,
      role: t.role,
      dealer: t.dealer,
      snapshot,
      lastAction: t.lastAction
        ? {
            action: t.lastAction.action,
            by: t.lastAction.by === null ? null : seatPlayer(t.lastAction.by),
            seq: t.lastAction.seq,
          }
        : null,
      opponentPreview,
      presence: { white: t.presence[0] ?? false, black: t.presence[1] ?? false },
      ready: { white: t.ready[0] ?? false, black: t.ready[1] ?? false },
      autopilot: t.autopilot,
      chat: t.chat.map(chatFromTable),
      latencyMs: t.latencyMs,
      error: t.error,
      draft,
    };
  }

  private onTableChange(): void {
    if (this.closed) return;
    const prev = this.lastTable;
    const next = this.table.getState();
    this.lastTable = next;
    const snapshot =
      next.snapshot === prev.snapshot
        ? this.state.snapshot
        : next.snapshot
          ? toMatchSnapshot(next.snapshot as BackgammonTableSnapshot)
          : null;
    let draft = this.state.draft;
    if (
      snapshot &&
      next.seat !== null &&
      (next.snapshot !== prev.snapshot || next.seat !== prev.seat)
    ) {
      draft = this.syncDraft(snapshot, seatPlayer(next.seat));
    }
    if (next.error !== prev.error && next.error && draft.pending) {
      draft = { ...draft, pending: false };
    }
    if (next.status !== 'joined' && prev.status === 'joined') {
      this.cancelPreview();
    }
    this.state = this.project(next, snapshot, draft);
    for (const l of Array.from(this.listeners)) l();
  }

  // ---------------------------------------------------------------------------------------------
  // Match commands
  // ---------------------------------------------------------------------------------------------

  private send(command: BackgammonCommand): void {
    if (this.closed) return;
    this.table.send(command);
  }

  startGame(): void {
    this.send({ type: 'start-game' });
  }
  ready(ready?: boolean): void {
    const mine = this.state.seat ? (this.state.ready?.[this.state.seat] ?? false) : false;
    this.table.setReady(ready ?? !mine);
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
    if (this.closed) return;
    this.table.sendChat(text);
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
    this.table.sendPreview([]);
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
    this.table.sendPreview(this.state.draft.played);
  }

  private cancelPreview(): void {
    this.previewDirty = false;
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
  }

  // ---------------------------------------------------------------------------------------------

  /** The seat index of `player` on the table (0 = white, 1 = black). */
  static seatOf(player: Player): number {
    return seatIndex(player);
  }

  close(): void {
    if (this.closed) return;
    this.basis = null;
    this.cancelPreview();
    this.table.close(); // sends bye, closes the transport, flips status → our listener projects it
    this.closed = true;
    const t = this.table.getState();
    this.lastTable = t;
    this.state = this.project(t, this.state.snapshot, this.state.draft);
    for (const l of Array.from(this.listeners)) l();
    this.listeners.clear();
  }
}
