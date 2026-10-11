/**
 * The mailbox: the one always-on piece of play between players who are not online together.
 *
 * It holds messages in transit, nothing else: a move from a player who is away to the device
 * hosting their match, or the table's new position back to them. Every message is sealed with
 * the match's own key (see `crypto.ts`), so the mailbox sees only who sends what to whom, never
 * what. A message is deleted once its recipient has collected it, or after `MAX_AGE_MS`.
 *
 * When a message arrives, the mailbox wakes the recipient's devices with an empty web push; their
 * service worker then collects it (`sw.ts`). Pushes carry no data, so nothing needs encrypting
 * for the push service.
 *
 * Players are addressed by their root public key, the key their seats are bound to. A device
 * registers once with a signature (its own key and the grant that authorises it, as at a table)
 * and from then on uses a random bearer token, which the service worker can hold without the
 * player's keys.
 *
 * This module is the mailbox's logic over a `Db` (Cloudflare D1 in production, SQLite in tests);
 * the Pages Functions in `functions/api/mailbox/` are thin wrappers around it.
 */
import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from '@bgf/protocol';
import { verifyDelegated } from '@bgf/wallet';
import { registrationBytes } from './bytes';

export { registrationBytes };

/** The slice of D1's API used here. */
export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): Promise<unknown>;
}
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface VapidKeys {
  /** base64url uncompressed P-256 public key (65 bytes), as browsers take it. */
  publicKey: string;
  /** base64url P-256 private scalar (32 bytes). */
  privateKey: string;
  /** `mailto:` or `https:` contact for push services. */
  subject: string;
}

export interface MailboxDeps {
  db: Db;
  now(): number;
  vapid?: VapidKeys;
  /** Sends a push request (fetch in production). */
  push?: (endpoint: string, init: RequestInit) => Promise<Response>;
}

