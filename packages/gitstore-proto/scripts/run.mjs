// Bundle a TypeScript entry with esbuild (workspace packages use .js-suffixed imports that Node's
// type stripping cannot resolve) and run it. The bundle is written inside this package so native
// dependencies (DuckDB bindings) resolve from its node_modules at runtime.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
const [entry, ...rest] = process.argv.slice(2);
if (!entry) throw new Error('usage: node scripts/run.mjs <entry.ts> [args]');
const pkg = resolve(import.meta.dirname, '..');
const outDir = join(pkg, '.run');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `entry-${process.pid}.mjs`);
const esbuild = resolve(pkg, '../../node_modules/.bin/esbuild');
execFileSync(
  esbuild,
  [entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`, '--external:node-datachannel', '--external:peerjs', '--external:@duckdb/*', '--log-level=error'],
  { stdio: 'inherit' },
);
const r = spawnSync(process.execPath, [out, ...rest], { stdio: 'inherit' });
rmSync(out, { force: true });
process.exit(r.status ?? 1);
