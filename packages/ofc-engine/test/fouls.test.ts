import { describe, expect, it } from 'vitest';
import { defaultConfig, foulReason, isFoul } from '../src/index.js';
import { rows } from './helpers.js';

const high = defaultConfig({ variant: 'pineapple' });
const low = defaultConfig({ variant: 'pineapple27' });

describe('fouls (high variants)', () => {
  it('accepts bottom >= middle >= top and equal strengths', () => {
    expect(isFoul(rows('Kd 9c 2h', 'Ad Ac 5h 4s 2d', '9d 8c 7h 6s 5d'), high)).toBe(false);
    // equal pairs with equal kickers so far: not a foul
    expect(isFoul(rows('Ah As Ks', 'Ad Ac Kh 4s 2d', 'Qd Qc Qh 3s 3c'), high)).toBe(false);
    expect(isFoul(rows('2h 3s 4c', '5d 6c 7h 8s Td', 'Ad Kc 9h 4s 2d'), high)).toBe(false); // high-card rows compare by kickers
  });

  it('fouls when the middle beats the bottom or the top beats the middle', () => {
    expect(foulReason(rows('Kd 9c 2h', '9d 8c 7h 6s 5d', 'Ad Ac 5h 4s 2d'), high)).toBe(
      'middle is stronger than bottom',
    );
    expect(foulReason(rows('Ad Ac 3s', 'Kd Kc 5h 4s 2d', '9d 8c 7h 6s 5d'), high)).toBe(
      'top is stronger than middle',
    );
    expect(foulReason(rows('Ah As Ks', 'Ad Ac 5h 4s 2d', 'Qd Qc Qh 3s 3c'), high)).toBe(
      'top is stronger than middle',
    );
  });

  it('rejects incomplete hands', () => {
    expect(() => isFoul(rows('Kd 9c', 'Ad Ac 5h 4s 2d', '9d 8c 7h 6s 5d'), high)).toThrow(
      /not complete/,
    );
  });
});

describe('fouls (2-7 middle)', () => {
  it('needs a qualified low in the middle and bottom >= top', () => {
    expect(isFoul(rows('Kd 9c 2h', 'Td 8c 5h 3s 2d', 'Ad Ac 5h 4s 3d'), low)).toBe(false);
    expect(foulReason(rows('Kd 9c 2h', 'Jd 8c 5h 3s 2d', 'Ad Ac 5h 4s 3d'), low)).toMatch(/10-low/);
    expect(foulReason(rows('Kd 9c 2h', 'Td Tc 5h 3s 2d', 'Ad Ac 5h 4s 3d'), low)).toMatch(/10-low/);
    expect(foulReason(rows('Ad Ac 2h', 'Td 8c 5h 3s 2d', 'Kd Kc 5h 4s 3d'), low)).toBe(
      'top is stronger than bottom',
    );
    // a monster middle does not matter: the low row is independent of the bottom
    expect(isFoul(rows('2h 3s 4c', '7d 5c 4h 3s 2d', '9d 8c 6h 5s 3d'), low)).toBe(false);
  });

  it('honours a custom qualifier', () => {
    const nine = defaultConfig({ variant: 'pineapple27', lowQualifier: 9 });
    expect(isFoul(rows('Kd 9c 2h', 'Td 8c 5h 3s 2d', 'Ad Ac 5h 4s 3d'), nine)).toBe(true);
  });
});
