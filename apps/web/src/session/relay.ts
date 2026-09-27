/**
 * TURN relay credentials, fetched from this site's own `/api/turn` and reused until shortly before
 * they expire. Every failure — no network, no function (the dev server), a refusal — yields an
 * empty list, which means direct connections only: exactly how things worked before the relay.
 */

interface Cached {
  servers: RTCIceServer[];
  /** When to stop using these and fetch again. */
  refreshAt: number;
}

/** Credentials are fetched well before they expire, so a connection never gets a dying one. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;
/** A relay that is slow to answer must not hold up the connection that wanted it. */
const FETCH_TIMEOUT_MS = 3000;
/** After a failure, try again soon rather than hammering or giving up for the whole session. */
const RETRY_AFTER_MS = 60 * 1000;

let cached: Cached | null = null;
let inflight: Promise<RTCIceServer[]> | null = null;

export function relayServers(now: () => number = Date.now): Promise<RTCIceServer[]> {
  if (cached && now() < cached.refreshAt) return Promise.resolve(cached.servers);
  if (!inflight) {
    inflight = fetchRelay(now).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function fetchRelay(now: () => number): Promise<RTCIceServer[]> {
  const stale = cached?.servers ?? [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch('/api/turn', { signal: controller.signal }).finally(() =>
      clearTimeout(timer),
    );
    if (!res.ok) throw new Error(`relay ${res.status}`);
    const body = (await res.json()) as { iceServers?: unknown; expiresAt?: unknown };
    const servers = Array.isArray(body.iceServers) ? (body.iceServers as RTCIceServer[]) : [];
    const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : now();
    cached = {
      servers,
      refreshAt: Math.max(now() + RETRY_AFTER_MS, expiresAt - REFRESH_MARGIN_MS),
    };
    return servers;
  } catch {
    // Keep using credentials that have not expired yet; otherwise go without a relay for now.
    cached = { servers: stale, refreshAt: now() + RETRY_AFTER_MS };
    return stale;
  }
}

/** For tests. */
export function resetRelayCache(): void {
  cached = null;
  inflight = null;
}
