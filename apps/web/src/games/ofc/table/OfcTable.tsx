import { useCallback, useEffect, useState } from 'react';
import { LayoutGroup, MotionConfig } from 'motion/react';
import type { TableClientState } from '@bgf/table';
import type { Command, Row, TableView, Card as CardT } from '@bgf/ofc-engine';
import { Card, HiddenStack } from '../cards/Card';
import type { SeatModel } from './model';
import { useOfcTableModel, usePlacementDraft } from './model';
import { SeatPanel } from './SeatPanel';
import { PendingTray } from './PendingTray';
import type { DragState } from './PendingTray';
import { ShowdownPanel } from './ShowdownPanel';
import type { FlowProps } from './FlowControls';
import styles from './OfcTable.module.css';

export interface OfcTableProps {
  state: TableClientState<TableView>;
  send: (command: Command) => void;
  /** Per seat (may be shorter than the number of seats). */
  names: string[];
  mySeat: number | null;
  reducedMotion?: boolean;
  /** The shell shows its ledger / settle sheet. */
  onOpenLedger?: () => void;
  fourColor?: boolean;
  /** Unattended table: readiness, countdown and reset requests (hides the deal buttons). */
  flow?: FlowProps;
}

const KEY_ROWS: Record<string, Row> = { '1': 'top', '2': 'middle', '3': 'bottom' };

function rowUnderPoint(x: number, y: number): Row | null {
  if (typeof document === 'undefined') return null;
  const el = document.elementFromPoint(x, y);
  const row = el?.closest<HTMLElement>('[data-row][data-mine="true"]');
  return (row?.dataset.row as Row | undefined) ?? null;
}

/**
 * The Open Face Chinese Poker table: opponents above, the local player's rows below with the
 * dealt cards to place, and the showdown once every seat has set its hand.
 */
