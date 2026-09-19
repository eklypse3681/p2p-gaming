import { motion } from 'motion/react';
import type { Card as CardT, HandResult, Row } from '@bgf/ofc-engine';
import { ROWS, ROW_CAPACITY, cardKey } from '@bgf/ofc-engine';
import { Card, HiddenStack } from '../cards/Card';
import type { RowModel, SeatModel } from './model';
import { rowOutcome } from './model';
import styles from './OfcTable.module.css';

export interface SeatPanelProps {
  seat: SeatModel;
  size: 'sm' | 'md';
  result: HandResult | null;
  /** Local player only: rows that accept a drop, the row under a drag, and an illegal-drop flash. */
  legalRows?: readonly Row[];
  dragOver?: Row | null;
  invalid?: boolean;
  onRowTap?: (row: Row) => void;
  fourColor?: boolean;
  compact?: boolean;
}

const HIDDEN_ROWS: Record<Row, number> = ROW_CAPACITY;

function ScoreText({ seat }: { seat: SeatModel }) {
  const value = seat.balance ?? seat.score;
  const text = seat.balance !== null ? `${value}` : value > 0 ? `+${value}` : `${value}`;
  return (
    <span
      className={styles.seatScore}
      data-testid={`score-${seat.seat}`}
      data-positive={seat.score > 0 ? 'true' : undefined}
      data-negative={seat.score < 0 ? 'true' : undefined}
      title={
        seat.balance !== null
          ? `balance ${value} (net ${seat.score > 0 ? '+' : ''}${seat.score})`
          : 'net points'
      }
    >
      {text}
      {seat.balance !== null && (
        <span className={styles.hiddenNote}>
          {' '}
          · {seat.score > 0 ? '+' : ''}
          {seat.score}
        </span>
      )}
    </span>
  );
}

function RowSlots({
  seat,
  rowModel,
  size,
  fourColor,
  hidden,
}: {
  seat: SeatModel;
  rowModel: RowModel;
  size: 'sm' | 'md';
  fourColor: boolean;
  hidden: boolean;
}) {
  const committed = rowModel.cards;
  const provisional = rowModel.provisional;
  const slots: Array<{ card?: CardT; provisional?: boolean; hidden?: boolean }> = [];
  if (hidden) {
    for (let i = 0; i < HIDDEN_ROWS[rowModel.row]; i++) slots.push({ hidden: true });
  } else {
    for (const c of committed) slots.push({ card: c });
    for (const c of provisional) slots.push({ card: c, provisional: true });
  }
  while (slots.length < rowModel.capacity) slots.push({});
  return (
    <div className={styles.slots}>
      {slots.map((s, i) => {
        const id = `slot-${seat.seat}-${rowModel.row}-${i}`;
        if (s.hidden) {
          return (
            <div key={i} className={styles.slot} data-testid={id} data-filled="true">
              <Card faceDown size={size} testId="card-back" />
            </div>
          );
        }
        if (!s.card) {
          return <div key={i} className={styles.slot} data-testid={id} data-filled="false" />;
        }
        const key = cardKey(s.card);
        return (
          <div
            key={key}
            className={styles.slot}
            data-testid={id}
            data-filled="true"
            data-provisional={s.provisional ? 'true' : undefined}
          >
            <motion.div
              layoutId={seat.isMe ? `me-${key}` : undefined}
              className={s.provisional ? styles.provisional : undefined}
            >
              <Card card={s.card} size={size} fourColor={fourColor} />
            </motion.div>
          </div>
        );
      })}
    </div>
  );
}

/** 👑 +n at the right edge of a row that earns a royalty. Struck through when the hand fouled. */
export function RoyaltyStamp({
  seat,
  row,
  points,
  voided,
}: {
  seat: number;
  row: Row;
  points: number;
  voided: boolean;
}) {
  return (
    <span
      className={styles.stamp}
      data-testid={`royalty-stamp-${seat}-${row}`}
      data-points={points}
      data-void={voided ? 'true' : undefined}
      aria-label={voided ? `royalty +${points}, void (fouled)` : `royalty +${points}`}
    >
      <span className={styles.stampCrown} aria-hidden="true">
        👑
      </span>
      <span className={styles.stampPoints}>+{points}</span>
    </span>
  );
}

