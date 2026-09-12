import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { HOST, appUrl, hostMatch, profileUrl, seedProfile } from './helpers';

/**
 * Moving a player to another browser: export from one context, import in a fresh one. The
 * player keeps the same id, so the saved match shows up and can be resumed as the host.
 */

async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('bgf:migrated', '1'));
  return page;
}

function storedProfileId(page: Page, slug: string): Promise<string | undefined> {
  return page.evaluate(
    (s) => JSON.parse(localStorage.getItem('bgf:profiles') ?? '{}')[s]?.id as string | undefined,
    slug,
  );
}

test.setTimeout(90_000);

test('export file → import in a fresh browser keeps the id and the saved match', async ({
  browser,
}) => {
  // Browser A: Alice hosts a match, then exports herself.
  const a = await freshPage(browser);
  await seedProfile(a, 'alice', HOST);
  const code = await hostMatch(a, 'alice', { length: 1 });
  const matchUrl = a.url();
  const matchId = matchUrl.slice(matchUrl.lastIndexOf('/') + 1).split('?')[0]!;
  await a.goto(profileUrl('alice', '/settings'));
  const [download] = await Promise.all([
    a.waitForEvent('download'),
    a.getByTestId('export-profile').click(),
  ]);
  expect(download.suggestedFilename()).toBe('p2p-gaming-alice.json');
  const path = await download.path();
  const exported = readFileSync(path!, 'utf8');
  expect(JSON.parse(exported)).toMatchObject({
    format: 'p2p-gaming-profile',
    profile: { id: HOST.id, name: 'Alice' },
  });
  // Alice leaves browser A entirely, so the room code is free again.
  await a.context().close();

  // Browser B: nothing here yet; import the file from the picker.
  const b = await freshPage(browser);
  await b.goto('/?transport=broadcast#/');
  await expect(b.getByTestId('picker-screen')).toBeVisible();
  await b.getByTestId('import-profile-toggle').click();
  await b.getByTestId('import-profile-file').setInputFiles({
    name: 'p2p-gaming-alice.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exported),
  });
  await expect(b.getByTestId('games-hub')).toBeVisible({ timeout: 10_000 });
  expect(b.url()).toContain('#/alice/');
  expect(await storedProfileId(b, 'alice')).toBe(HOST.id);

  // The match came along and can be resumed (hosting under its code, since A is gone).
  await b.goto(appUrl('alice', '/'));
  await expect(b.getByTestId(`saved-game-${matchId}`)).toBeVisible();
  await b.getByTestId(`resume-${matchId}`).click();
  await expect(b.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
  await expect(b.getByTestId('game-screen')).toHaveAttribute('data-seat', 'white');
  await expect(b.getByTestId('room-code').first()).toHaveText(code);
  await b.context().close();
});

test('transfer code → import carries identity and settings but no matches', async ({ browser }) => {
  const a = await freshPage(browser);
  await seedProfile(a, 'alice', HOST);
  await hostMatch(a, 'alice', { length: 1 });
  await a.goto(profileUrl('alice', '/settings'));
  await a.getByTestId('pieces-sky-navy').click();
  await a.getByTestId('copy-transfer-code').click();
  const code = await a.getByTestId('transfer-code').inputValue();
  expect(code.startsWith('p2pg1.')).toBe(true);
  await a.context().close();

  const b = await freshPage(browser);
  await b.goto('/?transport=broadcast#/');
  await b.getByTestId('import-profile-toggle').click();
  await b.getByTestId('import-profile-code').fill(code);
  await b.getByTestId('import-profile-button').click();
  await expect(b.getByTestId('games-hub')).toBeVisible({ timeout: 10_000 });
  expect(await storedProfileId(b, 'alice')).toBe(HOST.id);
  expect(
    await b.evaluate(() => JSON.parse(localStorage.getItem('bgf:settings:alice') ?? '{}').pieceSet),
  ).toBe('sky-navy');
  await b.goto(appUrl('alice', '/'));
  await expect(b.getByTestId('home-screen')).toBeVisible();
  await expect(b.locator('[data-testid^="saved-game-"]')).toHaveCount(0);
  await b.context().close();
});
