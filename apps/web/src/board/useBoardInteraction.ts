import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Board, Destination, Player, SubMove } from '@bgf/engine';
import { BAR as REL_BAR, OFF as REL_OFF, opponentCountAt, ownerAt } from '@bgf/engine';
import type { ClientState, GameClientApi } from '@bgf/client';
import type { BoardInteraction, BoardLocation, BoardRendererProps } from './contract';
import { EMPTY_INTERACTION, locationKey, sameLocation, toRel } from './contract';
import { relToLocation } from './checkerTracker';
import { isInteractive } from './useBoardViewModel';

export interface UseBoardInteractionOptions {
  /** Stage immediately when a clicked source has exactly one legal destination. Default false. */
  quickMove?: boolean;
  /** How long an invalid flash stays in the interaction state (ms). Default 500. */
  invalidMs?: number;
  now?: () => number;
}

export type BoardHandlers = Required<
  Pick<
    BoardRendererProps,
    'onSelect' | 'onDrop' | 'onHover' | 'onActivate' | 'onDragStart' | 'onDragCancel'
  >
>;

export interface BoardInteractionResult {
  interaction: BoardInteraction;
  handlers: BoardHandlers;
  /** Last illegal interaction, for HUD feedback. */
  lastError: { at: number; message: string } | null;
  clearSelection: () => void;
  /** True while the game is a free board (no rule enforcement). */
  free: boolean;
}

/** Player-relative point for a location from `seat`'s point of view, or null if not usable as a source. */
export function sourceRel(seat: Player, loc: BoardLocation): number | null {
  if (loc.kind === 'point') return toRel(seat, loc.point);
  if (loc.kind === 'bar') return loc.player === seat ? REL_BAR : null;
  return null;
}

/** Player-relative destination for a location (0 = bear off), or null when it can't be a target. */
export function targetRel(seat: Player, loc: BoardLocation): number | null {
  if (loc.kind === 'point') return toRel(seat, loc.point);
  if (loc.kind === 'off') return loc.player === seat ? 0 : null;
  return null;
}

// ---- free board helpers -----------------------------------------------------------------

/** Colour of the checkers at a location (top of the stack), or null when empty. */
export function colourAt(board: Board, loc: BoardLocation): Player | null {
  if (loc.kind === 'point') return ownerAt(board, loc.point - 1);
  if (loc.kind === 'bar') return board.bar[loc.player] > 0 ? loc.player : null;
  return board.off[loc.player] > 0 ? loc.player : null;
}

/** A location in `colour`'s relative coordinates (25 bar, 0 off); null for the other colour's bar/tray. */
export function freeRel(colour: Player, loc: BoardLocation): number | null {
  if (loc.kind === 'point') return toRel(colour, loc.point);
  if (loc.kind === 'bar') return loc.player === colour ? REL_BAR : null;
  return loc.player === colour ? REL_OFF : null;
}

/** Every occupied location on a free board (both colours). */
export function freeSources(board: Board | null): BoardLocation[] {
  if (!board) return [];
  const out: BoardLocation[] = [];
  for (let i = 0; i < 24; i++)
    if ((board.points[i] ?? 0) !== 0) out.push({ kind: 'point', point: i + 1 });
  for (const player of ['white', 'black'] as const) {
    if (board.bar[player] > 0) out.push({ kind: 'bar', player });
    if (board.off[player] > 0) out.push({ kind: 'off', player });
  }
  return out;
}

function bestSingle(dests: Destination[]): Destination | null {
  const singles = dests.filter((d) => d.via.length === 1);
  if (singles.length === 0) return dests[0] ?? null;
  return singles.reduce((best, d) => (d.via[0]!.die > best.via[0]!.die ? d : best));
}

type Attempt = { ok: true } | { ok: false; silent?: boolean; message: string };

/**
 * Turns renderer events into client operations: click-to-select, click-to-move, drag-and-drop,
 * double-tap auto-move. In enforced mode moves are staged in the local draft; on a free board
 * they are sent straight to the server (shown optimistically until confirmed). Selection is
 * cleared whenever the snapshot changes.
 */
