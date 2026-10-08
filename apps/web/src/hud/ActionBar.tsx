import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CubeOwner, Player, ResultKind } from '@bgf/engine';
import { opponent } from '@bgf/engine';
import type { ClientState, GameClientApi } from '@bgf/client';
import styles from './ActionBar.module.css';
import { FullscreenIcon } from './useFullscreen';
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
  isAutopilot,
  isFreeBoard,
  isMoving,
  kindLabel,
  phaseSummary,
  playerName,
  readyState,
} from './derive';

export interface ActionBarProps {
  state: ClientState;
  client: Pick<
    GameClientApi,
    | 'startGame'
    | 'ready'
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
  /** Smaller buttons, for the short dock of a landscape phone. */
  dense?: boolean;
  /** Render the status line inside the bar (default true). */
  showStatus?: boolean;
  /** When set, a "More" action is offered that calls this (opens the match/chat sheet). */
  onMore?: () => void;
  /** Full screen toggle: an icon after the actions, or an item in the menu once they split. */
  fullscreen?: { on: boolean; toggle: () => void };
}

const CUBE_VALUES = [1, 2, 4, 8, 16, 32, 64] as const;

/** The one-line phase summary; also usable on its own. */
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

type Tone = 'primary' | 'danger' | 'default' | 'quiet';

/** One thing the player can do now. Either an immediate action or a panel of choices. */
interface ActionItem {
  key: string;
  label: string;
  kbd?: string;
  tone: Tone;
  disabled?: boolean;
  testId: string;
  onSelect?: () => void;
  /** Opens a panel of further choices (resign stakes, cube, result, reset). */
  panel?: (close: () => void) => ReactNode;
  panelTestId?: string;
  attrs?: Record<string, string>;
  /** Drawn instead of the label where space is short (the split button). */
  icon?: ReactNode;
  /** Stays beside the main action as an icon when the rest fold into the split menu. */
  pinned?: boolean;
}

const CheckIcon = (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <path
      d="M4 10.5 8.2 14.5 16 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const UndoIcon = (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path
      d="M7.5 5 3.5 9l4 4M4 9h7.5a4.5 4.5 0 0 1 0 9H9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function toneClass(tone: Tone): string {
  if (tone === 'primary') return 'btn-primary';
  if (tone === 'danger') return 'btn-danger';
  if (tone === 'quiet') return 'btn-ghost';
  return '';
}

/**
 * The action a split button shows: the first enabled primary one; else the first primary one even
 * while disabled (Done before the move is complete says what comes next); else anything enabled.
 */
function defaultItem(items: ActionItem[]): ActionItem | undefined {
  return (
    items.find((i) => i.tone === 'primary' && !i.disabled) ??
    items.find((i) => i.tone === 'primary') ??
    items.find((i) => !i.disabled && i.tone !== 'quiet') ??
    items.find((i) => !i.disabled) ??
    items[0]
  );
}

/**
 * True when the actions do not fit on one line in the space given. A hidden copy of the full
 * row is measured, so the answer never depends on which mode is showing (no flip-flopping).
 * Without layout (jsdom) or a ResizeObserver everything is shown.
 */
function useOverflow(signature: string) {
  const room = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const measure = useCallback(() => {
    const r = room.current;
    const m = ruler.current;
    if (!r || !m || r.clientWidth === 0) {
      setOverflow(false);
      return;
    }
    setOverflow(m.scrollWidth > r.clientWidth + 0.5);
  }, []);
  useLayoutEffect(measure, [measure, signature]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !room.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(room.current);
    return () => ro.disconnect();
  }, [measure]);
  return { room, ruler, overflow };
}

