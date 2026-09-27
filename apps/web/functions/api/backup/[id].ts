/**
 * /api/backup/<credential id> — the encrypted copy of a player that a passkey can open.
 *
 * GET hands back whatever is stored: ciphertext, useless without the passkey that sealed it.
 * PUT stores a backup signed by the player's own key; once a credential's backup exists, only a
 * backup signed by that same key may replace it.
 */
import type { StoredBackup } from '../../../src/session/backupFormat';
import { asStoredBackup, backupSignatureValid } from '../../../src/session/backupFormat';

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
  params: { id?: string | string[] };
}

const key = (id: string) => `backup:${id}`;

export const onRequestGet = async ({ env, params }: Context): Promise<Response> => {
  const id = idOf(params);
  if (!id) return json({ error: 'bad-id' }, 400);
  if (!env.BACKUPS) return json({ error: 'unavailable' }, 503);
  const stored = asStoredBackup(await env.BACKUPS.get(key(id), 'json'));
  return stored ? json(stored) : json({ error: 'not-found' }, 404);
};

export const onRequestPut = async ({ request, env, params }: Context): Promise<Response> => {
  if (!sameSite(request)) return json({ error: 'forbidden' }, 403);
  const id = idOf(params);
  if (!id) return json({ error: 'bad-id' }, 400);
  if (!env.BACKUPS) return json({ error: 'unavailable' }, 503);
  let body: StoredBackup | null = null;
  try {
    body = asStoredBackup(await request.json());
  } catch {
    body = null;
  }
  if (!body || body.credentialId !== id) return json({ error: 'bad-backup' }, 400);
  if (!(await backupSignatureValid(body))) return json({ error: 'bad-signature' }, 400);
  const existing = asStoredBackup(await env.BACKUPS.get(key(id), 'json'));
  if (existing && existing.publicKey !== body.publicKey) {
    return json({ error: 'belongs-to-another-player' }, 409);
  }
  await env.BACKUPS.put(key(id), JSON.stringify(body));
  return json({ ok: true });
};

function idOf(params: Context['params']): string | null {
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  return id && /^[A-Za-z0-9_-]{16,512}$/.test(id) ? id : null;
}

function sameSite(request: Request): boolean {
  if (request.headers.get('Sec-Fetch-Site') === 'same-origin') return true;
  const origin = request.headers.get('Origin');
  return origin === 'https://amongfriends.gg' || origin === 'http://localhost:5173';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
