import { expect, test } from '@playwright/test';
import { GUEST, HOST, appUrl, freshKeys, hostMatch, joinMatch, seedProfile } from './helpers';

/**
 * Seats are bound to the player's key: knowing Bob's id is not enough to sit as Bob.
 */
test("an impostor with Bob's id but another key is refused; Bob's real second device is seated", async ({
  context,
}) => {
  const host = await context.newPage();
  await seedProfile(host, 'alice', HOST);
  const code = await hostMatch(host, 'alice', { length: 1 });

  const bob = await context.newPage();
  await seedProfile(bob, 'bob', GUEST);
  await joinMatch(bob, 'bob', code);
  await expect(bob.getByTestId('game-screen')).toHaveAttribute('data-seat', 'black');

  // Same id, fresh key, different slug so the browser stores it separately.
  const impostor = await context.newPage();
  await seedProfile(impostor, 'mallory', GUEST, { keys: await freshKeys() });
  await impostor.goto(appUrl('mallory', `/join/${code}`));
  await expect(impostor.getByTestId('join-error')).toContainText(/key|allowed|refused|unauthor/i, {
    timeout: 20_000,
  });
  await expect(bob.getByTestId('game-screen')).toHaveAttribute('data-seat', 'black');
  await expect(host.getByTestId('connection-badge').first()).toContainText(/online/i);

  // Bob's genuine second device (same key) joins the same seat.
  const bobPhone = await context.newPage();
  await seedProfile(bobPhone, 'bob-phone', GUEST);
  await joinMatch(bobPhone, 'bob-phone', code);
  await expect(bobPhone.getByTestId('game-screen')).toHaveAttribute('data-seat', 'black');
  await expect(bob.getByTestId('game-screen')).toHaveAttribute('data-seat', 'black');
});
