/**
 * POST /api/archive-runtime — copy the deployed table runtime into the archive (R2), so matches
 * pinned to it can still load it after later deploys. Run by CI after every deploy; harmless to
 * repeat, and anyone may call it: it only copies files this deploy already serves, each checked
 * against the manifest's SHA-256 and never overwritten.
 */
import type { ArchiveEnv } from '../../src/session/runtimeArchive';
import { FILE_PATH, PIN, currentManifest, pinKey } from '../../src/session/runtimeArchive';

interface Context {
  request: Request;
  env: ArchiveEnv;
}

export const onRequestPost = async ({ request, env }: Context): Promise<Response> => {
  const bucket = env.RUNTIMES;
  if (!bucket) return json({ error: 'unavailable' }, 503);
  const manifest = await currentManifest(request, env);
  if (!manifest || !PIN.test(manifest.id)) return json({ error: 'no-manifest' }, 500);
  let stored = 0;
  for (const f of manifest.files) {
    if (!FILE_PATH.test(f.path) || f.path.includes('..')) return json({ error: 'bad-path' }, 500);
    if (await bucket.head(f.path)) continue;
    const res = await env.ASSETS.fetch(new URL(`/${f.path}`, request.url).toString());
    if (!res.ok) return json({ error: 'missing-file', path: f.path }, 500);
    const body = await res.arrayBuffer();
    if ((await sha256(body)) !== f.sha256)
      return json({ error: 'hash-mismatch', path: f.path }, 500);
    await bucket.put(f.path, body, { httpMetadata: { contentType: 'text/javascript' } });
    stored++;
  }
  if (!(await bucket.head(pinKey(manifest.id)))) {
    await bucket.put(
      pinKey(manifest.id),
      JSON.stringify({ entry: manifest.entry, version: manifest.version, files: manifest.files }),
      { httpMetadata: { contentType: 'application/json' } },
    );
  }
  return json({ id: manifest.id, stored });
};

async function sha256(body: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
