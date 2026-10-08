import { useSettings } from '../../session/settings';
import type { HomeSidePreference } from '../../session/settings';
import { useTheme } from '../../app/ThemeProvider';
import type { BoardSet, PieceSet } from '../../themes/theme';
import type { HomeSide } from '../../board/contract';
import styles from '../../app/SettingsScreen.module.css';

/** Tiny schematic board: two felts, a bar, and the tray on the chosen side, with the 1-point marked. */
function HomeSidePreview({ side }: { side: HomeSide }) {
  const mirror = side === 'left';
  const x = (v: number) => (mirror ? 120 - v : v);
  const rect = (rx: number, w: number) => (mirror ? 120 - rx - w : rx);
  const tri = (cx: number, top: boolean, dark: boolean) => (
    <path
      key={`${cx}-${top}`}
      d={
        top
          ? `M ${x(cx) - 5} 6 L ${x(cx) + 5} 6 L ${x(cx)} 26 Z`
          : `M ${x(cx) - 5} 54 L ${x(cx) + 5} 54 L ${x(cx)} 34 Z`
      }
      fill={dark ? 'var(--ui-text-muted)' : 'var(--ui-accent)'}
      opacity={dark ? 0.45 : 0.8}
    />
  );
  const cols = [15, 26, 37, 48, 59, 70].map((c) => c - 4); // outer felt columns (canonical left)
  const home = [79, 90, 101, 112, 123, 134].map((c) => c - 22); // home felt columns (canonical right)
  return (
    <svg viewBox="0 0 120 60" className={styles.sidePreview} aria-hidden="true">
      <rect x={0} y={0} width={120} height={60} rx={5} fill="var(--ui-surface-raised)" />
      <rect x={rect(6, 60)} y={4} width={60} height={52} fill="var(--ui-bg)" opacity={0.7} />
      <rect x={rect(66, 7)} y={4} width={7} height={52} fill="var(--ui-border)" />
      <rect x={rect(73, 36)} y={4} width={36} height={52} fill="var(--ui-bg)" opacity={0.7} />
      <rect x={rect(111, 6)} y={4} width={6} height={52} fill="var(--ui-border)" opacity={0.7} />
      {cols.map((c, i) => tri(c, false, i % 2 === 0))}
      {cols.map((c, i) => tri(c, true, i % 2 === 1))}
      {home.map((c, i) => tri(c, false, i % 2 === 1))}
      {home.map((c, i) => tri(c, true, i % 2 === 0))}
      <circle cx={x(106)} cy={49} r={4.5} fill="var(--ui-accent)" />
      <text
        x={x(106)}
        y={49}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={6.5}
        fontWeight={800}
        fill="var(--ui-accent-text)"
      >
        1
      </text>
    </svg>
  );
}

/** Two chairs at one table: the same board seen from both sides. */
/** Frame, felt, a few points on each side of the bar, and a die. */
function BoardSwatch({ board }: { board: BoardSet }) {
  const cols = [10, 24, 38, 66, 80, 94];
  return (
    <svg viewBox="0 0 120 64" className={styles.previewSvg} aria-hidden="true">
      <rect x={0} y={0} width={120} height={64} rx={6} fill={board.frame} />
      <rect x={0} y={0} width={120} height={64} rx={6} fill="none" stroke={board.frameEdge} />
      <rect x={6} y={6} width={44} height={52} fill={board.felt} />
      <rect x={50} y={6} width={8} height={52} fill={board.bar} />
      <rect x={58} y={6} width={44} height={52} fill={board.felt} />
      <rect x={106} y={6} width={8} height={52} fill={board.tray} />
      {cols.map((cx, i) => (
        <path
          key={`t${cx}`}
          d={`M ${cx} 6 L ${cx + 12} 6 L ${cx + 6} 30 Z`}
          fill={i % 2 === 0 ? board.pointA : board.pointB}
          stroke={board.pointEdge}
          strokeWidth={0.5}
        />
      ))}
      {cols.map((cx, i) => (
        <path
          key={`b${cx}`}
          d={`M ${cx} 58 L ${cx + 12} 58 L ${cx + 6} 34 Z`}
          fill={i % 2 === 1 ? board.pointA : board.pointB}
          stroke={board.pointEdge}
          strokeWidth={0.5}
        />
      ))}
      <rect x={74} y={26} width={12} height={12} rx={2.5} fill={board.diceFace} />
      <circle cx={80} cy={32} r={1.6} fill={board.dicePip} />
      <rect x={52} y={27} width={4} height={10} rx={1} fill={board.cubeFace} opacity={0.9} />
    </svg>
  );
}

