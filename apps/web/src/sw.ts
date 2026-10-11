/// <reference lib="webworker" />
/**
 * The service worker: wakes when the mailbox pushes, so play by mail goes on with the app closed.
 *
 * On a push it collects every local player's mail exactly as an open page would (`processInbox`):
 * positions are saved, and moves for an OFC table this device hosts are applied with the same
 * rules (this worker is built with the app and shares its runtime; a table pinned to other rules
 * is left for the app to apply when opened). Then it shows what happened: "Your turn", or that a
 * move is waiting. It never caches the app: every page load fetches the current version.
 *
 * Served from the site root (`/sw.js`) so its scope is the whole app; registered only once the
 * player turns notifications on (`mailbox/notifications.ts`).
 */
import { createStore, get, set } from 'idb-keyval';
import type { PlayerProfile } from '@bgf/protocol';
import * as current from './runtime';
import { GAME_IDS } from './games/ids';
import type { MailboxDevice } from './mailbox/client';
import { allMailboxDevices } from './mailbox/client';
import type { InboxEnv, InboxEvent, KnownMatch } from './mailbox/inbox';
import { processInbox } from './mailbox/inbox';
import { MATCH_STORE_NAME, matchDbName } from './session/matchDb';

declare const self: ServiceWorkerGlobalScope;

const MAIL_MESSAGE = 'bgf:mail';

self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

type Snap = KnownMatch['snapshot'];

function swEnv(
  device: MailboxDevice,
  stored: { slug: string; game: string; id: string }[],
): InboxEnv {
  return {
    device,
    async findMatch(matchId) {
      for (const game of GAME_IDS) {
        const store = createStore(matchDbName(device.slug, game), MATCH_STORE_NAME);
        const snapshot = await get<Snap>(matchId, store);
        if (snapshot) {
          return {
            game,
            snapshot,
            put: async (s) => {
              await set(s.id, s, store);
              stored.push({ slug: device.slug, game, id: s.id });
            },
          };
        }
      }
      return undefined;
    },
    runtimeFor: async () => current,
    canApply: (pin) => !pin || pin === current.RUNTIME_ID,
    entropyFor: (provider) =>
      provider === 'drand'
        ? current.drandProvider()
        : provider === 'random.org'
          ? undefined
          : current.cryptoProvider(),
  };
}

/** Who sent it, by name, from the saved match. */
async function nameOf(device: MailboxDevice, e: InboxEvent): Promise<string> {
  const store = createStore(matchDbName(device.slug, e.game), MATCH_STORE_NAME);
  const s = await get<
    Snap & { seats?: (PlayerProfile | null)[]; players?: Record<string, PlayerProfile | null> }
  >(e.matchId, store);
  const people = s?.seats ?? Object.values(s?.players ?? {});
  return people.find((p) => p?.publicKey === e.from)?.name ?? 'Your opponent';
}

const GAME_NAMES: Record<string, string> = { backgammon: 'Backgammon', ofc: 'Open Face Chinese' };

async function onPush(): Promise<void> {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const stored: { slug: string; game: string; id: string }[] = [];
  const shown: { title: string; body: string; url: string; tag: string }[] = [];
  for (const device of await allMailboxDevices()) {
    let events: InboxEvent[] = [];
    try {
      events = await processInbox(swEnv(device, stored));
    } catch {
      continue; // offline or the mailbox is down: the mail waits, the page will collect it
    }
    for (const e of events) {
      const who = await nameOf(device, e);
      const url = `${self.registration.scope}#/${device.slug}/${e.game}/game/${e.matchId}`;
      const game = GAME_NAMES[e.game] ?? 'Among Friends';
      if (e.kind === 'view' && e.yourTurn) {
        shown.push({ title: `Your turn · ${game}`, body: `${who} played.`, url, tag: e.matchId });
      } else if (e.kind === 'deferred') {
        shown.push({
          title: `${who} played · ${game}`,
          body: 'Open the table to deal them their next cards.',
          url,
          tag: e.matchId,
        });
      }
    }
  }
  for (const p of pages) p.postMessage({ type: MAIL_MESSAGE, stored });
  const visible = pages.some((p) => p.visibilityState === 'visible');
  if (visible) return; // the open page shows it
  for (const n of shown) {
    await self.registration.showNotification(n.title, {
      body: n.body,
      tag: n.tag,
      data: { url: n.url },
      icon: '/apple-touch-icon.png',
    });
  }
  // A push must show something (iOS stops pushing to a worker that stays silent).
  if (shown.length === 0) {
    await self.registration.showNotification('Among Friends', {
      body: 'Your tables are up to date.',
      tag: 'mail',
      silent: true,
      icon: '/apple-touch-icon.png',
    });
  }
}

self.addEventListener('push', (e) => {
  e.waitUntil(onPush());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data as { url?: string } | null)?.url ?? self.registration.scope;
  e.waitUntil(
    (async () => {
      const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const page = pages[0];
      if (page) {
        await page.focus();
        await (page as WindowClient).navigate(url).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
