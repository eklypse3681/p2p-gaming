import { expect, test } from '@playwright/test';
import {
  GUEST,
  HOST,
  THIRD,
  appUrl,
  completeOpening,
  hostMatch,
  joinMatch,
  playMove,
  seedProfile,
  stageOne,
  statusOf,
} from './helpers';

test.describe('two players in one browser (BroadcastChannel transport)', () => {
  test('host and guest connect, roll for the opening, and play a turn', async ({
    page: host,
    context,
  }) => {
    const guest = await context.newPage();
    await seedProfile(host, 'alice', HOST);
    await seedProfile(guest, 'bob', GUEST);

    const code = await hostMatch(host, 'alice', { length: 1 });
    await expect(host.getByTestId('status-text')).toHaveText(/waiting for an opponent/i);

    await joinMatch(guest, 'bob', code);

    // Both see each other's names.
    await expect(host.getByTestId('player-name-black')).toContainText(GUEST.name);
    await expect(guest.getByTestId('player-name-white')).toContainText(HOST.name);
    await expect(host.getByTestId('connection-badge')).toHaveText(/opponent online/i);
    await expect(guest.getByTestId('connection-badge')).toHaveText(/opponent online/i);

    // One table: the host laid it out with home boards on the left, so the guest, sitting
    // across, has them on the right.
    await expect(host.getByTestId('board')).toHaveAttribute('data-home-side', 'left');
    await expect(guest.getByTestId('board')).toHaveAttribute('data-home-side', 'right');

    // Start the game (either side may).
    await host.getByTestId('start-game-button').click();
    await expect(host.getByTestId('opening-roll-button')).toBeVisible();
    await expect(guest.getByTestId('opening-roll-button')).toBeVisible();

    await completeOpening(host, guest);

    // Whoever is moving sees dice; the other sees "is moving".
    const hostMoving = await host.getByTestId('done-button').isVisible();
    const mover = hostMoving ? host : guest;
    const waiter = hostMoving ? guest : host;
    const moverName = hostMoving ? HOST.name : GUEST.name;
    await expect(mover.getByTestId('dice')).toBeVisible();
    const d0 = await mover.getByTestId('die-0').getAttribute('data-value');
    const d1 = await mover.getByTestId('die-1').getAttribute('data-value');
    expect(Number(d0)).toBeGreaterThanOrEqual(1);
    expect(Number(d1)).toBeLessThanOrEqual(6);
    await expect(waiter.getByTestId('status-text')).toHaveText(
      new RegExp(`${moverName} is moving`, 'i'),
    );
    await expect(mover.getByTestId('done-button')).toBeDisabled();

    // Undo works mid-draft.
    await stageOne(mover);
    await expect(mover.getByTestId('undo-button')).toBeEnabled();
    await mover.getByTestId('undo-button').click();
    await expect(mover.getByTestId('undo-button')).toBeDisabled();

    await playMove(mover);

    // Turn passes to the other player on both screens.
    await expect(waiter.getByTestId('roll-button')).toBeVisible({ timeout: 10_000 });
    await expect(mover.getByTestId('status-text')).toHaveText(/waiting for .* to roll/i);
    expect(await statusOf(waiter)).toMatch(/your roll/i);

    // Pip counts agree on both sides.
    const hostPips = await host.getByTestId('pips-white').textContent();
    const guestPips = await guest.getByTestId('pips-white').textContent();
    expect(hostPips).toBe(guestPips);

    // Chat round-trips.
    if (await guest.getByTestId('rail-tab-chat').isVisible())
      await guest.getByTestId('rail-tab-chat').click();
    await guest.getByTestId('chat-input').fill('gl hf');
    await guest.getByTestId('chat-send').click();
    await expect(host.locator('[data-testid="chat-message"]').last()).toContainText('gl hf');
  });

  test('a third player is turned away', async ({ page: host, context }) => {
    const guest = await context.newPage();
    const third = await context.newPage();
    await seedProfile(host, 'alice', HOST);
    await seedProfile(guest, 'bob', GUEST);
    await seedProfile(third, 'carol', THIRD);
    const code = await hostMatch(host, 'alice');
    await joinMatch(guest, 'bob', code);
    await third.goto(appUrl('carol', `/join/${code}`));
    await expect(third.getByTestId('join-error')).toHaveText(/two players/i, { timeout: 20_000 });
  });
});
