import { expect, test } from '@playwright/test';
import { HOST, profileUrl, seedProfile } from './helpers';

/**
 * Clubs run on a Node dealer runtime, so the browser suite walks the screens against the in-app
 * fake club (`?fakeclub=1`, development builds only): join by invite → lobby → sit → the game join
 * screen carries the club context and shows the club chip.
 */
const token =
  'p2pc1.' +
  Buffer.from(
    JSON.stringify({
      clubId: 'club-demo-1',
      clubName: 'The Back Room',
      address: 'club-demo-1',
      role: 'member',
      autoApprove: true,
      nonce: 'e2e',
    }),
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

test('join a club by invite, sit at a table, and reach the game with the club chip', async ({
  page,
}) => {
  await seedProfile(page, 'alice', HOST);
  const url = (hash: string) =>
    profileUrl('alice', hash).replace('?transport=broadcast', '?transport=broadcast&fakeclub=1');
  await page.goto(url('/clubs'));
  await expect(page.getByTestId('clubs-empty')).toBeVisible();
  await page.getByTestId('club-invite-input').fill(`https://example.test/#/club/join/${token}`);
  await page.getByTestId('club-join-button').click();
  await expect(page.getByTestId('club-name')).toHaveText('The Back Room', { timeout: 15_000 });
  await expect(page.getByTestId('club-balance')).toContainText('1,250 chips');
  await expect(page.getByTestId('template-pine-27')).toBeVisible();
  await expect(page.getByTestId('lobby-table-tbl-1')).toContainText('Bob');

  // Statement and chat work against the fake.
  await page.getByTestId('statement-button').click();
  await expect(page.getByTestId('statement-entry-2')).toContainText('+250 chips');
  await page.getByTestId('club-chat-input').fill('hello table');
  await page.getByTestId('club-chat-send').click();
  await expect(page.getByTestId('club-chat-message')).toContainText('hello table');

  // Sit: the club hands out a seat and we land on the OFC join screen inside the club context.
  await page.getByTestId('sit-tbl-1').click();
  await expect(page).toHaveURL(/#\/alice\/ofc\/join\/CLUBT1\?club=club-demo-1&table=tbl-1/);
  await expect(page.getByTestId('club-chip')).toContainText('The Back Room');
  await expect(page.getByTestId('club-chip-balance')).toContainText('1,150 chips');
  await expect(page.getByTestId('club-chip-stack')).toContainText('100 chips');

  // The club is remembered for this player and the lobby is one click away.
  await page.getByTestId('back-to-lobby').click();
  await expect(page.getByTestId('club-name')).toHaveText('The Back Room');
  await page.goto(url('/clubs'));
  await expect(page.getByTestId('club-club-demo-1')).toContainText('The Back Room');
});

test('read the disclosure, then let the club find a game', async ({ page }) => {
  await seedProfile(page, 'alice', HOST);
  const url = (hash: string) =>
    profileUrl('alice', hash).replace('?transport=broadcast', '?transport=broadcast&fakeclub=1');
  await page.goto(url('/clubs'));
  await page.getByTestId('club-invite-input').fill(`https://example.test/#/club/join/${token}`);
  await page.getByTestId('club-join-button').click();
  await expect(page.getByTestId('club-name')).toHaveText('The Back Room', { timeout: 15_000 });

  // Who holds the chips, when they move, how you get in — before playing anything.
  const disclosure = page.getByTestId('club-disclosure');
  await expect(disclosure).toHaveAttribute('data-custody', 'hosted');
  await expect(page.getByTestId('disclosure-custody')).toContainText('runs this club');
  await expect(page.getByTestId('disclosure-settlement')).toContainText('after every hand');
  await expect(page.getByTestId('disclosure-membership')).toContainText('invite');

  // Find a game: narrow it, queue, watch the wait, then get seated.
  await expect(page.getByTestId('find-game')).toHaveAttribute('data-queued', 'false');
  await page.getByTestId('criteria-game-ofc').click();
  await page.getByTestId('criteria-seats-3').click();
  await page.getByTestId('queue-button').click();

  await expect(page.getByTestId('find-game')).toHaveAttribute('data-queued', 'true');
  await expect(page.getByTestId('queue-depth')).toContainText('waiting');
  await expect(page.getByTestId('queue-elapsed')).toBeVisible();
  await expect(page.getByTestId('cancel-queue')).toBeVisible();

  // The fake club seats us shortly after queueing, and we land at the table with a stake.
  await expect(page).toHaveURL(/#\/alice\/ofc\/join\/.*club=club-demo-1/, { timeout: 15_000 });
  await expect(page.getByTestId('club-chip')).toContainText('The Back Room');
  await expect(page.getByTestId('club-chip-stack')).toContainText('chips');
});

test('cancelling the queue puts the player back in the lobby', async ({ page }) => {
  await seedProfile(page, 'alice', HOST);
  const url = (hash: string) =>
    profileUrl('alice', hash).replace('?transport=broadcast', '?transport=broadcast&fakeclub=1');
  await page.goto(url('/clubs'));
  await page.getByTestId('club-invite-input').fill(`https://example.test/#/club/join/${token}`);
  await page.getByTestId('club-join-button').click();
  await expect(page.getByTestId('club-name')).toHaveText('The Back Room', { timeout: 15_000 });

  await page.getByTestId('queue-button').click();
  await expect(page.getByTestId('cancel-queue')).toBeVisible();
  await page.getByTestId('cancel-queue').click();
  await expect(page.getByTestId('find-game')).toHaveAttribute('data-queued', 'false');
  await expect(page.getByTestId('queue-ended')).toContainText('left the queue');
});
