// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyPair } from '@bgf/protocol';
import { base64UrlToBytes, bytesToBase64Url, generateKeyPair, sign } from '@bgf/protocol';
import { issueGrant } from '@bgf/wallet';
import type { Db, MailboxDeps, Stmt } from './service';
import {
  DAILY_SENDS,
  MailboxError,
  ack,
  authenticate,
  inbox,
  register,
  registrationBytes,
  send,
  vapidAuthorization,
} from './service';

/** D1's API over Node's SQLite: the same SQL engine D1 runs. */
function sqliteDb(): Db {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql: string, args: unknown[] = []): Stmt => ({
    bind: (...values: unknown[]) => stmt(sql, values),
    all: async <T>() => ({ results: db.prepare(sql).all(...(args as never[])) as T[] }),
    first: async <T>() => (db.prepare(sql).get(...(args as never[])) as T | undefined) ?? null,
    run: async () => ({
      meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) },
    }),
  });
  return {
    prepare: (sql) => stmt(sql),
    exec: async (sql) => {
      db.exec(sql);
    },
  };
}

const token = () => bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));

async function signed(keys: KeyPair, player: string, tok: string, at: number, grant?: string) {
  const r = { player, device: keys.publicKey, at, token: tok };
  const signature = bytesToBase64Url(await sign(keys.privateKey, registrationBytes(r)));
  return { ...r, signature, ...(grant ? { grant } : {}) };
}

let deps: MailboxDeps;
let t: number;
let alice: KeyPair;
let bob: KeyPair;

beforeEach(async () => {
  t = Date.UTC(2026, 9, 10, 12);
  deps = { db: sqliteDb(), now: () => t };
  alice = await generateKeyPair();
  bob = await generateKeyPair();
});

async function device(keys: KeyPair): Promise<string> {
  const tok = token();
  await register(deps, await signed(keys, keys.publicKey, tok, t));
  return tok;
}

