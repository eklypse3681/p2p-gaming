import { useMemo, useState } from 'react';
import type { Board, GamePhase, Player, SubMove } from '@bgf/engine';
import {
  BAR as REL_BAR,
  destinationsFrom,
  opponent,
  pipCount,
  startingBoard,
  turnStartBoard,
} from '@bgf/engine';
import type { ClientState } from '@bgf/client';
import type {
  BoardInteraction,
  BoardLocation,
  BoardViewModel,
  CheckerVM,
  CubeVM,
  DiceVM,
  HighlightsVM,
  HomeSide,
  OpeningDiceVM,
} from './contract';
import { DEFAULT_HOME_SIDE, locationKey, sameLocation, toRel } from './contract';
import type { Tracker } from './checkerTracker';
import {
  applyFreeMoveToTracker,
  applyPlayToTracker,
  createTracker,
  locationToRel,
  relToLocation,
  stacked,
  trackAction,
} from './checkerTracker';

export interface UseBoardViewModelOptions {
  seat: Player | null;
  perspective: Player;
  interaction: BoardInteraction;
  /** Which side the viewing player's home board is drawn on (default: left). */
  homeSide?: HomeSide;
}

interface TrackerCache {
  seq: number;
  matchId: string | null;
  tracker: Tracker;
  recent: Set<string>;
  hit: Set<string>;
}

function gameBoard(state: ClientState): Board {
  return state.snapshot?.match.game?.board ?? startingBoard();
}

function phaseOf(state: ClientState): GamePhase | null {
  return state.snapshot?.match.game?.phase ?? null;
}

/**
 * Keep the checker tracker in step with the authoritative snapshot. The cache is adjusted
 * during render (React's "adjusting state when a prop changes" pattern), keyed by snapshot
 * seq, so animation starts on the same frame the state arrives. The computation is
 * deterministic, so StrictMode's double render is harmless.
 */
function useTracker(state: ClientState): TrackerCache {
  const snap = state.snapshot;
  const seq = snap?.seq ?? -1;
  const matchId = snap?.id ?? null;
  const board = gameBoard(state);
  const [cache, setCache] = useState<TrackerCache>(() => ({
    seq,
    matchId,
    tracker: createTracker(board),
    recent: new Set<string>(),
    hit: new Set<string>(),
  }));
  if (cache.matchId !== matchId) {
    const next: TrackerCache = {
      seq,
      matchId,
      tracker: createTracker(board),
      recent: new Set(),
      hit: new Set(),
    };
    setCache(next);
    return next;
  }
  if (cache.seq !== seq) {
    const action =
      state.lastAction && state.lastAction.seq === seq ? state.lastAction.action : null;
    const res = trackAction(cache.tracker, action, board);
    const next: TrackerCache = {
      seq,
      matchId,
      tracker: res.tracker,
      recent: new Set(res.moved),
      hit: new Set(res.hit),
    };
    setCache(next);
    return next;
  }
  return cache;
}

function draftSources(state: ClientState, seat: Player): BoardLocation[] {
  const seen = new Set<string>();
  const out: BoardLocation[] = [];
  for (const m of state.draft.next) {
    const loc = relToLocation(seat, m.from);
    const k = locationKey(loc);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(loc);
    }
  }
  return out;
}

function relOf(seat: Player, loc: BoardLocation): number | null {
  if (loc.kind === 'point') return toRel(seat, loc.point);
  if (loc.kind === 'bar') return loc.player === seat ? REL_BAR : null;
  return null;
}

/**
 * Free board: every occupied location is a source so any checker can be picked up, but nothing
 * is marked as a target or blocked — a physical board gives no guidance. A drop onto a held point
 * simply bounces (the server refuses it), which the player discovers the way they would at a table.
 */
