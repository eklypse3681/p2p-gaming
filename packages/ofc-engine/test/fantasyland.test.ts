import { describe, expect, it } from 'vitest';
import { canPlace, defaultConfig, fantasylandQualification, view } from '../src/index.js';
import { firstFit, playHand, rng, rows, table } from './helpers.js';

const cfg = defaultConfig({ variant: 'pineapple' });

describe('Fantasyland qualification', () => {
  it('enters with QQ+ on top (or trips), not with JJ', () => {
    expect(
      fantasylandQualification(rows('Qd Qc 2s', 'Ad Ac 5h 4s 3d', 'Kd Kc Kh 3s 3c'), false, cfg),
    ).toEqual({ cards: 14, reasons: ['top QQ'] });
    expect(
      fantasylandQualification(rows('Jd Jc 2s', 'Ad Ac 5h 4s 3d', 'Kd Kc Kh 3s 3c'), false, cfg)
        .cards,
    ).toBe(0);
    expect(
      fantasylandQualification(rows('2d 2c 2s', 'Ad Ac 5h 4s 3d', 'Kd Kc Kh 3s 3c'), false, cfg),
    ).toEqual({ cards: 14, reasons: ['top trips'] });
  });

  it('classic OFC deals 13; entry threshold and progressive cards are configurable', () => {
    const ofc = defaultConfig({ variant: 'ofc' });
    expect(
      fantasylandQualification(rows('Qd Qc 2s', 'Ad Ac 5h 4s 3d', 'Kd Kc Kh 3s 3c'), false, ofc)
        .cards,
    ).toBe(13);
    const kk = defaultConfig({ variant: 'pineapple', fantasyland: { entry: 'KK' } as never });
    expect(
      fantasylandQualification(rows('Qd Qc 2s', 'Ad Ac 5h 4s 3d', 'Kd Kc Kh 3s 3c'), false, kk)
        .cards,
    ).toBe(0);
    expect(
      fantasylandQualification(rows('Kd Kc 2s', 'Ad Ac 5h 4s 3d', 'Kh Ks 9h 3s 3c'), false, kk)
        .cards,
    ).toBe(14);
    const prog = defaultConfig({
      variant: 'pineapple',
      fantasyland: { progressive: true } as never,
    });
    expect(
      fantasylandQualification(rows('Qd Qc 2s', 'Ad Ac 5h 4s 3d', 'Kd Kc Kh 3s 3c'), false, prog)
        .cards,
    ).toBe(14);
    expect(
      fantasylandQualification(rows('Kd Kc 2s', 'Ad Ac 5h 4s 3d', 'Kh Ks 9h 3s 3c'), false, prog)
        .cards,
    ).toBe(15);
    expect(
      fantasylandQualification(rows('Ad Ac 2s', 'Ah As 5h 4s 3d', 'Kh Ks Kd 3s 3c'), false, prog)
        .cards,
    ).toBe(16);
    expect(
      fantasylandQualification(rows('2d 2c 2s', 'Ad Ac 5h 4s 3d', 'Kd Kc Kh 3s 3c'), false, prog)
        .cards,
    ).toBe(17);
    const off = defaultConfig({ variant: 'pineapple', fantasyland: { enabled: false } as never });
    expect(
      fantasylandQualification(rows('Ad Ac 2s', 'Ah As 5h 4s 3d', 'Kh Ks Kd 3s 3c'), false, off)
        .cards,
    ).toBe(0);
  });

  it('2-7: KK by default, a middle wheel also enters, super Fantasyland adds a card', () => {
    const low = defaultConfig({ variant: 'pineapple27' });
    expect(low.fantasyland.entry).toBe('KK');
    expect(
      fantasylandQualification(rows('Kd 9c 2s', '7d 5c 4h 3s 2d', 'Ad Ac 5h 4s 3d'), false, low),
    ).toEqual({ cards: 14, reasons: ['middle wheel'] });
    expect(
      fantasylandQualification(rows('Qd Qc 2s', '9d 5c 4h 3s 2d', 'Ad Ac 5h 4s 3d'), false, low)
        .cards,
    ).toBe(0);
    const superFl = defaultConfig({
      variant: 'pineapple27',
      fantasyland: { superFantasyland: true } as never,
    });
    expect(
      fantasylandQualification(
        rows('Kd Kc 2s', '7d 5c 4h 3s 2d', 'Ad Ac 5h 4s 3d'),
        false,
        superFl,
      ),
    ).toEqual({ cards: 15, reasons: ['top KK', 'middle wheel'] });
  });

  it('staying needs top trips, middle full house+ or bottom quads+', () => {
    expect(
      fantasylandQualification(rows('Qd Qc 2s', 'Ad Ac 5h 4s 3d', 'Kd Kc Kh 3s 3c'), true, cfg)
        .cards,
    ).toBe(0);
    expect(
      fantasylandQualification(rows('2d 2c 2s', 'Ad Ac 5h 4s 3d', 'Kd Kc Kh 3s 3c'), true, cfg)
        .reasons,
    ).toEqual(['top trips']);
    expect(
      fantasylandQualification(rows('Qd 9c 2s', 'Ad Ac Ah 4s 4d', 'Kd Kc Kh 3s 3c'), true, cfg)
        .reasons,
    ).toEqual(['middle full house+']);
    expect(
      fantasylandQualification(rows('Qd 9c 2s', 'Ad Kc 5h 4s 3d', 'Kd Kc Kh Ks 3c'), true, cfg)
        .reasons,
    ).toEqual(['bottom quads+']);
    const noStay = defaultConfig({
      variant: 'pineapple',
      fantasyland: {
        stay: { topTrips: false, middleFullHouse: false, bottomQuads: false },
      } as never,
    });
    expect(
      fantasylandQualification(rows('2d 2c 2s', 'Ad Ac 5h 4s 3d', 'Kd Kc Kh 3s 3c'), true, noStay)
        .cards,
    ).toBe(0);
    // 2-7: a wheel in the middle enters Fantasyland but does not keep you there by default…
    const low = defaultConfig({ variant: 'pineapple27' });
    expect(
      fantasylandQualification(rows('Qd 9c 2s', '7d 5c 4h 3s 2d', 'Kd Kc 9h 3s 3c'), true, low),
    ).toEqual({ cards: 0, reasons: [] });
    // …unless the table turns that stay condition on.
    const lowStay = defaultConfig({
      variant: 'pineapple27',
      fantasyland: { stay: { middleFullHouse: true } } as never,
    });
    expect(
      fantasylandQualification(rows('Qd 9c 2s', '7d 5c 4h 3s 2d', 'Kd Kc 9h 3s 3c'), true, lowStay)
        .reasons,
    ).toEqual(['middle wheel']);
  });
});

