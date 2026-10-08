import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  GUEST,
  HOST,
  hostMatch,
  joinMatch,
  seedProfile,
  touchDrag,
  checkersAt,
  startGameIfNeeded,
} from './helpers';

test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

async function noPageScroll(page: Page) {
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    sh: document.documentElement.scrollHeight,
    ch: document.documentElement.clientHeight,
    bw: document.body.scrollWidth,
  }));
  expect(m.sw, 'no horizontal page scroll').toBeLessThanOrEqual(m.cw + 1);
  expect(m.bw, 'no horizontal body scroll').toBeLessThanOrEqual(m.cw + 1);
  expect(m.sh, 'no vertical page scroll').toBeLessThanOrEqual(m.ch + 1);
}

test('landscape phone: board fills the screen, controls are reachable, nothing scrolls', async ({
  page: host,
  context,
}) => {
  const guest = await context.newPage();
  await seedProfile(host, 'alice', HOST);
  await seedProfile(guest, 'bob', GUEST);
  const code = await hostMatch(host, 'alice', { length: 1, rules: 'free' });
  await joinMatch(guest, 'bob', code);

  await expect(host.getByTestId('game-screen')).toHaveAttribute('data-layout', 'landscape');
  await noPageScroll(host);

  const viewport = host.viewportSize()!;
  const board = await host.getByTestId('board').boundingBox();
  expect(board).not.toBeNull();
  expect(board!.x).toBeGreaterThanOrEqual(0);
  expect(board!.y).toBeGreaterThanOrEqual(0);
  expect(board!.x + board!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(board!.y + board!.height).toBeLessThanOrEqual(viewport.height + 1);
  // The board uses most of the height available under the app bar.
  expect(board!.height).toBeGreaterThan(viewport.height * 0.6);

  // The dock under the board: me on the left, the opponent on the right, actions between.
  const me = await host.getByTestId('player-card-white').boundingBox();
  const them = await host.getByTestId('player-card-black').boundingBox();
  const bar = await host.getByTestId('action-bar').boundingBox();
  expect(me!.y).toBeGreaterThan(board!.y + board!.height - 1);
  expect(me!.x + me!.width).toBeLessThanOrEqual(bar!.x + 1);
  expect(them!.x).toBeGreaterThanOrEqual(bar!.x + bar!.width - 1);
  await expect(host.getByTestId('status-text')).toBeVisible();

  // Start the game from the dock; the roll button is tappable.
  await startGameIfNeeded(host);
  await expect(host.getByTestId('roll-button')).toBeVisible();
  const roll = await host.getByTestId('roll-button').boundingBox();
  expect(roll!.x + roll!.width).toBeLessThanOrEqual(viewport.width + 1);
  await host.getByTestId('roll-button').tap();
  await expect(host.getByTestId('dice')).toBeVisible();
  await noPageScroll(host);

  // A touch drag on the small board still lands on the intended point.
  await touchDrag(host, 'point-13', 'point-9');
  await expect(checkersAt(host, 'p9')).toHaveCount(1);
  await expect(checkersAt(guest, 'p9')).toHaveCount(1);

  // The rail lives in a sheet: open, read the score, close. In a narrow dock it sits behind
  // the split button's arrow.
  if (await host.getByTestId('more-actions').isVisible()) {
    await host.getByTestId('more-actions').tap();
  }
  await host.getByTestId('more-button').tap();
  await expect(host.getByTestId('rail-sheet')).toBeVisible();
  await expect(host.getByTestId('score-white')).toBeVisible();
  await host.getByTestId('sheet-close').tap();
  await expect(host.getByTestId('rail-sheet')).toHaveCount(0);
  await noPageScroll(host);

  // Full screen hides the app bar and gives the board the height; the same control undoes it.
  const before = (await host.getByTestId('board').boundingBox())!.height;
  const openFullscreen = async () => {
    if (await host.getByTestId('more-actions').isVisible()) {
      await host.getByTestId('more-actions').tap();
    }
    await host.getByTestId('fullscreen-button').tap();
  };
  await openFullscreen();
  await expect(host.getByTestId('app-bar')).toBeHidden();
  await expect
    .poll(async () => (await host.getByTestId('board').boundingBox())!.height)
    .toBeGreaterThan(before);
  await noPageScroll(host);
  await openFullscreen();
  await expect(host.getByTestId('app-bar')).toBeVisible();
});

test('portrait phone: board never overflows and the action bar sits under it', async ({
  page: host,
  context,
}) => {
  await host.setViewportSize({ width: 390, height: 844 });
  const guest = await context.newPage();
  await guest.setViewportSize({ width: 390, height: 844 });
  await seedProfile(host, 'alice', HOST);
  await seedProfile(guest, 'bob', GUEST);
  const code = await hostMatch(host, 'alice', { length: 1 });
  await joinMatch(guest, 'bob', code);
  await expect(host.getByTestId('game-screen')).toHaveAttribute('data-layout', 'default');
  const m = await host.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(m.sw).toBeLessThanOrEqual(m.cw + 1);
  const board = await host.getByTestId('board').boundingBox();
  expect(board!.x + board!.width).toBeLessThanOrEqual(391);
  const bar = await host.getByTestId('action-bar').boundingBox();
  expect(bar!.y).toBeGreaterThan(board!.y + board!.height - 1);
  await startGameIfNeeded(host);
  await expect(host.getByTestId('opening-roll-button')).toBeVisible();
  // Me on the left of the dock, the opponent on the right, both under the board.
  const me = await host.getByTestId('player-card-white').boundingBox();
  const them = await host.getByTestId('player-card-black').boundingBox();
  expect(me!.x).toBeLessThan(them!.x);
  expect(me!.y).toBeGreaterThan(board!.y + board!.height - 1);
  const g = await guest.getByTestId('player-card-black').boundingBox();
  const o = await guest.getByTestId('player-card-white').boundingBox();
  expect(g!.x).toBeLessThan(o!.x);
});
