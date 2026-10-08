import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook, act } from '@testing-library/react';
import type { Die } from '@bgf/engine';
import { BAR, boardFrom, scriptedDice, turnOptions } from '@bgf/engine';
import { makeState } from '../test/state';
import { createFakeClient } from './testing/fakeClient';
import { useBoardViewModel } from './useBoardViewModel';
import { EMPTY_INTERACTION, locationKey } from './contract';
import type { BoardInteraction } from './contract';

afterEach(cleanup);

function setup(interaction: BoardInteraction = EMPTY_INTERACTION) {
  const client = createFakeClient({ seat: 'white', dice: scriptedDice([3, 1, 4, 2]) });
  client.startGame();
  const hook = renderHook(
    ({ i }: { i: BoardInteraction }) =>
      useBoardViewModel(client.getState(), { seat: 'white', perspective: 'white', interaction: i }),
    { initialProps: { i: interaction } },
  );
  return { client, hook };
}

describe('useBoardViewModel', () => {
  it('shows opening dice, then turn dice with sources when it is my turn', () => {
    const { client, hook } = setup();
    expect(hook.result.current.homeSide).toBe('left');
    expect(hook.result.current.openingDice).toEqual({ ties: 0 });
    expect(hook.result.current.dice).toBeNull();
    expect(hook.result.current.interactive).toBe(false);
    act(() => client.openingRoll()); // white 3
    hook.rerender({ i: EMPTY_INTERACTION });
    expect(hook.result.current.openingDice).toEqual({ white: 3, ties: 0 });
    act(() => client.opponentOpeningRoll()); // black 1 → white moves 3-1
    hook.rerender({ i: EMPTY_INTERACTION });
    const vm = hook.result.current;
    expect(vm.openingDice).toBeNull();
    expect(vm.dice).toMatchObject({ player: 'white', values: [3, 1], used: [false, false] });
    expect(vm.interactive).toBe(true);
    expect(vm.highlights.sources.map(locationKey).sort()).toEqual(['p13', 'p24', 'p6', 'p8']);
    expect(vm.checkers).toHaveLength(30);
    expect(vm.pips).toEqual({ white: 167, black: 167 });
    expect(vm.cube).toEqual({ value: 1, owner: 'center' });
    expect(vm.names).toEqual({ white: 'White', black: 'Black' });
  });

  it('computes targets for the selected source, staged moves move checkers and consume dice', () => {
    const { client, hook } = setup();
    act(() => {
      client.openingRoll();
      client.opponentOpeningRoll();
    });
    hook.rerender({ i: { ...EMPTY_INTERACTION, selected: { kind: 'point', point: 8 } } });
    let vm = hook.result.current;
    expect(vm.highlights.targets.map(locationKey).sort()).toEqual(['p5', 'p7']);
    expect(vm.highlights.combinedTargets.map(locationKey)).toEqual(['p4']);
    const on8 = () => hook.result.current.checkers.filter((c) => locationKey(c.location) === 'p8');
    const top = on8().find((c) => c.index === 2)!;
    act(() => client.stage({ from: 8, to: 5, die: 3, hit: false }));
    hook.rerender({ i: EMPTY_INTERACTION });
    vm = hook.result.current;
    expect(on8()).toHaveLength(2);
    const moved = vm.checkers.find((c) => c.id === top.id)!;
    expect(moved.location).toEqual({ kind: 'point', point: 5 });
    expect(moved.ghost).toBeUndefined();
    expect(vm.dice!.used).toEqual([true, false]);
    // hovering a source shows its targets when nothing is selected
    hook.rerender({ i: { ...EMPTY_INTERACTION, hovered: { kind: 'point', point: 6 } } });
    expect(hook.result.current.highlights.targets.map(locationKey)).toEqual(['p5']);
    // commit: the authoritative play moves the very same checker (no visual jump)
    act(() => client.stage({ from: 6, to: 5, die: 1, hit: false }));
    act(() => client.commit());
    hook.rerender({ i: EMPTY_INTERACTION });
    vm = hook.result.current;
    expect(vm.checkers.find((c) => c.id === top.id)!.location).toEqual({ kind: 'point', point: 5 });
    expect(vm.checkers.find((c) => c.id === top.id)!.recent).toBe(true);
    expect(vm.interactive).toBe(false);
    expect(vm.dice).toBeNull();
  });

  it('shows the opponent preview as ghosts with dice usage', () => {
    const client = createFakeClient({ seat: 'black', dice: scriptedDice([3, 1]) });
    client.startGame();
    act(() => {
      client.applyAs('white', { type: 'opening-roll', player: 'white', die: 3 });
      client.applyAs('black', { type: 'opening-roll', player: 'black', die: 1 });
    });
    const hook = renderHook(() =>
      useBoardViewModel(client.getState(), {
        seat: 'black',
        perspective: 'black',
        interaction: EMPTY_INTERACTION,
      }),
    );
    expect(hook.result.current.interactive).toBe(false);
    expect(hook.result.current.dice).toMatchObject({ player: 'white', used: [false, false] });
    act(() => client.setOpponentPreview([{ from: 8, to: 5, die: 3, hit: false }]));
    hook.rerender();
    const vm = hook.result.current;
    const ghosts = vm.checkers.filter((c) => c.ghost);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]!.location).toEqual({ kind: 'point', point: 5 });
    expect(vm.dice!.used).toEqual([true, false]);
    expect(vm.perspective).toBe('black');
  });

  it('marks hit checkers and moves them to the bar', () => {
    const board = boardFrom({ 5: 1, 13: 14 }, { 24: 1, 13: 14 });
    const client = createFakeClient({ seat: 'white', board });
    client.replaceBoard(board);
    const hook = renderHook(() =>
      useBoardViewModel(client.getState(), {
        seat: 'white',
        perspective: 'white',
        interaction: EMPTY_INTERACTION,
      }),
    );
    const blot = hook.result.current.checkers.find(
      (c) => c.player === 'white' && locationKey(c.location) === 'p5',
    )!;
    act(() => {
      client.patch({
        snapshot: {
          ...client.getState().snapshot!,
          match: {
            ...client.getState().snapshot!.match,
            game: {
              ...client.getState().snapshot!.match.game!,
              phase: { kind: 'to-roll', player: 'black' },
            },
          },
        },
      });
      client.rollFor('black', [4, 1]);
    });
    act(() =>
      client.applyAs('black', {
        type: 'play',
        player: 'black',
        play: [
          { from: 24, to: 20, die: 4, hit: true },
          { from: 20, to: 19, die: 1, hit: false },
        ],
      }),
    );
    hook.rerender();
    const after = hook.result.current.checkers.find((c) => c.id === blot.id)!;
    expect(after.location).toEqual({ kind: 'bar', player: 'white' });
    expect(after.hit).toBe(true);
    expect(after.recent).toBe(true);
  });

  it('reports the cube offer', () => {
    const client = createFakeClient({ seat: 'white', dice: scriptedDice([3, 1, 2, 2]) });
    client.startGame();
    act(() => {
      client.openingRoll();
      client.opponentOpeningRoll();
      client.stage([
        { from: 8, to: 5, die: 3, hit: false },
        { from: 6, to: 5, die: 1, hit: false },
      ]);
      client.commit();
      client.applyAs('black', { type: 'double', player: 'black' });
    });
    const hook = renderHook(() =>
      useBoardViewModel(client.getState(), {
        seat: 'white',
        perspective: 'white',
        interaction: EMPTY_INTERACTION,
      }),
    );
    expect(hook.result.current.cube).toEqual({ value: 1, owner: 'center', offeredBy: 'black' });
  });

  describe('free board', () => {
    it('is interactive for both seats, lists every stack as a source and draws no guidance', () => {
      const client = createFakeClient({ seat: 'black', config: { length: 5, rules: 'free' } });
      client.startGame();
      const hook = renderHook(
        ({ i }: { i: BoardInteraction }) =>
          useBoardViewModel(client.getState(), {
            seat: 'black',
            perspective: 'black',
            interaction: i,
          }),
        { initialProps: { i: EMPTY_INTERACTION } },
      );
      let vm = hook.result.current;
      expect(vm.interactive).toBe(true);
      expect(vm.dice).toBeNull();
      expect(vm.openingDice).toBeNull();
      expect(vm.highlights.sources).toHaveLength(8); // 4 stacks per colour
      expect(vm.highlights.targets).toEqual([]);
      expect(vm.highlights.quiet).toBe(true);
      // pick up a white checker from abs 13: still no targets or blocked markers, only the selection
      hook.rerender({ i: { ...EMPTY_INTERACTION, selected: { kind: 'point', point: 13 } } });
      vm = hook.result.current;
      expect(vm.highlights.selected).toEqual({ kind: 'point', point: 13 });
      expect(vm.highlights.targets).toEqual([]);
      expect(vm.highlights.combinedTargets).toEqual([]);
      expect(vm.highlights.blocked ?? []).toEqual([]);
    });

    it('shows the last free roll as dice and overlays a pending move optimistically', () => {
      const client = createFakeClient({
        seat: 'white',
        config: { length: 5, rules: 'free' },
        dice: scriptedDice([5, 2]),
      });
      client.startGame();
      act(() => client.freeRoll());
      const frozen = client.getState();
      const hook = renderHook(
        ({ i, s }: { i: BoardInteraction; s: typeof frozen }) =>
          useBoardViewModel(s, { seat: 'white', perspective: 'white', interaction: i }),
        { initialProps: { i: EMPTY_INTERACTION, s: frozen } },
      );
      expect(hook.result.current.dice).toMatchObject({ player: 'white', values: [5, 2] });
      const token = hook.result.current.dice!.rollToken;
      act(() => client.freeRoll());
      hook.rerender({ i: EMPTY_INTERACTION, s: client.getState() });
      expect(hook.result.current.dice!.rollToken).not.toBe(token);
      // pending overlay against the current seq moves a checker before the server answers
      const cur = client.getState();
      hook.rerender({
        i: {
          ...EMPTY_INTERACTION,
          pendingFree: {
            checker: 'white',
            from: { kind: 'point', point: 8 },
            to: { kind: 'point', point: 9 },
            seq: cur.snapshot!.seq,
            at: 1,
          },
        },
        s: cur,
      });
      const on9 = hook.result.current.checkers.filter((c) => locationKey(c.location) === 'p9');
      expect(on9).toHaveLength(1);
      expect(on9[0]!.player).toBe('white');
      expect(
        hook.result.current.checkers.filter((c) => locationKey(c.location) === 'p8'),
      ).toHaveLength(2);
    });
  });
});

