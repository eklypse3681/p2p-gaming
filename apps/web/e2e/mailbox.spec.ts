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

const checkMail = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event('bgf:mail-check')));

test('OFC by mail: the guest plays while the host is away, then rejoins the live table', async ({
  context,
}) => {
  test.setTimeout(120_000);
  await withMailbox(context);
  const alice = await context.newPage();
  await seedProfile(alice, 'alice', { id: 'e2e-alice-0001', name: 'Alice' });
  const bob = await context.newPage();
  await seedProfile(bob, 'bob', { id: 'e2e-bob-0002', name: 'Bob' });

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
  await expect(bob.getByTestId('by-mail-banner')).toBeVisible({ timeout: 40_000 });
  await expect(bob.getByTestId('by-mail-banner')).toContainText('Alice is away');
  expect(await placeIfMyTurn(bob)).toBe(true);
  await expect(bob.getByTestId('by-mail-banner')).toContainText('Sent to Alice');
  const seqBefore = await bob.getByTestId('game-screen').getAttribute('data-seq');

  // Alice opens the app on its home screen (not the table): her device applies Bob's move.
  const alice2 = await context.newPage();
  await seedProfile(alice2, 'alice', { id: 'e2e-alice-0001', name: 'Alice' });
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
  await expect(bob.getByTestId('by-mail-banner')).toContainText('Alice is away');

  // Alice opens the table: she hosts it live; Bob is switched back to the live table.
  await alice2.goto(ofcUrl('alice', matchUrl.split('/ofc/')[1]!));
  await expect(alice2.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      async () => {
        await checkMail(bob);
        return bob.getByTestId('by-mail-banner').count();
      },
      { timeout: 45_000, intervals: [1500] },
    )
    .toBe(0);
  await expect(bob.getByTestId('game-screen')).toBeVisible();
  await expect(alice2.getByTestId('seat-card-1').first()).toHaveAttribute('data-online', 'true', {
    timeout: 20_000,
  });
});
