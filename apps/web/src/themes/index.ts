import type { BoardSet, CheckerStyle, PieceSet, Theme } from './theme';
import { LOOKS } from './looks';
import type { Look } from './looks';
import { BOARD_SETS } from './boards';
import { PIECE_SETS } from './pieces';

export * from './theme';
export * from './looks';
export * from './boards';
export * from './pieces';

/** A named combination of look + board set + piece set. */
export interface ThemePreset {
  id: string;
  name: string;
  look: string;
  board: string;
  pieces: string;
}

export const PRESETS: ThemePreset[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    look: 'midnight',
    board: 'midnight-slate',
    pieces: 'pearl-obsidian',
  },
  {
    id: 'classic',
    name: 'Classic Walnut',
    look: 'warm-light',
    board: 'walnut-green',
    pieces: 'ivory-ebony',
  },
  { id: 'harbour', name: 'Harbour', look: 'slate', board: 'marine', pieces: 'sky-navy' },
  {
    id: 'cherry',
    name: 'Cherry',
    look: 'warm-light',
    board: 'cherry-burgundy',
    pieces: 'ruby-cream',
  },
  { id: 'carbon', name: 'Carbon', look: 'midnight', board: 'carbon', pieces: 'amber-slate' },
  {
    id: 'atelier',
    name: 'Atelier',
    look: 'paper',
    board: 'oak-sand',
    pieces: 'rose-gold-graphite',
  },
  { id: 'greenhouse', name: 'Greenhouse', look: 'slate', board: 'carbon', pieces: 'jade-charcoal' },
];

export const DEFAULT_PRESET = PRESETS[0]!;
export const DEFAULT_THEME_ID = DEFAULT_PRESET.id;

export interface ThemeParts {
  look: string;
  board: string;
  pieces: string;
}

export const DEFAULT_PARTS: ThemeParts = {
  look: DEFAULT_PRESET.look,
  board: DEFAULT_PRESET.board,
  pieces: DEFAULT_PRESET.pieces,
};

export function getLook(id: string | null | undefined): Look {
  return LOOKS.find((l) => l.id === id) ?? LOOKS.find((l) => l.id === DEFAULT_PARTS.look)!;
}
export function getBoardSet(id: string | null | undefined): BoardSet {
  return (
    BOARD_SETS.find((b) => b.id === id) ?? BOARD_SETS.find((b) => b.id === DEFAULT_PARTS.board)!
  );
}
export function getPieceSet(id: string | null | undefined): PieceSet {
  return (
    PIECE_SETS.find((p) => p.id === id) ?? PIECE_SETS.find((p) => p.id === DEFAULT_PARTS.pieces)!
  );
}

/** Preset whose parts match exactly, if any. */
export function presetFor(parts: ThemeParts): ThemePreset | undefined {
  return PRESETS.find(
    (p) => p.look === parts.look && p.board === parts.board && p.pieces === parts.pieces,
  );
}

/** Composed theme id: `look/board/pieces`. */
export function composedId(parts: ThemeParts): string {
  return `${parts.look}/${parts.board}/${parts.pieces}`;
}

/** Parse a theme id: a preset id, or a composed `look/board/pieces` id. Unknown → null. */
export function parseThemeId(id: string | null | undefined): ThemeParts | null {
  if (!id) return null;
  const preset = PRESETS.find((p) => p.id === id);
  if (preset) return { look: preset.look, board: preset.board, pieces: preset.pieces };
  const [look, board, pieces] = id.split('/');
  if (
    look &&
    board &&
    pieces &&
    LOOKS.some((l) => l.id === look) &&
    BOARD_SETS.some((b) => b.id === board) &&
    PIECE_SETS.some((p) => p.id === pieces)
  ) {
    return { look, board, pieces };
  }
  return null;
}

/**
 * Build a theme from a look, a board set and a piece set. Unknown ids fall back to the defaults.
 * When the combination is a named preset the theme carries the preset's id and name; otherwise
 * the id is `look/board/pieces`.
 */
export function composeTheme(parts: Partial<ThemeParts>): Theme {
  const look = getLook(parts.look);
  const board = getBoardSet(parts.board);
  const pieces = getPieceSet(parts.pieces);
  const resolved: ThemeParts = { look: look.id, board: board.id, pieces: pieces.id };
  const preset = presetFor(resolved);
  return {
    id: preset ? preset.id : composedId(resolved),
    name: preset ? preset.name : `${look.name} · ${board.name} · ${pieces.name}`,
    mode: look.mode,
    ui: look.ui,
    board,
    pieces,
  };
}

/** The named presets as full themes. */
export const THEMES: Theme[] = PRESETS.map((p) =>
  composeTheme({ look: p.look, board: p.board, pieces: p.pieces }),
);

/** Theme for a preset id or a composed id; unknown ids give the default preset. */
export function getTheme(id: string | null | undefined): Theme {
  const parts = parseThemeId(id);
  return composeTheme(parts ?? DEFAULT_PARTS);
}

export const classic: Theme = getTheme('classic');
export const midnight: Theme = getTheme('midnight');

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function checkerVars(prefix: string, style: CheckerStyle, out: Record<string, string>): void {
  for (const [k, v] of Object.entries(style)) out[`${prefix}-${kebab(k)}`] = v;
}

/**
 * Flatten a theme into CSS custom properties:
 * `--ui-*` (chrome palette), `--board-*` (board set), `--piece-white-*` / `--piece-black-*`.
 */
export function themeToCssVars(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.ui)) out[`--ui-${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(theme.board)) {
    if (k === 'id' || k === 'name' || k === 'asset') continue;
    if (typeof v === 'string') out[`--board-${kebab(k)}`] = v;
  }
  checkerVars('--piece-white', theme.pieces.white, out);
  checkerVars('--piece-black', theme.pieces.black, out);
  out['--theme-id'] = theme.id;
  out['--theme-mode'] = theme.mode;
  return out;
}

// ---- colour helpers (shared by tests and previews) ----

/** Parse `#rgb` / `#rrggbb` into 0..255 channels; null for anything else (e.g. rgba()). */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG relative luminance (0..1). */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours (1..21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue (0..360), saturation and lightness (0..1) of a hex colour. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const rgb = hexToRgb(hex);
  if (!rgb) return { h: 0, s: 0, l: 0 };
  const [r, g, b] = rgb.map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}
