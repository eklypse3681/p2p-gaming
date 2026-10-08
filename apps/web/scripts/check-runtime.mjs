// Checks the published table runtime after `vite build` (run by `pnpm build`):
//   1. every file in runtime/manifest.json exists and matches its hash;
//   2. the runtime is the app's own code: every file it needs, except its entry, is one the app
//      itself loads, and the entry holds nothing but re-exports;
//   3. it imports under Node (no DOM, no browser storage) and can host a table.
// A club loads exactly this set, so any failure here would mean the club runs something the
// players do not.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const fail = (msg) => {
  console.error(`check-runtime: ${msg}`);
  process.exit(1);
};

const runtime = JSON.parse(await readFile(join(dist, 'runtime/manifest.json'), 'utf8'));
const vite = JSON.parse(await readFile(join(dist, '.vite/manifest.json'), 'utf8'));

// 1. Hashes.
for (const f of runtime.files) {
  const code = await readFile(join(dist, f.path));
  const sha = createHash('sha256').update(code).digest('hex');
  if (sha !== f.sha256) fail(`${f.path} does not match its hash in the manifest`);
}

// 2. Same code as the app: walk the app's own import graph from index.html.
const byKey = new Map(Object.entries(vite));
const appFiles = new Set();
const walk = (key) => {
  const chunk = byKey.get(key);
  if (!chunk || appFiles.has(chunk.file)) return;
  appFiles.add(chunk.file);
  for (const k of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) walk(k);
};
walk('index.html');
for (const f of runtime.files) {
  if (f.path === runtime.entry) continue;
  if (!appFiles.has(f.path)) fail(`${f.path} is loaded by the runtime but not by the app`);
}
const entry = (await readFile(join(dist, runtime.entry), 'utf8')).trim();
if (!/^(import\{[^}]*\}from"[^"]+";)+export\{[^}]*\};?$/.test(entry.replace(/\s+/g, ''))) {
  fail(`${runtime.entry} should only re-export the app's chunks, but holds code of its own`);
}

// 3. Under Node: import it and host a table.
const rt = await import(pathToFileURL(join(dist, runtime.entry)).href);
for (const name of ['RUNTIME_API_VERSION', 'TableServer', 'GameServer', 'backgammonDefinition', 'ofcDefinition', 'peerJsProvider', 'memoryProvider']) {
  if (rt[name] === undefined) fail(`the runtime does not export ${name}`);
}
if (typeof rt.RUNTIME_API_VERSION !== 'number') fail('RUNTIME_API_VERSION is not a number');
const server = await rt.GameServer.create({
  code: 'CHECK1',
  host: { id: 'dealer', name: 'Dealer' },
  hostSeat: null,
});
if (server.getSnapshot().code !== 'CHECK1') fail('a table hosted by the runtime lost its code');
server.close();

console.log(
  `check-runtime: ok — runtime ${runtime.version} (API ${rt.RUNTIME_API_VERSION}), ${runtime.files.length} files, all loaded by the app too`,
);
