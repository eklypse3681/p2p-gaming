import { describe, expect, it } from 'vitest';
import type { Action, TableConfig, TableState } from '@bgf/ofc-engine';
import { applyAll, init, seededRng, command, view } from '@bgf/ofc-engine';
import type { TableSnapshot } from '@bgf/protocol';
import type { OfcSnapshot } from './history';
import { computeOfcStats, describeSavedTable, summarizeTable } from './history';
import { ofcLedgerLines, ofcLedgerModel } from './ledger/model';

/** Play whole hands with a naive "fill bottom, then middle, then top" policy. */
function playHands(config: Partial<TableConfig>, hands: number): TableState {
  const rng = seededRng(11);
  let state = init(config);
  const log: Action[] = [];
  const apply = (actions: Action[]) => {
    log.push(...actions);
    state = applyAll(state, actions);
  };
  for (let h = 0; h < hands; h++) {
    apply(command(state, 0, { type: 'start' }, rng));
    let guard = 0;
    while (state.hand && state.hand.phase === 'setting' && guard++ < 100) {
      const seat = state.hand.seats.findIndex(
        (s, i) => !s.done && s.pending.length > 0 && (s.fantasyland || state.hand!.toAct === i),
      );
      if (seat < 0) break;
      const s = state.hand.seats[seat]!;
      const set = s.rows.top.length + s.rows.middle.length + s.rows.bottom.length;
      const place = s.fantasyland ? 13 - set : set === 0 ? s.pending.length : Math.min(2, 13 - set);
      const rows = {
        bottom: s.rows.bottom.length,
        middle: s.rows.middle.length,
        top: s.rows.top.length,
      };
      const placements = [];
      for (const card of s.pending.slice(0, place)) {
        const row = rows.bottom < 5 ? 'bottom' : rows.middle < 5 ? 'middle' : 'top';
        rows[row]++;
        placements.push({ card, row: row as 'top' | 'middle' | 'bottom' });
      }
      apply(
        command(state, seat, { type: 'place', placements, discards: s.pending.slice(place) }, rng),
      );
    }
  }
  return state;
}

function snapshotOf(
  state: TableState,
  seats: Array<{ id: string; name: string } | null>,
): OfcSnapshot {
  const s: TableSnapshot<TableState, Action, TableConfig> = {
    id: 't1',
    code: 'ABC234',
    seq: 9,
    createdAt: 10,
    updatedAt: 20,
    gameId: 'ofc',
    config: state.config,
    seats,
    hostSeat: 0,
    options: {},
    initialState: init(state.config),
    actions: [],
    state,
    chat: [],
  };
  return s;
}

describe('OFC history', () => {
  const seats = [
    { id: 'a', name: 'Alice' },
    { id: 'b', name: 'Bob' },
    { id: 'c', name: 'Carol' },
  ];

  it('summarises a table from my seat, with opponents, net points and hand stats', () => {
    const state = playHands(
      { seats: 3, scoring: { mode: 'buyin', buyIn: 100, multiplier: 0.5 } },
      3,
    );
    expect(state.history.length).toBe(3);
    const snap = snapshotOf(state, seats);
    const row = summarizeTable(snap, 'b')!;
    expect(row.mySeat).toBe(1);
    expect(row.opponents.map((o) => o.name)).toEqual(['Alice', 'Carol']);
    expect(row.myNet).toBe(state.scores[1]);
    expect(row.myBalance).toBe(100 + state.scores[1]!);
    expect(row.hands).toBe(3);
    expect(row.results.length).toBe(3);
    expect(summarizeTable(snap, 'zed')).toBeNull();
    const sum = describeSavedTable(snap, 'a')!;
    expect(sum.title).toBe('with Bob, Carol');
    expect(sum.meta).toContain('Pineapple · 3 hands');
    expect(sum.inProgress).toBe(true);
    expect(describeSavedTable({ nope: true }, 'a')).toBeNull();
    // A guest's view works the same way.
    const guestSnap = { ...snap, state: view(state, 2), view: true } as OfcSnapshot;
    expect(summarizeTable(guestSnap, 'c')!.myNet).toBe(state.scores[2]);
  });

  it('computes stats and head-to-head from pairwise results; points are zero-sum', () => {
    const state = playHands({ seats: 3 }, 4);
    const rows = [summarizeTable(snapshotOf(state, seats), 'a')!];
    const stats = computeOfcStats(rows);
    expect(stats.tables).toBe(1);
    expect(stats.handsPlayed).toBe(4);
    expect(stats.pointsNet).toBe(state.scores[0]);
    const h2h = stats.opponents.map((o) => o.pointsNet).reduce((x, y) => x + y, 0);
    expect(h2h).toBe(state.scores[0]);
    expect(state.scores.reduce((x, y) => x + y, 0)).toBe(0);
    expect(stats.opponents.map((o) => o.name).sort()).toEqual(['Bob', 'Carol']);
  });

  it('maps the engine ledger onto generic lines and balances', () => {
    const state = playHands({ seats: 2, scoring: { mode: 'up', multiplier: 2 } }, 2);
    const lines = ofcLedgerLines(state.ledger, 2);
    expect(lines.length).toBe(2);
    expect(lines[0]!.kind).toBe('hand');
    expect(lines[0]!.deltas[0]! + lines[0]!.deltas[1]!).toBe(0);
    const model = ofcLedgerModel(state, ['A', 'B']);
    expect(model.unsettled).toEqual(state.scores);
    expect(model.multiplier).toBe(2);
    expect(model.baseline).toBe(0);
    for (const t of model.plan) expect(t.amount).toBe(t.points * 2);
  });
});
