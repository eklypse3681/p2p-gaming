import type { CubeOwner, Player } from '@bgf/engine';
import type { BoardLocation, HomeSide } from './contract';
import { toAbs, toRel } from './contract';

/**
 * Pure board layout in a fixed 1500x1000 viewBox. All numbers are in viewBox units.
 *
 * The canonical layout has the viewing player's home board on the RIGHT (`homeSide: 'right'`):
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ frame  13 14 15 16 17 18 │bar│ 19 20 21 22 23 24 │ │ tray  │  (perspective player's numbers)
 *   │        outer felt        │   │   home felt       │ │       │
 *   │        12 11 10  9  8  7 │   │  6  5  4  3  2  1 │ │       │
 *   └────────────────────────────────────────────────────────────┘
 *
 * `homeSide: 'left'` (the app default) is the exact horizontal mirror: tray on the left, 1-point
 * bottom-left, 12 bottom-right, 13 top-right, 24 top-left. Every function that produces or
 * consumes an x coordinate takes `homeSide`; the constants below are always canonical
 * (home-right) values — use `boardLayout(homeSide)` for the rectangles actually drawn.
 * Mirroring is done on coordinates, never with an SVG transform, so text is never flipped.
 */

export const MIN_BOARD_WIDTH = 1500;
export const MIN_BOARD_HEIGHT = 1000;
/** Tallest a board may grow in a tall space: longer points, more checkers before stacks overlap. */
export const MAX_BOARD_HEIGHT = 1250;
/** Widest a board may stretch: points 1.5x as wide, still plainly a backgammon board. */
export const MAX_BOARD_WIDTH = 2100;

export interface XRect {
  x: number;
  width: number;
}

export interface BoardLayout {
  /** Felt holding the viewing player's 7..12 (bottom) and 13..18 (top). */
  outerFelt: XRect;
  /** Felt holding the viewing player's home board 1..6 (bottom) and 19..24 (top). */
  homeFelt: XRect;
  bar: XRect;
  divider: XRect;
  tray: XRect;
  /** Horizontal extent of the playing surface (outer felt edge .. tray edge). */
  minX: number;
  maxX: number;
}

export interface PointSlot {
  /** Centre x of the point column. */
  x: number;
  /** y of the triangle base (felt edge). */
  yBase: number;
  /** Direction the triangle points (and the stack grows). */
  direction: 'up' | 'down';
  /** Visual column 0..11, left to right across the whole board (depends on `homeSide`). */
  column: number;
  row: Row;
  /** Number printed on the frame for this point (perspective player's numbering). */
  display: number;
  abs: number;
}

export interface CheckerPosition {
  cx: number;
  cy: number;
  scale: number;
  /** Discs sit on points/bar; borne-off checkers are drawn as thin chips in the tray. */
  shape: 'disc' | 'chip';
}

export interface CubePosition {
  x: number;
  y: number;
  size: number;
  /** Which player the cube "faces" (drawn upright for them). */
  facing: Player | null;
}

export type Row = 'top' | 'bottom';

/**
 * The layout for a board `width` viewBox units wide (height is always 1000). The classic board is
 * 1500 wide (3:2); a wider one, for a wide space such as a landscape phone, widens the points and
 * keeps the frame, bar, tray, checkers and dice the same size.
 */
