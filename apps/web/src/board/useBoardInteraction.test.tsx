import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, act } from '@testing-library/react';
import { boardFrom, scriptedDice } from '@bgf/engine';
import { createFakeClient } from './testing/fakeClient';
import { useBoardInteraction } from './useBoardInteraction';
import type { UseBoardInteractionOptions } from './useBoardInteraction';

afterEach(cleanup);

function setup(opts: UseBoardInteractionOptions = {}) {
  const client = createFakeClient({ seat: 'white', dice: scriptedDice([3, 1, 4, 2]) });
  client.startGame();
  client.openingRoll();
  client.opponentOpeningRoll(); // white to move 3-1
  const hook = renderHook(() => useBoardInteraction(client, client.getState(), 'white', opts));
  return { client, hook };
}

describe('useBoardInteraction', () => {
  it('select source, click target stages the move; clicking the source again deselects', () => {
    const { client, hook } = setup();
    act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 8 }));
    expect(hook.result.current.interaction.selected).toEqual({ kind: 'point', point: 8 });
    act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 8 }));
    expect(hook.result.current.interaction.selected).toBeNull();
    act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 8 }));
    act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 5 }));
    hook.rerender();
    expect(client.getState().draft.played).toEqual([{ from: 8, to: 5, die: 3, hit: false }]);
    expect(hook.result.current.interaction.selected).toBeNull();
    expect(hook.result.current.lastError).toBeNull();
  });

  it('combined destinations stage two sub-moves', () => {
    const { client, hook } = setup();
    act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 8 }));
    act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 4 }));
    expect(client.getState().draft.played).toHaveLength(2);
    expect(client.getState().draft.complete).toBe(true);
  });

  it('flags illegal clicks and clears the flag', () => {
    vi.useFakeTimers();
    try {
      const { client, hook } = setup({ invalidMs: 100 });
      act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 3 }));
      expect(hook.result.current.interaction.invalid?.location).toEqual({
        kind: 'point',
        point: 3,
      });
      expect(hook.result.current.lastError?.message).toMatch(/No checker/);
      act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 8 }));
      act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 1 }));
      expect(hook.result.current.lastError?.message).toMatch(/cannot move there/);
      expect(client.getState().draft.played).toEqual([]);
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(hook.result.current.interaction.invalid).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drag and drop stages when legal and cancels otherwise', () => {
    const { client, hook } = setup();
    act(() => hook.result.current.handlers.onDragStart({ kind: 'point', point: 13 }));
    expect(hook.result.current.interaction.dragging).toEqual({ kind: 'point', point: 13 });
    act(() =>
      hook.result.current.handlers.onDrop(
        { kind: 'point', point: 13 },
        { kind: 'point', point: 10 },
      ),
    );
    expect(hook.result.current.interaction.dragging).toBeNull();
    expect(client.getState().draft.played).toEqual([{ from: 13, to: 10, die: 3, hit: false }]);
    act(() =>
      hook.result.current.handlers.onDrop({ kind: 'point', point: 6 }, { kind: 'point', point: 2 }),
    );
    expect(client.getState().draft.played).toHaveLength(1);
    expect(hook.result.current.lastError?.message).toMatch(/cannot move there/);
    act(() => hook.result.current.handlers.onDragStart({ kind: 'point', point: 3 })); // not a source
    expect(hook.result.current.interaction.dragging).toBeNull();
  });

  it('activate auto-plays the highest die; quick move stages single-destination sources', () => {
    const { client, hook } = setup();
    act(() => hook.result.current.handlers.onActivate({ kind: 'point', point: 24 }));
    expect(client.getState().draft.played).toEqual([{ from: 24, to: 21, die: 3, hit: false }]);
    act(() => client.unstage());
    hook.rerender();
    const q = setup({ quickMove: true });
    // 24 has two destinations (21, 23) → selects; stage 3 elsewhere first so only die 1 remains.
    act(() => q.hook.result.current.handlers.onSelect({ kind: 'point', point: 24 }));
    expect(q.hook.result.current.interaction.selected).toEqual({ kind: 'point', point: 24 });
    act(() => q.hook.result.current.handlers.onSelect({ kind: 'point', point: 21 }));
    q.hook.rerender();
    act(() => q.hook.result.current.handlers.onSelect({ kind: 'point', point: 6 }));
    expect(q.client.getState().draft.played).toEqual([
      { from: 24, to: 21, die: 3, hit: false },
      { from: 6, to: 5, die: 1, hit: false },
    ]);
  });

  it('ignores interaction when it is not my turn and clears selection when the snapshot changes', () => {
    const client = createFakeClient({ seat: 'black', dice: scriptedDice([3, 1]) });
    client.startGame();
    client.applyAs('white', { type: 'opening-roll', player: 'white', die: 3 });
    client.applyAs('black', { type: 'opening-roll', player: 'black', die: 1 });
    const hook = renderHook(() => useBoardInteraction(client, client.getState(), 'black'));
    act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 19 }));
    expect(hook.result.current.interaction.selected).toBeNull();
    expect(hook.result.current.lastError?.message).toMatch(/not your turn/);
    // hover is always tracked
    act(() => hook.result.current.handlers.onHover({ kind: 'point', point: 1 }));
    expect(hook.result.current.interaction.hovered).toEqual({ kind: 'point', point: 1 });

    const mine = setup();
    act(() => mine.hook.result.current.handlers.onSelect({ kind: 'point', point: 8 }));
    expect(mine.hook.result.current.interaction.selected).not.toBeNull();
    act(() =>
      mine.client.applyAs('white', {
        type: 'play',
        player: 'white',
        play: [
          { from: 8, to: 5, die: 3, hit: false },
          { from: 6, to: 5, die: 1, hit: false },
        ],
      }),
    );
    mine.hook.rerender();
    expect(mine.hook.result.current.interaction.selected).toBeNull();
  });

  describe('free board', () => {
    function freeSetup(seat: 'white' | 'black' = 'black') {
      const client = createFakeClient({ seat, config: { length: 5, rules: 'free' } });
      client.startGame();
      const hook = renderHook(() => useBoardInteraction(client, client.getState(), seat));
      return { client, hook };
    }

    it('any occupied location is a source for either seat; a move is sent, not staged', () => {
      const { client, hook } = freeSetup('black');
      expect(hook.result.current.free).toBe(true);
      // black picks up a WHITE checker from abs 13 (white's 13-point) and drops it on abs 10
      act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 13 }));
      expect(hook.result.current.interaction.selected).toEqual({ kind: 'point', point: 13 });
      act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 10 }));
      hook.rerender();
      const board = client.getState().snapshot!.match.game!.board;
      expect(board.points[12]).toBe(4); // abs 13
      expect(board.points[9]).toBe(1); // abs 10
      expect(client.getState().draft.played).toEqual([]);
      expect(hook.result.current.interaction.selected).toBeNull();
      expect(hook.result.current.lastError).toBeNull();
    });

    it('drag-and-drop onto a lone opposing checker hits it; a held point is refused locally', () => {
      const { client, hook } = freeSetup('white');
      // Put a lone white checker on abs 10 first.
      act(() => client.freeMove('white', 13, 10));
      hook.rerender();
      // black's 5 checkers at abs 12 (black rel 13) → drag one onto abs 10 (black rel 15)
      act(() => hook.result.current.handlers.onDragStart({ kind: 'point', point: 12 }));
      expect(hook.result.current.interaction.dragging).toEqual({ kind: 'point', point: 12 });
      act(() =>
        hook.result.current.handlers.onDrop(
          { kind: 'point', point: 12 },
          { kind: 'point', point: 10 },
        ),
      );
      hook.rerender();
      const board = client.getState().snapshot!.match.game!.board;
      expect(board.points[9]).toBe(-1);
      expect(board.bar.white).toBe(1);
      // abs 6 holds five white checkers: blocked, nothing sent, invalid flash
      const seqBefore = client.getState().snapshot!.seq;
      act(() =>
        hook.result.current.handlers.onDrop(
          { kind: 'point', point: 12 },
          { kind: 'point', point: 6 },
        ),
      );
      expect(client.getState().snapshot!.seq).toBe(seqBefore);
      expect(hook.result.current.lastError?.message).toMatch(/blocked/i);
      expect(hook.result.current.interaction.invalid?.location).toEqual({
        kind: 'point',
        point: 6,
      });
    });

    it('bar and tray belong to a colour; double-tap bears a checker off', () => {
      const { client, hook } = freeSetup('white');
      // white checker to black's tray is refused without sending
      const seq = client.getState().snapshot!.seq;
      act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 6 }));
      act(() => hook.result.current.handlers.onSelect({ kind: 'off', player: 'black' }));
      expect(client.getState().snapshot!.seq).toBe(seq);
      expect(hook.result.current.lastError?.message).toMatch(/other colour/i);
      // own tray works via double-tap (activate)
      act(() => hook.result.current.handlers.onActivate({ kind: 'point', point: 6 }));
      hook.rerender();
      expect(client.getState().snapshot!.match.game!.board.off.white).toBe(1);
      // and back from the tray onto the bar
      act(() => hook.result.current.handlers.onSelect({ kind: 'off', player: 'white' }));
      act(() => hook.result.current.handlers.onSelect({ kind: 'bar', player: 'white' }));
      hook.rerender();
      expect(client.getState().snapshot!.match.game!.board.bar.white).toBe(1);
      expect(client.getState().snapshot!.match.game!.board.off.white).toBe(0);
    });

    it('records the sent move as pending until the snapshot advances', () => {
      const client = createFakeClient({
        seat: 'white',
        config: { length: 5, rules: 'free' },
      });
      client.startGame();
      // Freeze the fake so the move is "in flight": capture the state before the move applies.
      const hook = renderHook(
        ({ s }: { s: ReturnType<typeof client.getState> }) =>
          useBoardInteraction(client, s, 'white'),
        { initialProps: { s: client.getState() } },
      );
      const before = client.getState();
      act(() =>
        hook.result.current.handlers.onDrop(
          { kind: 'point', point: 8 },
          { kind: 'point', point: 9 },
        ),
      );
      // hook still sees the old snapshot → pending overlay present
      hook.rerender({ s: before });
      expect(hook.result.current.interaction.pendingFree).toMatchObject({
        checker: 'white',
        from: { kind: 'point', point: 8 },
        to: { kind: 'point', point: 9 },
        seq: before.snapshot!.seq,
      });
      hook.rerender({ s: client.getState() });
      expect(hook.result.current.interaction.pendingFree).toBeNull();
    });

    it('a board built from a position exposes both colours as sources', () => {
      const board = boardFrom({ 5: 2, 13: 13 }, { 24: 1, 13: 14 });
      const client = createFakeClient({ seat: 'black', config: { length: 5, rules: 'free' } });
      client.startGame();
      client.replaceBoard(board);
      const hook = renderHook(() => useBoardInteraction(client, client.getState(), 'black'));
      act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 5 })); // white checkers
      expect(hook.result.current.interaction.selected).toEqual({ kind: 'point', point: 5 });
      act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 5 })); // deselect
      expect(hook.result.current.interaction.selected).toBeNull();
      act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 3 })); // empty
      expect(hook.result.current.lastError?.message).toMatch(/nothing to pick up/i);
      act(() => hook.result.current.handlers.onSelect({ kind: 'point', point: 1 })); // black checker
      expect(hook.result.current.interaction.selected).toEqual({ kind: 'point', point: 1 });
    });
  });
});