function freeHighlights(
  checkers: CheckerVM[],
  interaction: BoardInteraction,
  base: HighlightsVM,
): HighlightsVM {
  const byLoc = new Map<string, CheckerVM[]>();
  const sources: BoardLocation[] = [];
  for (const c of checkers) {
    if (c.ghost) continue;
    const k = locationKey(c.location);
    const arr = byLoc.get(k);
    if (arr) arr.push(c);
    else {
      byLoc.set(k, [c]);
      sources.push(c.location);
    }
  }
  return {
    ...base,
    sources,
    selected: interaction.selected,
    targets: [],
    combinedTargets: [],
    blocked: [],
    quiet: true,
    hovered: interaction.dragging ? interaction.hovered : null,
  };
}

function computeHighlights(
  state: ClientState,
  seat: Player | null,
  interaction: BoardInteraction,
  interactive: boolean,
  checkers: CheckerVM[],
): HighlightsVM {
  const none: HighlightsVM = {
    sources: [],
    selected: null,
    targets: [],
    combinedTargets: [],
    invalid: interaction.invalid
      ? { location: interaction.invalid.location, at: interaction.invalid.at }
      : null,
  };
  if (!seat || !interactive) return none;
  const phase = phaseOf(state);
  if (!phase) return none;
  if (phase.kind === 'free') return freeHighlights(checkers, interaction, none);
  if (phase.kind !== 'moving') return none;
  const sources = draftSources(state, seat);
  const focus = interaction.dragging ?? interaction.selected ?? interaction.hovered;
  const isSource = focus && sources.some((s) => sameLocation(s, focus));
  const targets: BoardLocation[] = [];
  const combined: BoardLocation[] = [];
  if (focus && isSource) {
    const from = relOf(seat, focus);
    if (from !== null) {
      const start = turnStartBoard(state.draft.board, seat, state.draft.played);
      for (const d of destinationsFrom(start, seat, phase.dice, state.draft.played, from)) {
        const loc = relToLocation(seat, d.to);
        (d.via.length === 1 ? targets : combined).push(loc);
      }
    }
  }
  return {
    ...none,
    sources,
    selected: interaction.selected,
    targets,
    combinedTargets: combined,
    hovered: interaction.dragging ? interaction.hovered : null,
  };
}

function diceVM(state: ClientState, seat: Player | null): DiceVM | null {
  const game = state.snapshot?.match.game;
  if (!game) return null;
  if (game.phase.kind === 'free') {
    const d = game.phase.dice;
    if (!d) return null;
    const doubles = d.dice[0] === d.dice[1];
    let rolls = 0;
    for (const h of game.history) if (h.type === 'free-roll') rolls++;
    const gameNumber = state.snapshot?.match.gameNumber ?? 0;
    return {
      player: d.player,
      values: d.dice,
      used: doubles ? [false, false, false, false] : [false, false],
      rollToken: gameNumber * 100000 + rolls,
    };
  }
  if (game.phase.kind !== 'moving') return null;
  const { player, dice } = game.phase;
  const doubles = dice[0] === dice[1];
  const slots = doubles ? 4 : 2;
  let usedCount = 0;
  let used: boolean[];
  if (player === seat) {
    used = doubles
      ? Array.from({ length: 4 }, (_, i) => i < 4 - state.draft.remaining.length)
      : [!state.draft.remaining.includes(dice[0]), !state.draft.remaining.includes(dice[1])];
  } else {
    const preview = state.opponentPreview ?? [];
    usedCount = preview.length;
    used = doubles
      ? Array.from({ length: 4 }, (_, i) => i < usedCount)
      : [preview.some((m) => m.die === dice[0]), preview.some((m) => m.die === dice[1])];
  }
  const gameNumber = state.snapshot?.match.gameNumber ?? 0;
  return {
    player,
    values: dice,
    used: used.slice(0, slots),
    rollToken: gameNumber * 1000 + game.turnCount,
  };
}

function openingVM(state: ClientState): OpeningDiceVM | null {
  const phase = phaseOf(state);
  if (!phase || phase.kind !== 'opening') return null;
  const out: OpeningDiceVM = { ties: phase.ties };
  if (phase.rolls.white !== undefined) out.white = phase.rolls.white;
  if (phase.rolls.black !== undefined) out.black = phase.rolls.black;
  return out;
}

