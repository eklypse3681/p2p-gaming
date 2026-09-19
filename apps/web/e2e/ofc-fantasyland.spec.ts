import { expect, test } from '@playwright/test';

/**
 * Fantasyland via the standalone demo: the panel hides opponents, the sort buttons reorder the
 * tray, thirteen cards go down by keyboard, and the table opens up once the hand is set.
 */
test('Fantasyland: sorted tray, hidden opponents, keyboard placement, then showdown', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/#/ofc/demo');
  await expect(page.getByTestId('ofc-demo')).toBeVisible();
  await page.getByTestId('demo-reduced-motion').check();
  await page.getByTestId('demo-fantasyland').check();
  await page.getByTestId('start-hand-button').click();

  const panel = page.getByTestId('fantasyland-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('set your 14 cards');
  await expect(page.getByTestId('seat-hidden-1')).toBeVisible();
  await expect(page.getByTestId('seat-hidden-2')).toBeVisible();
  await expect(page.getByTestId('seat-1')).toHaveCount(0);
  await expect(page.locator('[data-testid^="pending-card-"]')).toHaveCount(14);

  const keys = async () =>
    (await page
      .locator('[data-testid^="pending-card-"]')
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('pending-card-', '')),
      )) as string[];
  const rank = (k: string) => '23456789TJQKA'.indexOf(k[0]!);
  await page.getByTestId('sort-low').click();
  const low = await keys();
  for (let i = 1; i < low.length; i++)
    expect(rank(low[i]!)).toBeGreaterThanOrEqual(rank(low[i - 1]!));
  await page.getByTestId('sort-high').click();
  const high = await keys();
  for (let i = 1; i < high.length; i++)
    expect(rank(high[i]!)).toBeLessThanOrEqual(rank(high[i - 1]!));
  await page.getByTestId('sort-suit').click();
  const suits = (await keys()).map((k) => k[1]!);
  expect(suits).toEqual(suits.slice().sort());

  // The tray and my rows never overlap.
  const tray = await page.getByTestId('pending-cards').boundingBox();
  const rows = await page.getByTestId('row-0-top').boundingBox();
  expect(tray && rows && tray.y + tray.height <= rows.y + 1).toBe(true);

  const plan = ['3', '3', '3', '3', '3', '2', '2', '2', '2', '2', '1', '1', '1'];
  for (const k of plan) {
    await page.locator('[data-testid^="pending-card-"]').first().click();
    await page.keyboard.press(k);
  }
  await expect(page.getByTestId('discard-slot')).toHaveAttribute('data-count', '1');
  await expect(page.getByTestId('confirm-placement')).toBeEnabled();
  await page.getByTestId('confirm-placement').click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('seat-1')).toBeVisible();

  // Bots finish the hand; the showdown shows pairwise columns with the viewer first.
  await expect(page.getByTestId('showdown-panel')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('showdown-seat-0')).toHaveAttribute('data-me', 'true');
  await expect(page.getByTestId('pair-0-vs-1')).toBeVisible();
  await expect(page.getByTestId('pair-0-vs-2')).toBeVisible();
  await expect(page.getByTestId('showdown-panel')).not.toContainText(/\b(won|lost)\b/);
});
