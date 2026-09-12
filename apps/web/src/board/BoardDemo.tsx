import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Player } from '@bgf/engine';
import { boardFrom, pipCount } from '@bgf/engine';
import {
  BOARD_SETS,
  LOOKS,
  PIECE_SETS,
  PRESETS,
  composeTheme,
  parseThemeId,
  DEFAULT_PARTS,
  themeToCssVars,
} from '../themes';
import type { BoardLocation, BoardViewModel, CheckerVM, HomeSide } from './contract';
import { DEFAULT_HOME_SIDE, sameLocation } from './contract';
import { createTracker, stacked } from './checkerTracker';
import { Board2D } from './svg/Board2D';

function combinedFor(selected: BoardLocation | null): BoardLocation[] {
  if (!selected || selected.kind !== 'point') return [];
  const point = selected.point - 7;
  return point >= 1 ? [{ kind: 'point', point }] : [];
}

/** A fixed mid-game position with dice, cube and highlights — no client required. */
export function sampleViewModel(
  perspective: Player,
  selected: BoardLocation | null = null,
  homeSide: HomeSide = DEFAULT_HOME_SIDE,
): BoardViewModel {
  // White (perspective-independent absolute layout): a typical middle-game position.
  const board = boardFrom(
    { 24: 1, 20: 2, 13: 4, 8: 3, 6: 4, 5: 1 },
    { 24: 1, 21: 2, 13: 5, 11: 2, 8: 2, 6: 3 },
  );
  board.bar.black = 0;
  board.off.white = 0;
  const tracker = createTracker(board);
  const checkers: CheckerVM[] = stacked(tracker).map((c, i) => ({
    id: c.id,
    player: c.player,
    location: c.location,
    index: c.index,
    stackSize: c.stackSize,
    recent: i === 3,
  }));
  const sources: BoardLocation[] = [
    { kind: 'point', point: 13 },
    { kind: 'point', point: 8 },
    { kind: 'point', point: 6 },
    { kind: 'point', point: 24 },
  ];
  const targets: BoardLocation[] =
    selected && sameLocation(selected, { kind: 'point', point: 13 })
      ? [
          { kind: 'point', point: 10 },
          { kind: 'point', point: 9 },
        ]
      : selected
        ? [
            { kind: 'point', point: 5 },
            { kind: 'point', point: 4 },
          ]
        : [];
  return {
    perspective,
    homeSide,
    checkers,
    dice: { player: 'white', values: [4, 3], used: [false, false], rollToken: 1 },
    openingDice: null,
    cube: { value: 2, owner: 'black' },
    highlights: {
      sources,
      selected,
      targets,
      combinedTargets: combinedFor(selected),
      invalid: null,
    },
    interactive: true,
    pips: { white: pipCount(board, 'white'), black: pipCount(board, 'black') },
    names: { white: 'Ada', black: 'Grace' },
  };
}

export interface BoardDemoProps {
  /** A preset id or a composed `look/board/pieces` id. */
  initialThemeId?: string;
  initialLookId?: string;
  initialBoardId?: string;
  initialPieceId?: string;
  initialPerspective?: Player;
  initialHomeSide?: HomeSide;
}

/** Standalone board showcase with theme, perspective and home-side switches. Mounted at `#/demo`. */
export function BoardDemo({
  initialThemeId,
  initialLookId,
  initialBoardId,
  initialPieceId,
  initialPerspective = 'white',
  initialHomeSide = DEFAULT_HOME_SIDE,
}: BoardDemoProps) {
  const initialParts = parseThemeId(initialThemeId) ?? DEFAULT_PARTS;
  const [look, setLook] = useState(initialLookId ?? initialParts.look);
  const [boardId, setBoardId] = useState(initialBoardId ?? initialParts.board);
  const [pieceId, setPieceId] = useState(initialPieceId ?? initialParts.pieces);
  const [perspective, setPerspective] = useState<Player>(initialPerspective);
  const [homeSide, setHomeSide] = useState<HomeSide>(initialHomeSide);
  const [selected, setSelected] = useState<BoardLocation | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const theme = composeTheme({ look, board: boardId, pieces: pieceId });
  const presetId = PRESETS.some((p) => p.id === theme.id) ? theme.id : '';
  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setLook(p.look);
    setBoardId(p.board);
    setPieceId(p.pieces);
  };
  const model = useMemo(
    () => sampleViewModel(perspective, selected, homeSide),
    [perspective, selected, homeSide],
  );
  const vars = themeToCssVars(theme) as CSSProperties;

  const note = (s: string) => setLog((l) => [s, ...l].slice(0, 6));

  return (
    <div
      data-testid="board-demo"
      style={{
        ...vars,
        background: 'var(--ui-bg)',
        color: 'var(--ui-text)',
        fontFamily: 'var(--ui-font)',
        minHeight: '100%',
        padding: 16,
        display: 'grid',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>
          Preset{' '}
          <select
            value={presetId}
            onChange={(e) => applyPreset(e.target.value)}
            data-testid="demo-theme"
          >
            {presetId === '' && <option value="">Custom</option>}
            {PRESETS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Look{' '}
          <select value={look} onChange={(e) => setLook(e.target.value)} data-testid="demo-look">
            {LOOKS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Board{' '}
          <select
            value={boardId}
            onChange={(e) => setBoardId(e.target.value)}
            data-testid="demo-board"
          >
            {BOARD_SETS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Pieces{' '}
          <select
            value={pieceId}
            onChange={(e) => setPieceId(e.target.value)}
            data-testid="demo-pieces"
          >
            {PIECE_SETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="demo-flip"
          onClick={() => setPerspective((p) => (p === 'white' ? 'black' : 'white'))}
        >
          Perspective: {perspective}
        </button>
        <button
          type="button"
          data-testid="demo-home-side"
          onClick={() => setHomeSide((h) => (h === 'left' ? 'right' : 'left'))}
        >
          Home board: {homeSide}
        </button>
        <label>
          <input
            type="checkbox"
            checked={reducedMotion}
            onChange={(e) => setReducedMotion(e.target.checked)}
          />{' '}
          Reduced motion
        </label>
        <span style={{ opacity: 0.7, fontSize: 13 }}>{log[0]}</span>
      </div>
      <div
        style={{
          aspectRatio: '3 / 2',
          maxWidth: '100%',
          maxHeight: '80vh',
          margin: '0 auto',
          width: '100%',
        }}
      >
        <Board2D
          model={model}
          theme={theme}
          reducedMotion={reducedMotion}
          onSelect={(loc) => {
            note(`select ${JSON.stringify(loc)}`);
            setSelected((s) => (sameLocation(s, loc) ? null : loc));
          }}
          onDrop={(from, to) => note(`drop ${JSON.stringify(from)} → ${JSON.stringify(to)}`)}
          onActivate={(loc) => note(`activate ${JSON.stringify(loc)}`)}
          onHover={() => {}}
        />
      </div>
    </div>
  );
}
