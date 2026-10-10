import { expect, test } from '@playwright/test';
import { GUEST, HOST, THIRD, approvePairing, pairLinkOf, seedProfile, menuAction } from './helpers';
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
    await menuAction(bob, 'ledger');
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

    // Alice pairs a "phone" from the hand-off panel; it opens the table as Alice.
    const link = await pairLinkOf(host);
    const phone = await context.newPage();
    await phone.goto(link);
    await approvePairing(host);
    await expect(phone.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
    await expect(phone.getByTestId('game-screen')).toHaveAttribute('data-seat', '0');
    await expect(phone.getByTestId('seat-name-0').first()).toContainText('Alice');
    await phone.close();

    // The host leaves: Bob's copy is only a view, so resuming waits for the host.
    const bobUrl = bob.url();
    await menuAction(host, 'leave');
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
    await menuAction(bob, 'table');
    await expect(bob.getByTestId('rail-sheet')).toBeVisible();
    await bob.getByTestId('sheet-close').click();
    const scrollW = await host.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(390 + 1);
    await expect(host.getByTestId('table-menu-button')).toBeVisible();
  });
});

for (const size of [
  { width: 360, height: 700 },
  { width: 760, height: 300 },
]) {
  test(`on a ${size.width}x${size.height} phone the player on turn sees their cards and Confirm without scrolling`, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ viewport: size, isMobile: true, hasTouch: true });
    const host = await ctx.newPage();
    await seedProfile(host, 'alice', HOST);
    const code = await hostTable(host, 'alice', { seats: 3, preset: 'standard-pineapple' });
    const bob = await ctx.newPage();
    await seedProfile(bob, 'bob', GUEST);
    await joinTable(bob, 'bob', code);
    const carol = await ctx.newPage();
    await seedProfile(carol, 'carol', THIRD);
    await joinTable(carol, 'carol', code);
    await expect(host.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'setting', {
      timeout: 15_000,
    });
    let actor: typeof host | null = null;
    for (const p of [host, bob, carol]) {
      if ((await p.getByTestId('ofc-table').getAttribute('data-my-turn')) === 'true') actor = p;
    }
    expect(actor).not.toBeNull();
    const p = actor!;
    await p.locator('[data-testid^="pending-card-"]').first().waitFor();
    const inView = async (testId: string) => {
      const b = (await p.getByTestId(testId).first().boundingBox())!;
      expect(b.y, `${testId} top`).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height, `${testId} bottom`).toBeLessThanOrEqual(size.height + 1);
      expect(b.x + b.width, `${testId} right`).toBeLessThanOrEqual(size.width + 1);
    };
    await inView('confirm-placement');
    await inView('pending-cards');
    const scroll = await p.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(scroll.sw).toBeLessThanOrEqual(scroll.cw + 1);
    await ctx.close();
  });
}

