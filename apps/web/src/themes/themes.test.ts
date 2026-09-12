import { describe, expect, it } from 'vitest';
import {
  BOARD_SETS,
  DEFAULT_THEME_ID,
  LOOKS,
  PIECE_SETS,
  PRESETS,
  THEMES,
  composeTheme,
  composedId,
  contrast,
  getPieceSet,
  getTheme,
  hexToHsl,
  parseThemeId,
  themeToCssVars,
} from './index';

/** Every colour token a set must define (kept in sync with the contract by these tests). */
const BOARD_KEYS = [
  'frame',
  'frameEdge',
  'felt',
  'pointA',
  'pointB',
  'pointEdge',
  'bar',
  'tray',
  'label',
  'highlightSource',
  'highlightTarget',
  'highlightSelected',
  'diceFace',
  'dicePip',
  'cubeFace',
  'cubeText',
] as const;
const UI_KEYS = [
  'bg',
  'surface',
  'surfaceRaised',
  'border',
  'text',
  'textMuted',
  'accent',
  'accentText',
  'danger',
  'success',
  'font',
  'fontMono',
] as const;
const CHECKER_KEYS = ['fill', 'edge', 'sheen', 'label'] as const;

/** Dark checkers on dark felt read through their rim, sheen and shadow; this only rejects the
 *  near-invisible (a checker whose fill is almost the felt colour). */
const MIN_FELT_CONTRAST = 1.2;
/** The two checkers of a set must be clearly different. */
const MIN_PIECE_CONTRAST = 3;

describe('theme sets', () => {
  it('ids are unique within each collection', () => {
    for (const coll of [LOOKS, BOARD_SETS, PIECE_SETS, PRESETS]) {
      expect(new Set(coll.map((x) => x.id)).size).toBe(coll.length);
    }
  });

  it('every look defines every UI token', () => {
    expect(LOOKS.length).toBeGreaterThanOrEqual(4);
    for (const l of LOOKS) {
      for (const k of UI_KEYS) expect(l.ui[k].trim(), `${l.id}.${k}`).not.toBe('');
      expect(LOOKS.some((o) => o.id === l.counterpart && o.mode !== l.mode)).toBe(true);
    }
  });

  it('every board set defines every token', () => {
    expect(BOARD_SETS.length).toBeGreaterThanOrEqual(6);
    for (const b of BOARD_SETS) {
      for (const k of BOARD_KEYS) expect(b[k].trim(), `${b.id}.${k}`).not.toBe('');
    }
  });

  it('every piece set defines both checkers fully', () => {
    expect(PIECE_SETS.length).toBeGreaterThanOrEqual(7);
    for (const p of PIECE_SETS) {
      for (const side of ['white', 'black'] as const) {
        for (const k of CHECKER_KEYS)
          expect(p[side][k].trim(), `${p.id}.${side}.${k}`).not.toBe('');
      }
    }
  });

  it('the two checkers of every set contrast with each other and with every felt', () => {
    for (const p of PIECE_SETS) {
      expect(contrast(p.white.fill, p.black.fill), p.id).toBeGreaterThanOrEqual(MIN_PIECE_CONTRAST);
      for (const b of BOARD_SETS) {
        expect(contrast(p.white.fill, b.felt), `${p.id} light on ${b.id}`).toBeGreaterThanOrEqual(
          MIN_FELT_CONTRAST,
        );
        expect(contrast(p.black.fill, b.felt), `${p.id} dark on ${b.id}`).toBeGreaterThanOrEqual(
          MIN_FELT_CONTRAST,
        );
      }
    }
  });

  it('checker labels are readable on their checker', () => {
    for (const p of PIECE_SETS) {
      for (const side of ['white', 'black'] as const) {
        expect(contrast(p[side].label, p[side].fill), `${p.id}.${side}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('sky-navy has light blue checkers', () => {
    const sky = getPieceSet('sky-navy');
    expect(sky.id).toBe('sky-navy');
    const { h, s, l } = hexToHsl(sky.white.fill);
    expect(h).toBeGreaterThanOrEqual(190);
    expect(h).toBeLessThanOrEqual(230);
    expect(s).toBeGreaterThan(0.5);
    expect(l).toBeGreaterThan(0.7);
    const navy = hexToHsl(sky.black.fill);
    expect(navy.h).toBeGreaterThanOrEqual(200);
    expect(navy.h).toBeLessThanOrEqual(240);
    expect(navy.l).toBeLessThan(0.2);
  });
});

describe('presets and composition', () => {
  it('presets reference existing parts and compose to themes with the preset id', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const p of PRESETS) {
      expect(
        LOOKS.some((l) => l.id === p.look),
        p.id,
      ).toBe(true);
      expect(
        BOARD_SETS.some((b) => b.id === p.board),
        p.id,
      ).toBe(true);
      expect(
        PIECE_SETS.some((s) => s.id === p.pieces),
        p.id,
      ).toBe(true);
      const t = composeTheme({ look: p.look, board: p.board, pieces: p.pieces });
      expect(t.id).toBe(p.id);
      expect(t.name).toBe(p.name);
    }
    expect(THEMES.map((t) => t.id)).toEqual(PRESETS.map((p) => p.id));
    expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
  });

  it('a custom combination gets a composed id and falls back on unknown parts', () => {
    const t = composeTheme({ look: 'paper', board: 'marine', pieces: 'sky-navy' });
    expect(t.id).toBe('paper/marine/sky-navy');
    expect(t.mode).toBe('light');
    expect(t.board.id).toBe('marine');
    expect(t.pieces.id).toBe('sky-navy');
    const fallback = composeTheme({ look: 'nope', board: 'nope', pieces: 'nope' });
    expect(fallback.id).toBe(DEFAULT_THEME_ID);
  });

  it('getTheme understands preset ids, composed ids and garbage', () => {
    expect(getTheme('classic').id).toBe('classic');
    expect(getTheme('classic').board.id).toBe('walnut-green');
    expect(getTheme('midnight').pieces.id).toBe('pearl-obsidian');
    expect(getTheme('paper/marine/sky-navy').id).toBe('paper/marine/sky-navy');
    expect(getTheme('harbour').id).toBe('harbour');
    expect(getTheme('does-not-exist').id).toBe(DEFAULT_THEME_ID);
    expect(getTheme('paper/nope/sky-navy').id).toBe(DEFAULT_THEME_ID);
    expect(parseThemeId('cherry')).toEqual({
      look: 'warm-light',
      board: 'cherry-burgundy',
      pieces: 'ruby-cream',
    });
    expect(composedId({ look: 'a', board: 'b', pieces: 'c' })).toBe('a/b/c');
  });

  it('themes expose the same token set and flatten into css custom properties', () => {
    const keys = (t: (typeof THEMES)[number]) => Object.keys(themeToCssVars(t)).sort().join('|');
    const first = keys(THEMES[0]!);
    for (const t of THEMES) expect(keys(t)).toBe(first);
    const vars = themeToCssVars(getTheme('classic'));
    expect(vars['--ui-bg']).toBe('#efe6d6');
    expect(vars['--board-highlight-target']).toBeTruthy();
    expect(vars['--piece-white-fill']).toBeTruthy();
    expect(vars['--piece-black-sheen']).toBeTruthy();
    expect(vars['--theme-mode']).toBe('light');
    expect(vars['--theme-id']).toBe('classic');
    for (const k of Object.keys(vars)) expect(k.startsWith('--')).toBe(true);
  });
});
