/**
 * Talking to the mailbox from a page or the service worker: this device's registration (kept in
 * IndexedDB so the service worker can use it without the player's keys) and the calls.
 */
import { createStore, del, get, keys, set } from 'idb-keyval';
import type { Incoming } from './service';

/** Dispatched on `window` to collect mail now and keep checking quickly for a while. */
export const CHECK_MAIL_EVENT = 'bgf:mail-check';

export interface MailboxDevice {
  /** The local profile this registration belongs to. */
  slug: string;
  /** The player's root public key: their address. */
  player: string;
  /** Bearer token the mailbox knows this device by. */
  token: string;
  registeredAt: number;
  /** The push subscription endpoint, once notifications are on. */
  endpoint?: string;
}

let store: ReturnType<typeof createStore> | null = null;
const devices = () => (store ??= createStore('bgf-mailbox', 'devices'));
let handledStore: ReturnType<typeof createStore> | null = null;
const handled = () => (handledStore ??= createStore('bgf-mailbox-handled', 'handled'));

/**
 * Moves already applied from a push, by `<slug>:<id>`: their copy still waits in the mailbox (for
 * devices that missed the push) and must not be applied twice when it is collected.
 */
export function markHandled(slug: string, id: number): Promise<void> {
  return set(`${slug}:${id}`, Date.now(), handled());
}
export async function wasHandled(slug: string, id: number): Promise<boolean> {
  return (await get(`${slug}:${id}`, handled())) !== undefined;
}
export function forgetHandled(slug: string, id: number): Promise<void> {
  return del(`${slug}:${id}`, handled());
}

export function getMailboxDevice(slug: string): Promise<MailboxDevice | undefined> {
  return get<MailboxDevice>(slug, devices());
}
export function putMailboxDevice(d: MailboxDevice): Promise<void> {
  return set(d.slug, d, devices());
}
export function forgetMailboxDevice(slug: string): Promise<void> {
  return del(slug, devices());
}
export async function allMailboxDevices(): Promise<MailboxDevice[]> {
  const out: MailboxDevice[] = [];
  for (const k of await keys(devices())) {
    const d = await get<MailboxDevice>(k, devices());
    if (d) out.push(d);
  }
  return out;
}

const base = () => {
  const b = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${b}api/mailbox/`;
};

/** Overridable for tests. */
let fetcher: typeof fetch = (...a) => fetch(...a);
export function setMailboxFetchForTests(f: typeof fetch | null): void {
  fetcher = f ?? ((...a) => fetch(...a));
  status = null;
}

export class MailboxUnavailable extends Error {}
/** The mailbox does not know this device's token (it was reset, or the device signed out). */
export class MailboxAuthError extends Error {}

async function call<T>(path: string, init: RequestInit, token?: string): Promise<T> {
  const res = await fetcher(`${base()}${path}`, {
    // A send started as the page goes away still completes.
    keepalive: init.method === 'POST',
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    if (res.status === 503) throw new MailboxUnavailable('the mailbox is not set up here');
    if (res.status === 401) throw new MailboxAuthError(`mailbox ${path}: ${body.error ?? 401}`);
    throw new Error(`mailbox ${path}: ${body.error ?? res.status}`);
  }
  return body;
}

let status: Promise<{ available: boolean; vapidKey: string | null }> | null = null;

/** Whether this site has a mailbox, and the key push subscriptions need. */
export function mailboxStatus(): Promise<{ available: boolean; vapidKey: string | null }> {
  status ??= call<{ available: boolean; vapidKey: string | null }>('status', {
    method: 'GET',
  }).catch(() => ({ available: false, vapidKey: null }));
  return status;
}

export function registerDevice(body: unknown): Promise<{ ok: true }> {
  return call('register', { method: 'POST', body: JSON.stringify(body) });
}

export function sendMail(
  token: string,
  m: {
    to: string;
    match: string;
    kind: 'cmd' | 'view';
    body: string;
    notify?: boolean;
    push?: string;
  },
): Promise<{ id: number; woke: number }> {
  return call('send', { method: 'POST', body: JSON.stringify(m) }, token);
}

export async function fetchInbox(token: string): Promise<Incoming[]> {
  return (await call<{ messages: Incoming[] }>('inbox', { method: 'GET' }, token)).messages;
}

export async function ackMail(token: string, ids: number[]): Promise<void> {
  if (ids.length) await call('ack', { method: 'POST', body: JSON.stringify({ ids }) }, token);
}
