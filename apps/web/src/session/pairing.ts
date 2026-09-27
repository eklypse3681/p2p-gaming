/**
 * Pairing a new device to a player, without the player's key ever leaving the devices that
 * already hold it.
 *
 * ```
 *   player's device (host)                         new device (join)
 *   hosts pair-v1/<code>, shows a QR of the link
 *                              ◀── connects ──────  makes its own key pair
 *   ── hello {player: id, name, avatar, key} ──▶
 *                              ◀── request {device key, label}
 *   shows "Pair iPhone · Safari? 1a2b-3c4d-5e6f"      shows the same fingerprint
 *   the person taps Approve
 *   ── grant {p2pd1…, sync key} ───────────────▶     checks the grant, becomes the player
 * ```
 *
 * Nothing that crosses before approval is secret, and what crosses after it (the grant, and
 * the sync key so the new device joins the player's device sync) goes only to the key the person
 * approved. The fingerprint on both screens is there to compare if anything looks off; nobody has
 * to.
 */
import type { Transport, TransportProvider, Unsubscribe } from '@bgf/protocol';
import { generateKeyPair, generateRoomCode } from '@bgf/protocol';
import { fingerprint, issueGrant, verifyGrant } from '@bgf/wallet';
import type { GrantScope } from '@bgf/wallet';
import type { PairedDevice } from './profiles';
import { DEVICE_GRANT_MS } from './grants';
import {
  createProfile,
  getProfile,
  getProfilesIndex,
  getSecrets,
  isPairedDevice,
  nextDeviceSerial,
  recordPairedDevice,
  setDeviceGrant,
  setProfileSyncKey,
} from './profiles';

export const PAIR_CODE_LENGTH = 8;
/** A pairing offer is only open for this long. */
export const PAIR_WINDOW_MS = 10 * 60_000;
/** What a paired device may do for the player. It may not pair further devices itself. */
export const DEVICE_SCOPES: readonly GrantScope[] = ['seat', 'sync', 'club'];

interface PublicPlayer {
  id: string;
  name: string;
  avatar: string;
  publicKey: string;
}

type HostMessage =
  | { t: 'hello'; v: 1; player: PublicPlayer }
  | { t: 'grant'; grant: string; syncKey?: string }
  | { t: 'declined' };
type DeviceMessage = { t: 'request'; device: string; label: string };