export function createGeometry(width: number = MIN_BOARD_WIDTH, height: number = MIN_BOARD_HEIGHT) {
  const VIEWBOX = { width, height } as const;
  // Vertical layout: the felt runs frame to frame, split at the middle; points take most of it.
  const FELT_TOP = 58;
  const FELT_BOTTOM = height - 58;
  const MID_Y = height / 2;
  const halfFelt = MID_Y - FELT_TOP;
  const FRAME = 58;
  const POINT_HEIGHT = Math.round(halfFelt * 0.86);
  // Extra width goes to the points, and the checkers grow with them (up to a cap). Bigger
  // checkers mean fewer fit in a column before a stack has to overlap, so the visible stack
  // shrinks to what the half-board's height holds; the bar widens to keep fitting them.
  const roomyPoint = 96 + (width - MIN_BOARD_WIDTH) / 12;
  const CHECKER_RADIUS = Math.min(Math.round(roomyPoint * 0.4375), 52);
  const MAX_VISIBLE_STACK = Math.max(3, Math.floor(halfFelt / (CHECKER_RADIUS * 2)));
  const barWidth = Math.max(100, Math.ceil(CHECKER_RADIUS * 2 * 0.92 + 16));
  // Frame, bar, divider, tray and the right-hand frame take the rest; 12 points share it.
  const POINT_WIDTH = (width - FRAME - barWidth - 20 - 110 - 60) / 12;
  const LEFT_FELT = { x: FRAME, width: POINT_WIDTH * 6 } as const;
  const BAR = { x: LEFT_FELT.x + LEFT_FELT.width, width: barWidth } as const;
  const RIGHT_FELT = { x: BAR.x + BAR.width, width: POINT_WIDTH * 6 } as const;
  const DIVIDER = { x: RIGHT_FELT.x + RIGHT_FELT.width, width: 20 } as const;
  const TRAY = { x: DIVIDER.x + DIVIDER.width, width: 110 } as const;
  const CHIP = { width: 84, height: 14, spacing: 18 } as const;
  const DIE_SIZE = 76;
  const CUBE_SIZE = 72;
  const LABEL_TOP_Y = 34;
  const LABEL_BOTTOM_Y = height - 22;

  /** Mirror an x coordinate for the left-handed layout. */
  function mirrorX(x: number, homeSide: HomeSide = 'right'): number {
    return homeSide === 'left' ? VIEWBOX.width - x : x;
  }

  /** Mirror a horizontal span for the left-handed layout. */
  function mirrorRect<T extends XRect>(rect: T, homeSide: HomeSide = 'right'): T {
    return homeSide === 'left' ? { ...rect, x: VIEWBOX.width - rect.x - rect.width } : rect;
  }

  /** The rectangles to draw for a given home side. */
  function boardLayout(homeSide: HomeSide = 'right'): BoardLayout {
    const outerFelt = mirrorRect(LEFT_FELT, homeSide);
    const homeFelt = mirrorRect(RIGHT_FELT, homeSide);
    const bar = mirrorRect(BAR, homeSide);
    const divider = mirrorRect(DIVIDER, homeSide);
    const tray = mirrorRect(TRAY, homeSide);
    const minX = Math.min(outerFelt.x, tray.x);
    const maxX = Math.max(outerFelt.x + outerFelt.width, tray.x + tray.width);
    return { outerFelt, homeFelt, bar, divider, tray, minX, maxX };
  }

  function opponentOf(p: Player): Player {
    return p === 'white' ? 'black' : 'white';
  }

  /** Canonical (home-right) column 0..11, left to right, of a display number (1..24). */
  function displayToColumn(display: number): number {
    return display <= 12 ? 12 - display : display - 13;
  }

  /** Centre x of a visual column 0..11 for the given home side. */
  function columnX(column: number, homeSide: HomeSide = 'right'): number {
    const canonical = homeSide === 'left' ? 11 - column : column;
    const x =
      canonical < 6
        ? LEFT_FELT.x + canonical * POINT_WIDTH + POINT_WIDTH / 2
        : RIGHT_FELT.x + (canonical - 6) * POINT_WIDTH + POINT_WIDTH / 2;
    return mirrorX(x, homeSide);
  }

  function pointSlot(
    perspective: Player,
    absPoint: number,
    homeSide: HomeSide = 'right',
  ): PointSlot {
    if (absPoint < 1 || absPoint > 24) throw new RangeError(`abs point out of range: ${absPoint}`);
    const display = toRel(perspective, absPoint);
    const row: Row = display <= 12 ? 'bottom' : 'top';
    const canonical = displayToColumn(display);
    const column = homeSide === 'left' ? 11 - canonical : canonical;
    return {
      x: columnX(column, homeSide),
      yBase: row === 'bottom' ? FELT_BOTTOM : FELT_TOP,
      direction: row === 'bottom' ? 'up' : 'down',
      column,
      row,
      display,
      abs: absPoint,
    };
  }

  /** Absolute point for a (row, visual column) pair under a perspective; inverse of `pointSlot`. */
  function pointAt(
    perspective: Player,
    row: Row,
    column: number,
    homeSide: HomeSide = 'right',
  ): number {
    const canonical = homeSide === 'left' ? 11 - column : column;
    const display = row === 'bottom' ? 12 - canonical : canonical + 13;
    return toAbs(perspective, display);
  }

  /** Vertical distance between checker centres in a stack of `stackSize`. */
  function stackSpacing(stackSize: number): number {
    if (stackSize <= MAX_VISIBLE_STACK) return CHECKER_RADIUS * 2;
    return (CHECKER_RADIUS * 2 * (MAX_VISIBLE_STACK - 1)) / (stackSize - 1);
  }

  /** Which half of the bar / tray a player's checkers occupy under a perspective. */
  function halfFor(player: Player, perspective: Player, region: 'bar' | 'off'): Row {
    // Perspective player's bar checkers sit in the top half (they re-enter top-right);
    // their borne-off checkers sit in the bottom half of the tray (next to their home board).
    if (region === 'bar') return player === perspective ? 'top' : 'bottom';
    return player === perspective ? 'bottom' : 'top';
  }

  function barX(homeSide: HomeSide = 'right'): number {
    return mirrorX(BAR.x + BAR.width / 2, homeSide);
  }

  function trayX(homeSide: HomeSide = 'right'): number {
    return mirrorX(TRAY.x + TRAY.width / 2, homeSide);
  }

  const BAR_STACK_GAP = 70; // room left around the centre for the cube

  function checkerPosition(
    location: BoardLocation,
    index: number,
    stackSize: number,
    perspective: Player,
    homeSide: HomeSide = 'right',
  ): CheckerPosition {
    if (location.kind === 'point') {
      const slot = pointSlot(perspective, location.point, homeSide);
      const spacing = stackSpacing(stackSize);
      const offset = CHECKER_RADIUS + index * spacing;
      return {
        cx: slot.x,
        cy: slot.direction === 'up' ? slot.yBase - offset : slot.yBase + offset,
        scale: 1,
        shape: 'disc',
      };
    }
    if (location.kind === 'bar') {
      const half = halfFor(location.player, perspective, 'bar');
      const spacing = stackSpacing(Math.max(stackSize, 1));
      const offset =
        BAR_STACK_GAP + CHECKER_RADIUS + index * Math.min(spacing, CHECKER_RADIUS * 1.6);
      return {
        cx: barX(homeSide),
        cy: half === 'top' ? MID_Y - offset : MID_Y + offset,
        scale: 0.92,
        shape: 'disc',
      };
    }
    const half = halfFor(location.player, perspective, 'off');
    const offset = 10 + CHIP.height / 2 + index * CHIP.spacing;
    return {
      cx: trayX(homeSide),
      cy: half === 'bottom' ? FELT_BOTTOM - offset : FELT_TOP + offset,
      scale: 1,
      shape: 'chip',
    };
  }

  /** Centre of a location (used for keyboard focus rings and drop previews). */
  function locationCenter(
    location: BoardLocation,
    perspective: Player,
    homeSide: HomeSide = 'right',
  ): { x: number; y: number } {
    if (location.kind === 'point') {
      const slot = pointSlot(perspective, location.point, homeSide);
      const y =
        slot.direction === 'up' ? slot.yBase - POINT_HEIGHT / 2 : slot.yBase + POINT_HEIGHT / 2;
      return { x: slot.x, y };
    }
    if (location.kind === 'bar') {
      const half = halfFor(location.player, perspective, 'bar');
      return { x: barX(homeSide), y: half === 'top' ? MID_Y - 200 : MID_Y + 200 };
    }
    const half = halfFor(location.player, perspective, 'off');
    return { x: trayX(homeSide), y: half === 'bottom' ? FELT_BOTTOM - 180 : FELT_TOP + 180 };
  }

  /** Where a player's dice are drawn: their own (home) side of the board, vertically centred. */
  function dicePositions(
    player: Player,
    perspective: Player,
    count: number,
    homeSide: HomeSide = 'right',
  ): Array<{ x: number; y: number; size: number }> {
    const felt = player === perspective ? RIGHT_FELT : LEFT_FELT;
    const cx = mirrorX(felt.x + felt.width / 2, homeSide);
    const size = count > 2 ? DIE_SIZE * 0.78 : DIE_SIZE;
    const gap = count > 2 ? size + 14 : size + 28;
    const start = cx - ((count - 1) * gap) / 2;
    return Array.from({ length: count }, (_, i) => ({ x: start + i * gap, y: MID_Y, size }));
  }

  function openingDiePosition(
    player: Player,
    perspective: Player,
    homeSide: HomeSide = 'right',
  ): { x: number; y: number; size: number } {
    const felt = player === perspective ? RIGHT_FELT : LEFT_FELT;
    return { x: mirrorX(felt.x + felt.width / 2, homeSide), y: MID_Y, size: DIE_SIZE };
  }

  function cubePosition(
    cube: { owner: CubeOwner; offeredBy?: Player },
    perspective: Player,
    homeSide: HomeSide = 'right',
  ): CubePosition {
    const x = barX(homeSide);
    if (cube.offeredBy) {
      return { x, y: MID_Y, size: CUBE_SIZE * 1.15, facing: opponentOf(cube.offeredBy) };
    }
    if (cube.owner === 'center') return { x, y: MID_Y, size: CUBE_SIZE, facing: null };
    const half: Row = cube.owner === perspective ? 'bottom' : 'top';
    return {
      x,
      y: half === 'bottom' ? FELT_BOTTOM - CUBE_SIZE / 2 - 14 : FELT_TOP + CUBE_SIZE / 2 + 14,
      size: CUBE_SIZE,
      facing: cube.owner,
    };
  }

  /** Triangle path for a point. */
  function pointPath(slot: PointSlot, inset = 0): string {
    const half = POINT_WIDTH / 2 - inset;
    const h = POINT_HEIGHT - inset * 2;
    const apex = slot.direction === 'up' ? slot.yBase - inset - h : slot.yBase + inset + h;
    const base = slot.direction === 'up' ? slot.yBase - inset : slot.yBase + inset;
    return `M ${slot.x - half} ${base} L ${slot.x + half} ${base} L ${slot.x} ${apex} Z`;
  }

  /** Hit area (the whole column half) for a point. */
  function pointHitRect(slot: PointSlot): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const height = MID_Y - FELT_TOP;
    return {
      x: slot.x - POINT_WIDTH / 2,
      y: slot.row === 'top' ? FELT_TOP : MID_Y,
      width: POINT_WIDTH,
      height,
    };
  }

  /** Which board location (if any) sits under viewBox coordinates. */
  function hitTest(
    vx: number,
    y: number,
    perspective: Player,
    homeSide: HomeSide = 'right',
  ): BoardLocation | null {
    if (y < FELT_TOP || y > FELT_BOTTOM) return null;
    // Mirroring is an isometry, so hit-test in canonical (home-right) coordinates.
    const x = mirrorX(vx, homeSide);
    const row: Row = y < MID_Y ? 'top' : 'bottom';
    const inFelt = (felt: { x: number; width: number }, base: number): BoardLocation | null => {
      if (x < felt.x || x >= felt.x + felt.width) return null;
      const column = base + Math.floor((x - felt.x) / POINT_WIDTH);
      return { kind: 'point', point: pointAt(perspective, row, column, 'right') };
    };
    const left = inFelt(LEFT_FELT, 0);
    if (left) return left;
    const right = inFelt(RIGHT_FELT, 6);
    if (right) return right;
    if (x >= BAR.x && x < BAR.x + BAR.width) {
      return { kind: 'bar', player: row === 'top' ? perspective : opponentOf(perspective) };
    }
    if (x >= DIVIDER.x && x < TRAY.x + TRAY.width) {
      return { kind: 'off', player: row === 'bottom' ? perspective : opponentOf(perspective) };
    }
    return null;
  }

  const DROP_TOLERANCE = 90;

  /**
   * Finger-friendly hit test: like `hitTest`, but a pointer that lands just outside the playing
   * surface (on the frame, or past the tray) snaps to the nearest location within `tolerance`
   * viewBox units. Columns are contiguous, so a pointer between two points always resolves to
   * the nearer one.
   */
  function nearestLocation(
    x: number,
    y: number,
    perspective: Player,
    homeSide: HomeSide = 'right',
    tolerance = DROP_TOLERANCE,
  ): BoardLocation | null {
    const direct = hitTest(x, y, perspective, homeSide);
    if (direct) return direct;
    // Clamp in canonical (home-right) space so the half-open edges land inside the surface.
    const canonicalX = mirrorX(x, homeSide);
    const cx = Math.min(Math.max(canonicalX, LEFT_FELT.x), TRAY.x + TRAY.width - 0.001);
    const cy = Math.min(Math.max(y, FELT_TOP), FELT_BOTTOM - 0.001);
    if (Math.hypot(cx - canonicalX, cy - y) > tolerance) return null;
    return hitTest(mirrorX(cx, homeSide), cy, perspective, homeSide);
  }

  /** Map client (pixel) coordinates to viewBox units for an `xMidYMid meet` svg. */
  function clientToViewBox(
    rect: { left: number; top: number; width: number; height: number },
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null {
    if (!rect.width || !rect.height) return null;
    const scale = Math.min(rect.width / VIEWBOX.width, rect.height / VIEWBOX.height);
    const offsetX = (rect.width - VIEWBOX.width * scale) / 2;
    const offsetY = (rect.height - VIEWBOX.height * scale) / 2;
    return {
      x: (clientX - rect.left - offsetX) / scale,
      y: (clientY - rect.top - offsetY) / scale,
    };
  }

  function allPointSlots(perspective: Player, homeSide: HomeSide = 'right'): PointSlot[] {
    return Array.from({ length: 24 }, (_, i) => pointSlot(perspective, i + 1, homeSide));
  }

  return {
    FRAME,
    POINT_HEIGHT,
    CHECKER_RADIUS,
    MAX_VISIBLE_STACK,
    FELT_TOP,
    FELT_BOTTOM,
    MID_Y,
    CHIP,
    DIE_SIZE,
    CUBE_SIZE,
    LABEL_TOP_Y,
    LABEL_BOTTOM_Y,
    mirrorX,
    mirrorRect,
    boardLayout,
    opponentOf,
    displayToColumn,
    columnX,
    pointSlot,
    pointAt,
    stackSpacing,
    halfFor,
    barX,
    trayX,
    checkerPosition,
    locationCenter,
    dicePositions,
    openingDiePosition,
    cubePosition,
    pointPath,
    pointHitRect,
    hitTest,
    DROP_TOLERANCE,
    nearestLocation,
    clientToViewBox,
    allPointSlots,
    VIEWBOX,
    POINT_WIDTH,
    LEFT_FELT,
    BAR,
    RIGHT_FELT,
    DIVIDER,
    TRAY,
  };
}

