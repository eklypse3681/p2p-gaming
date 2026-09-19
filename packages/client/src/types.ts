import type {
  Action,
  Board,
  CubeOwner,
  Destination,
  Die,
  Play,
  Player,
  RelPoint,
  ResultKind,
  SubMove,
} from '@bgf/engine';
import type { ChatMessage, MatchSnapshot, PlayerProfile, RejectReason } from '@bgf/protocol';

/**
 * CONTRACT — consumed by the web UI, implemented by `GameClient`.
 * Keep this file additive: UI code is written against it in parallel.
 */

export type ConnectionStatus = 'connecting' | 'joined' | 'rejected' | 'disconnected';

/** Local, provisional construction of the current player's turn (before it is sent). */
export interface TurnDraft {
  /** Sub-moves staged so far, in player-relative coordinates. */
  played: SubMove[];
  /** Board after the staged sub-moves (equals the authoritative board when nothing is staged). */
  board: Board;
  /** Legal next sub-moves from the current draft position. */
  next: SubMove[];
  /** Dice not yet used by the draft. */
  remaining: Die[];
  /** True when the draft is a complete legal play and may be committed. */
  complete: boolean;
  /** Length of a maximal legal play this turn (0 = no legal move). */
  maxMoves: number;
  /** True after `commit()` until the server answers (the play is in flight). */
  pending?: boolean;
}

export interface ClientError {
  code: string;
  message: string;
  at: number;
}

export interface LastAction {
  action: Action;
  /** Seat that triggered it, when known. */
  by: Player | null;
  /** Snapshot seq after the action; strictly increasing, so the UI can detect new actions. */
  seq: number;
}

export interface ClientState {
  status: ConnectionStatus;
  rejectReason: RejectReason | null;
  /** Seat this client occupies; null until welcomed, and null for the dealer. */
  seat: Player | null;
  /** 'seat' once welcomed into a seat, 'dealer' when this device hosts as the non-playing dealer. */
  role?: 'seat' | 'dealer' | 'spectator';
  /** Dealer-hosted matches: the dealer's public profile and whether a dealer device is connected. */
  dealer?: { profile: PlayerProfile; connected: boolean } | null;
  /** Authoritative match snapshot from the server; null until welcomed. */
  snapshot: MatchSnapshot | null;
  lastAction: LastAction | null;
  /** Provisional sub-moves the opponent is currently building (null when none). */
  opponentPreview: Play | null;
  presence: Record<Player, boolean>;
  /** Readiness for the next game, by colour (table flow shared with every device). */
  ready?: Record<Player, boolean>;
  /** What an unattended table will do next (e.g. "next game" countdown), or null. */
  autopilot?: { reason: string; at: number } | null;
  chat: ChatMessage[];
  latencyMs: number | null;
  error: ClientError | null;
  draft: TurnDraft;
}

export interface GameClientApi {
  readonly profile: PlayerProfile;
  getState(): ClientState;
  /** `useSyncExternalStore`-compatible subscription; fires after every state change. */
  subscribe(listener: () => void): () => void;

  // ---- match commands (sent to the server; the server validates) ----
  startGame(): void;
  /** Table flow: I am (not) ready for the next game; an unattended table starts when both are. */
  ready(ready?: boolean): void;
  openingRoll(): void;
  roll(): void;
  double(): void;
  take(): void;
  drop(): void;
  offerResign(stakes: ResultKind): void;
  acceptResign(): void;
  declineResign(): void;
  sendChat(text: string): void;

  // ---- free-board mode (server rejects these in enforced mode) ----
  /** Roll the dice regardless of turn order. */
  freeRoll(): void;
  /** Move one checker of colour `checker`; `from`/`to` are relative to that colour (25 bar, 0 off). */
  freeMove(checker: Player, from: RelPoint, to: RelPoint): void;
  setCube(value: number, owner: CubeOwner): void;
  resetBoard(): void;
  /** Record who won the current game and by how much; ends the game and updates the score. */
  recordResult(winner: Player, kind: ResultKind): void;

  // ---- local turn drafting (validated with the engine before anything is sent) ----
  /** Stage one or more sub-moves. Throws RuleError if not legal from the current draft. */
  stage(moves: SubMove | SubMove[]): void;
  /** Remove the last staged sub-move. */
  unstage(): void;
  clearDraft(): void;
  /** Send the drafted play. Throws if the draft is not complete. */
  commit(): void;
  /** Destinations reachable from a player-relative point (1..24 or 25 = bar) in the current draft. */
  destinations(from: RelPoint): Destination[];

  close(): void;
}
