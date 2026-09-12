import type { Action, MatchConfig, Player } from '@bgf/engine';
import { applyAction, newMatch, turnOptions } from '@bgf/engine';
import type { MatchSnapshot } from '@bgf/protocol';
import type { ClientState, TurnDraft } from '@bgf/client';

export interface MakeStateOptions {
  seat?: Player | null;
  actions?: Action[];
  config?: Partial<MatchConfig>;
  names?: Partial<Record<Player, string>>;
  /** Omit the black player (waiting for opponent). */
  noOpponent?: boolean;
  status?: ClientState['status'];
  presence?: Partial<Record<Player, boolean>>;
  overrides?: Partial<ClientState>;
}

/** Build a synthetic ClientState by running actions through the engine. */
export function makeState(opts: MakeStateOptions = {}): ClientState {
  const seat = opts.seat === undefined ? 'white' : opts.seat;
  let match = newMatch(opts.config ?? { length: 5 });
  const actions = opts.actions ?? [];
  for (const a of actions) match = applyAction(match, a);
  const snapshot: MatchSnapshot = {
    id: 'match-1',
    code: 'ABC234',
    seq: actions.length,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000 + actions.length * 1000,
    config: match.config,
    players: {
      white: { id: 'w-id', name: opts.names?.white ?? 'Alice', avatar: '🦊' },
      black: opts.noOpponent
        ? null
        : { id: 'b-id', name: opts.names?.black ?? 'Bob', avatar: '🐙' },
    },
    hostSeat: 'white',
    actions,
    match,
    chat: [],
  };
  const g = match.game;
  let draft: TurnDraft;
  if (g && g.phase.kind === 'moving' && g.phase.player === seat) {
    const t = turnOptions(g.board, g.phase.player, g.phase.dice, []);
    draft = {
      played: [],
      board: g.board,
      next: t.next,
      remaining: t.remaining,
      complete: t.complete,
      maxMoves: t.maxMoves,
    };
  } else {
    draft = {
      played: [],
      board:
        g?.board ??
        match.game?.board ??
        newMatch().game?.board ??
        snapshot.match.game?.board ??
        emptyBoard(),
      next: [],
      remaining: [],
      complete: false,
      maxMoves: 0,
    };
  }
  return {
    status: opts.status ?? 'joined',
    rejectReason: null,
    seat,
    snapshot,
    lastAction: actions.length
      ? { action: actions[actions.length - 1]!, by: null, seq: actions.length }
      : null,
    opponentPreview: null,
    presence: { white: true, black: !opts.noOpponent, ...opts.presence },
    chat: [],
    latencyMs: 42,
    error: null,
    draft,
    ...opts.overrides,
  };
}

function emptyBoard() {
  return {
    points: new Array<number>(24).fill(0),
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
  };
}

/** Common action prefixes. */
export const A = {
  start: { type: 'start-game' } as const,
  openW: (die: 1 | 2 | 3 | 4 | 5 | 6) => ({ type: 'opening-roll', player: 'white', die }) as const,
  openB: (die: 1 | 2 | 3 | 4 | 5 | 6) => ({ type: 'opening-roll', player: 'black', die }) as const,
};

/** Game started, white won the opening 3-1 and is moving. */
export function movingWhiteActions(): Action[] {
  return [A.start, A.openW(3), A.openB(1)];
}

/** White played 3-1 (8/5 6/5); black to roll. */
export function blackToRollActions(): Action[] {
  return [
    ...movingWhiteActions(),
    {
      type: 'play',
      player: 'white',
      play: [
        { from: 8, to: 5, die: 3, hit: false },
        { from: 6, to: 5, die: 1, hit: false },
      ],
    },
  ];
}

/** A free-board match with the first game started (phase 'free'). */
export function freeBoardState(opts: MakeStateOptions = {}): ClientState {
  return makeState({
    ...opts,
    config: { length: 5, rules: 'free', ...(opts.config ?? {}) },
    actions: opts.actions ?? [A.start],
  });
}
