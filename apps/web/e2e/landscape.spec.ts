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
  pressAction,
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
  // No app bar, just a menu button: the board takes nearly the whole height.
  await expect(host.getByTestId('menu-button')).toBeVisible();
  expect(board!.height).toBeGreaterThan(viewport.height * 0.9);

  // One column beside the board: the opponent, then me, then the actions at the bottom.
  const me = await host.getByTestId('player-card-white').boundingBox();
  const them = await host.getByTestId('player-card-black').boundingBox();
  const bar = await host.getByTestId('action-bar').boundingBox();
  for (const box of [me!, them!, bar!]) {
    expect(box.x).toBeGreaterThanOrEqual(board!.x + board!.width - 1);
  }
  expect(me!.y).toBeGreaterThan(them!.y);
  expect(bar!.y).toBeGreaterThan(me!.y + me!.height - 1);
  // The board stretches into the space: wider than a 3:2 board of the same height.
  expect(board!.width / board!.height).toBeGreaterThan(1.55);
  await expect(host.getByTestId('status-text')).toBeVisible();

  // The menu button opens the side panel with the app's links.
  await host.getByTestId('menu-button').tap();
  await expect(host.getByTestId('app-bar')).toHaveAttribute('data-menu-open', 'true');
  await expect(host.getByTestId('nav-settings')).toContainText('Settings');
  await host.getByTestId('menu-scrim').tap({ position: { x: viewport.width - 20, y: 20 } });
  await expect(host.getByTestId('app-bar')).toHaveAttribute('data-menu-open', 'false');
  // Collapsed, the menu stays as a slim rail of icons beside the board, never over it.
  const rail = await host.getByTestId('app-bar').boundingBox();
  const board2 = await host.getByTestId('board').boundingBox();
  expect(rail!.x + rail!.width).toBeLessThanOrEqual(board2!.x + 1);
  await expect(host.getByTestId('nav-settings')).toBeVisible();

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

  // Full screen hides even the menu button; the same control undoes it.
  const openFullscreen = async () => {
    if (await host.getByTestId('more-actions').isVisible()) {
      await host.getByTestId('more-actions').tap();
    }
    await host.getByTestId('fullscreen-button').tap();
  };
  await openFullscreen();
  await expect(host.getByTestId('menu-button')).toBeHidden();
  await noPageScroll(host);
  await openFullscreen();
  await expect(host.getByTestId('menu-button')).toBeVisible();
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

for (const size of [
  { width: 412, height: 700 },
  { width: 390, height: 844 },
  { width: 360, height: 640 },
]) {
  test(`portrait ${size.width}x${size.height}: the game-over card fits on the board`, async ({
    page: host,
    context,
  }) => {
    await host.setViewportSize(size);
    const guest = await context.newPage();
    await seedProfile(host, 'alice', { id: 'e2e-host-0001', name: 'Steve Phone' });
    await seedProfile(guest, 'bob', { id: 'e2e-guest-0002', name: 'Breeze Longname' });
    const code = await hostMatch(host, 'alice', { length: 0, rules: 'free' });
    await joinMatch(guest, 'bob', code);
    await startGameIfNeeded(host, [guest]);
    await pressAction(host, 'record-result-button');
    await host.getByTestId('result-white-gammon').click();
    await host.getByTestId('confirm-result').click();
    await expect(host.getByTestId('game-over')).toBeVisible();

    const area = (await host.getByTestId('board-area').boundingBox())!;
    const card = (await host.locator('[data-testid="game-over"] > .card').boundingBox())!;
    expect(card.y).toBeGreaterThanOrEqual(area.y - 1);
    expect(card.y + card.height).toBeLessThanOrEqual(area.y + area.height + 1);
    expect(card.x).toBeGreaterThanOrEqual(area.x - 1);
    expect(card.x + card.width).toBeLessThanOrEqual(area.x + area.width + 1);
    // Every control on it is reachable.
    for (const id of ['overlay-ready-button', 'game-over-dismiss']) {
      const b = (await host.getByTestId(id).boundingBox())!;
      expect(b.y + b.height).toBeLessThanOrEqual(area.y + area.height + 1);
    }
    await host.screenshot({
      path: test.info().outputPath(`game-over-${size.width}x${size.height}.png`),
    });
  });
}
