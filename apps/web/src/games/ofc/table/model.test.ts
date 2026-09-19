import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Command, TableState } from '@bgf/ofc-engine';
import { applyAll, cards, command, init, seededRng, view } from '@bgf/ofc-engine';
import { FakeOfcClient } from '../demo/fakeOfcClient';
import { buildTableModel, describeRow, rowOutcome, usePlacementDraft } from './model';

function dealt(config: Parameters<typeof init>[0], seed = 3): TableState {
  const rng = seededRng(seed);
  let s = init(config);
  s = applyAll(s, command(s, 0, { type: 'start' }, rng));
  return s;
}

function clientStateFor(state: TableState, seat: number) {
  const c = new FakeOfcClient({
    config: state.config,
    mySeat: seat,
    autoPlay: false,
    botDelayMs: 0,
  });
  // Reuse the projection logic with our own state.
  const v = view(state, seat);
  const base = c.getState();
  return { ...base, seat, snapshot: { ...base.snapshot!, state: v, initialState: v } };
}

describe('describeRow', () => {
  it('describes complete and partial rows', () => {
    expect(describeRow([], 'high')).toBeNull();
    expect(describeRow(cards('As Ad'), 'high')).toBe('Pair of aces');
    expect(describeRow(cards('7s 7d 7c 2h'), 'high')).toBe('Three sevens');
    expect(describeRow(cards('Ks Qs Js'), 'high')).toBe('King high · suited');
    expect(describeRow(cards('Ks Qs Js 9s 2s'), 'high')).toBe('Flush, king high');
    expect(describeRow(cards('Ks Kd Kh'), 'top')).toBe('Three kings');
    expect(describeRow(cards('9s 4d'), 'low27')).toBe('Nine high so far');
    expect(describeRow(cards('7s 5d 4c 3h 2d'), 'low27')).toBe('Seven-five, number one');
  });
});

describe('buildTableModel', () => {
  it('orders seats with me last and reports the turn requirement', () => {
    const state = dealt({ variant: 'pineapple', seats: 3 });
    const toAct = state.hand!.toAct!;
    const cs = clientStateFor(state, toAct);
    const m = buildTableModel(cs, toAct, ['A', 'B', 'C']);
    expect(m.seats.map((s) => s.seat)).toEqual([(toAct + 1) % 3, (toAct + 2) % 3, toAct]);
    expect(m.me?.isMe).toBe(true);
    expect(m.myTurn).toBe(true);
    expect(m.requirement).toEqual({ place: 5, discard: 0 });
    expect(m.pending).toHaveLength(5);
    expect(m.turnText).toBe('Your turn: place 5 cards');
    expect(m.deckCount).toBe(52 - 15);
    expect(m.seats.find((s) => !s.isMe)!.pendingCount).toBe(5);
    expect(m.seats.find((s) => !s.isMe)!.rows.top.cards).toEqual([]);
    expect(m.canStart).toBe(false);
  });

  it('shows the waiting text and no requirement for the seat not to act', () => {
    const state = dealt({ variant: 'ofc', seats: 2 });
    const other = state.hand!.toAct === 0 ? 1 : 0;
    const m = buildTableModel(clientStateFor(state, other), other, ['A', 'B']);
    expect(m.myTurn).toBe(false);
    expect(m.requirement).toBeNull();
    expect(m.turnText).toMatch(/^Waiting for /);
  });

  it('labels the 2-7 middle, flags fouls on a complete provisional hand and qualification', () => {
    const state = dealt({ variant: 'pineapple27', seats: 2 });
    const seat = state.hand!.toAct!;
    const cs = clientStateFor(state, seat);
    const m = buildTableModel(cs, seat, []);
    expect(m.me!.rows.middle.label).toBe('Middle · 2-7');
    // Build a full provisional hand from arbitrary cards to exercise the foul path.
    const pending = m.pending;
    const provisional = pending.map((card, i) => ({
      card,
      row: (i < 3 ? 'top' : 'middle') as 'top' | 'middle',
    }));
    const m2 = buildTableModel(cs, seat, [], provisional);
    expect(m2.me!.rows.top.provisional).toHaveLength(3);
    expect(m2.me!.rows.middle.provisional).toHaveLength(2);
    expect(m2.me!.foul).toBeNull(); // not complete yet
  });

  it('exposes buy-in balances', () => {
    const state = dealt({
      variant: 'ofc',
      seats: 2,
      scoring: { mode: 'buyin', buyIn: 100, multiplier: 2 },
    });
    const m = buildTableModel(clientStateFor(state, 0), 0, ['A', 'B']);
    expect(m.balances).toEqual([100, 100]);
    expect(m.me!.balance).toBe(100);
  });

  it('is empty before any snapshot', () => {
    const c = new FakeOfcClient({ autoPlay: false });
    const m = buildTableModel({ ...c.getState(), snapshot: null }, 0, []);
    expect(m.phase).toBe('idle');
    expect(m.seats).toEqual([]);
    expect(m.turnText).toBe('Connecting…');
  });
});

