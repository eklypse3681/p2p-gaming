import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * Losing a device: a player saved with a passkey comes back after the browser forgets them, and
 * one whose words were written down comes back in a completely fresh browser. The passkey is a
 * real WebAuthn credential with the PRF extension, made by Chrome's virtual authenticator; the
 * backup endpoint is emulated in the page so the test needs no Cloudflare.
 */

const backups = new Map<string, string>();

async function withBackupEndpoint(context: BrowserContext): Promise<void> {
  await context.route('**/api/backup-status', (route) =>
    route.fulfill({ status: 200, json: { passkeys: true } }),
  );
  await context.route('**/api/backup/*', async (route) => {
    const id = route.request().url().split('/api/backup/')[1]!;
    if (route.request().method() === 'PUT') {
      backups.set(id, route.request().postData() ?? '');
      await route.fulfill({ status: 200, json: { ok: true } });
    } else {
      const stored = backups.get(id);
      await route.fulfill(stored ? { status: 200, body: stored } : { status: 404, json: {} });
    }
  });
}

async function withPasskeys(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function newPlayer(page: Page, name: string): Promise<string> {
  await page.goto('/?transport=broadcast#/');
  await page.locator('input').first().fill(name);
  await page.locator('input').first().press('Enter');
  await expect(page).toHaveURL(/#\/[a-z0-9-]+\//);
  return page.url().split('#/')[1]!.split('/')[0]!;
}

const playerIndex = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('bgf:profiles') ?? '{}'));

test('a player saved with a passkey comes back after the browser forgets them', async ({
  page,
  context,
}) => {
  await withBackupEndpoint(context);
  await withPasskeys(page);
  const slug = await newPlayer(page, 'Steve');
  await page.goto(`/?transport=broadcast#/${slug}/settings`);
  await page.getByTestId('save-passkey').click();
  await expect(page.getByTestId('passkey-note')).toContainText('is saved', { timeout: 20_000 });
  const before = (await playerIndex(page))[slug];
  expect(backups.size).toBe(1);
  // What reached the server is ciphertext: not the key, not the seed.
  const stored = [...backups.values()][0]!;
  expect(stored).not.toContain(before.privateKey);
  expect(stored).not.toContain(before.seed);

  // The browser forgets the player; the passkey (the keychain) is all that is left.
  await page.evaluate(() => localStorage.clear());
  await page.goto('/?transport=broadcast#/');
  await page.getByTestId('restore-toggle').click();
  await page.getByTestId('restore-passkey').click();
  await expect(page).toHaveURL(new RegExp(`#/${slug}/`), { timeout: 20_000 });
  const after = (await playerIndex(page))[slug];
  expect(after.id).toBe(before.id);
  expect(after.publicKey).toBe(before.publicKey);
  expect(after.privateKey).toBe(before.privateKey);
});

test('the recovery words bring a player back in a fresh browser', async ({ browser }) => {
  const first = await (await browser.newContext()).newPage();
  const slug = await newPlayer(first, 'Dana');
  await first.goto(`/?transport=broadcast#/${slug}/settings`);
  await first.getByTestId('toggle-words').click();
  const words = await first.getByTestId('recovery-words').locator('li').allTextContents();
  expect(words).toHaveLength(24);
  const before = (await playerIndex(first))[slug];
  await first.context().close();

  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto('/?transport=broadcast#/');
  await fresh.getByTestId('restore-toggle').click();
  await fresh.getByTestId('restore-words').fill(words.join(' '));
  await fresh.getByTestId('restore-words-button').click();
  await expect(fresh).toHaveURL(/#\/[a-z0-9-]+\//, { timeout: 20_000 });
  const restored = Object.values(await playerIndex(fresh)) as { id: string; publicKey: string }[];
  expect(restored).toHaveLength(1);
  expect(restored[0]!.id).toBe(before.id);
  expect(restored[0]!.publicKey).toBe(before.publicKey);
  await fresh.context().close();
});
