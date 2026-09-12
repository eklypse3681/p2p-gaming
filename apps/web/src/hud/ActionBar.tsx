import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { CubeOwner, Player, ResultKind } from '@bgf/engine';
import { opponent } from '@bgf/engine';
import type { ClientState, GameClientApi } from '@bgf/client';
import styles from './ActionBar.module.css';
import {
  canCommit,
  canDouble,
  canFreeRoll,
  canOfferResign,
  canOpeningRoll,
  canRecordResult,
  canResetBoard,
  canRespondToDouble,
  canRespondToResign,
  canRoll,
  canSetCube,
  canStartGame,
  canUndo,
  currentGame,
  currentMatch,
  gameOver,
  isFreeBoard,
  isMoving,
  kindLabel,
  phaseSummary,
  playerName,
} from './derive';

export type ActionBarLayout = 'row' | 'column';

export interface ActionBarProps {
  state: ClientState;
  client: Pick<
    GameClientApi,
    | 'startGame'
    | 'openingRoll'
    | 'roll'
    | 'double'
    | 'take'
    | 'drop'
    | 'offerResign'
    | 'acceptResign'
    | 'declineResign'
    | 'commit'
    | 'unstage'
    | 'clearDraft'
    | 'freeRoll'
    | 'setCube'
    | 'resetBoard'
    | 'recordResult'
  >;
  onLeave?: () => void;
  /** Hide keyboard hints (small screens). */
  compact?: boolean;
  /** 'column' stacks short-labelled buttons vertically (landscape phones). */
  layout?: ActionBarLayout;
  /** Render the status line inside the bar (default true). */
  showStatus?: boolean;
  /** When set, a "More" button is shown that calls this (opens the match/chat sheet). */
  onMore?: () => void;
}

const CUBE_VALUES = [1, 2, 4, 8, 16, 32, 64] as const;

/** The one-line phase summary; also usable on its own (landscape layout). */
export function StatusLine({ state, className }: { state: ClientState; className?: string }) {
  const summary = phaseSummary(state);
  return (
    <div
      className={`${styles.status} ${summary.mine ? styles.statusMine : ''} ${className ?? ''}`}
      data-testid="status-text"
      aria-live="polite"
    >
      <span className={`${styles.dot} ${summary.mine ? styles.dotMine : ''}`} />
      <span className={styles.statusText}>{summary.text}</span>
    </div>
  );
}

