import { expect, test } from '@playwright/test';

test('the board demo renders a full position and reacts to theme changes', async ({ page }) => {
  await page.goto('/#/backgammon/demo');
  await expect(page.getByTestId('board-demo')).toBeVisible();
  const board = page.getByTestId('board');
  await expect(board).toBeVisible();
  await expect(page.getByTestId('hit-layer').locator('[data-point]')).toHaveCount(24);
  await expect(page.locator('[data-testid^="checker-"]')).toHaveCount(30);
  await expect(page.getByTestId('cube')).toBeVisible();

  const shape = page.getByTestId('point-shape-1').locator('path').first();
  const before = await shape.getAttribute('fill');
  const select = page.getByTestId('demo-theme');
  const options = await select.locator('option').allTextContents();
  expect(options.length).toBeGreaterThan(1);
  const values = await select
    .locator('option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  const current = await select.inputValue();
  const other = values.find((v) => v !== current)!;
  await select.selectOption(other);
  await expect(shape).not.toHaveAttribute('fill', before ?? '');

  // Flipping the perspective renumbers the frame.
  const labelBefore = await page.getByTestId('point-label-1').textContent();
  await page.getByTestId('demo-flip').click();
  await expect(page.getByTestId('point-label-1')).not.toHaveText(labelBefore ?? '');

  // Home board side: the default puts the 1-point bottom-left; toggling mirrors the frame.
  const bottomLeftLabel = async () => {
    const boxes = await page.locator('[data-testid^="point-label-"]').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { text: e.textContent ?? '', x: r.x, y: r.y };
      }),
    );
    const bottom = boxes.filter((b) => b.y > Math.max(...boxes.map((c) => c.y)) - 1);
    return bottom.sort((a, b) => a.x - b.x)[0]!.text;
  };
  await expect(board).toHaveAttribute('data-home-side', 'left');
  expect(await bottomLeftLabel()).toBe('1');
  await page.getByTestId('demo-home-side').click();
  await expect(board).toHaveAttribute('data-home-side', 'right');
  expect(await bottomLeftLabel()).toBe('12');
  const trayBox = (await page.getByTestId('off-white').boundingBox())!;
  const barBox = (await page.getByTestId('bar-white').boundingBox())!;
  expect(trayBox.x).toBeGreaterThan(barBox.x);

  // Settings theme switch also changes app chrome.
  await page.goto('/#/tester/settings');
  await expect(page.getByTestId('theme-picker')).toBeVisible();
});