export function OfcTable(props: OfcTableProps) {
  const {
    state,
    send,
    names,
    mySeat,
    reducedMotion = false,
    onOpenLedger,
    fourColor = false,
    flow,
  } = props;
  const draft = usePlacementDraft(state, mySeat, send);
  const model = useOfcTableModel(state, mySeat, names, draft.placed);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Flash the rows briefly after an illegal drop: shown until a timer marks that drop as seen.
  const [seenInvalidAt, setSeenInvalidAt] = useState(0);
  useEffect(() => {
    if (!draft.invalidAt) return;
    const at = draft.invalidAt;
    const t = setTimeout(() => setSeenInvalidAt(at), 400);
    return () => clearTimeout(t);
  }, [draft.invalidAt]);
  const shaking = draft.invalidAt > 0 && seenInvalidAt < draft.invalidAt;

  const onDragStart = useCallback((card: CardT, x: number, y: number) => {
    setDrag({ card, x, y, over: rowUnderPoint(x, y) });
  }, []);
  const onDragMove = useCallback((x: number, y: number) => {
    setDrag((d) => (d ? { ...d, x, y, over: rowUnderPoint(x, y) } : d));
  }, []);
  const onDragEnd = useCallback(
    (x: number, y: number) => {
      setDrag((d) => {
        if (d) {
          const row = rowUnderPoint(x, y);
          if (row) draft.place(row, d.card);
        }
        return null;
      });
    },
    [draft],
  );
  const onDragCancel = useCallback(() => setDrag(null), []);

  // Keyboard: 1/2/3 place the selected card, Enter confirms, Backspace undoes, Escape clears.
  useEffect(() => {
    if (!model.myTurn) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (target?.isContentEditable) return;
      const row = KEY_ROWS[e.key];
      if (row && draft.selected) {
        e.preventDefault();
        draft.place(row);
      } else if (e.key === 'Enter' && draft.canConfirm) {
        e.preventDefault();
        draft.confirm();
      } else if (e.key === 'Backspace' && draft.placed.length > 0) {
        e.preventDefault();
        draft.undo();
      } else if (e.key === 'Escape') {
        draft.select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [model.myTurn, draft]);

  const opponents = model.seats.filter((s) => !s.isMe);
  const me = model.seats.find((s) => s.isMe) ?? null;
  const onRowTap = useCallback((row: Row) => draft.place(row), [draft]);
  const startHand = useCallback(() => send({ type: 'start' }), [send]);
  const auto = !!flow?.autopilot;
  // On an unattended table the lobby text says what the table is waiting for.
  const seatsTaken = (state.snapshot?.seats ?? []).filter((s) => s !== null).length;
  const seatCount = state.snapshot?.seats.length ?? 0;
  const everyoneHere =
    seatCount > 0 && seatsTaken === seatCount && state.presence.slice(0, seatCount).every(Boolean);
  const turnText =
    auto && !model.result && (model.phase === 'lobby' || model.phase === 'idle')
      ? everyoneHere
        ? 'Dealing…'
        : `Waiting for players (${seatsTaken}/${seatCount})`
      : model.turnText;

  return (
    <MotionConfig reducedMotion={reducedMotion ? 'always' : 'user'}>
      <LayoutGroup>
        <div
          className={styles.table}
          data-testid="ofc-table"
          data-phase={model.phase}
          data-variant={model.variant}
          data-my-turn={model.myTurn ? 'true' : 'false'}
          data-seats={model.seatCount}
        >
          <header className={styles.header}>
            <div className={styles.headerMeta}>
              <span data-testid="hand-number">Hand {model.handNumber}</span>
              {model.deckCount !== null && (
                <span data-testid="deck-count">Deck {model.deckCount}</span>
              )}
              <span>{variantName(model.variant)}</span>
            </div>
            <span
              className={styles.turn}
              data-testid="turn-indicator"
              data-mine={model.myTurn ? 'true' : 'false'}
            >
              {turnText}
            </span>
            <div className={styles.headerActions}>
              {onOpenLedger && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={onOpenLedger}
                  data-testid="ledger-button"
                >
                  Ledger
                </button>
              )}
              {model.canStart && model.phase !== 'showdown' && !auto && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={startHand}
                  data-testid="start-hand-button"
                >
                  {model.handNumber === 0 ? 'Deal first hand' : 'Next hand'}
                </button>
              )}
            </div>
          </header>

          {model.result && (
            <ShowdownPanel
              model={model}
              result={model.result}
              onNextHand={startHand}
              onOpenLedger={onOpenLedger}
              flow={flow}
            />
          )}

          {model.settingFantasyland && model.myTurn && me ? (
            <div className={styles.flLayout} data-testid="fantasyland-layout">
              <section className={styles.flPanel} data-testid="fantasyland-panel">
                <header className={styles.flHead}>
                  <strong>Fantasyland · set your {model.pending.length} cards</strong>
                  <span className={styles.hiddenNote}>
                    Opponents' cards stay hidden until you set your hand.
                  </span>
                </header>
                <PendingTray
                  draft={draft}
                  turnText={model.turnText}
                  fantasyland
                  drag={drag}
                  onDragStart={onDragStart}
                  onDragMove={onDragMove}
                  onDragEnd={onDragEnd}
                  onDragCancel={onDragCancel}
                  fourColor={fourColor}
                  reducedMotion={reducedMotion}
                />
              </section>
              <div className={styles.hiddenSeats} data-testid="opponents">
                {opponents.map((s) => (
                  <HiddenSeat key={s.seat} seat={s} />
                ))}
              </div>
              <div className={styles.mine} data-fantasyland="true">
                <SeatPanel
                  seat={me}
                  size="md"
                  result={model.result}
                  legalRows={draft.legalRows}
                  dragOver={drag?.over ?? null}
                  invalid={shaking}
                  onRowTap={onRowTap}
                  fourColor={fourColor}
                />
              </div>
            </div>
          ) : (
            <div className={styles.body}>
              <div className={styles.opponents} data-testid="opponents">
                {opponents.map((s) => (
                  <SeatPanel
                    key={s.seat}
                    seat={s}
                    size="sm"
                    result={model.result}
                    fourColor={fourColor}
                  />
                ))}
              </div>

              <div className={styles.mine}>
                {me && (
                  <SeatPanel
                    seat={me}
                    size="md"
                    result={model.result}
                    legalRows={model.myTurn ? draft.legalRows : []}
                    dragOver={drag?.over ?? null}
                    invalid={shaking}
                    onRowTap={model.myTurn ? onRowTap : undefined}
                    fourColor={fourColor}
                  />
                )}
                {model.myTurn && (
                  <PendingTray
                    draft={draft}
                    turnText={model.turnText}
                    fantasyland={!!me?.fantasyland}
                    drag={drag}
                    onDragStart={onDragStart}
                    onDragMove={onDragMove}
                    onDragEnd={onDragEnd}
                    onDragCancel={onDragCancel}
                    fourColor={fourColor}
                    reducedMotion={reducedMotion}
                  />
                )}
              </div>
            </div>
          )}

          {drag && (
            <div
              className={styles.ghost}
              style={
                { left: drag.x, top: drag.y, '--card-w': 'var(--card-w-md)' } as React.CSSProperties
              }
              data-testid="drag-ghost"
            >
              <Card card={drag.card} size="md" fourColor={fourColor} />
            </div>
          )}
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}

export function variantName(v: string): string {
  switch (v) {
    case 'pineapple':
      return 'Pineapple';
    case 'pineapple27':
      return 'Pineapple 2-7';
    default:
      return 'OFC';
  }
}

/** An opponent while I am setting a Fantasyland hand: name, score and a count of hidden cards. */
function HiddenSeat({ seat }: { seat: SeatModel }) {
  const set = seat.hiddenCount;
  return (
    <div
      className={styles.hiddenSeat}
      data-testid={`seat-hidden-${seat.seat}`}
      data-seat={seat.seat}
      aria-label={`${seat.name}: cards hidden while you set your Fantasyland hand`}
    >
      <span className={styles.dot} data-on={seat.present ? 'true' : 'false'} aria-hidden="true" />
      <span className={styles.seatName}>{seat.name}</span>
      <span className={styles.seatScore}>
        {seat.balance ?? (seat.score > 0 ? `+${seat.score}` : seat.score)}
      </span>
      {set > 0 ? (
        <HiddenStack count={set} size="xs" label={`${set} cards set, hidden`} />
      ) : (
        <span className={styles.hiddenNote}>nothing set yet</span>
      )}
      <span className={styles.hiddenNote}>hidden</span>
    </div>
  );
}
