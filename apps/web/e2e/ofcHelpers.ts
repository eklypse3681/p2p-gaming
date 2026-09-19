import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { appUrl } from './helpers';

export const ofcUrl = (profile: string, hash = '/') => appUrl(profile, hash, 'ofc');

/** Host a table from the OFC host screen with a preset and tweaks; returns the room code. */
export async function hostTable(
  page: Page,
  profile: string,
  opts: { preset?: string; seats?: 2 | 3; buyIn?: boolean; multiplier?: string } = {},
): Promise<string> {
  await page.goto(ofcUrl(profile, '/host'));
  await expect(page.getByTestId('rules-editor')).toBeVisible();
  if (opts.preset) await page.getByTestId(`rules-preset-${opts.preset}`).click();
  if (opts.seats) await page.getByTestId(`seats-${opts.seats}`).click();
  if (opts.buyIn) await page.getByTestId('scoring-buyin').click();
  if (opts.multiplier) {
    const m = page.getByTestId('multiplier-input');
    await m.fill(opts.multiplier);
  }
  await page.getByTestId('create-table-button').click();
  await expect(page.getByTestId('game-screen')).toBeVisible({ timeout: 15_000 });
  const code = (await page.getByTestId('room-code').first().textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  return code;
}

export async function joinTable(page: Page, profile: string, code: string): Promise<void> {
  await page.goto(ofcUrl(profile, `/join/${code}`));
  await expect(page.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
}

const CAPACITY: Record<string, number> = { top: 3, middle: 5, bottom: 5 };

/**
 * If this page's seat may act, place every required card (bottom, then middle, then top by
 * remaining room), let the tray discard the rest, confirm. Returns true when it acted.
 */
export async function placeIfMyTurn(page: Page): Promise<boolean> {
  const table = page.getByTestId('ofc-table');
  if ((await table.getAttribute('data-my-turn')) !== 'true') return false;
  // Right after a confirm the page may still say "my turn" until the next state arrives; with
  // no cards in hand there is nothing to place yet.
  if ((await page.locator('[data-testid^="pending-card-"]').count()) === 0) return false;
  const seat = await page.getByTestId('game-screen').getAttribute('data-seat');
  const confirm = page.getByTestId('confirm-placement');
  for (let i = 0; i < 20; i++) {
    if (await confirm.isEnabled().catch(() => false)) break;
    const card = page.locator('[data-testid^="pending-card-"]').first();
    if (!(await card.isVisible().catch(() => false))) break;
    await card.click();
    let placed = false;
    for (const row of ['bottom', 'middle', 'top']) {
      const el = page.getByTestId(`row-${seat}-${row}`);
      const count = Number((await el.getAttribute('data-count')) ?? '0');
      if (count < CAPACITY[row]!) {
        await el.click();
        placed = true;
        break;
      }
    }
    if (!placed) break;
  }
  await expect(confirm).toBeEnabled({ timeout: 5_000 });
  await confirm.click();
  return true;
}

/** Play the current hand to its showdown, whichever pages need to act. */
export async function playHand(pages: Page[]): Promise<void> {
  for (let round = 0; round < 80; round++) {
    if (
      await pages[0]!
        .getByTestId('showdown-panel')
        .isVisible()
        .catch(() => false)
    )
      return;
    let acted = false;
    for (const p of pages) {
      if (await placeIfMyTurn(p)) {
        acted = true;
        break;
      }
    }
    if (!acted) await pages[0]!.waitForTimeout(150);
  }
  throw new Error('hand did not reach the showdown');
}
