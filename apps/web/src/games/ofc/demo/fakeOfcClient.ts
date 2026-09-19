import type { TableClientState } from '@bgf/table';
import { ofcBot } from '@bgf/soak';
import type { TableSnapshot } from '@bgf/protocol';
import type { Action, Command, Rng, TableConfig, TableState, TableView } from '@bgf/ofc-engine';
import { applyAll, command, defaultConfig, init, seededRng, view } from '@bgf/ofc-engine';

export interface FakeOfcClientOptions {
  config?: Partial<TableConfig>;
  mySeat?: number;
  names?: string[];
  seed?: number;
  /** Delay between automatic opponent moves (0 = synchronous, for tests). */
  botDelayMs?: number;
  /** Bots act on their own after every change. */
  autoPlay?: boolean;
  /** Cards owed to the local seat in Fantasyland for the first hand (0 = a normal hand). */
  fantasylandForMe?: number;
}

/**
 * An in-memory "table" for the demo and tests: the engine plus a scripted rng, presenting the
 * same `TableClientState<TableView>` a real `TableClient` would, and playing the other seats
 * with a simple heuristic.
 */
export class FakeOfcClient {
  private state: TableState;
  private clientState: TableClientState<TableView>;
  private readonly listeners = new Set<() => void>();
  private readonly rng: Rng;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly mySeat: number;
  readonly names: string[];
  botDelayMs: number;
  autoPlay: boolean;

  constructor(opts: FakeOfcClientOptions = {}) {
    const config = defaultConfig({ seats: 3, ...opts.config });
    this.state = init(config);
    if (opts.fantasylandForMe) {
      const fl = this.state.fantasyland.slice();
      fl[opts.mySeat ?? 0] = opts.fantasylandForMe;
      this.state = { ...this.state, fantasyland: fl };
    }
    this.rng = seededRng(opts.seed ?? 7);
    this.mySeat = opts.mySeat ?? 0;
    this.names = opts.names ?? ['You', 'Ada', 'Grace'].slice(0, config.seats);
    this.botDelayMs = opts.botDelayMs ?? 450;
    this.autoPlay = opts.autoPlay ?? true;
    this.clientState = this.project(null, null);
  }

  getState(): TableClientState<TableView> {
    return this.clientState;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Full authoritative state (what the host would hold). */
  getTableState(): TableState {
    return this.state;
  }

  send = (cmd: Command): void => {
    this.apply(this.mySeat, cmd);
  };

  /** Apply a command as any seat (tests, bots). */
  apply(seat: number, cmd: Command): void {
    const actions = command(this.state, seat, cmd, this.rng, () => Date.now());
    this.state = applyAll(this.state, actions);
    this.seq += actions.length;
    this.clientState = this.project(actions[actions.length - 1] ?? null, seat);
    this.emit();
    if (this.autoPlay) this.scheduleBots();
  }

  setAutoPlay(on: boolean): void {
    this.autoPlay = on;
    if (on) this.scheduleBots();
  }

  /** Let every bot act until it is the local player's turn (or the hand ends). */
  playBots(): void {
    for (let guard = 0; guard < 60; guard++) {
      const seat = this.botToAct();
      if (seat === null) return;
      this.apply(seat, botPlacement(this.state, seat));
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private botToAct(): number | null {
    const hand = this.state.hand;
    if (!hand || hand.phase !== 'setting') return null;
    if (hand.toAct !== null && hand.toAct !== this.mySeat) return hand.toAct;
    const fl = hand.seats.findIndex(
      (s, i) => i !== this.mySeat && s.fantasyland && !s.done && s.pending.length > 0,
    );
    return fl >= 0 ? fl : null;
  }

  private scheduleBots(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.botToAct() === null) return;
    if (this.botDelayMs <= 0) {
      const seat = this.botToAct();
      if (seat !== null) this.apply(seat, botPlacement(this.state, seat));
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const seat = this.botToAct();
      if (seat !== null) this.apply(seat, botPlacement(this.state, seat));
    }, this.botDelayMs);
  }

  private project(action: Action | null, by: number | null): TableClientState<TableView> {
    const v = view(this.state, this.mySeat);
    const snapshot: TableSnapshot<TableView, Action, TableConfig> = {
      id: 'demo',
      code: 'DEMO',
      seq: this.seq,
      createdAt: 0,
      updatedAt: Date.now(),
      gameId: 'ofc',
      config: this.state.config,
      seats: this.names.map((name, i) => ({ id: `demo-${i}`, name })),
      hostSeat: 0,
      options: {},
      initialState: v,
      actions: [],
      state: v,
      chat: [],
      view: true,
    };
    return {
      status: 'joined',
      rejectReason: null,
      role: 'seat',
      dealer: null,
      seat: this.mySeat,
      snapshot,
      lastAction: action ? { action, by, seq: this.seq } : null,
      previews: {},
      presence: this.names.map(() => true),
      ready: this.names.map(() => false),
      autopilot: null,
      chat: [],
      latencyMs: 1,
      error: null,
    };
  }

  private emit(): void {
    for (const l of Array.from(this.listeners)) l();
  }
}

/**
 * The demo's stand-in opponents play with the soak bot, the same one that drives `pnpm soak`.
 * Throws when the seat cannot act (callers check `canPlace` first).
 */
export function botPlacement(state: TableState, seat: number): Command {
  const cmd = ofcBot(state, seat);
  if (!cmd) throw new Error(`seat ${seat} cannot place right now`);
  return cmd;
}