export class PairingError extends Error {
  constructor(
    public readonly code: 'not-yours' | 'bad-grant' | 'declined' | 'closed' | 'protocol',
    message: string,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

// ---------------------------------------------------------------------------------------------
// The player's device
// ---------------------------------------------------------------------------------------------

export interface PairingRequest {
  label: string;
  devicePublicKey: string;
  /** Same code the new device shows. */
  fingerprint: string;
  approve(): Promise<PairedDevice>;
  decline(): void;
  /** The device went away (closed the page, reloaded) before anyone answered. */
  onWithdrawn(listener: () => void): Unsubscribe;
}

export interface PairingHost {
  readonly code: string;
  onRequest(listener: (request: PairingRequest) => void): Unsubscribe;
  close(): void;
}

/** Only a device holding the player's own key can vouch for another. */
export function canPairDevices(slug: string): boolean {
  const record = getProfile(slug);
  return !!record?.publicKey && !!getSecrets(slug)?.privateKey;
}

export async function hostPairing(
  slug: string,
  provider: TransportProvider,
  opts: { code?: string; now?: () => number } = {},
): Promise<PairingHost> {
  const now = opts.now ?? Date.now;
  const record = getProfile(slug);
  const privateKey = getSecrets(slug)?.privateKey;
  if (!record?.publicKey || !privateKey) {
    throw new PairingError('not-yours', 'only a device holding this player’s own key can pair');
  }
  const root = { publicKey: record.publicKey, privateKey };
  const code = opts.code ?? generateRoomCode(PAIR_CODE_LENGTH);
  const listener = await provider.host(code);
  const requests = new Set<(r: PairingRequest) => void>();
  const open = new Set<Transport>();
  const expiry = setTimeout(() => close(), PAIR_WINDOW_MS);

  const close = () => {
    clearTimeout(expiry);
    for (const t of open) t.close();
    open.clear();
    listener.close();
  };

  listener.onConnection((transport) => {
    open.add(transport);
    transport.onStatus((s) => {
      if (s === 'closed') open.delete(transport);
    });
    const current = getProfile(slug) ?? record;
    const hello: HostMessage = {
      t: 'hello',
      v: 1,
      player: {
        id: current.id,
        name: current.name,
        avatar: current.avatar,
        publicKey: root.publicKey,
      },
    };
    transport.send(hello);
    let asked = false;
    let answered = false;
    const withdrawn = new Set<() => void>();
    transport.onStatus((s) => {
      if (s !== 'closed' || answered) return;
      for (const fn of withdrawn) fn();
    });
    transport.onMessage((raw) => {
      const msg = asDeviceMessage(raw);
      if (!msg || asked) return;
      asked = true;
      const request: PairingRequest = {
        label: msg.label,
        devicePublicKey: msg.device,
        fingerprint: fingerprint(msg.device),
        onWithdrawn: (fn) => {
          withdrawn.add(fn);
          return () => withdrawn.delete(fn);
        },
        approve: async () => {
          if (transport.status === 'closed') {
            throw new PairingError('closed', 'that device went away before it was approved');
          }
          answered = true;
          const serial = nextDeviceSerial(getProfile(slug) ?? record);
          const issuedAt = now();
          const grant = await issueGrant(root, {
            device: msg.device,
            serial,
            label: msg.label,
            scopes: DEVICE_SCOPES,
            issuedAt,
            expiresAt: issuedAt + DEVICE_GRANT_MS,
          });
          const decoded = await verifyGrant(grant, { now: issuedAt, root: root.publicKey });
          if (!decoded.ok) throw new PairingError('bad-grant', 'could not issue a grant');
          const device: PairedDevice = {
            serial,
            label: decoded.grant.label,
            publicKey: msg.device,
            pairedAt: issuedAt,
            expiresAt: decoded.grant.expiresAt,
          };
          recordPairedDevice(slug, device);
          const syncKey = getSecrets(slug)?.syncKey;
          transport.send({
            t: 'grant',
            grant,
            ...(syncKey ? { syncKey } : {}),
          } satisfies HostMessage);
          return device;
        },
        decline: () => {
          answered = true;
          if (transport.status === 'closed') return;
          transport.send({ t: 'declined' } satisfies HostMessage);
          transport.close();
        },
      };
      for (const fn of requests) fn(request);
    });
  });

  return {
    code,
    onRequest: (fn) => {
      requests.add(fn);
      return () => requests.delete(fn);
    },
    close,
  };
}

// ---------------------------------------------------------------------------------------------
// The new device
// ---------------------------------------------------------------------------------------------

export type JoinPhase =
  | { phase: 'connecting' }
  | { phase: 'waiting'; player: PublicPlayer; fingerprint: string }
  | { phase: 'paired'; slug: string; player: PublicPlayer }
  | { phase: 'failed'; error: PairingError };

export interface PairingJoin {
  /** This device's fingerprint, known before anything is sent. */
  readonly fingerprint: string;
  onPhase(listener: (phase: JoinPhase) => void): Unsubscribe;
  /** Resolves with the local player slug once approved. */
  readonly done: Promise<string>;
  cancel(): void;
}

export async function joinPairing(
  code: string,
  provider: TransportProvider,
  opts: { label?: string; now?: () => number; timeoutMs?: number } = {},
): Promise<PairingJoin> {
  const now = opts.now ?? Date.now;
  const keys = await generateKeyPair();
  const listeners = new Set<(p: JoinPhase) => void>();
  let last: JoinPhase = { phase: 'connecting' };
  const emit = (p: JoinPhase) => {
    last = p;
    for (const fn of listeners) fn(p);
  };
  let transport: Transport | null = null;
  let over = false;
  let settle!: { resolve: (slug: string) => void; reject: (e: PairingError) => void };
  const done = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  done.catch(() => {});
  const fail = (error: PairingError) => {
    if (over) return;
    over = true;
    emit({ phase: 'failed', error });
    settle.reject(error);
    transport?.close();
  };

  void (async () => {
    try {
      transport = await provider.join(code, { timeoutMs: opts.timeoutMs ?? 20_000 });
    } catch {
      fail(new PairingError('closed', 'that pairing code is not open any more'));
      return;
    }
    // Cancelled while still connecting: never ask to be paired.
    if (over) {
      transport.close();
      return;
    }
    let player: PublicPlayer | null = null;
    transport.onStatus((s) => {
      if (s === 'closed' && last.phase !== 'paired' && last.phase !== 'failed') {
        fail(new PairingError('closed', 'the other device went away'));
      }
    });
    transport.onMessage((raw) => {
      const msg = asHostMessage(raw);
      if (!msg || over) return;
      if (msg.t === 'hello') {
        if (player) return;
        player = msg.player;
        emit({ phase: 'waiting', player, fingerprint: fingerprint(keys.publicKey) });
        transport!.send({
          t: 'request',
          device: keys.publicKey,
          label: opts.label ?? deviceLabel(),
        } satisfies DeviceMessage);
        return;
      }
      if (msg.t === 'declined') {
        fail(new PairingError('declined', 'the pairing was declined'));
        return;
      }
      if (!player) return;
      const p = player;
      void (async () => {
        const check = await verifyGrant(msg.grant, {
          now: now(),
          root: p.publicKey,
          scope: 'seat',
        });
        if (!check.ok || check.grant.device !== keys.publicKey) {
          fail(new PairingError('bad-grant', 'the grant does not match this device'));
          return;
        }
        if (over) return;
        const slug = await adopt(p, keys.privateKey, msg.grant, msg.syncKey);
        over = true;
        emit({ phase: 'paired', slug, player: p });
        settle.resolve(slug);
        transport?.close();
      })();
    });
  })();

  return {
    fingerprint: fingerprint(keys.publicKey),
    onPhase: (fn) => {
      listeners.add(fn);
      fn(last);
      return () => listeners.delete(fn);
    },
    done,
    cancel: () => fail(new PairingError('closed', 'cancelled')),
  };
}

/** Become the player on this device, or refresh the grant if this device already is. */
async function adopt(
  player: PublicPlayer,
  deviceKey: string,
  grant: string,
  syncKey: string | undefined,
): Promise<string> {
  const existing = Object.entries(getProfilesIndex()).find(([, r]) => r.id === player.id);
  if (existing) {
    const [slug, record] = existing;
    // This browser already holds the player's own key: nothing to add.
    if (!isPairedDevice(record) && getSecrets(slug)?.privateKey) return slug;
    await setDeviceGrant(slug, { deviceKey, grant });
    if (syncKey) await setProfileSyncKey(slug, syncKey);
    return slug;
  }
  return createProfile(player.name, {
    id: player.id,
    avatar: player.avatar,
    publicKey: player.publicKey,
    deviceKey,
    grant,
    ...(syncKey ? { syncKey } : {}),
  }).slug;
}

// ---------------------------------------------------------------------------------------------

/** "iPhone · Safari", "Mac · Chrome": what the player sees in the approval prompt. */
export function deviceLabel(ua: string = globalThis.navigator?.userAgent ?? ''): string {
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /CriOS|Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return browser ? `${device} · ${browser}` : device;
}

function isKey(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{86,88}$/.test(v);
}

function asDeviceMessage(raw: unknown): DeviceMessage | null {
  const m = raw as Partial<DeviceMessage> | null;
  if (!m || m.t !== 'request' || !isKey(m.device)) return null;
  const label = typeof m.label === 'string' ? m.label.slice(0, 64) : 'Device';
  return { t: 'request', device: m.device, label };
}

function asHostMessage(raw: unknown): HostMessage | null {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m.t !== 'string') return null;
  if (m.t === 'declined') return { t: 'declined' };
  if (m.t === 'grant' && typeof m.grant === 'string' && m.grant.length < 4096) {
    return {
      t: 'grant',
      grant: m.grant,
      ...(typeof m.syncKey === 'string' && m.syncKey.length < 256 ? { syncKey: m.syncKey } : {}),
    };
  }
  if (m.t === 'hello' && m.v === 1) {
    const p = m.player as Partial<PublicPlayer> | undefined;
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || !isKey(p.publicKey)) {
      return null;
    }
    return {
      t: 'hello',
      v: 1,
      player: {
        id: p.id.slice(0, 128),
        name: p.name.slice(0, 64),
        avatar: typeof p.avatar === 'string' ? p.avatar.slice(0, 16) : '🎲',
        publicKey: p.publicKey,
      },
    };
  }
  return null;
}
