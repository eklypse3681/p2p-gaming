import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export interface TestProfile {
  id: string;
  name: string;
}

export const HOST: TestProfile = { id: 'e2e-host-0001', name: 'Alice' };
export const GUEST: TestProfile = { id: 'e2e-guest-0002', name: 'Bob' };
export const THIRD: TestProfile = { id: 'e2e-third-0003', name: 'Carol' };

export const GAME = 'backgammon';

/**
 * All e2e pages share one browser context (BroadcastChannel only crosses tabs of one context).
 * Every player is a route segment and every game lives under it: `#/<profile>/<game>/…`.
 * Settings are keyed by the player, saved matches by player and game, so two tabs are simply
 * two players. `appUrl('alice', '/host')` → `#/alice/backgammon/host`.
 */
export function appUrl(profile: string, hash = '/', game: string = GAME): string {
  const sub = hash.startsWith('#/') ? hash.slice(2) : hash.replace(/^\//, '');
  return `/?transport=broadcast#/${profile}/${game}/${sub}`;
}

/** A profile-level address (hub, settings): `profileUrl('alice', '/settings')`. */
export function profileUrl(profile: string, hash = '/'): string {
  const sub = hash.startsWith('#/') ? hash.slice(2) : hash.replace(/^\//, '');
  return `/?transport=broadcast#/${profile}/${sub}`;
}

/** Seed a player (slug → id/name) and calm settings before the app boots. */
export async function seedProfile(page: Page, slug: string, profile: TestProfile): Promise<void> {
  await page.addInitScript(
    ({ slug, profile }) => {
      const key = 'bgf:profiles';
      const index = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      if (!index[slug]) {
        index[slug] = {
          ...profile,
          avatar: '🎲',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        };
        localStorage.setItem(key, JSON.stringify(index));
      }
      localStorage.setItem('bgf:migrated', '1');
      localStorage.setItem(
        `bgf:settings:${slug}`,
        JSON.stringify({
          look: 'midnight',
          boardSet: 'midnight-slate',
          pieceSet: 'pearl-obsidian',
          reducedMotion: 'on',
          flipBoard: false,
        }),
      );
    },
    { slug, profile },
  );
}

/** Host a new match from the home screen; returns the room code. */
export async function hostMatch(
  page: Page,
  profile: string,
  opts: { length?: number; rules?: 'enforced' | 'free' } = {},
): Promise<string> {
  await page.goto(appUrl(profile, '/'));
  await page.getByTestId('host-button').click();
  await expect(page.getByTestId('host-screen')).toBeVisible();
  if (opts.rules) await page.getByTestId(`rules-${opts.rules}`).click();
  await page.getByTestId(`length-${opts.length ?? 1}`).click();
  await page.getByTestId('create-match-button').click();
  await expect(page.getByTestId('game-screen')).toBeVisible({ timeout: 15_000 });
  const code = (await page.getByTestId('room-code').first().textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  return code;
}

/** Join an existing match by code; waits for the game screen. */
export async function joinMatch(page: Page, profile: string, code: string): Promise<void> {
  await page.goto(appUrl(profile, `/join/${code}`));
  await expect(page.getByTestId('game-screen')).toBeVisible({ timeout: 20_000 });
}

/** Whichever page can act, act: opening rolls, rolls, and complete moves. Returns what it did. */
export async function statusOf(page: Page): Promise<string> {
  return (await page.getByTestId('status-text').textContent())?.trim() ?? '';
}

/**
 * Stage exactly one sub-move: click a source; if the board auto-staged it (single destination)
 * we are done, otherwise click the first highlighted target.
 */
export async function stageOne(page: Page): Promise<void> {
  const source = page.locator('[data-source="true"]').first();
  await expect(source).toBeVisible({ timeout: 10_000 });
  await source.click();
  const selected = page.locator('[data-selected="true"]');
  let picked = false;
  try {
    await expect(selected).toHaveCount(1, { timeout: 800 });
    picked = true;
  } catch {
    picked = false; // auto-staged
  }
  if (picked) {
    const target = page.locator('[data-target="true"]').first();
    await expect(target).toBeVisible({ timeout: 5_000 });
    await target.click();
  }
}

/** Click through one complete move for the page whose turn it is. */
export async function playMove(page: Page): Promise<void> {
  const done = page.getByTestId('done-button');
  await expect(done).toBeVisible({ timeout: 10_000 });
  for (let i = 0; i < 6; i++) {
    if (await done.isEnabled()) break;
    if ((await statusOf(page)).includes('No legal moves')) return;
    await stageOne(page);
  }
  await expect(done).toBeEnabled({ timeout: 5_000 });
  await done.click();
}

/**
 * Advance the game by one action on whichever page has one available.
 * Returns false when neither page can act (e.g. game over).
 */
export async function step(pages: Page[]): Promise<boolean> {
  for (const page of pages) {
    if (
      await page
        .getByTestId('opening-roll-button')
        .isVisible()
        .catch(() => false)
    ) {
      await page.getByTestId('opening-roll-button').click();
      return true;
    }
    if (
      await page
        .getByTestId('roll-button')
        .isVisible()
        .catch(() => false)
    ) {
      await page.getByTestId('roll-button').click();
      return true;
    }
    if (
      await page
        .getByTestId('done-button')
        .isVisible()
        .catch(() => false)
    ) {
      await playMove(page);
      return true;
    }
  }
  return false;
}

/** Complete the opening (both roll, re-rolling ties) until someone is moving. */
export async function completeOpening(host: Page, guest: Page): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const hostBtn = host.getByTestId('opening-roll-button');
    const guestBtn = guest.getByTestId('opening-roll-button');
    if (await hostBtn.isVisible().catch(() => false)) await hostBtn.click();
    else if (await guestBtn.isVisible().catch(() => false)) await guestBtn.click();
    const hostMoving = await host
      .getByTestId('done-button')
      .isVisible()
      .catch(() => false);
    const guestMoving = await guest
      .getByTestId('done-button')
      .isVisible()
      .catch(() => false);
    if (hostMoving || guestMoving) return;
    await host.waitForTimeout(150);
  }
  throw new Error('opening did not complete');
}

// ---- board geometry helpers ------------------------------------------------------------

/** Centre of an element in viewport CSS pixels. */
export async function centerOf(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`no bounding box for ${testId}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Checkers currently drawn at a board location (`p<abs>`, `bar-<colour>`, `off-<colour>`). */
export function checkersAt(page: Page, locationKey: string) {
  return page.locator(`[data-testid="checkers"] > g[data-location="${locationKey}"]`);
}

/** Drag with the mouse from one hit area to another (moves in steps so the drag threshold trips). */
export async function mouseDrag(page: Page, fromTestId: string, toTestId: string): Promise<void> {
  const from = await centerOf(page, fromTestId);
  const to = await centerOf(page, toTestId);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await page.mouse.up();
}

/**
 * Drag with a single finger using raw CDP touch events, which arrive in the page as pointer
 * events with `pointerType: 'touch'` — the same path a real phone takes.
 */
export async function touchDrag(page: Page, fromTestId: string, toTestId: string): Promise<void> {
  const from = await centerOf(page, fromTestId);
  const to = await centerOf(page, toTestId);
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => ({ x, y, radiusX: 8, radiusY: 8, force: 1 });
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point(from.x, from.y)],
    });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(x, y)] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

/** A single-finger tap through CDP (so it is a real touch, not a synthesised click). */
export async function touchTap(page: Page, testId: string): Promise<void> {
  const at = await centerOf(page, testId);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: at.x, y: at.y, radiusX: 8, radiusY: 8, force: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}
