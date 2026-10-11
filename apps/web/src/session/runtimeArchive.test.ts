import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { onRequestPost } from '../../functions/api/archive-runtime';
import { onRequestGet } from '../../functions/runtime-archive/[[path]]';

const ORIGIN = 'https://amongfriends.gg';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A deploy (what `env.ASSETS` serves) and an in-memory stand-in for the R2 bucket. */
function site(files: Record<string, string>, opts: { id?: string; badHash?: string } = {}) {
  const id = opts.id ?? 'runtime-AAAA1111.js';
  const manifest = {
    format: 1,
    version: 'v1',
    id,
    entry: 'runtime/runtime-entry1.js',
    files: Object.entries(files).map(([path, code]) => ({
      path,
      sha256: path === opts.badHash ? sha('something else') : sha(code),
    })),
  };
  const assets = {
    async fetch(req: Request | string) {
      const path = new URL(typeof req === 'string' ? req : req.url).pathname.slice(1);
      if (path === 'runtime/manifest.json') return Response.json(manifest);
      if (path in files) {
        return new Response(files[path], { headers: { 'Content-Type': 'text/javascript' } });
      }
      // The SPA fallback: the app's page, for any unknown path.
      return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
    },
  };
  const stored = new Map<string, string>();
  const bucket = {
    stored,
    async get(key: string) {
      const v = stored.get(key);
      return v === undefined ? null : { body: new Response(v).body! };
    },
    async head(key: string) {
      return stored.has(key) ? {} : null;
    },
    async put(key: string, value: ArrayBuffer | string) {
      stored.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value));
    },
  };
  return { env: { ASSETS: assets, RUNTIMES: bucket }, bucket, manifest };
}

const FILES = {
  'runtime/runtime-entry1.js': 'export{a as TableServer}from"../assets/runtime-AAAA1111.js";',
  'assets/runtime-AAAA1111.js': 'export const a=1;',
};

const post = (env: unknown) =>
  onRequestPost({
    request: new Request(`${ORIGIN}/api/archive-runtime`, { method: 'POST' }),
    env,
  } as never);
const get = (env: unknown, path: string) =>
  onRequestGet({
    request: new Request(`${ORIGIN}/runtime-archive/${path}`),
    env,
    params: { path: path.split('/') },
  } as never);

describe('the runtime archive', () => {
  it('copies the deployed runtime once, checked against its hashes, and names its entry by id', async () => {
    const s = site(FILES);
    expect(await (await post(s.env)).json()).toEqual({ id: 'runtime-AAAA1111.js', stored: 2 });
    expect(await (await post(s.env)).json()).toEqual({ id: 'runtime-AAAA1111.js', stored: 0 });
    expect(s.bucket.stored.get('assets/runtime-AAAA1111.js')).toBe('export const a=1;');
    const pin = JSON.parse(s.bucket.stored.get('pins/runtime-AAAA1111.js.json')!);
    expect(pin.entry).toBe('runtime/runtime-entry1.js');
  });

  it('refuses a file that does not match the manifest', async () => {
    const s = site(FILES, { badHash: 'assets/runtime-AAAA1111.js' });
    const res = await post(s.env);
    expect(res.status).toBe(500);
    expect(s.bucket.stored.has('assets/runtime-AAAA1111.js')).toBe(false);
  });

  it('serves archived files for good, after the deploy that published them is gone', async () => {
    const s = site(FILES);
    await post(s.env);
    // A later deploy serves other files; the archive still has these.
    const later = { ...s.env, ASSETS: site({}, { id: 'runtime-BBBB2222.js' }).env.ASSETS };
    const pin = await get(later, 'pins/runtime-AAAA1111.js');
    expect(pin.status).toBe(200);
    expect((await pin.json()).entry).toBe('runtime/runtime-entry1.js');
    const code = await get(later, 'assets/runtime-AAAA1111.js');
    expect(code.headers.get('Content-Type')).toContain('javascript');
    expect(code.headers.get('Cache-Control')).toContain('immutable');
    expect(await code.text()).toBe('export const a=1;');
  });

  it("serves the current deploy's runtime before it is archived, and nothing else", async () => {
    const s = site(FILES);
    expect((await get(s.env, 'pins/runtime-AAAA1111.js')).status).toBe(200);
    expect(await (await get(s.env, 'assets/runtime-AAAA1111.js')).text()).toBe('export const a=1;');
    expect((await get(s.env, 'pins/runtime-ZZZZ9999.js')).status).toBe(404);
    // The SPA fallback page is never passed off as code; nor is anything outside the runtime.
    expect((await get(s.env, 'assets/missing-1234.js')).status).toBe(404);
    expect((await get(s.env, 'index.html')).status).toBe(404);
    expect((await get(s.env, 'pins/../secrets')).status).toBe(400);
  });
});
