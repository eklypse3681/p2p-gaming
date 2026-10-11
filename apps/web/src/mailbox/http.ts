/**
 * The mailbox's HTTP face, shared by its Pages Functions (`functions/api/mailbox/`): each one is
 * a single call here, so the whole surface is tested in `http.test.ts`.
 *
 *   GET  /api/mailbox/status      { available, vapidKey }
 *   POST /api/mailbox/register    a signed `Registration` (token, optional push subscription)
 *   POST /api/mailbox/unregister  Bearer
 *   POST /api/mailbox/send        Bearer · { to, match, kind, body }
 *   GET  /api/mailbox/inbox       Bearer → { messages }
 *   POST /api/mailbox/ack         Bearer · { ids }
 */
import type { Db, MailboxDeps } from './service';
import { MailboxError, ack, authenticate, inbox, register, send, unregister } from './service';

export interface MailboxEnv {
  MAILBOX?: Db;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export type MailboxAction = 'status' | 'register' | 'unregister' | 'send' | 'inbox' | 'ack';

function depsFor(env: MailboxEnv, db: Db): MailboxDeps {
  return {
    db,
    now: () => Date.now(),
    ...(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? {
          vapid: {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT ?? 'https://amongfriends.gg',
          },
          push: (endpoint: string, init: RequestInit) => fetch(endpoint, init),
        }
      : {}),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

function bearer(request: Request): string | null {
  const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '');
  return m ? m[1]!.trim() : null;
}

/** Writes come from the site itself (its pages and service worker), never from other origins. */
function sameSite(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    throw new MailboxError(400, 'bad-json');
  }
}

export async function handleMailbox(
  action: MailboxAction,
  request: Request,
  env: MailboxEnv,
  deps?: MailboxDeps,
): Promise<Response> {
  if (action === 'status') {
    return json({
      available: !!env.MAILBOX,
      vapidKey: env.MAILBOX && env.VAPID_PRIVATE_KEY ? (env.VAPID_PUBLIC_KEY ?? null) : null,
    });
  }
  if (!env.MAILBOX && !deps) return json({ error: 'unavailable' }, 503);
  const d = deps ?? depsFor(env, env.MAILBOX!);
  try {
    if (action === 'inbox') {
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      const player = await authenticate(d, bearer(request));
      return json({ messages: await inbox(d, player) });
    }
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    if (!sameSite(request)) return json({ error: 'forbidden' }, 403);
    switch (action) {
      case 'register':
        await register(d, (await body(request)) as never);
        return json({ ok: true });
      case 'unregister':
        await unregister(d, bearer(request));
        return json({ ok: true });
      case 'send': {
        const player = await authenticate(d, bearer(request));
        return json(await send(d, player, (await body(request)) as never));
      }
      case 'ack': {
        const player = await authenticate(d, bearer(request));
        return json({ deleted: await ack(d, player, (await body(request)).ids) });
      }
    }
  } catch (e) {
    if (e instanceof MailboxError) return json({ error: e.code }, e.status);
    return json({ error: 'server' }, 500);
  }
}
