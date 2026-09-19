import { expect, test } from '@playwright/test';

test('creates an OFC table from a preset, opens it, deals nothing without players, stops it', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('tables-page')).toBeVisible();
  await expect(page.getByTestId('status-line')).toContainText('running');

  await page.getByTestId('new-table-button').click();
  await expect(page.getByTestId('new-table-page')).toBeVisible();
  await page.getByTestId('preset-standard-pineapple').click();
  await expect(page.getByTestId('rules-editor')).toHaveAttribute(
    'data-preset',
    'standard-pineapple',
  );
  await page.getByTestId('seats-3').click();
  await page.getByTestId('table-name').fill('Smoke table');
  await page.getByTestId('table-code').fill('SMOKE1');
  await page.getByTestId('create-table').click();

  await expect(page.getByTestId('table-page')).toBeVisible();
  await expect(page.getByTestId('room-code')).toHaveText('SMOKE1');
  await expect(page.getByTestId('invite-link')).toHaveValue(/#\/ofc\/join\/SMOKE1$/);
  await expect(page.getByTestId('qr').locator('svg')).toBeVisible();
  await expect(page.getByTestId('table-status')).toContainText('running');
  await expect(page.getByTestId('seat-2')).toContainText('open seat');
  await expect(page.getByTestId('deal-button')).toBeDisabled();
  await expect(page.getByTestId('ledger-panel')).toBeVisible();
  await expect(page.getByTestId('event-log')).toContainText('created ofc table SMOKE1');
  await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-live', 'open');

  await page.getByTestId('nav-tables').click();
  const card = page.locator('[data-testid^="table-card-"]').filter({ hasText: 'Smoke table' });
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('card-code')).toHaveText('SMOKE1');
  await card.getByTestId('card-stop').click();
  await expect(card).toHaveAttribute('data-status', 'stopped');
  await card.getByTestId('card-open').click();
  await expect(page.getByTestId('resume-button')).toBeVisible();
  await page.getByTestId('resume-button').click();
  await expect(page.getByTestId('stop-button')).toBeVisible();
  await page.getByTestId('stop-button').click();
  await expect(page.getByTestId('resume-button')).toBeVisible();
});

test('settings round-trip and rule sets persist in the dealer', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await page.getByTestId('dealer-name').fill('The House');
  await page.getByTestId('default-randomness').selectOption('seeded');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('toast')).toContainText('Settings saved');
  await page.reload();
  await expect(page.getByTestId('dealer-name')).toHaveValue('The House');
  await expect(page.getByTestId('default-randomness')).toHaveValue('seeded');

  await page.goto('/#/new');
  await page.getByTestId('preset-pineapple27').click();
  await page.getByTestId('ruleset-name').fill('Deuce night');
  await page.getByTestId('save-ruleset').click();
  await expect(page.getByTestId('ruleset-Deuce night')).toBeVisible();
  await page.getByTestId('preset-standard-ofc').click();
  await page.getByTestId('ruleset-Deuce night').click();
  await expect(page.getByTestId('variant-pineapple27')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('randomness-seeded')).toHaveAttribute('aria-checked', 'true');
});
