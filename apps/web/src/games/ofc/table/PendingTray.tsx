import { useCallback, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { Card as CardT, Row } from '@bgf/ofc-engine';
import { cardKey } from '@bgf/ofc-engine';
import { Card } from '../cards/Card';
import type { PlacementDraft, SortMode } from './model';
import { sortCards } from './model';
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
}

const DRAG_THRESHOLD = 6;

const SORTS: Array<{ mode: SortMode; id: string; label: string; title: string }> = [
  { mode: 'low', id: 'sort-low', label: '2→A', title: 'Sort lowest to highest' },
  { mode: 'high', id: 'sort-high', label: 'A→2', title: 'Sort highest to lowest' },
  { mode: 'suit', id: 'sort-suit', label: '♣♦♥♠', title: 'Sort by suit' },
];

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
  } = props;
  const pressed = useRef<{ card: CardT; x: number; y: number; dragging: boolean } | null>(null);
  const [sort, setSort] = useState<SortMode>('dealt');

  const onPointerDown = useCallback((card: CardT, e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pressed.current = { card, x: e.clientX, y: e.clientY, dragging: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const p = pressed.current;
      if (!p) return;
      if (!p.dragging) {
        const threshold = e.pointerType === 'touch' ? 3 : DRAG_THRESHOLD;
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < threshold) return;
        p.dragging = true;
        onDragStart(p.card, e.clientX, e.clientY);
      }
      onDragMove(e.clientX, e.clientY);
    },
    [onDragStart, onDragMove],
  );
  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const p = pressed.current;
      pressed.current = null;
      if (!p) return;
      if (p.dragging) onDragEnd(e.clientX, e.clientY);
      else {
        const same = draft.selected && cardKey(draft.selected) === cardKey(p.card);
        draft.select(same ? null : p.card);
      }
    },
    [draft, onDragEnd],
  );
  const onPointerCancel = useCallback(() => {
    const p = pressed.current;
    pressed.current = null;
    if (p?.dragging) onDragCancel();
  }, [onDragCancel]);

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
      data-sort={sort}
    >
      <div className={styles.trayHead}>
        <span data-testid="tray-hint">{turnText}</span>
        <span className={styles.trayHeadRight}>
          <span className={styles.hiddenNote}>
            {req ? `${draft.placed.length}/${req.place} placed` : ''}
          </span>
          {trayCards.length > 1 && (
            <span className={styles.sortButtons} role="group" aria-label="sort cards">
              {SORTS.map((s) => (
                <button
                  key={s.mode}
                  type="button"
                  className={styles.sortButton}
                  data-testid={s.id}
                  data-active={sort === s.mode ? 'true' : 'false'}
                  title={s.title}
                  aria-pressed={sort === s.mode}
                  onClick={() => setSort((cur) => (cur === s.mode ? 'dealt' : s.mode))}
                >
                  {s.label}
                </button>
              ))}
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
              onPointerDown={(e) => onPointerDown(card, e)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
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
      <div className={styles.trayActions}>
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
