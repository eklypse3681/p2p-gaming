import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { GUEST, HOST, approvePairing, pairLinkOf, seedProfile, startGameIfNeeded } from './helpers';

/**
 * Device-to-device profile sync over the real network (PeerJS cloud + WebRTC), so it is opt-in:
 *   E2E_NETWORK=1 pnpm --filter @bgf/web test:e2e e2e/sync.spec.ts
 * Three separate browser contexts play "laptop", "opponent" and "phone". The laptop pairs the
 * phone (which makes its own key; the approval sends a grant and the sync key) and — with no match
 * code at all — the phone sees the match arrive in its Continue list, then joins it as Alice. A
 * settings change on the laptop follows.
 */
test.skip(!process.env.E2E_NETWORK, 'needs the network (set E2E_NETWORK=1)');
test.setTimeout(180_000);

const BASE = '/?transport=peerjs';
const SYNC_KEY = 'e2e-sync-key-alice-0001';

async function pageIn(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  return { ctx, page };
}

const online = (page: Page) =>
  expect(page.getByTestId('connection-badge').first()).toHaveText(/opponent online/i, {
    timeout: 60_000,
  });

test('a match and a setting reach a second device through sync alone', async ({ browser }) => {
  const laptop = await pageIn(browser);
  const opponent = await pageIn(browser);
  const phone = await pageIn(browser);
  await seedProfile(laptop.page, 'alice', HOST, { syncKey: SYNC_KEY });
  await seedProfile(opponent.page, 'bob', GUEST);

  // Laptop hosts, Bob joins, and the game starts so there is something worth syncing.
  await laptop.page.goto(`${BASE}#/alice/backgammon/host`);
  await laptop.page.getByTestId('length-1').click();
  await laptop.page.getByTestId('create-match-button').click();
  await expect(laptop.page.getByTestId('game-screen')).toBeVisible({ timeout: 30_000 });
  const code = (await laptop.page.getByTestId('room-code').first().textContent())!.trim();
  const matchId = laptop.page.url().split('/game/')[1]!.split('?')[0]!;
  await opponent.page.goto(`${BASE}#/bob/backgammon/join/${code}`);
  await online(opponent.page);
  await online(laptop.page);
  await startGameIfNeeded(opponent.page);
  await expect(laptop.page.getByTestId('opening-roll-button')).toBeVisible({ timeout: 20_000 });

  // The laptop pairs the phone: the phone makes its own key, the laptop approves it.
  await laptop.page.goto(`${BASE}#/alice/settings`);
  await expect(laptop.page.getByTestId('sync-status')).toHaveAttribute('data-state', 'hub', {
    timeout: 60_000,
  });
  await laptop.page.getByTestId('add-device').click();
  await phone.page.goto(await pairLinkOf(laptop.page));
  await approvePairing(laptop.page);
  await expect(phone.page).toHaveURL(/#\/alice\/$/, { timeout: 30_000 });
  const phoneRecord = await phone.page.evaluate(
    () => JSON.parse(localStorage.getItem('bgf:profiles')!).alice,
  );
  expect(phoneRecord.syncKey).toBe(SYNC_KEY);
  expect(phoneRecord.grant).toMatch(/^p2pd1\./);
  // The phone has a key of its own and none of the laptop's.
  expect(phoneRecord.deviceKey).toBeTruthy();
  expect(phoneRecord.privateKey).toBeUndefined();
  expect(phoneRecord.seed).toBeUndefined();

  // With no match code at all, the match shows up on the phone via sync.
  await expect(phone.page.getByTestId(`hub-resume-${matchId}`)).toBeVisible({ timeout: 90_000 });
  await phone.page.goto(`${BASE}#/alice/settings`);
  // Either device may end up as the hub the other connects to; both mean the two are in sync.
  await expect(phone.page.getByTestId('sync-status')).toHaveText(
    /connected to 1 device|hub for 1 device/i,
    { timeout: 60_000 },
  );

  // A setting changed on the laptop follows to the phone.
  await laptop.page.goto(`${BASE}#/alice/settings/backgammon`);
  await laptop.page.getByTestId('pieces-sky-navy').click();
  await expect
    .poll(
      () =>
        phone.page.evaluate(
          () => JSON.parse(localStorage.getItem('bgf:settings:alice')!).pieceSet as string,
        ),
      { timeout: 60_000 },
    )
    .toBe('sky-navy');

  // And the phone can now join the live match as Alice (second device on the same seat).
  await phone.page.goto(`${BASE}#/alice/backgammon/game/${matchId}`);
  await expect(phone.page.getByTestId('game-screen')).toBeVisible({ timeout: 60_000 });
  await expect(phone.page.getByTestId('game-screen')).toHaveAttribute('data-seat', 'white');
  await online(phone.page);

  await Promise.all([laptop.ctx.close(), opponent.ctx.close(), phone.ctx.close()]);
});
