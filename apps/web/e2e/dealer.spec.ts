import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { GUEST, HOST, THIRD, appUrl, completeOpening, playMove, seedProfile } from './helpers';
import { joinTable, ofcUrl, playHand } from './ofcHelpers';

/**
 * A non-playing host ("dealer") runs the table; every seat is a guest. With seeded randomness
 * from this device the seed is committed before the hand and revealed at showdown, so the
 * fairness panel on any guest can re-derive the deal.
 */

async function hostAsDealer(page: Page, profile: string, game: 'ofc' | 'backgammon') {
  await page.goto(game === 'ofc' ? ofcUrl(profile, '/host') : appUrl(profile, '/host'));
  await expect(page.getByTestId('host-table-options')).toBeVisible();
  if (game === 'ofc') await page.getByTestId('rules-preset-standard-pineapple').click();
  else await page.getByTestId('length-1').click();
  await page.getByTestId('host-randomness-change').click();
  await page.getByTestId('host-mode-seeded').click();
  await page.getByTestId('host-as-dealer').check();
  await page.getByTestId(game === 'ofc' ? 'create-table-button' : 'create-match-button').click();
  await expect(page.getByTestId('game-screen')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('game-screen')).toHaveAttribute('data-role', 'dealer');
  const code = (await page.getByTestId('room-code').first().textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  return code;
}

test.describe('dealer-hosted tables', () => {
  test('OFC: the dealer deals, two guests play to the showdown, and the seeded hand verifies', async ({
    page: dealer,
    context,
  }) => {
    test.setTimeout(120_000);
    await seedProfile(dealer, 'alice', HOST);
    const code = await hostAsDealer(dealer, 'alice', 'ofc');

    const bob = await context.newPage();
    await seedProfile(bob, 'bob', GUEST);
    await joinTable(bob, 'bob', code);
    const carol = await context.newPage();
    await seedProfile(carol, 'carol', THIRD);
    await joinTable(carol, 'carol', code);

    // Guests fill both seats; the dealer holds none and sees the dealer bar instead of rows.
    await expect(bob.getByTestId('game-screen')).toHaveAttribute('data-seat', '0');
    await expect(carol.getByTestId('game-screen')).toHaveAttribute('data-seat', '1');
    await expect(dealer.getByTestId('dealer-bar')).toBeVisible();
    await expect(dealer.getByTestId('dealer-chip')).toContainText('Alice');
    expect(await dealer.locator('[data-testid^="seat-"][data-me="true"]').count()).toBe(0);
    await expect(bob.getByTestId('dealer-badge').first()).toContainText('Dealt by Alice');
    for (const p of [dealer, bob, carol]) {
      await expect(p.getByTestId('connection-badge').first()).toContainText(/online/i, {
        timeout: 20_000,
      });
    }

    // The dealer touches nothing: the table dealt the moment both seats were taken. The dealer's
    // overrides sit behind "Advanced".
    await expect(bob.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'setting', {
      timeout: 15_000,
    });
    await expect(dealer.getByTestId('dealer-advanced')).toBeVisible();
    await expect(dealer.getByTestId('status-text').first()).toContainText(/is setting/);
    await playHand([bob, carol]);
    await expect(dealer.getByTestId('showdown-panel')).toBeVisible({ timeout: 15_000 });
    await expect(dealer.getByTestId('status-text').first()).toContainText(/0\/2 ready/);

    // The seed was revealed at showdown; a guest can verify every draw of the hand.
    await bob.getByTestId('fairness-button').first().click();
    const panel = bob.getByTestId('fairness-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('fairness-mode')).toHaveAttribute('data-mode', 'seeded');
    await expect(panel.getByTestId('fairness-segment-0')).toHaveAttribute('data-revealed', 'true');
    await expect(panel.getByTestId('fairness-source')).toHaveAttribute('data-provider', 'crypto');
    // This device's randomness: derivation from the revealed seed is checkable, provenance is not.
    await expect(panel.getByTestId('fairness-verdict')).toContainText(/not verifiable/);
    expect(await panel.locator('[data-testid^="fairness-row-"]').count()).toBeGreaterThan(0);
    await panel.getByTestId('fairness-close').click();

    // Both players press Ready: the next hand deals itself.
    await bob.getByTestId('ready-button').click();
    await expect(dealer.getByTestId('status-text').first()).toContainText(/1\/2 ready/);
    await carol.getByTestId('ready-button').click();
    await expect(bob.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'setting', {
      timeout: 15_000,
    });
    await expect(bob.getByTestId('hand-number')).toContainText('Hand 2');
    await playHand([bob, carol]);
    await expect(bob.getByTestId('showdown-panel')).toBeVisible({ timeout: 15_000 });

    // Both ask to reset the scores: the table settles by itself and the sheet records it.
    await bob.getByTestId('settle-request-button').first().click();
    await expect(carol.getByTestId('settle-requests').first()).toContainText(/Bob wants/);
    await carol.getByTestId('settle-request-button').first().click();
    await bob.getByTestId('ledger-button').first().click();
    await expect(bob.locator('[data-testid="ledger-entry"][data-kind="settlement"]')).toHaveCount(
      1,
      { timeout: 10_000 },
    );
    await bob.getByTestId('ledger-close').click();

    // The dealer's overrides are still there, behind Advanced.
    await dealer.getByTestId('dealer-advanced').locator('summary').click();
    await dealer.getByTestId('settle-button').click();
    await expect(dealer.getByTestId('ledger-sheet')).toBeVisible();
  });

  test('backgammon: a dealer relays a match between two guests; the fairness panel shows the game segment', async ({
    page: dealer,
    context,
  }) => {
    test.setTimeout(120_000);
    await seedProfile(dealer, 'alice', HOST);
    const code = await hostAsDealer(dealer, 'alice', 'backgammon');

    const bob = await context.newPage();
    await seedProfile(bob, 'bob', GUEST);
    await bob.goto(appUrl('bob', `/join/${code}`));
    await expect(bob.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
    const carol = await context.newPage();
    await seedProfile(carol, 'carol', THIRD);
    await carol.goto(appUrl('carol', `/join/${code}`));
    await expect(carol.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });

    await expect(bob.getByTestId('game-screen')).toHaveAttribute('data-seat', 'white');
    await expect(carol.getByTestId('game-screen')).toHaveAttribute('data-seat', 'black');
    await expect(dealer.getByTestId('dealer-bar')).toBeVisible();
    expect(await dealer.getByTestId('roll-button').count()).toBe(0);
    await expect(dealer.getByTestId('dealer-badge').first()).toContainText('Dealt by Alice (you)');

    // Nobody presses Start: the game began when both players were seated. The guests play the
    // opening plus one move; the dealer only watches.
    expect(await bob.getByTestId('start-game-button').count()).toBe(0);
    await completeOpening(bob, carol);
    const mover = (await bob
      .getByTestId('done-button')
      .isVisible()
      .catch(() => false))
      ? bob
      : carol;
    await playMove(mover);
    await expect(dealer.getByTestId('status-text').first()).toContainText(/Dealing for/);

    await bob.getByTestId('fairness-button').first().click();
    const panel = bob.getByTestId('fairness-panel');
    await expect(panel.getByTestId('fairness-mode')).toHaveAttribute('data-mode', 'seeded');
    // One game = one segment: the current game's segment is committed but not revealed yet.
    await expect(panel.getByTestId('fairness-segment')).toContainText('not revealed yet');
    const open = panel.locator('[data-testid^="fairness-segment-"][data-revealed="false"]');
    expect(await open.count()).toBe(1);
    expect(await panel.locator('[data-testid^="fairness-row-"]').count()).toBeGreaterThan(0);
  });
});
