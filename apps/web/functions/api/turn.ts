/**
 * GET /api/turn — short-lived TURN credentials for Cloudflare's relay.
 *
 * Most players connect directly; the relay is for the ones whose networks forbid it. The key that
 * mints credentials lives only in this function's environment, and what it hands out expires, so a
 * copied credential stops working on its own. Answering only this site's own pages is a speed bump,
 * not a lock: anything can forge the headers, and the bill for relayed traffic is what's at stake.
 */
interface Env {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

interface Context {
  request: Request;
  env: Env;
}

/** Long enough to outlast a sitting; a host that stays up longer re-registers when it reconnects. */
const TTL_SECONDS = 24 * 60 * 60;

const ALLOWED_ORIGINS = new Set(['https://amongfriends.gg', 'http://localhost:5173']);

export const onRequestGet = async ({ request, env }: Context): Promise<Response> => {
  if (!fromThisSite(request)) return json({ error: 'forbidden' }, 403);
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ iceServers: [] }, 200);

  const upstream = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    },
  );
  if (!upstream.ok) return json({ iceServers: [] }, 502);
  const body = (await upstream.json()) as { iceServers?: unknown };
  return json({
    iceServers: usable(body.iceServers),
    expiresAt: Date.now() + TTL_SECONDS * 1000,
  });
};

function fromThisSite(request: Request): boolean {
  if (request.headers.get('Sec-Fetch-Site') === 'same-origin') return true;
  const origin = request.headers.get('Origin');
  return origin !== null && ALLOWED_ORIGINS.has(origin);
}

/**
 * Browsers refuse port 53, so a server listed there only costs every connection a timeout while
 * it is tried. Cloudflare's own guidance is to leave those URLs out.
 */
function usable(servers: unknown): RTCIceServer[] {
  const list = Array.isArray(servers) ? servers : servers ? [servers] : [];
  const out: RTCIceServer[] = [];
  for (const s of list as RTCIceServer[]) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(
      (u): u is string => typeof u === 'string' && !/:53(\?|$)/.test(u),
    );
    if (urls.length) out.push({ ...s, urls });
  }
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
