/**
 * CONTRACT — theme description consumed by renderers and the app chrome.
 * A theme is pure data; renderers turn it into CSS custom properties / SVG fills.
 * Future 3D renderers map the same tokens onto materials. Piece sets and board sets are
 * separate so a user can mix "walnut board" with "marble pieces".
 */

export interface CheckerStyle {
  /** Base fill colour. */
  fill: string;
  /** Rim / edge colour. */
  edge: string;
  /** Highlight colour for the specular dot. */
  sheen: string;
  /** Text colour used for the stack-count badge. */
  label: string;
}

export interface PieceSet {
  id: string;
  name: string;
  white: CheckerStyle;
  black: CheckerStyle;
  /** Reserved for image/3D asset references. */
  asset?: string;
}

export interface BoardSet {
  id: string;
  name: string;
  frame: string;
  frameEdge: string;
  felt: string;
  /** Alternating point colours (index 0 = the point at each player's 1-point / odd points). */
  pointA: string;
  pointB: string;
  pointEdge: string;
  bar: string;
  tray: string;
  /** Point number label colour. */
  label: string;
  highlightSource: string;
  highlightTarget: string;
  highlightSelected: string;
  diceFace: string;
  dicePip: string;
  cubeFace: string;
  cubeText: string;
  asset?: string;
}

export interface UiPalette {
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  danger: string;
  success: string;
  /** Font stack for chrome. */
  font: string;
  /** Font stack for numerals (dice, score, pips). */
  fontMono: string;
}

export interface Theme {
  id: string;
  name: string;
  mode: 'light' | 'dark';
  ui: UiPalette;
  board: BoardSet;
  pieces: PieceSet;
}

/** Renderer identifiers. Only 'svg2d' exists today; '3d' is reserved. */
export type RendererId = 'svg2d' | '3d';
