import type {
  Action,
  Board,
  CubeOwner,
  Destination,
  DiceSource,
  MatchConfig,
  Play,
  Player,
  RelPoint,
  ResultKind,
  SubMove,
} from '@bgf/engine';
import {
  RuleError,
  applyAction,
  applyPlay,
  destinationsFrom,
  newMatch,
  scriptedDice,
  startingBoard,
  turnOptions,
} from '@bgf/engine';
import type { MatchSnapshot, PlayerProfile } from '@bgf/protocol';
import type { ClientState, GameClientApi, TurnDraft } from '@bgf/client';

/**
 * An in-memory `GameClientApi` that applies actions locally through the engine — no server,
 * no transport. Used by board tests and the demo; also handy for a "practice" hotseat mode.
 * Both seats can be driven via `applyAs`.
 */
export interface FakeClientOptions {
  seat?: Player;
  profile?: PlayerProfile;
  names?: Record<Player, string>;
  config?: Partial<MatchConfig>;
  dice?: DiceSource;
  /** Start with a game already in progress from this board and phase. */
  board?: Board;
  autoStart?: boolean;
}

export function emptyDraft(board: Board): TurnDraft {
  return { played: [], board, next: [], remaining: [], complete: false, maxMoves: 0 };
}

export class FakeClient implements GameClientApi {
  readonly profile: PlayerProfile;
  readonly seat: Player;
  private state: ClientState;
  private listeners = new Set<() => void>();
  private dice: DiceSource;
  private seq = 0;

  constructor(opts: FakeClientOptions = {}) {
    this.seat = opts.seat ?? 'white';
    this.profile = opts.profile ?? {
      id: `fake-${this.seat}`,
      name: opts.names?.[this.seat] ?? 'You',
    };
    this.dice = opts.dice ?? scriptedDice([3, 1, 4, 2, 6, 5, 2, 2]);
    const match = newMatch(opts.config ?? { length: 5 });
    const now = 0;
    const snapshot: MatchSnapshot = {
      id: 'fake-match',
      code: 'FAKE01',
      seq: 0,
      createdAt: now,
      updatedAt: now,
      config: match.config,
      players: {
        white: { id: 'fake-white', name: opts.names?.white ?? 'White' },
        black: { id: 'fake-black', name: opts.names?.black ?? 'Black' },
      },
      hostSeat: 'white',
      actions: [],
      match,
      chat: [],
    };
    this.state = {
      status: 'joined',
      rejectReason: null,
      seat: this.seat,
      snapshot,
      lastAction: null,
      opponentPreview: null,
      presence: { white: true, black: true },
      chat: [],
      latencyMs: 12,
      error: null,
      draft: emptyDraft(startingBoard()),
    };
    if (opts.board) {
      this.replaceBoard(opts.board);
    }
    if (opts.autoStart) this.startGame();
  }