function cubeVM(state: ClientState): CubeVM {
  const game = state.snapshot?.match.game;
  if (!game) return { value: 1, owner: 'center' };
  const out: CubeVM = { value: game.cube.value, owner: game.cube.owner };
  if (game.phase.kind === 'double-offered') out.offeredBy = game.phase.by;
  return out;
}

export function isInteractive(state: ClientState, seat: Player | null): boolean {
  if (!seat || state.status !== 'joined') return false;
  const phase = phaseOf(state);
  if (!phase) return false;
  if (phase.kind === 'free') return true;
  return phase.kind === 'moving' && phase.player === seat;
}

/**
 * Build the renderer view model from client state. Local draft moves are overlaid as real
 * moves (the checkers move as you stage them); the opponent's preview is overlaid as ghosts.
 */
export function useBoardViewModel(
  state: ClientState,
  opts: UseBoardViewModelOptions,
): BoardViewModel {
  const { seat, perspective, interaction } = opts;
  const homeSide = opts.homeSide ?? DEFAULT_HOME_SIDE;
  const cache = useTracker(state);
  const interactive = isInteractive(state, seat);
  const phase = phaseOf(state);
  const board = gameBoard(state);
  const draftPlayed = state.draft.played;
  const preview = state.opponentPreview;
  const seq = state.snapshot?.seq ?? -1;
  const pending = interaction.pendingFree ?? null;

  const checkers = useMemo<CheckerVM[]>(() => {
    let tracker = cache.tracker;
    const ghosts = new Set<string>();
    if (phase?.kind === 'free' && pending && pending.seq === seq) {
      // Optimistic: show the sent move until the server confirms (or rejects) it.
      tracker = applyFreeMoveToTracker(
        tracker,
        pending.checker,
        locationToRel(pending.checker, pending.from),
        locationToRel(pending.checker, pending.to),
      ).tracker;
    } else if (seat && interactive && phase?.kind === 'moving' && draftPlayed.length > 0) {
      tracker = applyPlayToTracker(tracker, seat, draftPlayed).tracker;
    } else if (
      seat &&
      preview &&
      preview.length > 0 &&
      phase?.kind === 'moving' &&
      phase.player !== seat
    ) {
      const res = applyPlayToTracker(tracker, phase.player, preview);
      tracker = res.tracker;
      for (const id of res.moved) ghosts.add(id);
      for (const id of res.hit) ghosts.add(id);
    }
    const list = stacked(tracker).map<CheckerVM>((c) => {
      const vm: CheckerVM = {
        id: c.id,
        player: c.player,
        location: c.location,
        index: c.index,
        stackSize: c.stackSize,
      };
      if (ghosts.has(c.id)) vm.ghost = true;
      if (cache.recent.has(c.id)) vm.recent = true;
      if (cache.hit.has(c.id)) vm.hit = true;
      return vm;
    });
    // Stable order (by id) so React keys never reorder the DOM.
    return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }, [cache, seat, interactive, draftPlayed, preview, phase, pending, seq]);

  const highlights = useMemo(
    () => computeHighlights(state, seat, interaction, interactive, checkers),
    [state, seat, interaction, interactive, checkers],
  );

  const dice = useMemo(() => diceVM(state, seat), [state, seat]);
  const openingDice = useMemo(() => openingVM(state), [state]);
  const cube = useMemo(() => cubeVM(state), [state]);
  const pips = useMemo(
    () => ({ white: pipCount(board, 'white'), black: pipCount(board, 'black') }),
    [board],
  );
  const names = useMemo(() => {
    const p = state.snapshot?.players;
    return {
      white: p?.white?.name ?? 'White',
      black: p?.black?.name ?? 'Black',
    };
  }, [state.snapshot?.players]);

  return useMemo<BoardViewModel>(
    () => ({
      perspective,
      homeSide,
      checkers,
      dice,
      openingDice,
      cube,
      highlights,
      interactive,
      pips,
      names,
    }),
    [
      perspective,
      homeSide,
      checkers,
      dice,
      openingDice,
      cube,
      highlights,
      interactive,
      pips,
      names,
    ],
  );
}

/** Helper for containers/tests: the opponent of a seat. */
export function otherSeat(seat: Player): Player {
  return opponent(seat);
}

export type { SubMove };
