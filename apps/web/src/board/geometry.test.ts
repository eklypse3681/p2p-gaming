import { describe, expect, it } from 'vitest';
import {
  BAR,
  CHECKER_RADIUS,
  FELT_BOTTOM,
  FELT_TOP,
  LEFT_FELT,
  MID_Y,
  RIGHT_FELT,
  TRAY,
  VIEWBOX,
  allPointSlots,
  barX,
  boardLayout,
  checkerPosition,
  clientToViewBox,
  cubePosition,
  dicePositions,
  hitTest,
  locationCenter,
  nearestLocation,
  pointAt,
  pointSlot,
  stackSpacing,
  trayX,
} from './geometry';

describe('geometry', () => {
  it('maps abs points 1..24 to 24 distinct slots for both perspectives', () => {
    for (const perspective of ['white', 'black'] as const) {
      const slots = allPointSlots(perspective);
      const keys = new Set(slots.map((s) => `${s.row}:${s.column}`));
      expect(keys.size).toBe(24);
      expect(new Set(slots.map((s) => s.display)).size).toBe(24);
    }
  });

  it('puts the perspective player 1-point bottom right and 24-point top right', () => {
    const w1 = pointSlot('white', 1);
    expect(w1.row).toBe('bottom');
    expect(w1.column).toBe(11);
    expect(w1.display).toBe(1);
    const w24 = pointSlot('white', 24);
    expect(w24.row).toBe('top');
    expect(w24.column).toBe(11);
    // Black's 1-point is abs 24
    const b1 = pointSlot('black', 24);
    expect(b1.row).toBe('bottom');
    expect(b1.column).toBe(11);
    expect(b1.display).toBe(1);
    expect(pointSlot('black', 1).display).toBe(24);
    // 12/13 are far left
    expect(pointSlot('white', 12).column).toBe(0);
    expect(pointSlot('white', 13).column).toBe(0);
    expect(pointSlot('white', 13).row).toBe('top');
  });

  it('flipping perspective mirrors the board vertically (each player keeps home bottom-right)', () => {
    for (let abs = 1; abs <= 24; abs++) {
      const w = pointSlot('white', abs);
      const b = pointSlot('black', abs);
      expect(b.column).toBe(w.column);
      expect(b.row).toBe(w.row === 'top' ? 'bottom' : 'top');
      expect(b.display).toBe(25 - w.display);
    }
  });

  it('pointAt inverts pointSlot', () => {
    for (const perspective of ['white', 'black'] as const) {
      for (let abs = 1; abs <= 24; abs++) {
        const s = pointSlot(perspective, abs);
        expect(pointAt(perspective, s.row, s.column)).toBe(abs);
      }
    }
  });

  it('stacks checkers toward the middle and compacts beyond five', () => {
    const p0 = checkerPosition({ kind: 'point', point: 1 }, 0, 3, 'white');
    const p1 = checkerPosition({ kind: 'point', point: 1 }, 1, 3, 'white');
    expect(p0.cy).toBe(FELT_BOTTOM - CHECKER_RADIUS);
    expect(p1.cy).toBe(p0.cy - CHECKER_RADIUS * 2);
    const t0 = checkerPosition({ kind: 'point', point: 24 }, 0, 2, 'white');
    expect(t0.cy).toBe(FELT_TOP + CHECKER_RADIUS);
    expect(stackSpacing(5)).toBe(CHECKER_RADIUS * 2);
    expect(stackSpacing(15)).toBeLessThan(CHECKER_RADIUS * 2);
    const top15 = checkerPosition({ kind: 'point', point: 1 }, 14, 15, 'white');
    const top5 = checkerPosition({ kind: 'point', point: 1 }, 4, 5, 'white');
    expect(top15.cy).toBeCloseTo(top5.cy, 5);
  });

  it('places bar and tray stacks in the right halves', () => {
    const myBar = checkerPosition({ kind: 'bar', player: 'white' }, 0, 1, 'white');
    const theirBar = checkerPosition({ kind: 'bar', player: 'black' }, 0, 1, 'white');
    expect(myBar.cx).toBe(BAR.x + BAR.width / 2);
    expect(myBar.cy).toBeLessThan(MID_Y);
    expect(theirBar.cy).toBeGreaterThan(MID_Y);
    const myOff = checkerPosition({ kind: 'off', player: 'white' }, 0, 1, 'white');
    const theirOff = checkerPosition({ kind: 'off', player: 'black' }, 0, 1, 'white');
    expect(myOff.shape).toBe('chip');
    expect(myOff.cx).toBe(TRAY.x + TRAY.width / 2);
    expect(myOff.cy).toBeGreaterThan(MID_Y);
    expect(theirOff.cy).toBeLessThan(MID_Y);
    // flipped perspective swaps halves
    expect(checkerPosition({ kind: 'bar', player: 'white' }, 0, 1, 'black').cy).toBeGreaterThan(
      MID_Y,
    );
  });

  it('draws dice on the mover side and the cube where it belongs', () => {
    const mine = dicePositions('white', 'white', 2);
    const theirs = dicePositions('black', 'white', 2);
    expect(mine.every((d) => d.x > RIGHT_FELT.x)).toBe(true);
    expect(theirs.every((d) => d.x < LEFT_FELT.x + LEFT_FELT.width)).toBe(true);
    expect(dicePositions('white', 'white', 4)).toHaveLength(4);
    expect(cubePosition({ owner: 'center' }, 'white').y).toBe(MID_Y);
    expect(cubePosition({ owner: 'white' }, 'white').y).toBeGreaterThan(MID_Y);
    expect(cubePosition({ owner: 'black' }, 'white').y).toBeLessThan(MID_Y);
    expect(cubePosition({ owner: 'white' }, 'black').y).toBeLessThan(MID_Y);
    const offered = cubePosition({ owner: 'center', offeredBy: 'white' }, 'white');
    expect(offered.y).toBe(MID_Y);
    expect(offered.facing).toBe('black');
  });

  it('hit-tests points, bar and trays', () => {
    for (const perspective of ['white', 'black'] as const) {
      for (let abs = 1; abs <= 24; abs++) {
        const s = pointSlot(perspective, abs);
        const y = s.row === 'top' ? FELT_TOP + 100 : FELT_BOTTOM - 100;
        expect(hitTest(s.x, y, perspective)).toEqual({ kind: 'point', point: abs });
      }
    }
    expect(hitTest(BAR.x + 10, MID_Y - 100, 'white')).toEqual({ kind: 'bar', player: 'white' });
    expect(hitTest(BAR.x + 10, MID_Y + 100, 'white')).toEqual({ kind: 'bar', player: 'black' });
    expect(hitTest(TRAY.x + 10, MID_Y + 100, 'white')).toEqual({ kind: 'off', player: 'white' });
    expect(hitTest(TRAY.x + 10, MID_Y - 100, 'black')).toEqual({ kind: 'off', player: 'white' });
    expect(hitTest(10, 10, 'white')).toBeNull();
  });

  it('maps client pixels to viewBox units with letterboxing', () => {
    const rect = { left: 0, top: 0, width: 750, height: 750 };
    // 1500x1000 fits as 750x500, centred vertically with 125px bars.
    expect(clientToViewBox(rect, 0, 125)).toEqual({ x: 0, y: 0 });
    expect(clientToViewBox(rect, 750, 625)).toEqual({ x: 1500, y: 1000 });
    expect(clientToViewBox({ left: 0, top: 0, width: 0, height: 0 }, 1, 1)).toBeNull();
  });

  describe('home board on the left', () => {
    it('puts 1 bottom-left, 12 bottom-right, 13 top-right and 24 top-left', () => {
      const w1 = pointSlot('white', 1, 'left');
      expect(w1.row).toBe('bottom');
      expect(w1.column).toBe(0);
      expect(w1.display).toBe(1);
      expect(pointSlot('white', 12, 'left').column).toBe(11);
      expect(pointSlot('white', 12, 'left').row).toBe('bottom');
      expect(pointSlot('white', 13, 'left').column).toBe(11);
      expect(pointSlot('white', 13, 'left').row).toBe('top');
      expect(pointSlot('white', 24, 'left').column).toBe(0);
      expect(pointSlot('white', 24, 'left').row).toBe('top');
      // Black keeps its own numbering: black's 1-point is abs 24.
      const b1 = pointSlot('black', 24, 'left');
      expect(b1.row).toBe('bottom');
      expect(b1.column).toBe(0);
      expect(b1.display).toBe(1);
      // Bottom row reads 1..12 left to right.
      const bottom = allPointSlots('white', 'left')
        .filter((s) => s.row === 'bottom')
        .sort((a, b) => a.x - b.x)
        .map((s) => s.display);
      expect(bottom).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('is the exact horizontal mirror of the right-hand layout', () => {
      for (const perspective of ['white', 'black'] as const) {
        for (let abs = 1; abs <= 24; abs++) {
          const r = pointSlot(perspective, abs, 'right');
          const l = pointSlot(perspective, abs, 'left');
          expect(l.x).toBeCloseTo(VIEWBOX.width - r.x, 6);
          expect(l.row).toBe(r.row);
          expect(l.display).toBe(r.display);
          expect(l.column).toBe(11 - r.column);
          expect(l.yBase).toBe(r.yBase);
        }
      }
      expect(barX('left')).toBeCloseTo(VIEWBOX.width - barX('right'), 6);
      expect(trayX('left')).toBeCloseTo(VIEWBOX.width - trayX('right'), 6);
      expect(trayX('left')).toBeLessThan(barX('left'));
      const layout = boardLayout('left');
      expect(layout.tray.x + layout.tray.width).toBeLessThanOrEqual(layout.divider.x);
      expect(layout.divider.x + layout.divider.width).toBeLessThanOrEqual(layout.homeFelt.x);
      expect(layout.homeFelt.x + layout.homeFelt.width).toBeLessThanOrEqual(layout.bar.x);
      expect(layout.bar.x + layout.bar.width).toBeLessThanOrEqual(layout.outerFelt.x);
      expect(layout.minX).toBe(layout.tray.x);
      expect(layout.maxX).toBe(layout.outerFelt.x + layout.outerFelt.width);
    });

    it('mirrors checker, dice, cube and centre positions', () => {
      const locs = [
        { kind: 'point', point: 5 },
        { kind: 'bar', player: 'white' },
        { kind: 'off', player: 'black' },
      ] as const;
      for (const loc of locs) {
        const r = checkerPosition(loc, 1, 3, 'white', 'right');
        const l = checkerPosition(loc, 1, 3, 'white', 'left');
        expect(l.cx).toBeCloseTo(VIEWBOX.width - r.cx, 6);
        expect(l.cy).toBe(r.cy);
        expect(l.shape).toBe(r.shape);
        const rc = locationCenter(loc, 'white', 'right');
        const lc = locationCenter(loc, 'white', 'left');
        expect(lc.x).toBeCloseTo(VIEWBOX.width - rc.x, 6);
        expect(lc.y).toBe(rc.y);
      }
      // The mover's dice stay on their home side: for a left home board that is the left half.
      const mine = dicePositions('white', 'white', 2, 'left');
      const theirs = dicePositions('black', 'white', 2, 'left');
      const layout = boardLayout('left');
      expect(mine.every((d) => d.x < layout.bar.x)).toBe(true);
      expect(theirs.every((d) => d.x > layout.bar.x + layout.bar.width)).toBe(true);
      expect(cubePosition({ owner: 'center' }, 'white', 'left').x).toBe(barX('left'));
    });

    it('pointAt inverts pointSlot and hit-tests round-trip on the left', () => {
      for (const perspective of ['white', 'black'] as const) {
        for (let abs = 1; abs <= 24; abs++) {
          const s = pointSlot(perspective, abs, 'left');
          expect(pointAt(perspective, s.row, s.column, 'left')).toBe(abs);
          const y = s.row === 'top' ? FELT_TOP + 100 : FELT_BOTTOM - 100;
          expect(hitTest(s.x, y, perspective, 'left')).toEqual({ kind: 'point', point: abs });
        }
      }
      const layout = boardLayout('left');
      expect(hitTest(layout.bar.x + 10, MID_Y - 100, 'white', 'left')).toEqual({
        kind: 'bar',
        player: 'white',
      });
      expect(hitTest(layout.tray.x + 10, MID_Y + 100, 'white', 'left')).toEqual({
        kind: 'off',
        player: 'white',
      });
      // Just past the left edge of the tray snaps onto it; where the tray used to be is felt.
      expect(nearestLocation(layout.tray.x - 30, MID_Y + 100, 'white', 'left')).toEqual({
        kind: 'off',
        player: 'white',
      });
      expect(hitTest(TRAY.x + 10, MID_Y + 100, 'white', 'left')).toEqual({
        kind: 'point',
        point: 11,
      });
      expect(hitTest(VIEWBOX.width - 20, MID_Y + 100, 'white', 'left')).toBeNull();
      expect(nearestLocation(VIEWBOX.width - 20, MID_Y + 100, 'white', 'left')).toEqual({
        kind: 'point',
        point: 12,
      });
    });
  });
});
