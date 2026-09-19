#!/usr/bin/env node
// Bundles the TypeScript sources on first use (esbuild, ~100 ms) so `pnpm exec dealer` works
// without a separate build step, then runs the CLI.
import { build } from 'esbuild';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const entry = join(pkg, 'src', 'run.ts');
const out = join(pkg, 'dist', 'dealer.mjs');

function newest(dir) {
  let t = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    t = Math.max(t, s.isDirectory() ? newest(p) : s.mtimeMs);
  }
  return t;
}

const packagesDir = join(pkg, '..');
const stale = !existsSync(out) || statSync(out).mtimeMs < newest(packagesDir) - 1;
if (stale || process.argv.includes('--build-only')) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: out,
    sourcemap: true,
    logLevel: 'silent',
    // Loaded at runtime from node_modules so the native WebRTC module stays a normal import.
    external: ['peerjs', 'node-datachannel', 'node-datachannel/polyfill'],
  });
}
if (process.argv.includes('--build-only')) process.exit(0);

const { main } = await import(pathToFileURL(out).href);
const code = await main(process.argv.slice(2));
process.exit(code);
