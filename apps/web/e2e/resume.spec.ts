import { expect, test } from '@playwright/test';
import {
  GUEST,
  HOST,
  appUrl,
  completeOpening,
  hostMatch,
  joinMatch,
  seedProfile,
  step,
} from './helpers';

test('a match survives the host leaving: the guest resumes as host and the original host rejoins', async ({
  page: host,
  context,
}) => {
  const guest = await context.newPage();
  await seedProfile(host, 'alice', HOST);
  await seedProfile(guest, 'bob', GUEST);

  const code = await hostMatch(host, 'alice', { length: 3 });
  await joinMatch(guest, 'bob', code);
  await host.getByTestId('start-game-button').click();
  await completeOpening(host, guest);

  // Play a couple of actions so there is real state to preserve.
  for (let i = 0; i < 3; i++) {
    if (!(await step([host, guest]))) break;
    await host.waitForTimeout(200);
  }
  const pipsBefore = {
    white: await guest.getByTestId('pips-white').textContent(),
    black: await guest.getByTestId('pips-black').textContent(),
  };
  const statusBefore = await guest.getByTestId('status-text').textContent();

  // Host walks away ("Leave" keeps the match saved on both sides), then closes the tab.
  await host.getByTestId('leave-button').click();
  await expect(host.getByTestId('home-screen')).toBeVisible();
  await expect(guest.getByTestId('connection-badge')).toHaveText(/disconnected|offline|stopped/i, {
    timeout: 15_000,
  });
  await host.close();

  // Guest goes home, finds the saved match and resumes — becoming the host.
  await guest.goto(appUrl('bob', '/'));
  const saved = guest.locator('[data-testid^="saved-game-"]').first();
  await expect(saved).toBeVisible();
  await expect(saved).toContainText(HOST.name);
  await saved.locator('[data-testid^="resume-"]').click();
  await expect(guest.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
  await expect(guest.getByTestId('game-screen')).toHaveAttribute('data-role', 'host');
  await expect(guest.getByTestId('pips-white')).toHaveText(pipsBefore.white ?? '');
  await expect(guest.getByTestId('pips-black')).toHaveText(pipsBefore.black ?? '');

  // The original host comes back in a fresh page with the same identity and joins by code.
  const hostAgain = await context.newPage();
  await seedProfile(hostAgain, 'alice', HOST);
  await joinMatch(hostAgain, 'alice', code);
  await expect(hostAgain.getByTestId('game-screen')).toHaveAttribute('data-role', 'guest');
  await expect(hostAgain.getByTestId('game-screen')).toHaveAttribute('data-seat', 'white');
  await expect(hostAgain.getByTestId('pips-white')).toHaveText(pipsBefore.white ?? '');
  await expect(hostAgain.getByTestId('pips-black')).toHaveText(pipsBefore.black ?? '');
  await expect(guest.getByTestId('connection-badge')).toHaveText(/opponent online/i);

  // Both agree on whose turn it is and the game continues.
  const guestStatus = await guest.getByTestId('status-text').textContent();
  expect(guestStatus?.trim()).toBe(statusBefore?.trim());
  expect(await step([guest, hostAgain])).toBe(true);
});
