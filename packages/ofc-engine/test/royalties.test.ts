import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROYALTIES,
  bottomRoyalty,
  cards,
  defaultConfig,
  middleRoyalty,
  topRoyalty,
} from '../src/index.js';

const r = DEFAULT_ROYALTIES;

describe('royalties', () => {
  it('top pairs and trips', () => {
    expect(topRoyalty(cards('5d 5c 2s'), r)).toBe(0);
    expect(topRoyalty(cards('6d 6c 2s'), r)).toBe(1);
    expect(topRoyalty(cards('Qd Qc 2s'), r)).toBe(7);
    expect(topRoyalty(cards('Ad Ac 2s'), r)).toBe(9);
    expect(topRoyalty(cards('2d 2c 2s'), r)).toBe(10);
    expect(topRoyalty(cards('Ad Ac As'), r)).toBe(22);
    expect(topRoyalty(cards('Ad Kc Qs'), r)).toBe(0);
  });

  it('middle high row pays double the bottom', () => {
    expect(middleRoyalty(cards('7d 7c 7h Ks 2d'), r, 'pineapple')).toBe(2);
    expect(middleRoyalty(cards('Ts 9d 8c 7h 6s'), r, 'pineapple')).toBe(4);
    expect(middleRoyalty(cards('Ad 9d 7d 4d 2d'), r, 'ofc')).toBe(8);
    expect(middleRoyalty(cards('3d 3c 3h 9s 9d'), r, 'ofc')).toBe(12);
    expect(middleRoyalty(cards('Kd Kc Kh Ks 2s'), r, 'ofc')).toBe(20);
    expect(middleRoyalty(cards('9s 8s 7s 6s 5s'), r, 'ofc')).toBe(30);
    expect(middleRoyalty(cards('As Ks Qs Js Ts'), r, 'ofc')).toBe(50);
    expect(middleRoyalty(cards('Jd Jc 4h 4s Ad'), r, 'ofc')).toBe(0);
  });

  it('bottom row', () => {
    expect(bottomRoyalty(cards('Ts 9d 8c 7h 6s'), r)).toBe(2);
    expect(bottomRoyalty(cards('Ad 9d 7d 4d 2d'), r)).toBe(4);
    expect(bottomRoyalty(cards('3d 3c 3h 9s 9d'), r)).toBe(6);
    expect(bottomRoyalty(cards('Kd Kc Kh Ks 2s'), r)).toBe(10);
    expect(bottomRoyalty(cards('9s 8s 7s 6s 5s'), r)).toBe(15);
    expect(bottomRoyalty(cards('As Ks Qs Js Ts'), r)).toBe(25);
    expect(bottomRoyalty(cards('7d 7c 7h Ks 2d'), r)).toBe(0);
  });

  it('middle low row in 2-7 by high card, wheel on top', () => {
    expect(middleRoyalty(cards('Td 8c 5h 3s 2d'), r, 'pineapple27')).toBe(0);
    expect(middleRoyalty(cards('9d 8c 5h 3s 2d'), r, 'pineapple27')).toBe(1);
    expect(middleRoyalty(cards('8d 7c 5h 3s 2d'), r, 'pineapple27')).toBe(2);
    expect(middleRoyalty(cards('7d 6c 5h 3s 2d'), r, 'pineapple27')).toBe(4);
    expect(middleRoyalty(cards('7d 5c 4h 3s 2d'), r, 'pineapple27')).toBe(8);
    expect(middleRoyalty(cards('Jd 8c 5h 3s 2d'), r, 'pineapple27')).toBe(0);
    expect(middleRoyalty(cards('7d 7c 7h Ks 2d'), r, 'pineapple27')).toBe(0); // trips pay nothing in the low row
  });

  it('master switch and overrides', () => {
    const off = { ...r, enabled: false };
    expect(topRoyalty(cards('Ad Ac As'), off)).toBe(0);
    expect(bottomRoyalty(cards('As Ks Qs Js Ts'), off)).toBe(0);
    const cfg = defaultConfig({
      royalties: { topPairs: { 12: 20 }, middleLow: { wheel: 10 } } as never,
    });
    expect(cfg.royalties.topPairs[12]).toBe(20);
    expect(cfg.royalties.topPairs[13]).toBe(8); // untouched default
    expect(cfg.royalties.middleLow.wheel).toBe(10);
    expect(cfg.royalties.middleLow.seven).toBe(4);
  });
});
