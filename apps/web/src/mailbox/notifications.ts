import { base64UrlToBytes } from '@bgf/protocol';
import { connLog } from '../session/connLog';
import { getMailboxDevice, mailboxStatus } from './client';
import { ensureMailboxDevice } from './device';

/**
 * "Tell me when it's my turn": the service worker, a push subscription, and the mailbox told
 * where to wake this device. Turned on by the player; never asked for out of the blue.
 */

export type NotifySupport =
  | 'ok'
  /** iPhone or iPad in Safari: web push needs the site added to the Home Screen first. */
  | 'needs-home-screen'
  | 'unsupported';

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

function standalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function notifySupport(): NotifySupport {
  if (typeof window === 'undefined') return 'unsupported';
  const pushable =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !standalone()) return 'needs-home-screen';
  return pushable ? 'ok' : 'unsupported';
}

/** Whether this device will be woken for `slug`. */
export async function notificationsOn(slug: string): Promise<boolean> {
  if (notifySupport() !== 'ok' || Notification.permission !== 'granted') return false;
  return !!(await getMailboxDevice(slug))?.endpoint;
}

export type EnableResult = 'on' | 'denied' | 'unavailable' | 'needs-home-screen' | 'failed';

/** Ask for permission, subscribe, and tell the mailbox. Call from a tap. */
export async function enableNotifications(slug: string): Promise<EnableResult> {
  const support = notifySupport();
  if (support === 'needs-home-screen') return 'needs-home-screen';
  if (support !== 'ok') return 'unavailable';
  const { vapidKey } = await mailboxStatus();
  if (!vapidKey) return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  try {
    const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      type: 'module',
      scope: import.meta.env.BASE_URL,
    });
    await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(vapidKey),
      }));
    const device = await ensureMailboxDevice(slug, sub.toJSON());
    connLog('notifications: on', { slug });
    return device ? 'on' : 'unavailable';
  } catch (e) {
    connLog('notifications: could not turn on', {
      error: e instanceof Error ? e.message : String(e),
    });
    return 'failed';
  }
}

/** Stop waking this device for `slug` (the subscription stays for other players here). */
export async function disableNotifications(slug: string): Promise<void> {
  await ensureMailboxDevice(slug, null);
}
