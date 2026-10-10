import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import type { Card as CardT, Row } from '@bgf/ofc-engine';
import { cardKey } from '@bgf/ofc-engine';
import { Card } from '../cards/Card';
import type { PlacementDraft, TraySort } from './model';
import { DEFAULT_TRAY_SORT, sortCards } from './model';
import { useCardPress } from './useCardPress';
import styles from './OfcTable.module.css';

export interface DragState {
  card: CardT;
  x: number;
  y: number;
  over: Row | null;
}

export interface PendingTrayProps {
  draft: PlacementDraft;
  turnText: string;
  fantasyland: boolean;
  drag: DragState | null;
  onDragStart: (card: CardT, x: number, y: number) => void;
  onDragMove: (x: number, y: number) => void;
  onDragEnd: (x: number, y: number) => void;
  onDragCancel: () => void;
  fourColor?: boolean;
  reducedMotion?: boolean;
  /** Where the sort starts (the player's setting); the buttons still change it. */
  initialSort?: TraySort;
}

/** The local player's dealt cards, the derived discards, and the confirm/undo controls. */
export function PendingTray(props: PendingTrayProps) {
  const {
    draft,
    turnText,
    fantasyland,
    drag,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
    fourColor = false,
    reducedMotion = false,
    initialSort = DEFAULT_TRAY_SORT,
  } = props;
  const [sort, setSort] = useState<TraySort>(initialSort);
  const press = useCardPress({
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
    onTap: (card) => {
      const same = draft.selected && cardKey(draft.selected) === cardKey(card);
      draft.select(same ? null : card);
    },
  });
  // A placed card lifted from a row: tapping the tray takes it back.
  const lifted = draft.selected && draft.isPlaced(draft.selected) ? draft.selected : null;

  const discardKeys = new Set(draft.discards.map(cardKey));
  const trayCards = useMemo(
    () =>
      sortCards(
        draft.remaining.filter((c) => !discardKeys.has(cardKey(c))),
        sort,
      ),
    // discardKeys is derived from draft.discards
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft.remaining, draft.discards, sort],
  );
  const req = draft.requirement;
  const showDiscards = req !== null && req.discard > 0;

  return (
    <div
      className={styles.tray}
      data-testid="pending-cards"
      data-fantasyland={fantasyland ? 'true' : undefined}
      data-sort={`${sort.suits ? 'suits-' : ''}${sort.order}`}
      data-tray
      data-lifted={lifted ? 'true' : undefined}
      onClick={lifted ? () => draft.unplace(lifted) : undefined}
    >
      <div className={styles.trayHead}>
        <span data-testid="tray-hint">{turnText}</span>
        <span className={styles.trayHeadRight}>
          <span className={styles.hiddenNote}>
            {req ? `${draft.placed.length}/${req.place} placed` : ''}
          </span>
          {trayCards.length > 1 && (
            <span className={styles.sortButtons} role="group" aria-label="sort cards">
              <button
                type="button"
                className={styles.sortButton}
                data-testid="sort-suits"
                data-active={sort.suits ? 'true' : 'false'}
                title={sort.suits ? 'Grouped by suit: tap to sort by rank only' : 'Group by suit'}
                aria-pressed={sort.suits}
                onClick={(e) => {
                  e.stopPropagation();
                  setSort((cur) => ({ ...cur, suits: !cur.suits }));
                }}
              >
                ♣♦♥♠
              </button>
              <button
                type="button"
                className={styles.sortButton}
                data-testid="sort-order"
                data-order={sort.order}
                data-active="true"
                title={
                  sort.order === 'high'
                    ? 'Highest first: tap for lowest first'
                    : 'Lowest first: tap for highest first'
                }
                aria-label={sort.order === 'high' ? 'Highest first' : 'Lowest first'}
                onClick={(e) => {
                  e.stopPropagation();
                  setSort((cur) => ({ ...cur, order: cur.order === 'high' ? 'low' : 'high' }));
                }}
              >
                {sort.order === 'high' ? 'A→2' : '2→A'}
              </button>
            </span>
          )}
        </span>
      </div>
      <div className={styles.trayCards} role="list" aria-label="cards to place">
        {trayCards.map((card, i) => {
          const key = cardKey(card);
          const selected = !!draft.selected && cardKey(draft.selected) === key;
          const dragging = !!drag && cardKey(drag.card) === key;
          return (
            <motion.div
              key={key}
              layoutId={`me-${key}`}
              className={styles.trayCard}
              data-testid={`pending-card-${key}`}
              data-selected={selected ? 'true' : 'false'}
              data-dragging={dragging ? 'true' : undefined}
              initial={reducedMotion ? false : { opacity: 0, y: -28, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={
                reducedMotion ? { duration: 0 } : { delay: Math.min(i, 8) * 0.05, duration: 0.25 }
              }
              {...press(card)}
              role="listitem"
            >
              <Card card={card} size="md" fourColor={fourColor} selected={selected} />
            </motion.div>
          );
        })}
        {trayCards.length === 0 && <span className={styles.hiddenNote}>All cards placed</span>}
      </div>
      {showDiscards && (
        <div
          className={styles.discards}
          onClick={(e) => e.stopPropagation()}
          data-testid="discard-slot"
          data-count={draft.discards.length}
        >
          <span>Discard{req.discard > 1 ? 's' : ''}:</span>
          {draft.discards.map((card) => (
            <div key={cardKey(card)} data-testid={`discard-card-${cardKey(card)}`}>
              <Card
                card={card}
                size="sm"
                fourColor={fourColor}
                dimmed
                selected={!!draft.selected && cardKey(draft.selected) === cardKey(card)}
                onClick={() => draft.select(card)}
                aria-label={`discard ${cardKey(card)}; tap to place it instead`}
              />
            </div>
          ))}
          {draft.discards.length === 0 && (
            <span className={styles.hiddenNote}>
              {req.discard === 1
                ? 'the card you do not place'
                : `the ${req.discard} cards you do not place`}
            </span>
          )}
        </div>
      )}
      <div className={styles.trayActions} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={draft.clear}
          disabled={draft.placed.length === 0}
          data-testid="clear-placement"
        >
          Clear
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={draft.undo}
          disabled={draft.placed.length === 0}
          data-testid="undo-placement"
        >
          Undo
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={draft.confirm}
          disabled={!draft.canConfirm}
          data-testid="confirm-placement"
        >
          {fantasyland ? 'Set hand' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}
