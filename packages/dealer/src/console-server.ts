import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RandomnessMode } from '@bgf/protocol';
import { isDealerGame } from './games.js';
import type { DealerManager, ManagerEvent } from './manager.js';
import { ManagerError, presetsFor } from './manager.js';
import { isEntropySourceName } from './entropy.js';
import { isRandomnessMode, publicSettings } from './settings.js';

export interface ConsoleServerOptions {
  manager: DealerManager;
  port?: number;
  host?: string;
  /** Bearer token required for every request; mandatory when `host` is not loopback. */
  token?: string;
  /** Directory holding the built console (`index.html` + `assets/`). */
  staticDir?: string;
  log?: (line: string) => void;
  /** Version string reported by `/api/status`. */
  version?: string;
}

export interface ConsoleServer {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

/** Where the console build is copied by `pnpm build:console`. */
export function defaultConsoleDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ (dev) or dist/ (bundled): both are one level below the package root.
  return resolve(here, '..', 'console');
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'error',
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function tokenFrom(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return url.searchParams.get('token');
}

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Dealer console</title>
<body style="font-family:system-ui;background:#0f1117;color:#eef0f6;padding:2rem;max-width:40rem">
<h1>Console not built</h1>
<p>The dealer is running and its API is up at <code>/api/status</code>, but the console UI has not
been built yet. From the repository run:</p>
<pre style="background:#171a23;padding:1rem;border-radius:8px">pnpm build:console</pre>
<p>then reload this page.</p>`;

/**
 * Serve the console UI and its JSON API for a `DealerManager`. Binds to localhost by default; any
 * other host requires a token. Live updates use server-sent events at `/api/events`.
 */
export async function startConsoleServer(opts: ConsoleServerOptions): Promise<ConsoleServer> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 7777;
  const staticDir = opts.staticDir ?? defaultConsoleDir();
  const log = opts.log ?? (() => {});
  const { manager } = opts;
  const token = opts.token ?? manager.settings().consoleToken;
  if (!isLoopback(host) && !token) {
    throw new Error(`binding to ${host} needs a console token (--token or Settings)`);
  }
  const startedAt = Date.now();
  const clients = new Set<ServerResponse>();

  const unsubscribe = manager.subscribe((event: ManagerEvent) => {
    const line = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of Array.from(clients)) res.write(line);
  });
  const keepAlive = setInterval(() => {
    for (const res of Array.from(clients)) res.write(': keep-alive\n\n');
  }, 25_000);
  keepAlive.unref();

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const seg = path.split('/').filter(Boolean); // ['api', ...]

    if (token) {
      const presented = tokenFrom(req, url);
      if (presented !== token) throw new HttpError(401, 'console token required', 'unauthorized');
    }

    // GET /api/status
    if (seg.length === 2 && seg[1] === 'status' && method === 'GET') {
      const tables = await manager.list();
      return sendJson(res, 200, {
        ok: true,
        version: opts.version ?? '0.1.0',
        dataDir: manager.dataDir,
        host,
        port,
        uptimeMs: Date.now() - startedAt,
        tables: tables.length,
        running: tables.filter((t) => t.status === 'running').length,
        consoleBuilt: existsSync(join(staticDir, 'index.html')),
        dealer: await manager.dealerProfile(),
        settings: publicSettings(manager.settings()),
      });
    }
    // /api/settings
    if (seg.length === 2 && seg[1] === 'settings') {
      if (method === 'GET') return sendJson(res, 200, publicSettings(manager.settings()));
      if (method === 'PUT' || method === 'PATCH') {
        const body = (await readJson(req)) as Record<string, unknown>;
        if (body.defaultEntropy !== undefined && !isEntropySourceName(body.defaultEntropy)) {
          throw new HttpError(400, 'defaultEntropy must be crypto, random.org or drand');
        }
        if (body.defaultRandomness !== undefined && !isRandomnessMode(body.defaultRandomness)) {
          throw new HttpError(400, 'defaultRandomness must be per-draw, seeded or beacon');
        }
        const next = await manager.updateSettings(body);
        return sendJson(res, 200, publicSettings(next));
      }
    }
    // /api/presets?game=
    if (seg.length === 2 && seg[1] === 'presets' && method === 'GET') {
      const game = url.searchParams.get('game') ?? 'ofc';
      if (!isDealerGame(game)) throw new HttpError(400, 'unknown game');
      return sendJson(res, 200, presetsFor(game));
    }
    // /api/rulesets, /api/rulesets/:name
    if (seg[1] === 'rulesets') {
      if (seg.length === 2 && method === 'GET')
        return sendJson(res, 200, await manager.listRulesets());
      const name = seg[2] ? decodeURIComponent(seg[2]) : '';
      if (seg.length === 3 && method === 'PUT') {
        const body = (await readJson(req)) as { config?: unknown };
        return sendJson(res, 200, await manager.saveRuleset(name, body.config ?? body));
      }
      if (seg.length === 3 && method === 'DELETE') {
        await manager.deleteRuleset(name);
        return sendJson(res, 200, { ok: true });
      }
    }
    // /api/events (SSE)
    if (seg.length === 2 && seg[1] === 'events' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
      for (const e of manager.recentEvents(50))
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    // /api/tables…
    if (seg[1] === 'tables') {
      if (seg.length === 2 && method === 'GET') return sendJson(res, 200, await manager.list());
      if (seg.length === 2 && method === 'POST') {
        const body = (await readJson(req)) as Record<string, unknown>;
        if (!isDealerGame(body.game)) throw new HttpError(400, 'game must be backgammon or ofc');
        const info = await manager.create({
          game: body.game,
          config: body.config,
          seats: typeof body.seats === 'number' ? body.seats : undefined,
          name: typeof body.name === 'string' ? body.name : undefined,
          code: typeof body.code === 'string' && body.code ? body.code : undefined,
          entropy: isEntropySourceName(body.entropy) ? body.entropy : undefined,
          randomness: isRandomnessMode(body.randomness)
            ? (body.randomness as RandomnessMode)
            : undefined,
          fallback: body.fallback === true,
          options:
            body.options && typeof body.options === 'object'
              ? (body.options as Record<string, unknown>)
              : undefined,
        });
        return sendJson(res, 201, info);
      }
      const id = seg[2] ? decodeURIComponent(seg[2]) : '';
      if (!id) throw new HttpError(404, 'not found');
      if (seg.length === 3 && method === 'GET') {
        return sendJson(res, 200, {
          ...(await manager.info(id)),
          events: manager.recentEvents(50, id),
        });
      }
      if (seg.length === 4 && method === 'GET') {
        switch (seg[3]) {
          case 'snapshot': {
            const s = await manager.publicSnapshot(id);
            if (!s) throw new HttpError(404, 'no such table');
            return sendJson(res, 200, s);
          }
          case 'audit': {
            const a = await manager.audit(id);
            if (!a) throw new HttpError(404, 'no such table');
            return sendJson(res, 200, a);
          }
          case 'ledger': {
            const l = await manager.ledger(id);
            if (!l) throw new HttpError(404, 'no ledger for this table');
            return sendJson(res, 200, l);
          }
          case 'events':
            return sendJson(res, 200, manager.recentEvents(200, id));
          default:
            break;
        }
      }
      if (seg.length === 4 && method === 'POST') {
        switch (seg[3]) {
          case 'resume':
            return sendJson(res, 200, await manager.resume(id));
          case 'stop':
            return sendJson(res, 200, await manager.stop(id));
          case 'remove': {
            const body = (await readJson(req)) as { purge?: boolean };
            await manager.remove(id, { purge: body.purge === true });
            return sendJson(res, 200, { ok: true });
          }
          case 'command': {
            const body = (await readJson(req)) as { command?: unknown };
            if (!body.command || typeof body.command !== 'object')
              throw new HttpError(400, 'command required');
            return sendJson(res, 200, await manager.sendDealerCommand(id, body.command));
          }
          default:
            break;
        }
      }
    }
    throw new HttpError(404, 'not found');
  };

  const serveStatic = (res: ServerResponse, pathname: string): void => {
    const root = resolve(staticDir);
    let rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    if (rel === '/' || rel === '') rel = '/index.html';
    let file = resolve(root, `.${rel}`);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(NOT_BUILT);
      return;
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': file.includes('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
    });
    createReadStream(file).pipe(res);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    res.setHeader('x-content-type-options', 'nosniff');
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
      api(req, res, url).catch((e: unknown) => {
        if (e instanceof HttpError)
          return sendJson(res, e.status, { error: e.code, message: e.message });
        if (e instanceof ManagerError) {
          const status =
            e.code === 'not-found'
              ? 404
              : e.code === 'invalid'
                ? 400
                : e.code === 'running' || e.code === 'stopped'
                  ? 409
                  : 422;
          return sendJson(res, status, { error: e.code, message: e.message });
        }
        log(`console error: ${(e as Error)?.stack ?? String(e)}`);
        return sendJson(res, 500, { error: 'internal', message: (e as Error)?.message ?? 'error' });
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(res, url.pathname);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${boundPort}/`;
  log(`console at ${url}${token ? ' (token required)' : ''}`);
  return {
    url,
    port: boundPort,
    host,
    async close() {
      unsubscribe();
      clearInterval(keepAlive);
      for (const res of Array.from(clients)) res.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
