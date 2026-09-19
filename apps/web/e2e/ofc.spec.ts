import { expect, test } from '@playwright/test';
import { GUEST, HOST, THIRD, seedProfile } from './helpers';
import { hostTable, joinTable, ofcUrl, playHand } from './ofcHelpers';

test.describe('Open Face Chinese Poker', () => {
  test('three players host, join, play a hand and settle a buy-in ledger', async ({
    page: host,
    context,
  }) => {
    test.setTimeout(120_000);
    await seedProfile(host, 'alice', HOST);
    const code = await hostTable(host, 'alice', {
      preset: 'standard-pineapple',
      seats: 3,
      buyIn: true,
      multiplier: '0.5',
    });
    await expect(host.getByTestId('rules-summary').first()).toContainText(
      'Pineapple · 3 players · buy-in 100 · ×0.5',
    );

    const bob = await context.newPage();
    await seedProfile(bob, 'bob', GUEST);
    await joinTable(bob, 'bob', code);
    const carol = await context.newPage();
    await seedProfile(carol, 'carol', THIRD);
    await joinTable(carol, 'carol', code);
    const pages = [host, bob, carol];
    for (const p of pages) {
      await expect(p.getByTestId('connection-badge').first()).toContainText(/online/i, {
        timeout: 20_000,
      });
      await expect(p.getByTestId('seat-name-2').first()).toContainText('Carol');
    }
    expect(bob.url()).toContain('#/bob/ofc/game/');

    // Nobody deals: the table is unattended by default and dealt when the last seat filled.
    expect(await host.getByTestId('start-hand-button').count()).toBe(0);
    await expect(host.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'setting', {
      timeout: 10_000,
    });
    await playHand(pages);

    // Scores are zero-sum across the three seats and identical on every page.
    const totals: number[] = [];
    for (const i of [0, 1, 2]) {
      totals.push(Number(await host.getByTestId(`hand-total-${i}`).getAttribute('data-points')));
    }
    expect(totals.reduce((a, b) => a + b, 0)).toBe(0);
    for (const p of [bob, carol]) {
      for (const i of [0, 1, 2]) {
        expect(Number(await p.getByTestId(`hand-total-${i}`).getAttribute('data-points'))).toBe(
          totals[i],
        );
      }
    }
    // Every seat's block lists a column per opponent; no win/lose words anywhere.
    await expect(host.getByTestId('pair-0-vs-1')).toBeVisible();
    await expect(host.getByTestId('pair-1-vs-2')).toBeVisible();
    await expect(host.getByTestId('showdown-panel')).not.toContainText(/\b(won|lost)\b/);

    // The score sheet shows one hand entry; the full ledger (amounts at half a unit per point,
    // an immediate settlement) sits under Advanced.
    await bob.getByTestId('ledger-button').first().click();
    await expect(bob.getByTestId('ledger-sheet')).toBeVisible();
    await expect(bob.locator('[data-testid="ledger-entry"][data-kind="hand"]')).toHaveCount(1);
    await bob.getByTestId('ledger-advanced').click();
    const planRows = bob.getByTestId('ledger-plan-row');
    const n = await planRows.count();
    for (let i = 0; i < n; i++) {
      const text = (await planRows.nth(i).textContent()) ?? '';
      const m = text.match(/(\d+) pts · \$(\d+\.\d\d)/);
      expect(m, text).not.toBeNull();
      expect(Number(m![2])).toBeCloseTo(Number(m![1]) * 0.5, 2);
    }
    if (n > 0) {
      await bob.getByTestId('settle-button').click();
      await bob.getByTestId('confirm-settle').click();
      await expect(bob.getByTestId('ledger-settled')).toBeVisible({ timeout: 10_000 });
      await expect(bob.locator('[data-testid="ledger-entry"][data-kind="settlement"]')).toHaveCount(
        1,
      );
      for (const i of [0, 1, 2]) {
        await expect(bob.getByTestId(`ledger-balance-${i}`)).toContainText('100');
      }
    }
    await bob.getByTestId('ledger-close').click();
    // Every page's balances are back to the buy-in.
    for (const p of pages) {
      for (const i of [0, 1, 2]) await expect(p.getByTestId(`balance-${i}`)).toHaveText('100');
    }

    // Unattended flow: the next hand deals itself once everyone presses Ready.
    for (const p of pages) await expect(p.getByTestId('ready-button')).toBeVisible();
    await host.getByTestId('ready-button').click();
    await expect(bob.getByTestId('ready-0')).toHaveAttribute('data-ready', 'true');
    await expect(host.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'showdown');
    await bob.getByTestId('ready-button').click();
    await carol.getByTestId('ready-button').click();
    await expect(host.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'setting', {
      timeout: 10_000,
    });
    await expect(host.getByTestId('hand-number')).toContainText('Hand 2');
  });

  test('a two-player 2-7 table labels the middle row and completes a hand', async ({
    page: host,
    context,
  }) => {
    test.setTimeout(90_000);
    await seedProfile(host, 'alice', HOST);
    const code = await hostTable(host, 'alice', { preset: 'pineapple27' });
    await expect(host.getByTestId('rules-summary').first()).toContainText('Pineapple 2-7');
    const bob = await context.newPage();
    await seedProfile(bob, 'bob', GUEST);
    await joinTable(bob, 'bob', code);
    await expect(host.getByTestId('connection-badge').first()).toContainText(/online/i, {
      timeout: 20_000,
    });
    await expect(host.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'setting', {
      timeout: 10_000,
    });
    await expect(host.getByTestId('ofc-table')).toHaveAttribute('data-variant', 'pineapple27');
    await expect(host.getByTestId('ofc-table')).toContainText(/2-7/);
    await playHand([host, bob]);
    await expect(bob.getByTestId('showdown-panel')).toBeVisible();
    await expect(host.getByTestId('history-stats')).toHaveCount(0);
    // History records the hand.
    await host.goto(ofcUrl('alice', '/history'));
    await expect(host.getByTestId('history-stats')).toContainText('1');
    await expect(host.getByTestId('history-list')).toContainText('Pineapple 2-7');
  });

  test('hand-off seats a second device as the same player, and a guest waits for an absent host', async ({
    page: host,
    context,
  }) => {
    test.setTimeout(90_000);
    await seedProfile(host, 'alice', HOST);
    const code = await hostTable(host, 'alice', { preset: 'standard-ofc' });
    const bob = await context.newPage();
    await seedProfile(bob, 'bob', GUEST);
    await joinTable(bob, 'bob', code);
    await expect(host.getByTestId('connection-badge').first()).toContainText(/online/i, {
      timeout: 20_000,
    });

    // Alice's hand-off link opens the table as Alice on a "phone".
    const link = await host.getByTestId('handoff-link').first().inputValue();
    const phone = await context.newPage();
    await phone.goto(link);
    await expect(phone.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
    await expect(phone.getByTestId('game-screen')).toHaveAttribute('data-seat', '0');
    await expect(phone.getByTestId('seat-name-0').first()).toContainText('Alice');
    await phone.close();

    // The host leaves: Bob's copy is only a view, so resuming waits for the host.
    const bobUrl = bob.url();
    await host.getByTestId('leave-button').click();
    await expect(host.getByTestId('home-screen')).toBeVisible();
    await expect(bob.getByTestId('disconnected-banner')).toBeVisible({ timeout: 20_000 });
    await bob.goto(ofcUrl('bob', '/'));
    await expect(bob.getByTestId('continue-section')).toContainText('hosted elsewhere');
    await bob.goto(bobUrl);
    // A view can only rejoin; the join probe waits its full timeout before reporting no host.
    await expect(bob.getByTestId('host-offline')).toContainText('Waiting for Alice', {
      timeout: 45_000,
    });
  });

  test('portrait and landscape phones keep the table on screen', async ({
    page: host,
    context,
  }) => {
    await seedProfile(host, 'alice', HOST);
    await host.setViewportSize({ width: 390, height: 844 });
    const code = await hostTable(host, 'alice');
    const bob = await context.newPage();
    await seedProfile(bob, 'bob', GUEST);
    await bob.setViewportSize({ width: 844, height: 390 });
    await joinTable(bob, 'bob', code);
    await expect(bob.getByTestId('game-screen')).toHaveAttribute('data-layout', 'landscape');
    const box = await bob.getByTestId('ofc-table').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(844 + 1);
    await bob.getByTestId('more-button').click();
    await expect(bob.getByTestId('rail-sheet')).toBeVisible();
    await bob.getByTestId('sheet-close').click();
    const scrollW = await host.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(390 + 1);
    await expect(host.getByTestId('leave-button')).toBeVisible();
  });
});
