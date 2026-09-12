import type { CubeOwner, Player } from '@bgf/engine';
import type { Theme } from '../themes/theme';

/**
 * CONTRACT — what any board renderer (2D SVG today, 3D later) receives and emits.
 * The renderer is a pure presentation component: it never talks to the client or engine.
 * The container (`GameScreen`) builds the view model from client state and answers events.
 *
 * Locations are expressed in ABSOLUTE points (1..24 = White's numbering, see engine docs).
 * `perspective` tells the renderer which player sits at the bottom (their home board is on the
 * bottom row and their relative numbering is printed on the frame). `homeSide` says which side
 * that home board is on:
 *
 *   'left'  (default)  bottom row reads 1..12 left→right, top row reads 24..13 left→right;
 *                      tray on the left; checkers travel 24 (top-left) → 13 (top-right) →
 *                      12 (bottom-right) → 1 (bottom-left).
 *   'right'            the mirror image: 1 bottom-right, 12 bottom-left, 13 top-left,
 *                      24 top-right; tray on the right.
 */

/** Which side of the board the viewing player's home board (points 1..6) sits on. */
import type { HomeSide } from '@bgf/protocol';
export type { HomeSide };
export { DEFAULT_HOME_SIDE } from '@bgf/protocol';

export type BoardLocation =
  | { kind: 'point'; point: number } // absolute 1..24
  | { kind: 'bar'; player: Player }
  | { kind: 'off'; player: Player };

export function locationKey(l: BoardLocation): string {
  return l.kind === 'point' ? `p${l.point}` : `${l.kind}-${l.player}`;
}

export interface CheckerVM {
  /** Stable identity across moves so the renderer can animate. */
  id: string;
  /** Sent to the bar by the last action (renderer may animate an arc). */
  hit?: boolean;
  player: Player;
  location: BoardLocation;
  /** 0-based position in its stack (0 = closest to the frame edge). */
  index: number;
  /** Size of the stack this checker is in (for overflow rendering). */
  stackSize: number;
  /** Rendered translucent: opponent's provisional preview or the local draft's moved checker. */
  ghost?: boolean;
  /** Just moved (renderer may pulse it). */
  recent?: boolean;
}

export interface DiceVM {
  player: Player;
  values: [number, number];
  /** Per die (and per repeat for doubles): true once consumed by the draft/turn. */
  used: boolean[];
  /** Renderer may play a roll animation when this token changes. */
  rollToken: number;
}

export interface OpeningDiceVM {
  white?: number;
  black?: number;
  ties: number;
}

export interface CubeVM {
  value: number;
  owner: CubeOwner;
  /** Set while a double is pending: cube drawn in the middle, facing the responder. */
  offeredBy?: Player;
}

export interface HighlightsVM {
  /** Locations the local player may pick a checker up from. */
  sources: BoardLocation[];
  /** Currently selected source, if any. */
  selected: BoardLocation | null;
  /** Legal drop targets for the selected source (or for the hovered/dragged checker). */
  targets: BoardLocation[];
  /** Target that would be reached with both dice (drawn with a secondary style). */
  combinedTargets: BoardLocation[];
  /**
   * Free board: sources stay interactive (draggable) but no guidance rings are drawn — a real
   * board does not tell you where you may go. The picked-up checker and the live drop indicator
   * while dragging are still shown.
   */
  quiet?: boolean;
  /** Free board: points the selected checker may not be dropped on (2+ opposing checkers). */
  blocked?: BoardLocation[];
  /** Location currently under the pointer while dragging (renderer emphasises it if a target). */
  hovered?: BoardLocation | null;
  /** A location the player just tried to use illegally (renderer flashes it briefly). */
  invalid?: { location: BoardLocation; at: number } | null;
}

/** Transient UI interaction state, owned by `useBoardInteraction`, read by `useBoardViewModel`. */
export interface BoardInteraction {
  selected: BoardLocation | null;
  hovered: BoardLocation | null;
  /** Source of an in-progress drag. */
  dragging: BoardLocation | null;
  /** Last illegal interaction (for a brief shake/flash). */
  invalid: { location: BoardLocation; at: number; message: string } | null;
  /**
   * Free board: a move sent to the server that has not been confirmed yet. The view model
   * shows it optimistically; it is dropped when the snapshot advances or the server errors.
   */
  pendingFree?: PendingFreeMove | null;
}

export interface PendingFreeMove {
  checker: Player;
  from: BoardLocation;
  to: BoardLocation;
  /** Snapshot seq the move was sent against. */
  seq: number;
  at: number;
}

export const EMPTY_INTERACTION: BoardInteraction = {
  selected: null,
  hovered: null,
  dragging: null,
  invalid: null,
  pendingFree: null,
};

export function sameLocation(a: BoardLocation | null, b: BoardLocation | null): boolean {
  if (!a || !b) return a === b;
  return locationKey(a) === locationKey(b);
}

export interface BoardViewModel {
  perspective: Player;
  /** Side of the viewing player's home board; see the header comment. */
  homeSide: HomeSide;
  checkers: CheckerVM[];
  dice: DiceVM | null;
  openingDice: OpeningDiceVM | null;
  cube: CubeVM;
  highlights: HighlightsVM;
  /** Whether the local player is allowed to interact right now. */
  interactive: boolean;
  /** Pip counts for the HUD-in-board overlay (renderer may show them on the trays). */
  pips: Record<Player, number>;
  /** Player names for labels on the trays/bars (optional). */
  names: Record<Player, string>;
}

export interface BoardRendererProps {
  model: BoardViewModel;
  theme: Theme;
  /** Player tapped/clicked a location (a checker stack, a point, the bar, or a tray). */
  onSelect?: (location: BoardLocation) => void;
  /** Player dragged a checker from one location and released over another. */
  onDrop?: (from: BoardLocation, to: BoardLocation) => void;
  /** Hover feedback: renderer reports the location under the pointer (null when leaving). */
  onHover?: (location: BoardLocation | null) => void;
  /** Double-click / double-tap on a checker: containers use this for "auto-play" of that checker. */
  onActivate?: (location: BoardLocation) => void;
  /** A drag started from a location (the container may highlight targets). */
  onDragStart?: (from: BoardLocation) => void;
  /** A drag ended without a valid drop (released outside the board / cancelled). */
  onDragCancel?: () => void;
  /** Reduced motion preference; renderer must respect it. */
  reducedMotion?: boolean;
  /** Test hook: ids are stamped on elements as `data-testid`. */
  testIdPrefix?: string;
}

/** Player-relative point number to print for an absolute point given the viewing perspective. */
export function displayNumber(perspective: Player, absPoint: number): number {
  return perspective === 'white' ? absPoint : 25 - absPoint;
}

/** Convert an absolute point to the perspective player's relative point. */
export function toRel(player: Player, absPoint: number): number {
  return player === 'white' ? absPoint : 25 - absPoint;
}

/** Convert the perspective player's relative point to an absolute point. */
export function toAbs(player: Player, relPoint: number): number {
  return player === 'white' ? relPoint : 25 - relPoint;
}
