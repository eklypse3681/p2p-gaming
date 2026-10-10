import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Card as CardT } from '@bgf/ofc-engine';

/** Mouse: a small dead zone so a click never turns into a drag. Touch starts sooner. */
const DRAG_THRESHOLD = 6;

export interface CardPressHandlers {
  onDragStart: (card: CardT, x: number, y: number) => void;
  onDragMove: (x: number, y: number) => void;
  onDragEnd: (x: number, y: number) => void;
  onDragCancel: () => void;
  /** A press that did not move: select (or deselect) the card. */
  onTap: (card: CardT) => void;
}

/**
 * Press, drag or tap a card, with mouse or finger. Used by the tray's cards and by the cards
 * already placed (not yet confirmed) on the player's own rows, so a placed card can be dragged to
 * another row or back to the tray exactly like a dealt one.
 */
export function useCardPress(h: CardPressHandlers) {
  const pressed = useRef<{ card: CardT; x: number; y: number; dragging: boolean } | null>(null);
  const handlers = useRef(h);
  useLayoutEffect(() => {
    handlers.current = h;
  });

  const onPointerDown = useCallback((card: CardT, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // No text selection or native image drag: this press belongs to the card.
    e.preventDefault();
    pressed.current = { card, x: e.clientX, y: e.clientY, dragging: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const p = pressed.current;
    if (!p) return;
    if (!p.dragging) {
      const threshold = e.pointerType === 'touch' ? 3 : DRAG_THRESHOLD;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < threshold) return;
      p.dragging = true;
      handlers.current.onDragStart(p.card, e.clientX, e.clientY);
    }
    handlers.current.onDragMove(e.clientX, e.clientY);
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const p = pressed.current;
    pressed.current = null;
    if (!p) return;
    if (p.dragging) handlers.current.onDragEnd(e.clientX, e.clientY);
    else handlers.current.onTap(p.card);
  }, []);
  const onPointerCancel = useCallback(() => {
    const p = pressed.current;
    pressed.current = null;
    if (p?.dragging) handlers.current.onDragCancel();
  }, []);

  /** Props to spread on a card's element. */
  const bind = useCallback(
    (card: CardT) => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => onPointerDown(card, e),
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      // The press already did its work; do not let the click reach the row underneath.
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
    }),
    [onPointerDown, onPointerMove, onPointerUp, onPointerCancel],
  );
  return bind;
}