describe('Fantasyland at the table', () => {
  it('deals the owed cards face down, lets the FL seat set any time, and skips it in turn order', () => {
    let t = table({ variant: 'pineapple', seats: 3 });
    t = { ...t, fantasyland: [0, 14, 0], button: 2 };
    const r = rng(5);
    const { state } = playHand(t, r, (s, seat) => {
      // seat 1 (FL) waits until the others are done, proving it is skipped in turn order
      if (seat === 1 && !s.hand!.seats.every((x, i) => i === 1 || x.done)) {
        // firstFit for others only; the loop asks seat 0/2 first because canPlace(1) is only true when it holds cards
        return firstFit(s, seat);
      }
      return firstFit(s, seat);
    });
    expect(state.hand!.phase).toBe('showdown');
    expect(state.hand!.seats[1]!.fantasyland).toBe(true);
    expect(state.hand!.seats[1]!.discards).toHaveLength(1);
    expect(state.hand!.seats[1]!.faceDown).toBe(false); // revealed at showdown
  });

  it('FL seat starts with all its cards, hidden from others, and turn order starts with a non-FL seat', () => {
    let t = table({ variant: 'pineapple', seats: 2 });
    t = { ...t, fantasyland: [15, 0], button: 1 };
    const r = rng(9);
    const start = playHandStart(t, r);
    expect(start.hand!.seats[0]!.pending).toHaveLength(15);
    expect(start.hand!.seats[0]!.faceDown).toBe(true);
    expect(start.hand!.toAct).toBe(1); // seat 0 is left of the button but in FL
    expect(canPlace(start, 0)).toBe(true);
    expect(canPlace(start, 1)).toBe(true);
    const v = view(start, 1);
    expect(v.hand!.seats[0]!.pending).toEqual([]);
    expect(v.hand!.seats[0]!.pendingCount).toBe(15);
    expect(start.fantasyland).toEqual([0, 0]); // consumed
  });

  it('two FL seats and one normal seat still complete the hand', () => {
    let t = table({ variant: 'pineapple', seats: 3 });
    t = { ...t, fantasyland: [14, 0, 14] };
    const { state } = playHand(t, rng(3));
    expect(state.hand!.phase).toBe('showdown');
    expect(state.hand!.seats.every((s) => s.done)).toBe(true);
  });
});

import { applyAll, command } from '../src/index.js';
import type { TableState } from '../src/index.js';
import type { Rng } from '../src/index.js';
function playHandStart(t: TableState, r: Rng): TableState {
  return applyAll(t, command(t, 0, { type: 'start' }, r));
}
