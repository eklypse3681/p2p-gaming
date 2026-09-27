/**
 * /api/revocations/<player public key> — the devices a player has signed out.
 *
 * Anyone may read it: a table or club checks it before letting a paired device take a player's
 * seat. Only a list signed by the player's own key is stored, and a new list must still revoke
 * everything the old one did, so a stolen device cannot be signed back in by replaying or
 * shrinking the list.
 */
import type { Revocation } from '@bgf/wallet';
import { isRevoked, openRevocation } from '@bgf/wallet';

interface KVNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

interface Env {
  BACKUPS?: KVNamespace;
}

interface Context {
  request: Request;
  env: Env;
  params: { key?: string | string[] };
}

interface Stored {
  token: string;
}

const storeKey = (key: string) => `revocation:${key}`;

export const onRequestGet = async ({ env, params }: Context): Promise<Response> => {
  const key = keyOf(params);
  if (!key) return json({ error: 'bad-key' }, 400);
  if (!env.BACKUPS) return json({ error: 'unavailable' }, 503);
  const stored = (await env.BACKUPS.get(storeKey(key), 'json')) as Stored | null;
  return stored?.token
    ? json({ token: stored.token }, 200, 'public, max-age=30')
    : json({ error: 'not-found' }, 404, 'public, max-age=30');
};

export const onRequestPut = async ({ request, env, params }: Context): Promise<Response> => {
  const key = keyOf(params);
  if (!key) return json({ error: 'bad-key' }, 400);
  if (!env.BACKUPS) return json({ error: 'unavailable' }, 503);
  let token: unknown;
  try {
    token = ((await request.json()) as { token?: unknown }).token;
  } catch {
    token = null;
  }
  if (typeof token !== 'string' || token.length > 16_384) return json({ error: 'bad-token' }, 400);
  const next = await openRevocation(token, key);
  if (!next) return json({ error: 'bad-signature' }, 400);
  const stored = (await env.BACKUPS.get(storeKey(key), 'json')) as Stored | null;
  const current = stored?.token ? await openRevocation(stored.token, key) : null;
  if (current && !stillRevokes(next, current)) {
    return json({ error: 'would-sign-devices-back-in' }, 409);
  }
  await env.BACKUPS.put(storeKey(key), JSON.stringify({ token } satisfies Stored));
  return json({ ok: true });
};

/** Everything `old` revoked, `next` revokes too; and `next` is not older. */
export function stillRevokes(next: Revocation, old: Revocation): boolean {
  if (next.issuedAt < old.issuedAt) return false;
  if (next.minSerial < old.minSerial) return false;
  return old.serials.every((s) => isRevoked(next, s));
}

function keyOf(params: Context['params']): string | null {
  const key = Array.isArray(params.key) ? params.key[0] : params.key;
  return key && /^[A-Za-z0-9_-]{86,88}$/.test(key) ? key : null;
}

function json(body: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  });
}