  // ---- store ----
  getState(): ClientState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of Array.from(this.listeners)) l();
  }

  /** Test helper: overwrite parts of the state directly. */
  patch(patch: Partial<ClientState>): void {
    this.set(patch);
  }

  /** Test helper: simulate the opponent's provisional moves arriving. */
  setOpponentPreview(play: Play | null): void {
    this.set({ opponentPreview: play });
  }

  private board(): Board {
    return this.state.snapshot?.match.game?.board ?? startingBoard();
  }

  /** Replace the current game's board (test helper for constructing positions). */
  replaceBoard(board: Board): void {
    const snap = this.state.snapshot!;
    const game = snap.match.game;
    const match = game
      ? { ...snap.match, game: { ...game, board } }
      : {
          ...snap.match,
          game: {
            board,
            cube: { value: 1, owner: 'center' as const },
            phase: { kind: 'to-roll' as const, player: this.seat },
            crawford: false,
            turnCount: 0,
            history: [],
          },
        };
    this.set({
      snapshot: { ...snap, match },
      draft: emptyDraft(board),
    });
  }

  // ---- actions ----
  applyAs(player: Player, action: Action): void {
    const snap = this.state.snapshot!;
    try {
      const match = applyAction(snap.match, action);
      this.seq += 1;
      const snapshot: MatchSnapshot = {
        ...snap,
        seq: this.seq,
        updatedAt: this.seq,
        actions: [...snap.actions, action],
        match,
      };
      const board = match.game?.board ?? startingBoard();
      this.set({
        snapshot,
        lastAction: { action, by: player, seq: this.seq },
        draft: this.freshDraft(board, snapshot),
        opponentPreview: null,
        error: null,
      });
    } catch (e) {
      if (e instanceof RuleError) {
        this.set({ error: { code: e.code, message: e.message, at: this.seq } });
        return;
      }
      throw e;
    }
  }

  private freshDraft(board: Board, snapshot: MatchSnapshot): TurnDraft {
    const game = snapshot.match.game;
    if (game && game.phase.kind === 'moving' && game.phase.player === this.seat) {
      const opts = turnOptions(board, this.seat, game.phase.dice, []);
      return { played: [], board, ...opts };
    }
    return emptyDraft(board);
  }

  private act(action: Action): void {
    this.applyAs(this.seat, action);
  }

  private dieFor(): 1 | 2 | 3 | 4 | 5 | 6 {
    return this.dice.rollDie();
  }

  startGame(): void {
    this.act({ type: 'start-game' });
  }
  openingRoll(): void {
    this.act({ type: 'opening-roll', player: this.seat, die: this.dieFor() });
  }
  /** Test helper: opponent's opening roll. */
  opponentOpeningRoll(): void {
    const opp = this.seat === 'white' ? 'black' : 'white';
    this.applyAs(opp, { type: 'opening-roll', player: opp, die: this.dieFor() });
  }
  roll(): void {
    this.act({ type: 'roll', player: this.seat, dice: [this.dieFor(), this.dieFor()] });
  }
  /** Test helper: roll for whoever is on roll. */
  rollFor(player: Player, dice?: [1 | 2 | 3 | 4 | 5 | 6, 1 | 2 | 3 | 4 | 5 | 6]): void {
    this.applyAs(player, { type: 'roll', player, dice: dice ?? [this.dieFor(), this.dieFor()] });
  }
  double(): void {
    this.act({ type: 'double', player: this.seat });
  }
  take(): void {
    this.act({ type: 'take', player: this.seat });
  }
  drop(): void {
    this.act({ type: 'drop', player: this.seat });
  }
  offerResign(stakes: ResultKind): void {
    this.act({ type: 'offer-resign', player: this.seat, stakes });
  }
  acceptResign(): void {
    this.act({ type: 'accept-resign', player: this.seat });
  }
  declineResign(): void {
    this.act({ type: 'decline-resign', player: this.seat });
  }
  sendChat(text: string): void {
    this.set({ chat: [...this.state.chat, { seat: this.seat, text, at: this.seq }] });
  }

  // ---- free board (the engine validates: blocked points, empty sources, cube values) ----
  freeRoll(): void {
    this.act({ type: 'free-roll', player: this.seat, dice: [this.dieFor(), this.dieFor()] });
  }
  freeMove(checker: Player, from: RelPoint, to: RelPoint): void {
    this.act({ type: 'free-move', player: this.seat, checker, from, to });
  }
  setCube(value: number, owner: CubeOwner): void {
    this.act({ type: 'free-cube', player: this.seat, value, owner });
  }
  resetBoard(): void {
    this.act({ type: 'free-reset', player: this.seat });
  }
  recordResult(winner: Player, kind: ResultKind): void {
    this.act({ type: 'free-result', player: this.seat, winner, kind });
  }

  // ---- draft ----
  private moving(): { dice: [1 | 2 | 3 | 4 | 5 | 6, 1 | 2 | 3 | 4 | 5 | 6] } | null {
    const game = this.state.snapshot?.match.game;
    if (!game || game.phase.kind !== 'moving' || game.phase.player !== this.seat) return null;
    return { dice: game.phase.dice };
  }

  stage(moves: SubMove | SubMove[]): void {
    const moving = this.moving();
    if (!moving) throw new RuleError('not-your-turn', 'not moving');
    const list = Array.isArray(moves) ? moves : [moves];
    let played = this.state.draft.played;
    const start = this.board();
    for (const m of list) {
      const opts = turnOptions(start, this.seat, moving.dice, played);
      const ok = opts.next.find((n) => n.from === m.from && n.to === m.to && n.die === m.die);
      if (!ok) throw new RuleError('illegal-move', `illegal sub-move ${m.from}/${m.to}`);
      played = [...played, ok];
    }
    this.setDraft(played, start, moving.dice);
  }

  private setDraft(
    played: SubMove[],
    start: Board,
    dice: [1 | 2 | 3 | 4 | 5 | 6, 1 | 2 | 3 | 4 | 5 | 6],
  ): void {
    const opts = turnOptions(start, this.seat, dice, played);
    const board = applyPlay(start, this.seat, played);
    this.set({ draft: { played, board, ...opts } });
  }

  unstage(): void {
    const moving = this.moving();
    if (!moving) return;
    this.setDraft(this.state.draft.played.slice(0, -1), this.board(), moving.dice);
  }

  clearDraft(): void {
    const moving = this.moving();
    if (!moving) return;
    this.setDraft([], this.board(), moving.dice);
  }

  commit(): void {
    if (!this.state.draft.complete) throw new RuleError('incomplete', 'the play is not complete');
    this.act({ type: 'play', player: this.seat, play: this.state.draft.played });
  }

  destinations(from: RelPoint): Destination[] {
    const moving = this.moving();
    if (!moving) return [];
    return destinationsFrom(this.board(), this.seat, moving.dice, this.state.draft.played, from);
  }

  close(): void {
    this.set({ status: 'disconnected' });
  }
}

export function createFakeClient(opts?: FakeClientOptions): FakeClient {
  return new FakeClient(opts);
}