/** One seat: name, score, badges and the three rows. */
export function SeatPanel(props: SeatPanelProps) {
  const {
    seat,
    size,
    result,
    legalRows = [],
    dragOver = null,
    invalid = false,
    onRowTap,
    fourColor = false,
  } = props;
  const hidden = seat.hidden;
  const seatResult = result?.seats[seat.seat] ?? null;
  const fouled = !!seatResult?.fouled;
  return (
    <section
      className={styles.seat}
      data-testid={`seat-${seat.seat}`}
      data-seat={seat.seat}
      data-me={seat.isMe ? 'true' : 'false'}
      data-to-act={seat.toAct ? 'true' : 'false'}
      data-fantasyland={seat.fantasyland ? 'true' : 'false'}
      data-foul={seat.foul ? 'true' : 'false'}
      data-hidden={hidden ? 'true' : undefined}
      style={
        {
          '--card-w': size === 'md' ? 'var(--card-w-md)' : 'var(--card-w-sm)',
        } as React.CSSProperties
      }
      aria-label={`${seat.name}${seat.isMe ? ' (you)' : ''}`}
    >
      <header className={styles.seatHead}>
        <span className={styles.dot} data-on={seat.present ? 'true' : 'false'} aria-hidden="true" />
        <span className={styles.seatName} data-testid={`seat-name-${seat.seat}`}>
          {seat.name}
          {seat.isMe && <span className={styles.hiddenNote}> (you)</span>}
        </span>
        <ScoreText seat={seat} />
        <span className={styles.seatMeta}>
          {seat.fantasyland && (
            <span
              className={`${styles.badge} ${styles.badgeFl}`}
              data-testid={`fantasyland-badge-${seat.seat}`}
            >
              Fantasyland
            </span>
          )}
          {!seat.fantasyland && seat.fantasylandNext > 0 && (
            <span
              className={`${styles.badge} ${styles.badgeFl}`}
              data-testid={`fantasyland-badge-${seat.seat}`}
            >
              FL next hand · {seat.fantasylandNext}
            </span>
          )}
          {seat.toAct && <span className={`${styles.badge} ${styles.button}`}>to act</span>}
          {fouled && <span className={`${styles.badge} ${styles.badgeDanger}`}>fouled</span>}
          {!seat.isMe && seat.pendingCount > 0 && !seat.faceDown && (
            <HiddenStack
              count={seat.pendingCount}
              size="xs"
              testId={`pending-hidden-${seat.seat}`}
              label={`${seat.pendingCount} cards in hand`}
            />
          )}
        </span>
      </header>
      <div className={styles.rows}>
        {ROWS.map((row) => {
          const rm = seat.rows[row];
          const droppable = seat.isMe && legalRows.includes(row);
          const outcome = result && !hidden ? rowOutcome(result, seat.seat, row) : null;
          const royalty = hidden ? 0 : rm.royalty;
          return (
            <div
              key={row}
              className={styles.row}
              data-testid={`row-${seat.seat}-${row}`}
              data-row={row}
              data-seat={seat.seat}
              data-mine={seat.isMe ? 'true' : undefined}
              data-count={rm.cards.length + rm.provisional.length}
              data-drop={droppable ? 'true' : undefined}
              data-over={dragOver === row ? 'true' : undefined}
              data-invalid={invalid ? 'true' : undefined}
              onClick={droppable && onRowTap ? () => onRowTap(row) : undefined}
              role={droppable ? 'button' : undefined}
              tabIndex={droppable ? 0 : undefined}
              onKeyDown={
                droppable && onRowTap
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowTap(row);
                      }
                    }
                  : undefined
              }
              aria-label={`${rm.label} row, ${rm.cards.length + rm.provisional.length} of ${rm.capacity}`}
            >
              <div className={styles.rowLabel}>
                <span className={styles.rowName}>{rm.label}</span>
                <span
                  className={styles.rowDesc}
                  data-qualifies={
                    rm.qualifies === null ? undefined : rm.qualifies ? 'true' : 'false'
                  }
                >
                  {hidden ? 'hidden' : (rm.description ?? '')}
                  {!hidden && rm.qualifies === false && ' · no low'}
                  {!hidden && rm.qualifies === true && ' · qualifies'}
                </span>
                {outcome && (
                  <span
                    data-testid={`row-result-${seat.seat}-${row}`}
                    data-outcome={outcome}
                    hidden
                  />
                )}
              </div>
              <RowSlots
                seat={seat}
                rowModel={rm}
                size={size}
                fourColor={fourColor}
                hidden={hidden}
              />
              <div className={styles.rowEnd}>
                {royalty > 0 && (
                  <RoyaltyStamp seat={seat.seat} row={row} points={royalty} voided={fouled} />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {seat.foul && seat.isMe && !result && (
        <div className={styles.foulNote} data-testid="foul-warning">
          This would foul: {seat.foul}
        </div>
      )}
      {!seat.isMe && seat.discardCount > 0 && (
        <span className={styles.hiddenNote}>{seat.discardCount} discarded</span>
      )}
    </section>
  );
}
