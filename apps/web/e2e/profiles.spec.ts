import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  GUEST,
  HOST,
  completeOpening,
  hostMatch,
  joinMatch,
  profileUrl,
  seedProfile,
  startGameIfNeeded,
} from './helpers';

const online = (page: Page) =>
  expect(
    page
      .getByTestId('connection-badge')
      .filter({ hasText: /online/i })
      .first(),
  ).toBeVisible({ timeout: 20_000 });

test.describe('players are route segments', () => {
  test('the picker creates a player and lands on their home', async ({ page }) => {
    await page.goto('/?transport=broadcast#/');
    await expect(page.getByTestId('picker-screen')).toBeVisible();
    await page.getByTestId('new-profile-name').fill('Dana');
    await page.getByTestId('new-profile-button').click();
    await expect(page.getByTestId('games-hub')).toBeVisible();
    expect(page.url()).toContain('#/dana/');
    // The hub lists the games; backgammon leads to its game home.
    await page.getByTestId('game-card-backgammon').click();
    await expect(page.getByTestId('home-screen')).toHaveAttribute('data-game', 'backgammon');
    expect(page.url()).toContain('#/dana/backgammon/');
    await expect(page.getByTestId('playing-as')).toContainText('Dana');
    await expect(page.getByTestId('profile-chip')).toContainText('Dana');
    // Back at the picker the player is listed.
    await page.getByTestId('switch-player').click();
    await expect(page.getByTestId('profile-dana')).toBeVisible();
  });

  test('an unknown slug in the address is created on the spot', async ({ page }) => {
    await page.goto('/?transport=broadcast#/eve/');
    await expect(page.getByTestId('games-hub')).toHaveAttribute('data-profile', 'eve');
    await expect(page.getByTestId('playing-as')).toContainText('Eve');
    await page.goto('/?transport=broadcast#/');
    await expect(page.getByTestId('profile-eve')).toBeVisible();
  });

  test('an invite link asks who is joining, then joins as that player', async ({
    page: host,
    context,
  }) => {
    await seedProfile(host, 'alice', HOST);
    const code = await hostMatch(host, 'alice', { length: 1 });
    const guest = await context.newPage();
    await seedProfile(guest, 'bob', GUEST);
    await guest.goto(`/?transport=broadcast#/backgammon/join/${code}`);
    await expect(guest.getByTestId('picker-joining')).toContainText(code);
    await guest.getByTestId('profile-bob').click();
    await expect(guest.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
    expect(guest.url()).toContain(`#/bob/backgammon/game/`);
    await expect(guest.getByTestId('player-name-black')).toContainText(GUEST.name);
    await expect(host.getByTestId('player-name-black')).toContainText(GUEST.name);
    await online(host);
    await online(guest);
  });

  test('two tabs, two players: seats survive both tabs reloading at once', async ({
    page: host,
    context,
  }) => {
    test.setTimeout(120_000);
    const guest = await context.newPage();
    await seedProfile(host, 'alice', HOST);
    await seedProfile(guest, 'bob', GUEST);
    const code = await hostMatch(host, 'alice', { length: 1 });
    await joinMatch(guest, 'bob', code);
    await expect(host.getByTestId('player-name-white')).toContainText(HOST.name);
    await expect(host.getByTestId('player-name-black')).toContainText(GUEST.name);
    await expect(guest.getByTestId('game-screen')).toHaveAttribute('data-seat', 'black');
    await startGameIfNeeded(host);
    await completeOpening(host, guest);
    expect(host.url()).toContain('#/alice/backgammon/game/');
    expect(guest.url()).toContain('#/bob/backgammon/game/');

    // Both tabs reload (a dev-server full reload does exactly this). The host tab goes first by a
    // beat so the BroadcastChannel test transport, which has no central id registry, does not see
    // two hosts race for the same code.
    const hostReload = host.reload();
    await host.waitForTimeout(300);
    await Promise.all([hostReload, guest.reload()]);
    await expect(host.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
    await expect(guest.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
    const quickOnline = (p: Page) =>
      expect(
        p
          .getByTestId('connection-badge')
          .filter({ hasText: /online/i })
          .first(),
      ).toBeVisible({ timeout: 8_000 });
    for (let attempt = 0; attempt < 4; attempt++) {
      for (const p of [guest, host]) {
        const rb = p.getByTestId('reconnect-button');
        if (await rb.count()) await rb.click();
      }
      try {
        await quickOnline(host);
        await quickOnline(guest);
        break;
      } catch {
        /* one more try */
      }
    }
    await expect(host.getByTestId('game-screen')).toHaveAttribute('data-seat', 'white');
    await expect(guest.getByTestId('game-screen')).toHaveAttribute('data-seat', 'black');
    await expect(host.getByTestId('player-name-black')).toContainText(GUEST.name);
    await expect(guest.getByTestId('player-name-white')).toContainText(HOST.name);
    await expect(host.getByTestId('game-screen')).toHaveAttribute('data-role', 'host');
  });

  test('settings and saved matches are per player', async ({ page, context }) => {
    await seedProfile(page, 'alice', HOST);
    await page.goto(profileUrl('alice', '/settings'));
    await page.getByTestId('preset-classic').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'classic');
    await page.getByTestId('pieces-sky-navy').click();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme-id',
      'warm-light/walnut-green/sky-navy',
    );
    const other = await context.newPage();
    await seedProfile(other, 'bob', GUEST);
    await other.goto(profileUrl('bob', '/settings'));
    await expect(other.locator('html')).toHaveAttribute('data-theme-id', 'midnight');
  });
});