export function useBoardInteraction(
  client: GameClientApi,
  state: ClientState,
  seat: Player | null,
  opts: UseBoardInteractionOptions = {},
): BoardInteractionResult {
  const { quickMove = false, invalidMs = 500 } = opts;
  const now = opts.now ?? Date.now;
  const [interaction, setInteraction] = useState<BoardInteraction>(EMPTY_INTERACTION);
  const [lastError, setLastError] = useState<{ at: number; message: string } | null>(null);
  const invalidTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactive = isInteractive(state, seat);
  const game = state.snapshot?.match.game ?? null;
  const board = game?.board ?? null;
  const free = game?.phase.kind === 'free';
  const seq = state.snapshot?.seq ?? -1;
  const errorAt = state.error?.at ?? null;

  const sourceKeys = useMemo(() => {
    if (!seat) return new Set<string>();
    if (free) return new Set(freeSources(board).map(locationKey));
    return new Set(state.draft.next.map((m) => locationKey(relToLocation(seat, m.from))));
  }, [free, board, state.draft.next, seat]);

  // Adjust transient state during render when the authoritative state moves on.
  const [seenSeq, setSeenSeq] = useState(seq);
  const [seenError, setSeenError] = useState(errorAt);
  let current = interaction;
  if (seenSeq !== seq) {
    setSeenSeq(seq);
    if (current.selected || current.dragging || current.pendingFree) {
      current = { ...current, selected: null, dragging: null, pendingFree: null };
      setInteraction(current);
    }
  }
  if (seenError !== errorAt) {
    setSeenError(errorAt);
    if (current.pendingFree) {
      // The server refused the move: drop the optimistic overlay so the checker snaps back.
      current = { ...current, pendingFree: null };
      setInteraction(current);
    }
  }
  if (current.selected && !sourceKeys.has(locationKey(current.selected))) {
    // The selection is no longer a legal source (e.g. after staging).
    current = { ...current, selected: null };
    setInteraction(current);
  }

  useEffect(
    () => () => {
      if (invalidTimer.current) clearTimeout(invalidTimer.current);
    },
    [],
  );

  const flagInvalid = useCallback(
    (location: BoardLocation, message: string) => {
      const at = now();
      setLastError({ at, message });
      setInteraction((i) => ({ ...i, invalid: { location, at, message } }));
      if (invalidTimer.current) clearTimeout(invalidTimer.current);
      invalidTimer.current = setTimeout(() => {
        setInteraction((i) => (i.invalid && i.invalid.at === at ? { ...i, invalid: null } : i));
      }, invalidMs);
    },
    [invalidMs, now],
  );

  const isSource = useCallback(
    (loc: BoardLocation) => sourceKeys.has(locationKey(loc)),
    [sourceKeys],
  );

  // ---- enforced mode: draft staging ----
  const tryStage = useCallback(
    (from: BoardLocation, to: BoardLocation): boolean => {
      if (!seat) return false;
      const fromRel = sourceRel(seat, from);
      const toRelPoint = targetRel(seat, to);
      if (fromRel === null || toRelPoint === null) return false;
      const dest = client.destinations(fromRel).find((d) => d.to === toRelPoint);
      if (!dest) return false;
      try {
        client.stage(dest.via as SubMove[]);
        return true;
      } catch {
        return false;
      }
    },
    [client, seat],
  );

  const stageBest = useCallback(
    (from: BoardLocation): boolean => {
      if (!seat) return false;
      const fromRel = sourceRel(seat, from);
      if (fromRel === null) return false;
      const best = bestSingle(client.destinations(fromRel));
      if (!best) return false;
      try {
        client.stage(best.via as SubMove[]);
        return true;
      } catch {
        return false;
      }
    },
    [client, seat],
  );

  // ---- free board: send a move (pre-checked locally for instant feedback) ----
  const tryFree = useCallback(
    (from: BoardLocation, to: BoardLocation): Attempt => {
      if (!board || !seat) return { ok: false, message: 'Not connected.' };
      const colour = colourAt(board, from);
      if (!colour) return { ok: false, message: 'Nothing to pick up there.' };
      const fromRel = freeRel(colour, from);
      const toRel = freeRel(colour, to);
      if (fromRel === null || toRel === null) {
        return {
          ok: false,
          message: `That is the other colour's ${to.kind === 'bar' ? 'bar' : 'tray'}.`,
        };
      }
      if (fromRel === toRel) return { ok: false, silent: true, message: '' };
      if (to.kind === 'point' && opponentCountAt(board, colour, toRel) >= 2) {
        return { ok: false, message: 'That point is blocked.' };
      }
      try {
        client.freeMove(colour, fromRel, toRel);
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'Could not move.' };
      }
      setInteraction((i) => ({
        ...i,
        selected: null,
        dragging: null,
        pendingFree: { checker: colour, from, to, seq, at: now() },
      }));
      return { ok: true };
    },
    [board, seat, client, seq, now],
  );

  const onSelect = useCallback(
    (loc: BoardLocation) => {
      if (!interactive || !seat) {
        flagInvalid(loc, free ? 'Not connected.' : 'It is not your turn to move.');
        return;
      }
      const selected = current.selected;
      if (free) {
        if (selected) {
          if (sameLocation(selected, loc)) {
            setInteraction((i) => ({ ...i, selected: null }));
            return;
          }
          const r = tryFree(selected, loc);
          if (!r.ok && !r.silent) flagInvalid(loc, r.message);
          return;
        }
        if (isSource(loc)) {
          setInteraction((i) => ({ ...i, selected: loc }));
          return;
        }
        flagInvalid(loc, 'Nothing to pick up there.');
        return;
      }
      if (isSource(loc)) {
        if (selected && sameLocation(selected, loc)) {
          setInteraction((i) => ({ ...i, selected: null }));
          return;
        }
        if (quickMove) {
          const fromRel = sourceRel(seat, loc);
          const dests = fromRel === null ? [] : client.destinations(fromRel);
          if (dests.length === 1 && stageBest(loc)) {
            setInteraction((i) => ({ ...i, selected: null }));
            return;
          }
        }
        setInteraction((i) => ({ ...i, selected: loc }));
        return;
      }
      if (selected) {
        if (tryStage(selected, loc)) {
          setInteraction((i) => ({ ...i, selected: null }));
          return;
        }
        flagInvalid(loc, 'That checker cannot move there.');
        return;
      }
      flagInvalid(loc, 'No checker there can move.');
    },
    [
      interactive,
      seat,
      free,
      current.selected,
      isSource,
      quickMove,
      client,
      stageBest,
      tryStage,
      tryFree,
      flagInvalid,
    ],
  );

  const onActivate = useCallback(
    (loc: BoardLocation) => {
      if (!interactive || !seat) return;
      if (free) {
        // Double-tap on a free board sends the checker to its tray.
        const colour = board ? colourAt(board, loc) : null;
        if (!colour || loc.kind === 'off') return;
        const r = tryFree(loc, { kind: 'off', player: colour });
        if (!r.ok && !r.silent) flagInvalid(loc, r.message);
        return;
      }
      if (isSource(loc) && stageBest(loc)) {
        setInteraction((i) => ({ ...i, selected: null }));
        return;
      }
      if (current.selected && tryStage(current.selected, loc)) {
        setInteraction((i) => ({ ...i, selected: null }));
        return;
      }
      flagInvalid(loc, 'No legal move for that checker.');
    },
    [
      interactive,
      seat,
      free,
      board,
      tryFree,
      isSource,
      stageBest,
      current.selected,
      tryStage,
      flagInvalid,
    ],
  );

  const onDragStart = useCallback(
    (from: BoardLocation) => {
      if (!interactive || !isSource(from)) return;
      setInteraction((i) => ({ ...i, dragging: from, selected: null }));
    },
    [interactive, isSource],
  );

  const onDragCancel = useCallback(() => {
    setInteraction((i) => (i.dragging ? { ...i, dragging: null } : i));
  }, []);

  const onDrop = useCallback(
    (from: BoardLocation, to: BoardLocation) => {
      setInteraction((i) => ({ ...i, dragging: null }));
      if (!interactive || !seat) {
        flagInvalid(to, free ? 'Not connected.' : 'It is not your turn to move.');
        return;
      }
      if (sameLocation(from, to)) return;
      if (free) {
        const r = tryFree(from, to);
        if (!r.ok && !r.silent) flagInvalid(to, r.message);
        return;
      }
      if (!tryStage(from, to)) flagInvalid(to, 'That checker cannot move there.');
    },
    [interactive, seat, free, tryFree, tryStage, flagInvalid],
  );

  const onHover = useCallback((loc: BoardLocation | null) => {
    setInteraction((i) => (sameLocation(i.hovered, loc) ? i : { ...i, hovered: loc }));
  }, []);

  const clearSelection = useCallback(() => {
    setInteraction((i) => ({ ...i, selected: null, dragging: null }));
  }, []);

  const handlers = useMemo<BoardHandlers>(
    () => ({ onSelect, onDrop, onHover, onActivate, onDragStart, onDragCancel }),
    [onSelect, onDrop, onHover, onActivate, onDragStart, onDragCancel],
  );

  return { interaction: current, handlers, lastError, clearSelection, free };
}
