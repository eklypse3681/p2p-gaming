import { expect, test } from '@playwright/test';
import {
  GUEST,
  HOST,
  checkersAt,
  hostMatch,
  joinMatch,
  mouseDrag,
  seedProfile,
  touchDrag,
  touchTap,
} from './helpers';

test.use({ hasTouch: true });

test.describe('free board (no rule enforcement)', () => {
  test('either player moves anything with mouse or touch; hits, blocks, dice and scoring', async ({
    page: host,
    context,
  }) => {
    const guest = await context.newPage();
    await seedProfile(host, 'alice', HOST);
    await seedProfile(guest, 'bob', GUEST);

    const code = await hostMatch(host, 'alice', { length: 7, rules: 'free' });
    await joinMatch(guest, 'bob', code);
    await host.getByTestId('start-game-button').click();
    await expect(host.getByTestId('game-screen')).toHaveAttribute('data-rules', 'free');
    await expect(guest.getByTestId('status-text')).toHaveText(/free board/i);
    await expect(guest.getByTestId('board')).toHaveAttribute('data-interactive', 'true');
    await expect(host.getByTestId('board')).toHaveAttribute('data-interactive', 'true');

    // Guest (black) drags a WHITE checker with the mouse from abs 13 to the empty abs 10.
    await expect(checkersAt(guest, 'p13')).toHaveCount(5);
    await mouseDrag(guest, 'point-13', 'point-10');
    await expect(checkersAt(guest, 'p10')).toHaveCount(1);
    await expect(checkersAt(guest, 'p13')).toHaveCount(4);
    await expect(checkersAt(host, 'p10')).toHaveCount(1);
    await expect(checkersAt(host, 'p10').first()).toHaveAttribute('data-colour', 'white');

    // Host drags a BLACK checker with a finger from abs 12 onto that lone white checker: a hit.
    await touchDrag(host, 'point-12', 'point-10');
    await expect(checkersAt(host, 'bar-white')).toHaveCount(1);
    await expect(checkersAt(host, 'p10')).toHaveCount(1);
    await expect(checkersAt(host, 'p10').first()).toHaveAttribute('data-colour', 'black');
    await expect(checkersAt(guest, 'bar-white')).toHaveCount(1);
    await expect(checkersAt(guest, 'p12')).toHaveCount(4);

    // Dropping onto a made point (abs 6: five white checkers) changes nothing.
    await touchDrag(host, 'point-12', 'point-6');
    await expect(checkersAt(host, 'p6')).toHaveCount(5);
    await expect(checkersAt(host, 'p12')).toHaveCount(4);
    await expect(checkersAt(guest, 'p12')).toHaveCount(4);

    // Tap-to-select marks only the picked-up stack: a free board gives no guidance about
    // where a checker may go. Tapping the source again clears it.
    await touchTap(host, 'point-12');
    await expect(host.getByTestId('point-12')).toHaveAttribute('data-selected', 'true');
    await expect(host.locator('[data-target]')).toHaveCount(0);
    await expect(host.locator('[data-blocked]')).toHaveCount(0);
    await touchTap(host, 'point-12');
    await expect(host.getByTestId('point-12')).not.toHaveAttribute('data-selected', 'true');

    // The bar checker can be dragged back onto the board by either side.
    await mouseDrag(guest, 'bar-white', 'point-22');
    await expect(checkersAt(host, 'bar-white')).toHaveCount(0);
    await expect(checkersAt(host, 'p22')).toHaveCount(1);

    // Anyone rolls, any time; both see the same dice.
    await guest.getByTestId('roll-button').click();
    await expect(guest.getByTestId('dice')).toHaveAttribute('data-player', 'black');
    await expect(host.getByTestId('dice')).toHaveAttribute('data-player', 'black');
    await host.getByTestId('roll-button').click();
    await expect(guest.getByTestId('dice')).toHaveAttribute('data-player', 'white');
    const d0 = await guest.getByTestId('die-0').getAttribute('data-value');
    expect(await host.getByTestId('die-0').getAttribute('data-value')).toBe(d0);

    // Cube by hand.
    await host.getByTestId('cube-button').click();
    await host.getByTestId('cube-value-2').click();
    await expect(guest.getByTestId('cube')).toHaveAttribute('data-value', '2');
    await host.keyboard.press('Escape');

    // Record the result: white wins a gammon at cube 2 → 4 points for the host, on both pages.
    await host.getByTestId('record-result-button').click();
    await host.getByTestId('result-white-gammon').click();
    await host.getByTestId('confirm-result').click();
    await expect(host.getByTestId('game-over')).toBeVisible();
    await expect(host.getByTestId('score-white')).toHaveText('4');
    await expect(guest.getByTestId('score-white')).toHaveText('4');
    await expect(guest.getByTestId('game-over')).toContainText(/Alice wins/);

    // Next game starts a fresh free board.
    await guest.getByTestId('start-game-button').first().click();
    await expect(guest.getByTestId('status-text')).toHaveText(/free board/i);
    await expect(checkersAt(host, 'p13')).toHaveCount(5);
  });
});
