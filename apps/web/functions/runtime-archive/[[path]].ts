/**
 * /runtime-archive/… — every table runtime the site has ever published, so a match can always be
 * played with the rules it was created with (see `src/session/runtimes.ts`).
 *
 *   /runtime-archive/pins/<runtime id>   which entry file that runtime starts from (JSON)
 *   /runtime-archive/runtime/<file>.js   the entry, and
 *   /runtime-archive/assets/<file>.js    the files it imports (relative, so they resolve here)
 *
 * Everything is content-hashed, so it never changes and is cached for good. A file the archive
 * does not have yet but the current deploy serves (in the moments before `/api/archive-runtime`
 * runs) is served from the deploy.
 */
import type { ArchiveEnv } from '../../src/session/runtimeArchive';
import { FILE_PATH, PIN, currentManifest, pinKey } from '../../src/session/runtimeArchive';

interface Context {
  request: Request;
  env: ArchiveEnv;
  params: { path?: string | string[] };
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

export const onRequestGet = async ({ request, env, params }: Context): Promise<Response> => {
  const path = (Array.isArray(params.path) ? params.path : [params.path ?? '']).join('/');
  const pin = /^pins\/(.+)$/.exec(path)?.[1];
  if (pin !== undefined) {
    if (!PIN.test(pin)) return new Response('bad id', { status: 400 });
    const stored = await env.RUNTIMES?.get(pinKey(pin));
    if (stored) return file(stored.body, 'application/json');
    // Not archived yet: the current deploy's own runtime, if that is the one asked for.
    const manifest = await currentManifest(request, env);
    if (manifest?.id === pin) {
      return new Response(JSON.stringify({ entry: manifest.entry, version: manifest.version }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      });
    }
    return new Response('not archived', { status: 404 });
  }
  if (!FILE_PATH.test(path) || path.includes('..'))
    return new Response('not found', { status: 404 });
  const stored = await env.RUNTIMES?.get(path);
  if (stored) return file(stored.body, 'text/javascript');
  const live = await env.ASSETS.fetch(new URL(`/${path}`, request.url).toString());
  if (live.ok && (live.headers.get('Content-Type') ?? '').includes('javascript')) {
    return file(live.body!, 'text/javascript');
  }
  return new Response('not found', { status: 404 });
};

function file(body: ReadableStream, type: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': `${type}; charset=utf-8`,
      'Cache-Control': IMMUTABLE,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