test('on a desktop, dragging a dealt card with the mouse moves that card and selects nothing', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const host = await ctx.newPage();
  await seedProfile(host, 'alice', HOST);
  const code = await hostTable(host, 'alice', { seats: 2, preset: 'standard-pineapple' });
  const bob = await ctx.newPage();
  await seedProfile(bob, 'bob', GUEST);
  await joinTable(bob, 'bob', code);
  await expect(host.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'setting', {
    timeout: 15_000,
  });
  const p =
    (await host.getByTestId('ofc-table').getAttribute('data-my-turn')) === 'true' ? host : bob;
  const seat = await p.getByTestId('game-screen').getAttribute('data-seat');
  const card = p.locator('[data-testid^="pending-card-"]').first();
  await card.waitFor();
  const key = (await card.getAttribute('data-testid'))!.replace('pending-card-', '');
  const from = (await card.boundingBox())!;
  const to = (await p.getByTestId(`row-${seat}-bottom`).boundingBox())!;
  await p.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await p.mouse.down();
  await p.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await p.mouse.up();
  await expect(p.getByTestId(`row-${seat}-bottom`)).toHaveAttribute('data-count', '1');
  await expect(p.getByTestId(`placed-card-${key}`)).toBeVisible();
  expect(await p.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

  // The placed card moves on again, to the top row.
  const placed = (await p.getByTestId(`placed-card-${key}`).boundingBox())!;
  const top = (await p.getByTestId(`row-${seat}-top`).boundingBox())!;
  await p.mouse.move(placed.x + placed.width / 2, placed.y + placed.height / 2);
  await p.mouse.down();
  await p.mouse.move(top.x + top.width / 2, top.y + top.height / 2, { steps: 12 });
  await p.mouse.up();
  await expect(p.getByTestId(`row-${seat}-top`)).toHaveAttribute('data-count', '1');
  await expect(p.getByTestId(`row-${seat}-bottom`)).toHaveAttribute('data-count', '0');
  expect(await p.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
  await ctx.close();
});

test('on a desktop the table scrolls with the wheel, so every hand at the showdown can be read', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const host = await ctx.newPage();
  await seedProfile(host, 'alice', HOST);
  const code = await hostTable(host, 'alice', { seats: 3, preset: 'standard-pineapple' });
  const bob = await ctx.newPage();
  await seedProfile(bob, 'bob', GUEST);
  await joinTable(bob, 'bob', code);
  const carol = await ctx.newPage();
  await seedProfile(carol, 'carol', THIRD);
  await joinTable(carol, 'carol', code);
  await expect(host.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'setting', {
    timeout: 15_000,
  });
  await playHand([host, bob, carol]);
  await expect(host.getByTestId('showdown-panel')).toBeVisible();

  const area = host.getByTestId('table-area');
  const box = (await area.boundingBox())!;
  for (const seat of [0, 1, 2]) {
    const bottomRow = host.getByTestId(`row-${seat}-bottom`);
    // Scroll with the wheel until the seat's bottom row is inside the table area.
    for (let i = 0; i < 20; i++) {
      const r = (await bottomRow.boundingBox())!;
      if (r.y >= box.y - 1 && r.y + r.height <= box.y + box.height + 1) break;
      await host.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await host.mouse.wheel(0, r.y > box.y ? 200 : -200);
      await host.waitForTimeout(50);
    }
    const r = (await bottomRow.boundingBox())!;
    expect(r.y, `seat ${seat} bottom row top`).toBeGreaterThanOrEqual(box.y - 1);
    expect(r.y + r.height, `seat ${seat} bottom row bottom`).toBeLessThanOrEqual(
      box.y + box.height + 1,
    );
  }
  // The page itself never had to scroll for it.
  expect(await host.evaluate(() => window.scrollY)).toBe(0);
  await ctx.close();
});

test('a guest is told once who hosts the table, and in portrait the table never runs under the panel below', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 860 },
    isMobile: true,
    hasTouch: true,
  });
  const host = await ctx.newPage();
  await seedProfile(host, 'alice', HOST);
  const code = await hostTable(host, 'alice', { seats: 2, preset: 'standard-pineapple' });
  await expect(host.getByTestId('trust-note')).toHaveCount(0);
  const bob = await ctx.newPage();
  await seedProfile(bob, 'bob', GUEST);
  await bob.goto(ofcUrl('bob', `/join/${code}`));
  await expect(bob.getByTestId('trust-note')).toContainText(`${HOST.name} is hosting this table`);
  await bob.getByTestId('trust-note-ok').click();
  await expect(bob.getByTestId('trust-note')).toHaveCount(0);
  await expect(bob.getByTestId('trust-line')).toContainText(`Hosted by ${HOST.name}`);
  await bob.reload();
  await expect(bob.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
  await bob.waitForTimeout(1500);
  await expect(bob.getByTestId('trust-note')).toHaveCount(0);

  await expect(host.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'setting', {
    timeout: 15_000,
  });
  for (const p of [host, bob]) {
    const area = (await p.getByTestId('table-area').boundingBox())!;
    const mine = (await p
      .locator('[data-testid="ofc-table"] section[data-me="true"]')
      .boundingBox())!;
    const rail = (await p.getByTestId('rail').boundingBox())!;
    // My board lies inside the table area, and the panel below starts after it.
    expect(mine.y + mine.height, 'my board inside the table area').toBeLessThanOrEqual(
      area.y + area.height + 1,
    );
    expect(rail.y, 'panel starts below my board').toBeGreaterThanOrEqual(mine.y + mine.height - 1);
  }
  await ctx.close();
});