function PanelButton({
  item,
  className,
  open,
  onToggle,
  onClose,
  children,
}: {
  item: ActionItem;
  className: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const ref = useOutsideClose(open, onClose);
  return (
    <div className={styles.menu} ref={ref}>
      <button
        className={className}
        data-testid={item.testId}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={item.disabled}
        onClick={onToggle}
        title={item.label}
        {...item.attrs}
      >
        {children ?? item.label}
      </button>
      {open && item.panel && (
        <div className={styles.menuList} role="menu" data-testid={item.panelTestId}>
          {item.panel(onClose)}
        </div>
      )}
    </div>
  );
}

function ActionButtons({
  items,
  compact,
  dense,
  fullscreen,
}: {
  items: ActionItem[];
  compact?: boolean;
  dense?: boolean;
  fullscreen?: { on: boolean; toggle: () => void };
}) {
  const signature = items.map((i) => `${i.key}:${i.label}`).join('|');
  const { room, ruler, overflow } = useOverflow(signature);
  // A panel or menu belongs to the actions on screen: once they change, it counts as closed.
  const context = `${signature}#${overflow ? 'split' : 'row'}`;
  const [openState, setOpenState] = useState<{ key: string; context: string } | null>(null);
  const [splitState, setSplitState] = useState<{ panel: string | null; context: string } | null>(
    null,
  );
  const open = openState?.context === context ? openState.key : null;
  const splitOpen = splitState?.context === context;
  const splitPanel = splitOpen ? splitState!.panel : null;
  const setOpen = (key: string | null) => setOpenState(key ? { key, context } : null);
  const setSplitPanel = (panel: string | null) => setSplitState({ panel, context });
  const close = useCallback(() => setOpenState(null), []);
  const closeSplit = useCallback(() => setSplitState(null), []);
  const splitRef = useOutsideClose(splitOpen, closeSplit);

  const size = dense ? 'btn-sm' : '';
  // Quiet actions (resign, leave) are small everywhere: they leave room for the ones that matter.
  const cls = (i: ActionItem) =>
    `btn ${i.tone === 'quiet' ? 'btn-sm' : size} ${toneClass(i.tone)} ${styles.action}`;
  const content = (i: ActionItem) => (
    <>
      {i.label}
      {!compact && !dense && i.kbd && <kbd className={styles.kbd}>{i.kbd}</kbd>}
    </>
  );
  const render = (i: ActionItem) =>
    i.panel ? (
      <PanelButton
        key={i.key}
        item={i}
        className={cls(i)}
        open={open === i.key}
        onToggle={() => setOpen(open === i.key ? null : i.key)}
        onClose={close}
      >
        {content(i)}
      </PanelButton>
    ) : (
      <button
        key={i.key}
        className={cls(i)}
        data-testid={i.testId}
        disabled={i.disabled}
        onClick={i.onSelect}
        title={i.label}
        {...i.attrs}
      >
        {content(i)}
      </button>
    );

  const fsLabel = fullscreen?.on ? 'Exit full screen' : 'Full screen';
  const fsIcon = fullscreen && (
    <button
      className={`btn btn-ghost btn-sm btn-icon ${styles.action}`}
      onClick={fullscreen.toggle}
      data-testid="fullscreen-button"
      data-on={fullscreen.on ? 'true' : 'false'}
      aria-pressed={fullscreen.on}
      aria-label={fsLabel}
      title={fsLabel}
    >
      <FullscreenIcon on={fullscreen.on} />
    </button>
  );
  const main = overflow ? defaultItem(items) : undefined;
  const pinned = main ? items.filter((i) => i !== main && i.pinned) : [];
  const rest = main ? items.filter((i) => i !== main && !i.pinned) : [];
  // Where space is short an action with an icon shows just the icon; the name stays its label.
  const iconButton = (i: ActionItem, extra = '') => (
    <button
      key={i.key}
      className={`btn ${size} ${toneClass(i.tone)} btn-icon ${styles.action} ${extra}`}
      data-testid={i.testId}
      disabled={i.disabled}
      onClick={i.onSelect}
      title={i.label}
      aria-label={i.label}
      {...i.attrs}
    >
      {i.icon}
    </button>
  );
  if (main && fullscreen) {
    rest.push({
      key: 'fullscreen',
      label: fsLabel,
      tone: 'quiet',
      testId: 'fullscreen-button',
      attrs: { 'data-on': fullscreen.on ? 'true' : 'false' },
      onSelect: fullscreen.toggle,
    });
  }
  const panelItem = splitPanel ? rest.find((i) => i.key === splitPanel) : undefined;

  return (
    <div className={styles.row}>
      <div className={styles.room} ref={room}>
        {/* The full row, invisible, for measuring. */}
        <div className={styles.rulerBox} aria-hidden="true">
          <div className={styles.ruler} ref={ruler}>
            {items.map((i) => (
              <span key={i.key} className={cls(i)}>
                {content(i)}
              </span>
            ))}
            {fullscreen && (
              <span className={`btn btn-ghost btn-sm btn-icon ${styles.action}`}>
                <FullscreenIcon on={fullscreen.on} />
              </span>
            )}
          </div>
        </div>
        {!main ? (
          <div className={styles.buttons}>
            {items.map(render)}
            {fsIcon}
          </div>
        ) : (
          <div className={styles.split} data-testid="split-actions" ref={splitRef}>
            {main.icon && !main.panel ? iconButton(main, styles.mainIcon) : render(main)}
            {rest.length > 0 && (
              <button
                className={`btn ${size} ${main.tone === 'primary' && !main.disabled ? 'btn-primary' : ''} ${styles.caret}`}
                data-testid="more-actions"
                aria-haspopup="menu"
                aria-expanded={splitOpen}
                aria-label="More actions"
                title="More actions"
                onClick={() => (splitOpen ? closeSplit() : setSplitPanel(null))}
              >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path
                    d="M2 4.5 6 8.5 10 4.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
            {pinned.map((i) => iconButton(i, styles.pinned))}
            {splitOpen && (
              <div
                className={`${styles.menuList} ${styles.splitList}`}
                role="menu"
                data-testid={panelItem?.panelTestId ?? 'more-actions-menu'}
              >
                {panelItem ? (
                  <>
                    <button className={styles.menuBack} onClick={() => setSplitPanel(null)}>
                      ‹ {panelItem.label}
                    </button>
                    {panelItem.panel!(closeSplit)}
                  </>
                ) : (
                  rest.map((i) => (
                    <button
                      key={i.key}
                      className={`${styles.menuItem} ${i.tone === 'danger' ? styles.menuDanger : ''}`}
                      role="menuitem"
                      data-testid={i.testId}
                      disabled={i.disabled}
                      onClick={() => {
                        if (i.panel) {
                          setSplitPanel(i.key);
                          return;
                        }
                        closeSplit();
                        i.onSelect?.();
                      }}
                      {...i.attrs}
                    >
                      {i.label}
                      {i.panel && <span className={styles.menuChevron}>›</span>}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ActionBar({
  state,
  client,
  onLeave,
  compact,
  dense,
  showStatus = true,
  onMore,
  fullscreen,
}: ActionBarProps) {
  const match = currentMatch(state);
  const game = currentGame(state);
  const over = gameOver(state);
  const [pendingResult, setPendingResult] = useState<{ winner: Player; kind: ResultKind } | null>(
    null,
  );

  const auto = isAutopilot(state);
  const readiness = readyState(state);
  // Unattended table: the first game starts by itself; later games start when both are ready.
  const showStart = canStartGame(state) && !match?.winner && !auto;
  const showReady = canStartGame(state) && !match?.winner && auto && game !== null;
  const waitingToStart = canStartGame(state) && !match?.winner && auto && game === null;
  const moving = isMoving(state);
  const free = isFreeBoard(state);
  const seat = state.seat;
  const cube = game?.cube ?? { value: 1, owner: 'center' as CubeOwner };

  const setCube = (value: number, owner: CubeOwner) => {
    const v = owner === 'center' ? value : Math.max(value, 2);
    client.setCube(v, v === 1 ? 'center' : owner);
  };

  const items: ActionItem[] = [];
  const add = (i: ActionItem | false | null | undefined) => {
    if (i) items.push(i);
  };

  const later = over || (match && match.games.length > 0);
  add(
    showStart && {
      key: 'start',
      label: later ? 'Next game' : 'Start game',
      tone: 'primary',
      testId: 'start-game-button',
      onSelect: () => client.startGame(),
    },
  );
  add(
    showReady && {
      key: 'ready',
      label: readiness.mine ? 'Not ready' : 'Ready',
      tone: readiness.mine ? 'default' : 'primary',
      testId: 'ready-button',
      attrs: { 'data-ready': readiness.mine ? 'true' : 'false' },
      onSelect: () => client.ready(!readiness.mine),
    },
  );
  add(
    canOpeningRoll(state) && {
      key: 'opening',
      label: 'Roll for start',
      kbd: 'R',
      tone: 'primary',
      testId: 'opening-roll-button',
      onSelect: () => client.openingRoll(),
    },
  );
  add(
    canRoll(state) && {
      key: 'roll',
      label: 'Roll',
      kbd: 'R',
      tone: 'primary',
      testId: 'roll-button',
      onSelect: () => client.roll(),
    },
  );
  add(
    free &&
      canFreeRoll(state) && {
        key: 'free-roll',
        label: 'Roll',
        kbd: 'R',
        tone: 'primary',
        testId: 'roll-button',
        onSelect: () => client.freeRoll(),
      },
  );
  add(
    canDouble(state) && {
      key: 'double',
      label: 'Double',
      kbd: 'D',
      tone: 'default',
      testId: 'double-button',
      onSelect: () => client.double(),
    },
  );
  if (canRespondToDouble(state)) {
    add({
      key: 'take',
      label: 'Take',
      tone: 'primary',
      testId: 'take-button',
      onSelect: () => client.take(),
    });
    add({
      key: 'drop',
      label: 'Drop',
      tone: 'danger',
      testId: 'drop-button',
      onSelect: () => client.drop(),
    });
  }
  if (canRespondToResign(state)) {
    add({
      key: 'accept-resign',
      label: 'Accept resignation',
      tone: 'primary',
      testId: 'accept-resign-button',
      onSelect: () => client.acceptResign(),
    });
    add({
      key: 'decline-resign',
      label: 'Decline',
      tone: 'default',
      testId: 'decline-resign-button',
      onSelect: () => client.declineResign(),
    });
  }
  if (moving) {
    add({
      key: 'done',
      label: 'Done',
      kbd: '⏎',
      icon: CheckIcon,
      tone: 'primary',
      disabled: !canCommit(state),
      testId: 'done-button',
      onSelect: () => client.commit(),
    });
    add({
      key: 'undo',
      label: 'Undo',
      kbd: 'U',
      icon: UndoIcon,
      pinned: true,
      tone: 'default',
      disabled: !canUndo(state),
      testId: 'undo-button',
      onSelect: () => client.unstage(),
    });
  }

  // ---- free board controls ----
  add(
    free &&
      canSetCube(state) && {
        key: 'cube',
        label: `Cube ×${cube.value}`,
        tone: 'default',
        testId: 'cube-button',
        panelTestId: 'cube-menu',
        panel: () => (
          <>
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
          </>
        ),
      },
  );
  add(
    free &&
      canRecordResult(state) &&
      seat && {
        key: 'result',
        label: 'Record result…',
        tone: 'default',
        testId: 'record-result-button',
        panelTestId: 'record-result-menu',
        panel: (close) =>
          pendingResult ? (
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
                    setPendingResult(null);
                    close();
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
          ),
      },
  );
  add(
    free &&
      canResetBoard(state) && {
        key: 'reset',
        label: 'Reset board',
        tone: 'default',
        testId: 'reset-board-button',
        panelTestId: 'reset-menu',
        panel: (close) => (
          <div className={styles.confirm}>
            <div>Put every checker back to the starting position?</div>
            <div className={styles.confirmRow}>
              <button
                className="btn btn-danger btn-sm"
                data-testid="confirm-reset"
                onClick={() => {
                  close();
                  client.resetBoard();
                }}
              >
                Reset
              </button>
              <button className="btn btn-ghost btn-sm" data-testid="cancel-reset" onClick={close}>
                Cancel
              </button>
            </div>
          </div>
        ),
      },
  );

  add(
    canOfferResign(state) && {
      key: 'resign',
      label: 'Resign…',
      tone: 'quiet',
      testId: 'resign-button',
      panelTestId: 'resign-menu',
      panel: (close) => (
        <>
          {(
            [
              ['single', 'Resign single game', 'Opponent scores the cube value'],
              ['gammon', 'Resign gammon', 'Twice the cube'],
              ['backgammon', 'Resign backgammon', 'Three times the cube'],
            ] as const
          ).map(([stakes, title, note]) => (
            <button
              key={stakes}
              className={styles.menuItem}
              role="menuitem"
              data-testid={`resign-${stakes}`}
              onClick={() => {
                close();
                client.offerResign(stakes);
              }}
            >
              {title}
              <small>{note}</small>
            </button>
          ))}
        </>
      ),
    },
  );
  add(
    !!onMore && {
      key: 'more',
      label: 'Match & chat',
      tone: 'quiet',
      testId: 'more-button',
      onSelect: onMore,
    },
  );
  add(
    !!onLeave && {
      key: 'leave',
      label: 'Leave',
      tone: 'quiet',
      testId: 'leave-button',
      onSelect: onLeave,
    },
  );

  const note = showReady ? (
    <span
      className={styles.note}
      data-testid="ready-indicator"
      data-opponent-ready={readiness.opponent ? 'true' : 'false'}
    >
      {readiness.opponent
        ? `${playerName(state, opponent(seat ?? 'white'))} is ready`
        : `Waiting for ${playerName(state, opponent(seat ?? 'white'))}`}
    </span>
  ) : waitingToStart ? (
    <span className={styles.note} data-testid="auto-start-note">
      The game starts as soon as both players are here.
    </span>
  ) : null;

  return (
    <div className={`${styles.bar} ${dense ? styles.dense : ''}`} data-testid="action-bar">
      {(showStatus || note) && (
        <div className={styles.statusRow}>
          {showStatus && <StatusLine state={state} />}
          {note}
        </div>
      )}
      <ActionButtons items={items} compact={compact} dense={dense} fullscreen={fullscreen} />
    </div>
  );
}