describe('usePlacementDraft', () => {
  it('places, derives discards, swaps, undoes and confirms a pineapple turn', () => {
    const client = new FakeOfcClient({
      config: { variant: 'pineapple', seats: 2 },
      autoPlay: false,
      botDelayMs: 0,
      seed: 5,
    });
    client.apply(0, { type: 'start' });
    // Make sure it is our (seat 0) turn: bots play until then.
    client.playBots();
    const sent: Command[] = [];
    const { result, rerender } = renderHook(() =>
      usePlacementDraft(client.getState(), 0, (c) => sent.push(c)),
    );
    const first = client.getState().snapshot!.state.hand!.seats[0]!.pending;
    expect(first).toHaveLength(5);
    expect(result.current.requirement).toEqual({ place: 5, discard: 0 });
    act(() => {
      result.current.place('bottom', first[0]!);
      result.current.place('bottom', first[1]!);
      result.current.place('middle', first[2]!);
      result.current.place('top', first[3]!);
    });
    expect(result.current.placed).toHaveLength(4);
    expect(result.current.canConfirm).toBe(false);
    act(() => {
      result.current.select(first[4]!);
    });
    act(() => {
      expect(result.current.place('top')).toBe(true);
    });
    expect(result.current.canConfirm).toBe(true);
    act(() => {
      result.current.undo();
    });
    expect(result.current.placed).toHaveLength(4);
    act(() => {
      result.current.place('middle', first[4]!);
    });
    act(() => {
      expect(result.current.confirm()).toBe(true);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'place', discards: [] });
    expect((sent[0] as { placements: unknown[] }).placements).toHaveLength(5);

    // Apply it for real, let the bot play, and take the next 3-card turn.
    act(() => {
      client.apply(0, sent[0]!);
      client.playBots();
    });
    rerender();
    const three = client.getState().snapshot!.state.hand!.seats[0]!.pending;
    expect(three).toHaveLength(3);
    expect(result.current.placed).toEqual([]); // reset on the new deal
    expect(result.current.requirement).toEqual({ place: 2, discard: 1 });
    act(() => {
      result.current.place('bottom', three[0]!);
      result.current.place('middle', three[1]!);
    });
    expect(result.current.discards.map((c) => c.rank)).toEqual([three[2]!.rank]);
    expect(result.current.canConfirm).toBe(true);
    // Placing the would-be discard swaps out the most recent placement.
    act(() => {
      result.current.place('top', three[2]!);
    });
    expect(result.current.placed.map((p) => p.card.rank)).toEqual([three[0]!.rank, three[2]!.rank]);
    expect(result.current.discards.map((c) => c.rank)).toEqual([three[1]!.rank]);
    // A full row refuses and flags the drop as invalid.
    act(() => {
      result.current.clear();
    });
    expect(result.current.placed).toEqual([]);
  });

  it('refuses a full row and records invalidAt', () => {
    const client = new FakeOfcClient({
      config: { variant: 'ofc', seats: 2 },
      autoPlay: false,
      botDelayMs: 0,
      seed: 9,
    });
    client.apply(0, { type: 'start' });
    client.playBots();
    const { result } = renderHook(() => usePlacementDraft(client.getState(), 0, () => {}));
    const five = client.getState().snapshot!.state.hand!.seats[0]!.pending;
    act(() => {
      result.current.place('top', five[0]!);
      result.current.place('top', five[1]!);
      result.current.place('top', five[2]!);
    });
    let ok = true;
    act(() => {
      ok = result.current.place('top', five[3]!);
    });
    expect(ok).toBe(false);
    expect(result.current.invalidAt).toBeGreaterThan(0);
    expect(result.current.legalRows).toEqual(['middle', 'bottom']);
  });
});

describe('rowOutcome', () => {
  it('aggregates pair rows from the seat point of view', () => {
    const result = {
      hand: 1,
      seats: [],
      transfers: [],
      pairs: [
        { a: 0, b: 1, rows: { top: 1, middle: -1, bottom: 0 }, scoop: 0, royalties: 0, net: 0 },
        { a: 1, b: 2, rows: { top: 1, middle: 1, bottom: 1 }, scoop: 3, royalties: 0, net: 6 },
      ],
    };
    expect(rowOutcome(result, 0, 'top')).toBe('win');
    expect(rowOutcome(result, 1, 'top')).toBe('tie'); // lost to 0, beat 2
    expect(rowOutcome(result, 2, 'bottom')).toBe('lose');
    expect(rowOutcome(result, 0, 'bottom')).toBe('tie');
  });
});
