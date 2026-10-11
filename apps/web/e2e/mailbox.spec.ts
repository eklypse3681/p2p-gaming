import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { handleMailbox } from '../src/mailbox/http';
import type { MailboxAction } from '../src/mailbox/http';
import type { Db } from '../src/mailbox/service';
import { profileUrl, seedProfile } from './helpers';
import { hostTable, joinTable, ofcUrl, placeIfMyTurn } from './ofcHelpers';

/** The mailbox, served to the pages by the test itself: the real code over SQLite. */
async function withMailbox(context: BrowserContext): Promise<void> {
  const sqlite = new DatabaseSync(':memory:');
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => stmt(sql, values),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...(args as never[])) as T[] }),
    first: async <T>() => (sqlite.prepare(sql).get(...(args as never[])) as T | undefined) ?? null,
    run: async () => ({
      meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) },
    }),
  });
  const db: Db = {
    prepare: (sql) => stmt(sql),
    exec: async (sql) => {
      sqlite.exec(sql);
    },
  };
  await context.route('**/api/mailbox/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const action = url.pathname.split('/').pop() as MailboxAction;
    const headers = await req.allHeaders();
    const res = await handleMailbox(
      action,
      new Request(url, {
        method: req.method(),
        headers: { Authorization: headers.authorization ?? '', 'Content-Type': 'application/json' },
        ...(req.method() === 'POST' ? { body: req.postData() ?? '' } : {}),
      }),
      { MAILBOX: db },
    );
    await route.fulfill({
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
      body: await res.text(),
    });
  });
}

/** The status line while playing by mail. */
const byMail = (page: Page) =>
  page.locator('[data-testid="status-text"][data-by-mail="true"]').first();

/** Treat turn notifications as on (a dev-server stand-in: headless browsers cannot subscribe). */
const withPushes = (page: Page) =>
  page.addInitScript(() => localStorage.setItem('bgf:e2e-push', '1'));

const checkMail = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event('bgf:mail-check')));

test('OFC by mail: the guest plays while the host is away, then rejoins the live table', async ({
  context,
}) => {
  test.setTimeout(120_000);
  await withMailbox(context);
  const alice = await context.newPage();
  await seedProfile(alice, 'alice', { id: 'e2e-alice-0001', name: 'Alice' });
  await withPushes(alice);
  const bob = await context.newPage();
  await seedProfile(bob, 'bob', { id: 'e2e-bob-0002', name: 'Bob' });
  await withPushes(bob);

  const code = await hostTable(alice, 'alice', { seats: 2 });
  await joinTable(bob, 'bob', code);
  await expect(alice.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'setting', {
    timeout: 15_000,
  });
  // Play live until it is Bob's turn.
  for (let i = 0; i < 30; i++) {
    if ((await bob.getByTestId('ofc-table').getAttribute('data-my-turn')) === 'true') break;
    await placeIfMyTurn(alice);
    await alice.waitForTimeout(200);
  }
  await expect(bob.getByTestId('ofc-table')).toHaveAttribute('data-my-turn', 'true');
  const matchUrl = bob.url();

  // Alice leaves: her table closes. Bob comes back to the table later.
  await alice.close();
  await bob.goto(profileUrl('bob', '/'));
  await bob.goto(matchUrl);
  await expect(byMail(bob)).toBeVisible({ timeout: 40_000 });
  await expect(byMail(bob)).toContainText('Alice is away');
  expect(await placeIfMyTurn(bob)).toBe(true);
  await expect(byMail(bob)).toContainText('Sent to Alice');
  // Nothing more to place until Alice's device answers.
  await expect(bob.getByTestId('ofc-table')).toHaveAttribute('data-my-turn', 'false');
  const seqBefore = await bob.getByTestId('game-screen').getAttribute('data-seq');

  // Alice opens the app on its home screen (not the table): her device applies Bob's move.
  const alice2 = await context.newPage();
  await seedProfile(alice2, 'alice', { id: 'e2e-alice-0001', name: 'Alice' });
  await withPushes(alice2);
  await alice2.goto(profileUrl('alice', '/'));
  await expect(alice2.getByTestId('game-screen')).toHaveCount(0);

  // Bob's open table gets the new position by mail.
  await expect
    .poll(
      async () => {
        await checkMail(bob);
        return bob.getByTestId('game-screen').getAttribute('data-seq');
      },
      { timeout: 30_000, intervals: [1000] },
    )
    .not.toBe(seqBefore);
  await expect(byMail(bob)).toContainText('Alice is away');

  // Alice opens the table: she hosts it live; Bob is switched back to the live table.
  await alice2.goto(ofcUrl('alice', matchUrl.split('/ofc/')[1]!));
  await expect(alice2.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      async () => {
        await checkMail(bob);
        return byMail(bob).count();
      },
      { timeout: 45_000, intervals: [1500] },
    )
    .toBe(0);
  await expect(bob.getByTestId('game-screen')).toBeVisible();
  await expect(alice2.getByTestId('seat-card-1').first()).toHaveAttribute('data-online', 'true', {
    timeout: 20_000,
  });
});

test('OFC: the host reloading puts the guest back at the live table within seconds', async ({
  context,
}) => {
  test.setTimeout(90_000);
  await withMailbox(context);
  const alice = await context.newPage();
  await seedProfile(alice, 'alice', { id: 'e2e-alice-0001', name: 'Alice' });
  await withPushes(alice);
  const bob = await context.newPage();
  await seedProfile(bob, 'bob', { id: 'e2e-bob-0002', name: 'Bob' });
  await withPushes(bob);
  const code = await hostTable(alice, 'alice', { seats: 2 });
  await joinTable(bob, 'bob', code);
  await expect(alice.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'setting', {
    timeout: 15_000,
  });

  await alice.reload();
  await expect(alice.getByTestId('game-screen')).toHaveAttribute('data-role', 'host', {
    timeout: 20_000,
  });
  // Bob may go on by mail for a moment; he is back at the live table soon after.
  const started = Date.now();
  await expect(alice.getByTestId('seat-card-1').first()).toHaveAttribute('data-online', 'true', {
    timeout: 20_000,
  });
  await expect(byMail(bob)).toHaveCount(0);
  console.log(`guest back live ${Math.round((Date.now() - started) / 1000)} s after the host was`);
});