describe('the mailbox', () => {
  it('registers a device signed by the player, and knows whose its token is', async () => {
    const tok = await device(alice);
    expect(await authenticate(deps, tok)).toBe(alice.publicKey);
    await expect(authenticate(deps, token())).rejects.toMatchObject({ status: 401 });
  });

  it('takes a paired device with its grant, and nobody else claiming the player', async () => {
    const phone = await generateKeyPair();
    const grant = await issueGrant(alice, {
      device: phone.publicKey,
      serial: 1,
      label: 'Phone',
      scopes: ['seat'],
      issuedAt: t,
    });
    const tok = token();
    await register(deps, await signed(phone, alice.publicKey, tok, t, grant));
    expect(await authenticate(deps, tok)).toBe(alice.publicKey);

    // Bob's key, claiming to be Alice: no grant, no entry.
    await expect(
      register(deps, await signed(bob, alice.publicKey, token(), t)),
    ).rejects.toMatchObject({ code: 'not-authorised' });
    // A signature that does not cover the token presented.
    const r = await signed(alice, alice.publicKey, token(), t);
    await expect(register(deps, { ...r, token: token() })).rejects.toMatchObject({
      code: 'not-authorised',
    });
    // An old registration replayed.
    await expect(
      register(deps, await signed(alice, alice.publicKey, token(), t - 3600_000)),
    ).rejects.toMatchObject({ code: 'stale' });
  });

  it('delivers in order, only to the recipient, until collected', async () => {
    const a = await device(alice);
    const b = await device(bob);
    const from = await authenticate(deps, a);
    await send(deps, from, { to: bob.publicKey, match: 'm1', kind: 'cmd', body: 'one' });
    await send(deps, from, { to: bob.publicKey, match: 'm1', kind: 'cmd', body: 'two' });
    expect(await inbox(deps, alice.publicKey)).toEqual([]);
    const got = await inbox(deps, await authenticate(deps, b));
    expect(got.map((m) => [m.body, m.from, m.match, m.kind])).toEqual([
      ['one', alice.publicKey, 'm1', 'cmd'],
      ['two', alice.publicKey, 'm1', 'cmd'],
    ]);
    // Alice cannot clear Bob's mail; Bob can.
    expect(await ack(deps, alice.publicKey, [got[0]!.id])).toBe(0);
    expect(await ack(deps, bob.publicKey, [got[0]!.id])).toBe(1);
    expect((await inbox(deps, bob.publicKey)).map((m) => m.body)).toEqual(['two']);
  });

  it('keeps only the latest uncollected position per match and sender', async () => {
    await device(bob);
    for (const body of ['v1', 'v2', 'v3']) {
      await send(deps, alice.publicKey, { to: bob.publicKey, match: 'm1', kind: 'view', body });
    }
    await send(deps, alice.publicKey, { to: bob.publicKey, match: 'm2', kind: 'view', body: 'w1' });
    expect((await inbox(deps, bob.publicKey)).map((m) => m.body)).toEqual(['v3', 'w1']);
  });

  it('refuses malformed messages and a sender over the daily limit', async () => {
    await expect(
      send(deps, alice.publicKey, { to: 'nobody', match: 'm1', kind: 'cmd', body: 'x' }),
    ).rejects.toBeInstanceOf(MailboxError);
    for (let i = 0; i < DAILY_SENDS; i++) {
      await send(deps, alice.publicKey, {
        to: bob.publicKey,
        match: 'm1',
        kind: 'view',
        body: 'x',
      });
    }
    await expect(
      send(deps, alice.publicKey, { to: bob.publicKey, match: 'm1', kind: 'view', body: 'x' }),
    ).rejects.toMatchObject({ status: 429, code: 'daily-limit' });
    // The next day the allowance is back.
    t += 86_400_000;
    await send(deps, alice.publicKey, { to: bob.publicKey, match: 'm1', kind: 'view', body: 'x' });
  });

  it('wakes the recipient’s devices with an empty, VAPID-signed push, and forgets dead ones', async () => {
    const vapidPair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', vapidPair.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', vapidPair.privateKey);
    const pushed: { endpoint: string; init: RequestInit }[] = [];
    let status = 201;
    deps.vapid = {
      publicKey: bytesToBase64Url(raw),
      privateKey: jwk.d!,
      subject: 'https://amongfriends.gg',
    };
    deps.push = vi.fn(async (endpoint: string, init: RequestInit) => {
      pushed.push({ endpoint, init });
      return new Response(null, { status });
    });
    const tok = token();
    await register(deps, {
      ...(await signed(bob, bob.publicKey, tok, t)),
      push: { endpoint: 'https://push.example/abc', p256dh: 'x'.repeat(87), auth: 'y'.repeat(22) },
    });
    const out = await send(deps, alice.publicKey, {
      to: bob.publicKey,
      match: 'm1',
      kind: 'cmd',
      body: 'x',
    });
    expect(out.woke).toBe(1);
    const headers = pushed[0]!.init.headers as Record<string, string>;
    expect(pushed[0]!.init.body).toBe('');
    // The JWT verifies with the public key and names the push service as its audience.
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(headers.Authorization!)!;
    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(m[2]!)));
    expect(claims.aud).toBe('https://push.example');
    expect(claims.sub).toBe('https://amongfriends.gg');
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        vapidPair.publicKey,
        base64UrlToBytes(m[3]!),
        new TextEncoder().encode(`${m[1]}.${m[2]}`),
      ),
    ).toBe(true);

    // The subscription is gone: the mailbox stops pushing to it, and the message still waits.
    status = 410;
    await send(deps, alice.publicKey, { to: bob.publicKey, match: 'm1', kind: 'cmd', body: 'y' });
    status = 201;
    const again = await send(deps, alice.publicKey, {
      to: bob.publicKey,
      match: 'm1',
      kind: 'cmd',
      body: 'z',
    });
    expect(again.woke).toBe(0);
    expect(pushed).toHaveLength(2);
    expect((await inbox(deps, bob.publicKey)).map((x) => x.body)).toEqual(['x', 'y', 'z']);
    // And the device is still registered: it can collect.
    expect(await authenticate(deps, tok)).toBe(bob.publicKey);
    expect(typeof (await vapidAuthorization(deps.vapid, 'https://push.example/q', t))).toBe(
      'string',
    );
  });
});
