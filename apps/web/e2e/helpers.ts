import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { webcrypto } from 'node:crypto';

export interface TestProfile {
  id: string;
  name: string;
}

export interface TestKeys {
  publicKey: string;
  privateKey: string;
}

function b64url(buf: ArrayBuffer): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const keyCache = new Map<string, Promise<TestKeys>>();

/**
 * Every test player owns an ECDSA P-256 key pair (the app binds it to the player's seats).
 * Generated once per worker in Node's WebCrypto and seeded into the browser profile record.
 */
export function keysFor(profile: TestProfile): Promise<TestKeys> {
  let p = keyCache.get(profile.id);
  if (!p) {
    p = (async () => {
      const pair = await webcrypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const [pub, priv] = await Promise.all([
        webcrypto.subtle.exportKey('raw', pair.publicKey),
        webcrypto.subtle.exportKey('pkcs8', pair.privateKey),
      ]);
      return { publicKey: b64url(pub), privateKey: b64url(priv) };
    })();
    keyCache.set(profile.id, p);
  }
  return p;
}

/** A fresh, uncached key pair (for impostor tests). */
export async function freshKeys(): Promise<TestKeys> {
  return keysFor({ id: `fresh-${Math.random()}`, name: 'x' });
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

/**
 * Seed a player (slug → id/name) and calm settings before the app boots. Pass `syncKey` to put
 * two contexts in the same device-sync group; otherwise a fresh key is generated on load.
 */
export async function seedProfile(
  page: Page,
  slug: string,
  profile: TestProfile,
  opts: { syncKey?: string; sync?: boolean; keys?: TestKeys | null } = {},
): Promise<void> {
  // `keys: null` seeds a legacy (unkeyed) player; otherwise the player's cached key pair is used.
  const keys = opts.keys === null ? null : (opts.keys ?? (await keysFor(profile)));
  await page.addInitScript(
    ({ slug, profile, opts, keys }) => {
      const key = 'bgf:profiles';
      const index = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      if (!index[slug]) {
        index[slug] = {
          ...profile,
          avatar: '🎲',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          updatedAt: Date.now(),
          ...(opts.syncKey ? { syncKey: opts.syncKey } : {}),
          ...(keys ? { publicKey: keys.publicKey, privateKey: keys.privateKey } : {}),
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
          sync: opts.sync ?? true,
          updatedAt: 1,
        }),
      );
    },
    { slug, profile, opts, keys },
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
 * Stage exactly one sub-move. Clicking a source either auto-stages it (single destination) or
 * selects it; in the latter case the first highlighted target is clicked. Progress is read from
 * `data-staged` on the game screen, so the helper is immune to render timing under load.
 */
export async function stageOne(page: Page): Promise<void> {
  const screen = page.getByTestId('game-screen');
  const stagedBefore = Number((await screen.getAttribute('data-staged')) ?? '0');
  const source = page.locator('[data-source="true"]').first();
  await expect(source).toBeVisible({ timeout: 10_000 });
  await source.click();
  const selected = page.locator('[data-selected="true"]');
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const staged = Number((await screen.getAttribute('data-staged')) ?? '0');
    if (staged > stagedBefore) return; // auto-staged
    if ((await selected.count()) === 1) {
      const target = page.locator('[data-target="true"]').first();
      await expect(target).toBeVisible({ timeout: 5_000 });
      await target.click();
      await expect
        .poll(async () => Number((await screen.getAttribute('data-staged')) ?? '0'), {
          timeout: 5_000,
        })
        .toBeGreaterThan(stagedBefore);
      return;
    }
    await page.waitForTimeout(40);
  }
  throw new Error('stageOne: clicking a source neither staged a move nor selected it');
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

/**
 * Tables run unattended by default: the first game starts as soon as both players are here and
 * the next one when both are ready. Click "Start game" when a manual table still shows it;
 * otherwise press Ready wherever it is offered (this page and `others`) and wait for the game to
 * begin (an opening roll, a roll, or the free-board prompt).
 */
export async function startGameIfNeeded(page: Page, others: Page[] = []): Promise<void> {
  const start = page.getByTestId('start-game-button');
  if (
    await start
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await start.first().click();
    return;
  }
  for (const p of [page, ...others]) {
    const ready = p.getByTestId('ready-button');
    if (
      await ready
        .first()
        .isVisible()
        .catch(() => false)
    )
      await ready.first().click();
  }
  await expect(page.getByTestId('status-text').first()).toHaveText(
    /free board|roll|your move|is moving|opening/i,
    { timeout: 20_000 },
  );
}
