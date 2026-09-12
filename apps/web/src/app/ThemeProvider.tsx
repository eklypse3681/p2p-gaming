import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { BoardSet, PieceSet, Theme } from '../themes/theme';
import type { Look, ThemePreset } from '../themes';
import {
  BOARD_SETS,
  LOOKS,
  PIECE_SETS,
  PRESETS,
  THEMES,
  composeTheme,
  getLook,
  themeToCssVars,
} from '../themes';
import { resolveReducedMotion, useSettings } from '../session/settings';

interface ThemeCtx {
  theme: Theme;
  /** Named presets, as full themes. */
  themes: Theme[];
  presets: ThemePreset[];
  looks: Look[];
  boardSets: BoardSet[];
  pieceSets: PieceSet[];
  setLook: (id: string) => void;
  setBoardSet: (id: string) => void;
  setPieceSet: (id: string) => void;
  applyPreset: (id: string) => void;
  /** Switch the look between light and dark, keeping the board and pieces. */
  toggleMode: () => void;
  reducedMotion: boolean;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [settings, update] = useSettings();
  const { look, boardSet, pieceSet } = settings;
  const theme = useMemo(
    () => composeTheme({ look, board: boardSet, pieces: pieceSet }),
    [look, boardSet, pieceSet],
  );
  const reducedMotion = resolveReducedMotion(settings.reducedMotion);

  useEffect(() => {
    const root = document.documentElement;
    const vars = themeToCssVars(theme);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.dataset.theme = theme.mode;
    root.dataset.themeId = theme.id;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.ui.bg);
    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k);
    };
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.reducedMotion = reducedMotion ? 'true' : 'false';
  }, [reducedMotion]);

  const value = useMemo<ThemeCtx>(
    () => ({
      theme,
      themes: THEMES,
      presets: PRESETS,
      looks: LOOKS,
      boardSets: BOARD_SETS,
      pieceSets: PIECE_SETS,
      setLook: (id) => update({ look: id }),
      setBoardSet: (id) => update({ boardSet: id }),
      setPieceSet: (id) => update({ pieceSet: id }),
      applyPreset: (id) => {
        const p = PRESETS.find((x) => x.id === id);
        if (p) update({ look: p.look, boardSet: p.board, pieceSet: p.pieces });
      },
      toggleMode: () => update({ look: getLook(getLook(look).counterpart).id }),
      reducedMotion,
    }),
    [theme, look, update, reducedMotion],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
