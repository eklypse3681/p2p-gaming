import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  GUEST,
  HOST,
  completeOpening,
  hostMatch,
  joinMatch,
  playMove,
  seedProfile,
  startGameIfNeeded,
} from './helpers';

/** The page whose turn it is to roll, once one is. */
async function roller(pages: Page[]): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    for (const p of pages) {
      if (
        await p
          .getByTestId('roll-button')
          .isVisible()
          .catch(() => false)
      )
        return p;
    }
    await pages[0]!.waitForTimeout(100);
  }
  throw new Error('nobody got to roll');
}

test('tapping the cube on your roll asks, then offers the double; the opponent shows away when gone', async ({
  page: host,
  context,
}) => {
  const guest = await context.newPage();
  await seedProfile(host, 'alice', HOST);
  await seedProfile(guest, 'bob', GUEST);
  const code = await hostMatch(host, 'alice', { length: 3 });
  await joinMatch(guest, 'bob', code);
  await startGameIfNeeded(host, [guest]);
  await completeOpening(host, guest);
  const mover = (await host.getByTestId('done-button').isVisible()) ? host : guest;
  const other = mover === host ? guest : host;

  // While moving, the cube is not a button.
  await expect(mover.getByTestId('cube-hit')).toHaveCount(0);
  await playMove(mover);

  // On the next player's roll the centred cube is: cancel first, then double for real.
  const r = await roller([other, mover]);
  const responder = r === host ? guest : host;
  await expect(r.getByTestId('cube')).toHaveAttribute('data-pressable', 'true');
  await expect(responder.getByTestId('cube-hit')).toHaveCount(0);
  await r.getByTestId('cube-hit').click();
  await expect(r.getByTestId('double-confirm')).toBeVisible();
  await r.getByTestId('cancel-double').click();
  await expect(r.getByTestId('double-confirm')).toHaveCount(0);
  await expect(responder.getByTestId('take-button')).toHaveCount(0);

  await r.getByTestId('cube-hit').click();
  await r.getByTestId('confirm-double').click();
  await expect(responder.getByTestId('take-button')).toBeVisible();
  await expect(responder.getByTestId('cube')).toHaveAttribute('data-offered');

  // The responder walks away: their card on the other side turns "away".
  const goneSeat = (await responder.getByTestId('game-screen').getAttribute('data-seat'))!;
  await expect(r.getByTestId(`player-card-${goneSeat}`)).toHaveAttribute('data-presence', 'here');
  await responder.close();
  await expect(r.getByTestId(`player-card-${goneSeat}`)).toHaveAttribute('data-presence', 'away', {
    timeout: 20_000,
  });
  await expect(r.getByTestId(`presence-${goneSeat}`)).toHaveText(/away/i);
});