/** Closes when clicking/tapping outside. */
function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function Menu({
  open,
  onClose,
  children,
  testId,
  trigger,
  anchor = 'above',
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  testId: string;
  trigger: ReactNode;
  /** 'above' pops over the button; 'left' floats beside a vertical column (fixed position). */
  anchor?: 'above' | 'left';
}) {
  const ref = useOutsideClose(open, onClose);
  const [fixed, setFixed] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open || anchor !== 'left' || !ref.current) {
      setFixed(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    const top = Math.max(8, Math.min(r.top, window.innerHeight - 220));
    setFixed({
      position: 'fixed',
      top,
      right: Math.max(8, window.innerWidth - r.left + 8),
      left: 'auto',
      bottom: 'auto',
      maxHeight: window.innerHeight - top - 8,
    });
  }, [open, anchor, ref]);
  return (
    <div className={styles.menu} ref={ref}>
      {trigger}
      {open && (
        <div
          className={styles.menuList}
          role="menu"
          data-testid={testId}
          style={anchor === 'left' ? (fixed ?? { visibility: 'hidden' }) : undefined}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function ActionBar({
  state,
  client,
  onLeave,
  compact,
  layout = 'row',
  showStatus = true,
  onMore,
}: ActionBarProps) {
  const match = currentMatch(state);
  const game = currentGame(state);
  const over = gameOver(state);
  const column = layout === 'column';
  const [menu, setMenu] = useState<'resign' | 'cube' | 'result' | 'reset' | null>(null);
  const [pendingResult, setPendingResult] = useState<{ winner: Player; kind: ResultKind } | null>(
    null,
  );
  const closeMenu = () => {
    setMenu(null);
    setPendingResult(null);
  };
  const toggle = (m: NonNullable<typeof menu>) => setMenu((cur) => (cur === m ? null : m));

  const resign = (stakes: ResultKind) => {
    closeMenu();
    client.offerResign(stakes);
  };

  const showStart = canStartGame(state) && !match?.winner;
  const moving = isMoving(state);
  const free = isFreeBoard(state);
  const seat = state.seat;
  const cube = game?.cube ?? { value: 1, owner: 'center' as CubeOwner };

  const setCube = (value: number, owner: CubeOwner) => {
    const v = owner === 'center' ? value : Math.max(value, 2);
    client.setCube(v, v === 1 ? 'center' : owner);
  };

  /** Label helper: full text in row layout, short text in column layout (full text as tooltip). */
  const lbl = (full: string, short: string, kbd?: string) => ({
    children: (
      <>
        {column ? short : full}
        {!compact && !column && kbd && <kbd className={styles.kbd}>{kbd}</kbd>}
      </>
    ),
    title: full,
    'aria-label': full,
  });
  const btn = (extra = '') => `btn ${column ? `btn-sm ${styles.vbtn}` : ''} ${extra}`;

  return (
    <div
      className={`${styles.bar} ${column ? styles.column : ''}`}
      data-testid="action-bar"
      data-layout={layout}
    >
      {showStatus && <StatusLine state={state} />}
      <div className={styles.buttons}>
        {showStart && (
          <button
            className={btn('btn-primary')}
            data-testid="start-game-button"
            onClick={() => client.startGame()}
            {...lbl(
              over || (match && match.games.length > 0) ? 'Next game' : 'Start game',
              over || (match && match.games.length > 0) ? 'Next' : 'Start',
            )}
          />
        )}
        {canOpeningRoll(state) && (
          <button
            className={btn('btn-primary')}
            data-testid="opening-roll-button"
            onClick={() => client.openingRoll()}
            {...lbl('Roll for start', 'Roll', 'R')}
          />
        )}
        {canRoll(state) && (
          <button
            className={btn('btn-primary')}
            data-testid="roll-button"
            onClick={() => client.roll()}
            {...lbl('Roll', 'Roll', 'R')}
          />
        )}
        {free && canFreeRoll(state) && (
          <button
            className={btn('btn-primary')}
            data-testid="roll-button"
            onClick={() => client.freeRoll()}
            {...lbl('Roll', 'Roll', 'R')}
          />
        )}
        {canDouble(state) && (
          <button
            className={btn()}
            data-testid="double-button"
            onClick={() => client.double()}
            {...lbl('Double', 'Dbl', 'D')}
          />
        )}
        {canRespondToDouble(state) && (
          <>
            <button
              className={btn('btn-primary')}
              data-testid="take-button"
              onClick={() => client.take()}
              {...lbl('Take', 'Take')}
            />
            <button
              className={btn('btn-danger')}
              data-testid="drop-button"
              onClick={() => client.drop()}
              {...lbl('Drop', 'Drop')}
            />
          </>
        )}
        {canRespondToResign(state) && (
          <>
            <button
              className={btn('btn-primary')}
              data-testid="accept-resign-button"
              onClick={() => client.acceptResign()}
              {...lbl('Accept resignation', 'Accept')}
            />
            <button
              className={btn()}
              data-testid="decline-resign-button"
              onClick={() => client.declineResign()}
              {...lbl('Decline', 'Decline')}
            />
          </>
        )}
        {moving && (
          <>
            <button
              className={btn('btn-primary')}
              data-testid="done-button"
              disabled={!canCommit(state)}
              onClick={() => client.commit()}
              {...lbl('Done', 'Done', '⏎')}
            />
            <button
              className={btn()}
              data-testid="undo-button"
              disabled={!canUndo(state)}
              onClick={() => client.unstage()}
              {...lbl('Undo', 'Undo', 'U')}
            />
          </>
        )}

        {/* ---- free board controls ---- */}
        {free && canSetCube(state) && (
          <Menu
            open={menu === 'cube'}
            onClose={closeMenu}
            anchor={column ? 'left' : 'above'}
            testId="cube-menu"
            trigger={
              <button
                className={btn()}
                data-testid="cube-button"
                aria-haspopup="menu"
                aria-expanded={menu === 'cube'}
                onClick={() => toggle('cube')}
                {...lbl(`Cube ×${cube.value}`, `×${cube.value}`)}
              />
            }
          >
            <div className={styles.menuHeading}>Cube owner</div>
            <div className={styles.chipRow}>
              {(['center', 'white', 'black'] as const).map((owner) => (
                <button
                  key={owner}
                  className={`${styles.chip} ${cube.owner === owner ? styles.chipActive : ''}`}
                  role="menuitemradio"
                  aria-checked={cube.owner === owner}
                  data-testid={`cube-owner-${owner}`}
                  onClick={() => setCube(cube.value, owner)}
                >
                  {owner === 'center' ? 'Centred' : playerName(state, owner)}
                </button>
              ))}
            </div>
            <div className={styles.menuHeading}>Value</div>
            <div className={styles.chipRow}>
              {CUBE_VALUES.map((v) => (
                <button
                  key={v}
                  className={`${styles.chip} ${cube.value === v ? styles.chipActive : ''}`}
                  role="menuitemradio"
                  aria-checked={cube.value === v}
                  data-testid={`cube-value-${v}`}
                  onClick={() => setCube(v, cube.owner)}
                >
                  {v}
                </button>
              ))}
            </div>
          </Menu>
        )}
        {free && canRecordResult(state) && seat && (
          <Menu
            open={menu === 'result'}
            onClose={closeMenu}
            anchor={column ? 'left' : 'above'}
            testId="record-result-menu"
            trigger={
              <button
                className={btn()}
                data-testid="record-result-button"
                aria-haspopup="menu"
                aria-expanded={menu === 'result'}
                onClick={() => toggle('result')}
                {...lbl('Record result…', 'Score')}
              />
            }
          >
            {pendingResult ? (
              <div className={styles.confirm} data-testid="confirm-result-panel">
                <div>
                  <strong>{playerName(state, pendingResult.winner)}</strong> wins a{' '}
                  {kindLabel(pendingResult.kind).toLowerCase()}
                  {cube.value > 1 ? ` · cube ×${cube.value}` : ''}. End the game?
                </div>
                <div className={styles.confirmRow}>
                  <button
                    className="btn btn-primary btn-sm"
                    data-testid="confirm-result"
                    onClick={() => {
                      const r = pendingResult;
                      closeMenu();
                      client.recordResult(r.winner, r.kind);
                    }}
                  >
                    Record
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    data-testid="cancel-result"
                    onClick={() => setPendingResult(null)}
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : (
              [seat, opponent(seat)].map((w) => (
                <div key={w}>
                  <div className={styles.menuHeading}>
                    {w === seat ? `${playerName(state, w)} (you)` : playerName(state, w)} wins…
                  </div>
                  <div className={styles.chipRow}>
                    {(['single', 'gammon', 'backgammon'] as const).map((kind) => (
                      <button
                        key={kind}
                        className={styles.chip}
                        role="menuitem"
                        data-testid={`result-${w}-${kind}`}
                        onClick={() => setPendingResult({ winner: w, kind })}
                      >
                        {kindLabel(kind)}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </Menu>
        )}
        {free && canResetBoard(state) && (
          <Menu
            open={menu === 'reset'}
            onClose={closeMenu}
            anchor={column ? 'left' : 'above'}
            testId="reset-menu"
            trigger={
              <button
                className={btn()}
                data-testid="reset-board-button"
                aria-haspopup="menu"
                aria-expanded={menu === 'reset'}
                onClick={() => toggle('reset')}
                {...lbl('Reset board', 'Reset')}
              />
            }
          >
            <div className={styles.confirm}>
              <div>Put every checker back to the starting position?</div>
              <div className={styles.confirmRow}>
                <button
                  className="btn btn-danger btn-sm"
                  data-testid="confirm-reset"
                  onClick={() => {
                    closeMenu();
                    client.resetBoard();
                  }}
                >
                  Reset
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  data-testid="cancel-reset"
                  onClick={closeMenu}
                >
                  Cancel
                </button>
              </div>
            </div>
          </Menu>
        )}

        {!column && <span className={styles.spacer} />}
        {canOfferResign(state) && (
          <Menu
            open={menu === 'resign'}
            onClose={closeMenu}
            anchor={column ? 'left' : 'above'}
            testId="resign-menu"
            trigger={
              <button
                className={column ? `btn btn-sm ${styles.vbtn}` : 'btn btn-ghost btn-sm'}
                data-testid="resign-button"
                aria-haspopup="menu"
                aria-expanded={menu === 'resign'}
                onClick={() => toggle('resign')}
                {...lbl('Resign…', 'Resign')}
              />
            }
          >
            <button
              className={styles.menuItem}
              role="menuitem"
              data-testid="resign-single"
              onClick={() => resign('single')}
            >
              Resign single game
              <small>Opponent scores the cube value</small>
            </button>
            <button
              className={styles.menuItem}
              role="menuitem"
              data-testid="resign-gammon"
              onClick={() => resign('gammon')}
            >
              Resign gammon
              <small>Twice the cube</small>
            </button>
            <button
              className={styles.menuItem}
              role="menuitem"
              data-testid="resign-backgammon"
              onClick={() => resign('backgammon')}
            >
              Resign backgammon
              <small>Three times the cube</small>
            </button>
          </Menu>
        )}
        {onMore && (
          <button
            className={`btn btn-sm ${styles.vbtn}`}
            data-testid="more-button"
            onClick={onMore}
            {...lbl('Match, chat and room code', 'More')}
          />
        )}
        {onLeave && (
          <button
            className={column ? `btn btn-sm ${styles.vbtn}` : 'btn btn-ghost btn-sm'}
            data-testid="leave-button"
            onClick={onLeave}
            {...lbl('Leave (resume later)', 'Leave')}
          />
        )}
      </div>
    </div>
  );
}