describe('dice that cannot be played', () => {
  /** A state where `mover` is moving `dice` on `board`, seen from `seat`. */
  function moving(
    board: ReturnType<typeof boardFrom>,
    dice: [number, number],
    seat: 'white' | 'black',
    mover: 'white' | 'black' = 'white',
  ) {
    const base = makeState({ seat, actions: [{ type: 'start-game' }] });
    const game = {
      ...base.snapshot!.match.game!,
      board,
      phase: { kind: 'moving' as const, player: mover, dice: dice as [Die, Die] },
    };
    const snapshot = { ...base.snapshot!, match: { ...base.snapshot!.match, game } };
    const t = turnOptions(board, mover, dice as [Die, Die], []);
    const draft =
      mover === seat
        ? {
            played: [],
            board,
            next: t.next,
            remaining: t.remaining,
            complete: t.complete,
            maxMoves: t.maxMoves,
          }
        : base.draft;
    return { ...base, snapshot, draft };
  }
  const vmOf = (state: ReturnType<typeof moving>, seat: 'white' | 'black') =>
    renderHook(() =>
      useBoardViewModel(state, { seat, perspective: seat, interaction: EMPTY_INTERACTION }),
    ).result.current;

  it('greys out every die when there is no legal move, for both players', () => {
    // White on the bar against a closed board.
    const board = boardFrom({ [BAR]: 1, 13: 14 }, { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 13: 3 });
    expect(vmOf(moving(board, [3, 4], 'white'), 'white').dice).toMatchObject({
      used: [false, false],
      blocked: [true, true],
    });
    expect(vmOf(moving(board, [3, 4], 'black'), 'black').dice!.blocked).toEqual([true, true]);
  });

  // White has one checker on the bar and the rest on its 1-point (no bearing off while one is
  // out), so the only thing that can move is the entering checker.
  const white = { [BAR]: 1, 1: 14 };

  it('greys out the smaller die when only the larger one can be played', () => {
    // It can enter with the 6 only, and then the 1 is blocked (black holds the next point).
    const board = boardFrom(white, { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 7: 2, 13: 3 });
    expect(turnOptions(board, 'white', [6, 1], []).maxMoves).toBe(1);
    expect(vmOf(moving(board, [6, 1], 'white'), 'white').dice).toMatchObject({
      used: [false, false],
      blocked: [false, true],
    });
  });

  it('greys out the doubles that cannot all be played', () => {
    // It enters with one 2, and every further 2 is blocked.
    const board = boardFrom(white, { 1: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 13: 3 });
    expect(turnOptions(board, 'white', [2, 2], []).maxMoves).toBe(1);
    expect(vmOf(moving(board, [2, 2], 'white'), 'white').dice).toMatchObject({
      used: [false, false, false, false],
      blocked: [false, true, true, true],
    });
  });
});