export type Geometry = ReturnType<typeof createGeometry>;

/** The classic 3:2 board. */
export const DEFAULT_GEOMETRY: Geometry = createGeometry();

export const {
  FRAME,
  POINT_HEIGHT,
  CHECKER_RADIUS,
  MAX_VISIBLE_STACK,
  FELT_TOP,
  FELT_BOTTOM,
  MID_Y,
  CHIP,
  DIE_SIZE,
  CUBE_SIZE,
  LABEL_TOP_Y,
  LABEL_BOTTOM_Y,
  mirrorX,
  mirrorRect,
  boardLayout,
  opponentOf,
  displayToColumn,
  columnX,
  pointSlot,
  pointAt,
  stackSpacing,
  halfFor,
  barX,
  trayX,
  checkerPosition,
  locationCenter,
  dicePositions,
  openingDiePosition,
  cubePosition,
  pointPath,
  pointHitRect,
  hitTest,
  DROP_TOLERANCE,
  nearestLocation,
  clientToViewBox,
  allPointSlots,
  VIEWBOX,
  POINT_WIDTH,
  LEFT_FELT,
  BAR,
  RIGHT_FELT,
  DIVIDER,
  TRAY,
} = DEFAULT_GEOMETRY;

/**
 * The board size (viewBox units) that fills a space of the given pixel size: the classic 3:2 board
 * stretched wider or taller to the space's shape, within the allowed range. Steps of 20 units so
 * small resizes do not lay the board out again for nothing.
 */
export function boardSizeFor(
  spaceWidth: number,
  spaceHeight: number,
): { width: number; height: number } {
  if (!spaceWidth || !spaceHeight) return { width: MIN_BOARD_WIDTH, height: MIN_BOARD_HEIGHT };
  const aspect = spaceWidth / spaceHeight;
  const step = (n: number) => Math.floor(n / 20) * 20;
  if (aspect >= MIN_BOARD_WIDTH / MIN_BOARD_HEIGHT) {
    return {
      width: step(Math.min(MAX_BOARD_WIDTH, MIN_BOARD_HEIGHT * aspect)),
      height: MIN_BOARD_HEIGHT,
    };
  }
  return {
    width: MIN_BOARD_WIDTH,
    height: step(Math.min(MAX_BOARD_HEIGHT, MIN_BOARD_WIDTH / aspect)),
  };
}
