import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  GUEST,
  HOST,
  approvePairing,
  completeOpening,
  hostMatch,
  joinMatch,
  pairLinkOf,
  seedProfile,
  step,
  startGameIfNeeded,
} from './helpers';

/**
 * "Move to another device": the hand-off panel pairs another page with the player and opens the
 * match there as the *same* player, once approved. Both devices share the seat and stay in sync.
 * (All pages live in one browser context because the BroadcastChannel test transport only
 * crosses tabs of one context, so the "phone" already holds the player; pairing across separate
 * storage is covered by sync.spec.ts.)
 */
test.setTimeout(120_000);

/** Open the hand-off panel's pairing link on `phone` and approve it from `from`. */
async function handOff(from: Page, phone: Page): Promise<void> {
  const link = await pairLinkOf(from);
  expect(link).toContain('?next=backgammon/join/');
  await phone.goto(link);
  await approvePairing(from);
}

const online = (page: Page) =>
  expect(page.getByTestId('connection-badge').first()).toHaveText(/opponent online/i, {
    timeout: 20_000,
  });

test('the host hands the game to a second device; both stay in sync and the second one can take over', async ({
  page: laptop,
  context,
}) => {
  const bob = await context.newPage();
  await seedProfile(laptop, 'alice', HOST);
  await seedProfile(bob, 'bob', GUEST);
  const code = await hostMatch(laptop, 'alice', { length: 1 });
  await joinMatch(bob, 'bob', code);
  await startGameIfNeeded(laptop);
  await expect(laptop.getByTestId('opening-roll-button')).toBeVisible();

  // Scan the QR (open its link) on a "phone".
  const phone = await context.newPage();
  await handOff(laptop, phone);
  await expect(phone.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
  await expect(phone.getByTestId('game-screen')).toHaveAttribute('data-seat', 'white');
  await expect(phone.getByTestId('player-name-white')).toContainText(HOST.name);
  await online(phone);
  await online(laptop);
  await online(bob);

  // Acting on the phone is visible on the laptop without touching it.
  await phone.getByTestId('opening-roll-button').click();
  await expect(laptop.getByTestId('opening-roll-button')).toHaveCount(0, { timeout: 10_000 });
  await completeOpening(phone, bob);
  const statusPhone = await phone.getByTestId('status-text').first().textContent();
  await expect(laptop.getByTestId('status-text').first()).toHaveText(statusPhone?.trim() ?? '');

  // The laptop leaves: it was hosting, so the table goes down; the phone takes over as host.
  await laptop.getByTestId('leave-button').click();
  await expect(laptop.getByTestId('home-screen')).toBeVisible();
  await expect(phone.getByTestId('reconnect-button')).toBeVisible({ timeout: 20_000 });
  await phone.getByTestId('reconnect-button').click();
  await expect(phone.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
  await expect(phone.getByTestId('game-screen')).toHaveAttribute('data-seat', 'white');
  await expect(bob.getByTestId('reconnect-button')).toBeVisible({ timeout: 20_000 });
  await bob.getByTestId('reconnect-button').click();
  await expect(bob.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
  await online(phone);
  await online(bob);
  const roles = await Promise.all(
    [phone, bob].map((p) => p.getByTestId('game-screen').getAttribute('data-role')),
  );
  expect(roles.sort()).toEqual(['guest', 'host']);
  await expect(bob.getByTestId('game-screen')).toHaveAttribute('data-seat', 'black');
  expect(await step([phone, bob])).toBe(true);
});

test('a guest hands the game to a second device without interrupting anyone', async ({
  page: alice,
  context,
}) => {
  const bob = await context.newPage();
  await seedProfile(alice, 'alice', HOST);
  await seedProfile(bob, 'bob', GUEST);
  const code = await hostMatch(alice, 'alice', { length: 1 });
  await joinMatch(bob, 'bob', code);
  await startGameIfNeeded(bob);

  const bobPhone = await context.newPage();
  await handOff(bob, bobPhone);
  await expect(bobPhone.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
  await expect(bobPhone.getByTestId('game-screen')).toHaveAttribute('data-seat', 'black');
  await expect(bobPhone.getByTestId('game-screen')).toHaveAttribute('data-role', 'guest');
  await online(bobPhone);
  await online(alice);
  await expect(bob.getByTestId('game-screen')).toBeVisible(); // the first device is still in

  // Bob rolls from the phone; the laptop copy of Bob and Alice both see it.
  await bobPhone.getByTestId('opening-roll-button').click();
  await expect(bob.getByTestId('opening-roll-button')).toHaveCount(0, { timeout: 10_000 });
  await alice.getByTestId('opening-roll-button').click();
  await completeOpening(alice, bobPhone);
  // Status text is phrased per viewer ("Your move" vs "Bob is moving"), so compare Bob's two
  // devices with each other and check all three agree on the dice.
  const bobStatus = (await bob.getByTestId('status-text').first().textContent())?.trim() ?? '';
  await expect(bobPhone.getByTestId('status-text').first()).toHaveText(bobStatus);
  const dice = bobStatus.match(/\d[–-]\d/)?.[0] ?? '';
  expect(dice).not.toBe('');
  await expect(alice.getByTestId('status-text').first()).toContainText(dice);

  // Closing the phone does not change Bob's presence for Alice.
  await bobPhone.close();
  await alice.waitForTimeout(500);
  await online(alice);
});
