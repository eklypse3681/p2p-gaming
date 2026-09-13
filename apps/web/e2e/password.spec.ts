import { expect, test } from '@playwright/test';
import { GUEST, HOST, hostMatch, joinMatch, profileUrl, seedProfile } from './helpers';

test('a password locks the player: reload asks for it, a wrong one fails, the right one resumes the game', async ({
  context,
}) => {
  const alice = await context.newPage();
  await seedProfile(alice, 'alice', HOST);
  const code = await hostMatch(alice, 'alice', { length: 1 });
  const bob = await context.newPage();
  await seedProfile(bob, 'bob', GUEST);
  await joinMatch(bob, 'bob', code);
  const gameUrl = alice.url();

  // Set a password from Settings.
  await alice.goto(profileUrl('alice', '/settings'));
  await alice.getByTestId('set-password').click();
  await alice.getByTestId('password-input').fill('open-sesame');
  await alice.getByTestId('password-confirm').fill('open-sesame');
  await alice.getByTestId('password-submit').click();
  await expect(alice.getByTestId('password-note')).toContainText(/set/i);
  await expect(alice.getByTestId('change-password')).toBeVisible();
  // The stored record no longer holds the keys in the clear.
  const stored = await alice.evaluate(() => localStorage.getItem('bgf:profiles') ?? '');
  expect(stored).toContain('"secrets"');
  expect(stored).not.toContain('"privateKey"');

  // The tab that set the password stays unlocked (sessionStorage survives a reload)…
  await alice.reload();
  await expect(alice.getByTestId('settings-screen')).toBeVisible();
  // …and the picker shows the lock.
  await alice.goto('/?transport=broadcast#/');
  await expect(alice.getByTestId('profile-locked')).toBeVisible();

  // "Lock now" forgets the secrets in this tab: the next visit asks for the password.
  await alice.goto(profileUrl('alice', '/settings'));
  await alice.getByTestId('lock-now').click();
  await expect(alice.getByTestId('unlock-prompt')).toBeVisible();
  await alice.close();

  // A new tab (fresh sessionStorage) opening the game must unlock first; the server is gone with
  // the old tab, so the unlocked tab re-hosts and Bob reconnects.
  const again = await context.newPage();
  await again.goto(gameUrl);
  await expect(again.getByTestId('unlock-prompt')).toBeVisible({ timeout: 20_000 });
  await again.getByTestId('unlock-password').fill('wrong');
  await again.getByTestId('unlock-button').click();
  await expect(again.getByTestId('unlock-error')).toBeVisible();
  await again.getByTestId('unlock-password').fill('open-sesame');
  await again.getByTestId('unlock-button').click();
  await expect(again.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
  await expect(again.getByTestId('game-screen')).toHaveAttribute('data-seat', 'white');
  const rb = bob.getByTestId('reconnect-button');
  if (await rb.count()) await rb.click();
  await expect(again.getByTestId('connection-badge').first()).toContainText(/online/i, {
    timeout: 20_000,
  });

  // Choosing the locked player in the picker asks inline, then continues.
  const picker = await context.newPage();
  await picker.goto('/?transport=broadcast#/');
  await picker.getByTestId('profile-alice').click();
  await expect(picker.getByTestId('unlock-prompt')).toBeVisible();
  await picker.getByTestId('unlock-password').fill('open-sesame');
  await picker.getByTestId('unlock-button').click();
  await expect(picker.getByTestId('games-hub')).toBeVisible();
});