export const MAX_AGE_MS = 30 * 24 * 3600_000;
export const MAX_BODY = 256 * 1024;
/** Messages a sender may post a day: generous for play, a ceiling for abuse. */
export const DAILY_SENDS = 2000;
/** Uncollected messages a recipient may hold. */
export const MAX_PENDING = 300;
/** How far a registration's timestamp may be from the mailbox's clock. */
export const REGISTER_SKEW_MS = 10 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mailbox_devices (
  token TEXT PRIMARY KEY,
  player TEXT NOT NULL,
  endpoint TEXT,
  p256dh TEXT,
  auth TEXT,
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mailbox_devices_player ON mailbox_devices(player);
CREATE TABLE IF NOT EXISTS mailbox_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  sender TEXT NOT NULL,
  match TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mailbox_messages_recipient ON mailbox_messages(recipient, id);
CREATE TABLE IF NOT EXISTS mailbox_quota (
  sender TEXT NOT NULL,
  day INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (sender, day)
);`;

const ready = new WeakMap<Db, Promise<unknown>>();
function schema(db: Db): Promise<unknown> {
  let p = ready.get(db);
  if (!p) {
    // D1's exec runs one statement per line.
    const sql = SCHEMA.split(';')
      .map((st) => st.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(';\n');
    p = db.exec(`${sql};`).catch((e: unknown) => {
      ready.delete(db);
      throw e;
    });
    ready.set(db, p);
  }
  return p;
}

export class MailboxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const KEY = /^[A-Za-z0-9_-]{40,120}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const MATCH = /^[\w-]{1,80}$/;

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', utf8Bytes(text) as Uint8Array<ArrayBuffer>);
  return bytesToBase64Url(new Uint8Array(d));
}

export interface PushSubscriptionJson {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface Registration {
  /** The player's root public key: their address. */
  player: string;
  /** The key that signed: the root key itself, or a device key with `grant`. */
  device: string;
  at: number;
  token: string;
  signature: string;
  grant?: string;
  /** Where to wake this device; null to stop pushes, absent to leave as is. */
  push?: PushSubscriptionJson | null;
}

function validPush(p: unknown): p is PushSubscriptionJson {
  if (!p || typeof p !== 'object') return false;
  const { endpoint, p256dh, auth } = p as Record<string, unknown>;
  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
    return false;
  }
  try {
    return new URL(endpoint).protocol === 'https:' && endpoint.length < 2048 && p256dh.length < 200;
  } catch {
    return false;
  }
}

export async function register(deps: MailboxDeps, r: Registration): Promise<void> {
  if (
    !KEY.test(r.player ?? '') ||
    !KEY.test(r.device ?? '') ||
    !TOKEN.test(r.token ?? '') ||
    typeof r.at !== 'number' ||
    typeof r.signature !== 'string'
  ) {
    throw new MailboxError(400, 'bad-registration');
  }
  if (r.push !== undefined && r.push !== null && !validPush(r.push)) {
    throw new MailboxError(400, 'bad-push');
  }
  const now = deps.now();
  if (Math.abs(now - r.at) > REGISTER_SKEW_MS) throw new MailboxError(400, 'stale');
  if (r.device !== r.player && !r.grant) throw new MailboxError(403, 'not-authorised');
  const auth = await verifyDelegated(
    r.player,
    registrationBytes(r),
    { signature: r.signature, ...(r.grant ? { grant: r.grant } : {}) },
    { now, scope: 'seat' },
  );
  if (!auth.ok || auth.device !== r.device) throw new MailboxError(403, 'not-authorised');
  await schema(deps.db);
  const id = await sha256(r.token);
  const existing = await deps.db
    .prepare('SELECT player FROM mailbox_devices WHERE token = ?')
    .bind(id)
    .first<{ player: string }>();
  if (existing && existing.player !== r.player) throw new MailboxError(409, 'token-taken');
  if (existing) {
    if (r.push === undefined) {
      await deps.db
        .prepare('UPDATE mailbox_devices SET seen = ? WHERE token = ?')
        .bind(now, id)
        .run();
    } else {
      await deps.db
        .prepare(
          'UPDATE mailbox_devices SET endpoint = ?, p256dh = ?, auth = ?, seen = ? WHERE token = ?',
        )
        .bind(r.push?.endpoint ?? null, r.push?.p256dh ?? null, r.push?.auth ?? null, now, id)
        .run();
    }
    return;
  }
  // The same player re-registering this device under a new token (its storage was cleared)
  // replaces the old row. Other players on the same browser share the subscription and keep theirs.
  if (r.push) {
    await deps.db
      .prepare('DELETE FROM mailbox_devices WHERE endpoint = ? AND player = ?')
      .bind(r.push.endpoint, r.player)
      .run();
  }
  await deps.db
    .prepare(
      'INSERT INTO mailbox_devices (token, player, endpoint, p256dh, auth, created, seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      r.player,
      r.push?.endpoint ?? null,
      r.push?.p256dh ?? null,
      r.push?.auth ?? null,
      now,
      now,
    )
    .run();
}

/** The player a bearer token belongs to. */
export async function authenticate(deps: MailboxDeps, token: string | null): Promise<string> {
  if (!token || !TOKEN.test(token)) throw new MailboxError(401, 'no-token');
  await schema(deps.db);
  const row = await deps.db
    .prepare('SELECT player FROM mailbox_devices WHERE token = ?')
    .bind(await sha256(token))
    .first<{ player: string }>();
  if (!row) throw new MailboxError(401, 'unknown-token');
  return row.player;
}

export async function unregister(deps: MailboxDeps, token: string | null): Promise<void> {
  await authenticate(deps, token);
  await deps.db
    .prepare('DELETE FROM mailbox_devices WHERE token = ?')
    .bind(await sha256(token!))
    .run();
}

export interface Outgoing {
  to: string;
  match: string;
  /** `view`: the table's latest position (replaces an uncollected older one); `cmd`: a move. */
  kind: 'cmd' | 'view';
  body: string;
  /** Wake the recipient's devices (default true). Off for news that can wait to be collected. */
  notify?: boolean;
}

export async function send(
  deps: MailboxDeps,
  sender: string,
  m: Outgoing,
): Promise<{ id: number; woke: number }> {
  if (
    !KEY.test(m.to ?? '') ||
    !MATCH.test(m.match ?? '') ||
    (m.kind !== 'cmd' && m.kind !== 'view') ||
    typeof m.body !== 'string' ||
    m.body.length === 0
  ) {
    throw new MailboxError(400, 'bad-message');
  }
  if (m.body.length > MAX_BODY) throw new MailboxError(413, 'too-big');
  const now = deps.now();
  const db = deps.db;
  await schema(db);
  const day = Math.floor(now / 86_400_000);
  const used = await db
    .prepare(
      'INSERT INTO mailbox_quota (sender, day, n) VALUES (?, ?, 1) ON CONFLICT (sender, day) DO UPDATE SET n = n + 1 RETURNING n',
    )
    .bind(sender, day)
    .first<{ n: number }>();
  if ((used?.n ?? 0) > DAILY_SENDS) throw new MailboxError(429, 'daily-limit');
  if (m.kind === 'view') {
    await db
      .prepare(
        "DELETE FROM mailbox_messages WHERE recipient = ? AND sender = ? AND match = ? AND kind = 'view'",
      )
      .bind(m.to, sender, m.match)
      .run();
  }
  const pending = await db
    .prepare('SELECT COUNT(*) AS n FROM mailbox_messages WHERE recipient = ?')
    .bind(m.to)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING) throw new MailboxError(429, 'mailbox-full');
  const row = await db
    .prepare(
      'INSERT INTO mailbox_messages (recipient, sender, match, kind, body, created) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    )
    .bind(m.to, sender, m.match, m.kind, m.body, now)
    .first<{ id: number }>();
  // Housekeeping, cheaply: what nobody collected in a month, and old quota rows.
  await db
    .prepare('DELETE FROM mailbox_messages WHERE created < ?')
    .bind(now - MAX_AGE_MS)
    .run();
  await db
    .prepare('DELETE FROM mailbox_quota WHERE day < ?')
    .bind(day - 1)
    .run();
  const woke = m.notify === false ? 0 : await wake(deps, m.to);
  return { id: row!.id, woke };
}

export interface Incoming {
  id: number;
  from: string;
  match: string;
  kind: 'cmd' | 'view';
  body: string;
  at: number;
}

export async function inbox(deps: MailboxDeps, player: string): Promise<Incoming[]> {
  await schema(deps.db);
  const { results } = await deps.db
    .prepare(
      'SELECT id, sender, match, kind, body, created FROM mailbox_messages WHERE recipient = ? ORDER BY id LIMIT 100',
    )
    .bind(player)
    .all<{
      id: number;
      sender: string;
      match: string;
      kind: 'cmd' | 'view';
      body: string;
      created: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    from: r.sender,
    match: r.match,
    kind: r.kind,
    body: r.body,
    at: r.created,
  }));
}

export async function ack(deps: MailboxDeps, player: string, ids: unknown): Promise<number> {
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every((i) => Number.isInteger(i))) {
    throw new MailboxError(400, 'bad-ids');
  }
  await schema(deps.db);
  let n = 0;
  for (const id of ids as number[]) {
    const r = await deps.db
      .prepare('DELETE FROM mailbox_messages WHERE id = ? AND recipient = ?')
      .bind(id, player)
      .run();
    n += r.meta?.changes ?? 0;
  }
  return n;
}

// ---- web push --------------------------------------------------------------------------------

/** Wake every device of `player` that asked for pushes. Returns how many push services took it. */
async function wake(deps: MailboxDeps, player: string): Promise<number> {
  if (!deps.vapid || !deps.push) return 0;
  const { results } = await deps.db
    .prepare(
      'SELECT token, endpoint FROM mailbox_devices WHERE player = ? AND endpoint IS NOT NULL',
    )
    .bind(player)
    .all<{ token: string; endpoint: string }>();
  let woke = 0;
  for (const d of results) {
    try {
      const res = await deps.push(d.endpoint, {
        method: 'POST',
        headers: {
          Authorization: await vapidAuthorization(deps.vapid, d.endpoint, deps.now()),
          TTL: String(7 * 24 * 3600),
          Urgency: 'high',
          'Content-Length': '0',
        },
      });
      if (res.ok) woke++;
      else if (res.status === 404 || res.status === 410) {
        // The subscription is gone (unsubscribed, app removed): stop trying it.
        await deps.db
          .prepare(
            'UPDATE mailbox_devices SET endpoint = NULL, p256dh = NULL, auth = NULL WHERE token = ?',
          )
          .bind(d.token)
          .run();
      }
    } catch {
      /* the push service is unreachable: the message waits in the inbox all the same */
    }
  }
  return woke;
}

const json64 = (v: unknown) => bytesToBase64Url(utf8Bytes(JSON.stringify(v)));

/** `Authorization: vapid t=<JWT>, k=<public key>` for a push to `endpoint` (RFC 8292). */
export async function vapidAuthorization(
  vapid: VapidKeys,
  endpoint: string,
  now: number,
): Promise<string> {
  const pub = base64UrlToBytes(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be 65 bytes');
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: vapid.privateKey,
      x: bytesToBase64Url(pub.slice(1, 33)),
      y: bytesToBase64Url(pub.slice(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const unsigned = `${json64({ typ: 'JWT', alg: 'ES256' })}.${json64({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: vapid.subject,
  })}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8Bytes(unsigned) as Uint8Array<ArrayBuffer>,
  );
  return `vapid t=${unsigned}.${bytesToBase64Url(new Uint8Array(sig))}, k=${vapid.publicKey}`;
}
