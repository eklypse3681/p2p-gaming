import { describe, expect, it } from 'vitest';
import { applyAll, command, redactAction, view, viewerIsSettingFantasyland } from '../src/index.js';
import { firstFit, rng, table } from './helpers.js';

describe('views', () => {
  it('hides the deck, other seats pending cards and discards, keeps own cards', () => {
    let t = table({ variant: 'pineapple', seats: 3 });
    const r = rng(2);
    t = applyAll(t, command(t, 0, { type: 'start' }, r));
    // play the initial round and one pineapple turn so discards exist
    for (const seat of [1, 2, 0]) t = applyAll(t, command(t, seat, firstFit(t, seat), r));
    t = applyAll(t, command(t, 1, firstFit(t, 1), r));
    expect(t.hand!.seats[1]!.discards).toHaveLength(1);
    const v = view(t, 2);
    expect(v.viewer).toBe(2);
    expect((v.hand as unknown as { deck?: unknown }).deck).toBeUndefined();
    expect(v.hand!.deckCount).toBe(t.hand!.deck.length);
    expect(v.hand!.seats[1]!.discards).toEqual([]);
    expect(v.hand!.seats[1]!.discardCount).toBe(1);
    expect(v.hand!.seats[1]!.rows).toEqual(t.hand!.seats[1]!.rows); // face-up rows are public
    expect(v.hand!.seats[2]!.pending).toEqual(t.hand!.seats[2]!.pending);
    expect(v.hand!.seats[2]!.pendingCount).toBe(t.hand!.seats[2]!.pending.length);
    const other = v.hand!.seats[0]!;
    expect(other.pending).toEqual([]);
    expect(other.pendingCount).toBe(t.hand!.seats[0]!.pending.length);
    expect(other.hiddenCount).toBe(0);
  });

  it('hides a face-down Fantasyland hand until the showdown', () => {
    let t = table({ variant: 'pineapple', seats: 2 });
    t = { ...t, fantasyland: [14, 0] };
    const r = rng(3);
    t = applyAll(t, command(t, 0, { type: 'start' }, r));
    t = applyAll(t, command(t, 0, firstFit(t, 0), r)); // FL seat sets all 13 at once
    expect(t.hand!.seats[0]!.done).toBe(true);
    const v = view(t, 1);
    expect(v.hand!.seats[0]!.rows).toEqual({ top: [], middle: [], bottom: [] });
    expect(v.hand!.seats[0]!.hiddenCount).toBe(13);
    expect(view(t, 0).hand!.seats[0]!.rows.top).toHaveLength(3);
  });

  it('redacts actions for display', () => {
    let t = table({ variant: 'pineapple', seats: 2 });
    const r = rng(4);
    const start = command(t, 0, { type: 'start' }, r)[0]!;
    const red = redactAction(t, start, 1);
    if (red.type === 'start-hand') {
      expect(red.deals.find((d) => d.seat === 1)!.cards).toHaveLength(5);
      expect(red.deals.find((d) => d.seat === 0)!.cards).toEqual([]);
    }
    t = applyAll(t, [start]);
    const place = command(t, 1, firstFit(t, 1), r)[0]!;
    expect(redactAction(t, place, 1)).toBe(place);
    const seen = redactAction(t, place, 0);
    expect(seen.type === 'place' && seen.placements.length).toBe(5); // face-up placements stay visible
  });

  it('a seat setting its Fantasyland hand sees no other rows until it has submitted', () => {
    let t = table({ variant: 'pineapple', seats: 3 });
    t = { ...t, fantasyland: [14, 0, 0] };
    const r = rng(5);
    t = applyAll(t, command(t, 0, { type: 'start' }, r));
    // The two normal seats set their initial five cards face up.
    t = applyAll(t, command(t, 1, firstFit(t, 1), r));
    t = applyAll(t, command(t, 2, firstFit(t, 2), r));
    expect(
      t.hand!.seats[1]!.rows.bottom.length + t.hand!.seats[1]!.rows.middle.length,
    ).toBeGreaterThan(0);
    expect(viewerIsSettingFantasyland(t.hand!, 0)).toBe(true);
    const blind = view(t, 0);
    for (const seat of [1, 2]) {
      const sv = blind.hand!.seats[seat]!;
      expect(sv.rows).toEqual({ top: [], middle: [], bottom: [] });
      expect(sv.hiddenCount).toBe(5);
      expect(sv.faceDown).toBe(false);
      expect(sv.pending).toEqual([]);
    }
    // My own cards are all there.
    expect(blind.hand!.seats[0]!.pending).toHaveLength(14);
    // Normal seats still see each other and see my rows as face-down backs only.
    const v1 = view(t, 1);
    expect(v1.hand!.seats[2]!.rows).toEqual(t.hand!.seats[2]!.rows);
    expect(v1.hand!.seats[0]!.hiddenCount).toBe(0); // nothing set yet
    // After I set my hand the table is visible to me again.
    t = applyAll(t, command(t, 0, firstFit(t, 0), r));
    expect(t.hand!.seats[0]!.done).toBe(true);
    expect(viewerIsSettingFantasyland(t.hand!, 0)).toBe(false);
    const open = view(t, 0);
    expect(open.hand!.seats[1]!.rows).toEqual(t.hand!.seats[1]!.rows);
    expect(open.hand!.seats[1]!.hiddenCount).toBe(0);
    // ...while the others still cannot see my face-down hand.
    expect(view(t, 2).hand!.seats[0]!.hiddenCount).toBe(13);
  });

  it('two Fantasyland seats hide each other until both have set', () => {
    let t = table({ variant: 'pineapple', seats: 3 });
    t = { ...t, fantasyland: [14, 14, 0] };
    const r = rng(6);
    t = applyAll(t, command(t, 0, { type: 'start' }, r));
    t = applyAll(t, command(t, 2, firstFit(t, 2), r));
    t = applyAll(t, command(t, 0, firstFit(t, 0), r)); // seat 0 sets, seat 1 has not
    const v0 = view(t, 0);
    expect(v0.hand!.seats[2]!.rows).toEqual(t.hand!.seats[2]!.rows); // done: table visible
    expect(v0.hand!.seats[1]!.hiddenCount).toBe(0); // seat 1 has set nothing yet
    const v1 = view(t, 1);
    expect(v1.hand!.seats[2]!.hiddenCount).toBe(5); // still setting: blind
    expect(v1.hand!.seats[0]!.hiddenCount).toBe(13); // face-down FL hand
  });
});