/** One checker of each colour with rim and sheen, on a neutral ground. */
function PiecesSwatch({ pieces }: { pieces: PieceSet }) {
  const checker = (cx: number, c: PieceSet['white']) => (
    <g key={cx}>
      <circle cx={cx} cy={34} r={19} fill="rgba(0,0,0,0.25)" transform="translate(1.5 2)" />
      <circle cx={cx} cy={32} r={19} fill={c.edge} />
      <circle cx={cx} cy={32} r={16} fill={c.fill} />
      <ellipse cx={cx - 5} cy={25} rx={6} ry={3.5} fill={c.sheen} opacity={0.75} />
      <text
        x={cx}
        y={33}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={11}
        fontWeight={800}
        fill={c.label}
      >
        5
      </text>
    </g>
  );
  return (
    <svg viewBox="0 0 120 64" className={styles.previewSvg} aria-hidden="true">
      <rect x={0} y={0} width={120} height={64} rx={6} fill="var(--board-felt, #2b3a4a)" />
      {checker(38, pieces.white)}
      {checker(82, pieces.black)}
    </svg>
  );
}

/** Backgammon's own settings: how the board and checkers look, and how the table faces you. */
export function BackgammonSettings() {
  const [settings, update] = useSettings();
  const { theme, presets, boardSets, pieceSets, applyPreset } = useTheme();
  return (
    <>
      <section className={`card ${styles.section}`} data-testid="appearance">
        <h2>Board and checkers</h2>
        <div className={styles.rowText}>
          Presets
          <small>Named combinations of board, checkers and app look; mix and match below.</small>
        </div>
        <div className={styles.presets} data-testid="theme-picker">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`${styles.presetChip} ${p.id === theme.id ? styles.presetActive : ''}`}
              onClick={() => applyPreset(p.id)}
              data-testid={`preset-${p.id}`}
              aria-pressed={p.id === theme.id}
            >
              {p.name}
            </button>
          ))}
        </div>

        <div className={styles.rowText}>
          Board
          <small>Frame, felt and points.</small>
        </div>
        <div className={styles.themes} role="radiogroup" aria-label="Board set">
          {boardSets.map((b) => (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={settings.boardSet === b.id}
              className={`${styles.themeCard} ${settings.boardSet === b.id ? styles.themeActive : ''}`}
              onClick={() => update({ boardSet: b.id })}
              data-testid={`board-${b.id}`}
            >
              <BoardSwatch board={b} />
              <span className={styles.themeName}>{b.name}</span>
            </button>
          ))}
        </div>

        <div className={styles.rowText}>
          Pieces
          <small>The two checker styles, shown on your current felt.</small>
        </div>
        <div className={styles.themes} role="radiogroup" aria-label="Piece set">
          {pieceSets.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={settings.pieceSet === p.id}
              className={`${styles.themeCard} ${settings.pieceSet === p.id ? styles.themeActive : ''}`}
              onClick={() => update({ pieceSet: p.id })}
              data-testid={`pieces-${p.id}`}
            >
              <PiecesSwatch pieces={p} />
              <span className={styles.themeName}>{p.name}</span>
            </button>
          ))}
        </div>
      </section>

      <section className={`card ${styles.section}`} data-testid="backgammon-table-settings">
        <h2>At the table</h2>
        <div className={styles.rowText}>
          My home board
          <small>
            Your home board (your 1 to 6 points) is always drawn at the bottom, on this side,
            whichever colour you play and whoever hosts.
          </small>
        </div>
        <div className={styles.sides} role="radiogroup" aria-label="My home board">
          {(
            [
              ['left', 'Bottom left', 'your 1 bottom-left · 24 top-left'],
              ['right', 'Bottom right', 'your 1 bottom-right · 24 top-right'],
            ] as const
          ).map(([side, label, hint]) => (
            <button
              key={side}
              type="button"
              role="radio"
              aria-checked={settings.homeSidePreference === side}
              className={`${styles.sideCard} ${settings.homeSidePreference === side ? styles.sideActive : ''}`}
              onClick={() => update({ homeSidePreference: side as HomeSidePreference })}
              data-testid={`home-side-${side}`}
            >
              <HomeSidePreview side={side} />
              <span className={styles.sideLabel}>
                {label}
                <small>{hint}</small>
              </span>
            </button>
          ))}
        </div>
        <div>
          <div className={styles.rowField}>
            <div className={styles.rowText}>
              Renderer
              <small>3D is on the roadmap; the same board model will drive it.</small>
            </div>
            <select
              className="select"
              style={{ width: 'auto' }}
              value={settings.rendererId}
              onChange={(e) => update({ rendererId: e.target.value as 'svg2d' | '3d' })}
              data-testid="renderer-select"
            >
              <option value="svg2d">2D (SVG)</option>
              <option value="3d" disabled>
                3D — coming soon
              </option>
            </select>
          </div>
        </div>
      </section>
    </>
  );
}
