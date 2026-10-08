import { expect, test } from '@playwright/test';
import { GUEST, HOST, hostMatch, joinMatch, seedProfile, startGameIfNeeded } from './helpers';

test("holding the opponent's card shows the board numbered from their side until release", async ({
  page: host,
  context,
}) => {
  const guest = await context.newPage();
  await seedProfile(host, 'alice', HOST);
  await seedProfile(guest, 'bob', GUEST);
  const code = await hostMatch(host, 'alice', { length: 1 });
  await joinMatch(guest, 'bob', code);
  await startGameIfNeeded(host, [guest]);

  const labels = host.getByTestId('point-labels');
  const one = host.getByTestId('point-label-1');
  await expect(labels).toHaveAttribute('data-numbering', 'white');
  await expect(one).toHaveText('1');

  // Mouse: press on Bob's card, release somewhere else entirely.
  const card = (await host.getByTestId('player-card-black').boundingBox())!;
  await host.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await host.mouse.down();
  await expect(labels).toHaveAttribute('data-numbering', 'black');
  await expect(one).toHaveText('24');
  await host.mouse.move(5, 5);
  await host.mouse.up();
  await expect(labels).toHaveAttribute('data-numbering', 'white');
  await expect(one).toHaveText('1');

  // My own card does nothing.
  await host.getByTestId('player-card-white').click();
  await expect(labels).toHaveAttribute('data-numbering', 'white');
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('a press and hold works the same with a finger', async ({ page: host, context }) => {
    const guest = await context.newPage();
    await seedProfile(host, 'alice', HOST);
    await seedProfile(guest, 'bob', GUEST);
    const code = await hostMatch(host, 'alice', { length: 1 });
    await joinMatch(guest, 'bob', code);
    await startGameIfNeeded(host, [guest]);

    const labels = host.getByTestId('point-labels');
    await host.getByTestId('player-card-black').scrollIntoViewIfNeeded();
    const card = (await host.getByTestId('player-card-black').boundingBox())!;
    const cdp = await context.newCDPSession(host);
    const at = {
      x: card.x + card.width / 2,
      y: card.y + card.height / 2,
      radiusX: 8,
      radiusY: 8,
      force: 1,
    };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
    await expect(labels).toHaveAttribute('data-numbering', 'black');
    await host.waitForTimeout(700); // a long press must not turn into a menu or a selection
    await expect(labels).toHaveAttribute('data-numbering', 'black');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(labels).toHaveAttribute('data-numbering', 'white');
    await cdp.detach();
  });
});
