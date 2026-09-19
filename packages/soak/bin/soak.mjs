#!/usr/bin/env node
// Bundles the TypeScript sources on first use (esbuild) so `pnpm soak` needs no build step.
import { build } from 'esbuild';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');

// `--club` and `--lobby` soak a hosted club and the house lobby end to end. Both need the
// platform runtime, which is a separate private repository: this one holds the games, the
// table core, the club specification and its reference implementation. When the platform is
// checked out alongside (a workspace that includes both), its binary is used directly.
for (const [flag, command] of [
  ['--club', 'soak'],
  ['--lobby', 'lobby'],
]) {
  if (!process.argv.includes(flag)) continue;
  const { spawnSync } = await import('node:child_process');
  // Either laid out beside us in one workspace, or above us when this repository is checked
  // out as a submodule of the one that holds the platform.
  const platformBin = [
    join(pkg, '..', 'platform', 'bin', 'platform.mjs'),
    join(pkg, '..', '..', '..', 'packages', 'platform', 'bin', 'platform.mjs'),
  ].find((p) => existsSync(p));
  if (!platformBin) {
    console.error(
      `${flag} soaks a hosted club, which needs the platform runtime.\n` +
        'It is not part of this repository. Run this from a workspace that also has the\n' +
        'platform checked out, or use `pnpm soak --game ofc` / `--game backgammon`, which\n' +
        'soak the games themselves and need nothing else.',
    );
    process.exit(2);
  }
  const args = [command, ...process.argv.slice(2).filter((a) => a !== flag)];
  const r = spawnSync(process.execPath, [platformBin, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const entry = join(pkg, 'src', 'cli.ts');
const out = join(pkg, 'dist', 'soak.mjs');

function newest(dir) {
  let t = 0;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'dist-types') continue;
    const p = join(dir, name);
    const s = statSync(p);
    t = Math.max(t, s.isDirectory() ? newest(p) : s.mtimeMs);
  }
  return t;
}

const stale = !existsSync(out) || statSync(out).mtimeMs < newest(join(pkg, '..')) - 1;
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
    external: ['peerjs', 'node-datachannel', 'node-datachannel/polyfill'],
  });
}
if (process.argv.includes('--build-only')) process.exit(0);

const { main } = await import(pathToFileURL(out).href);
const code = await main(process.argv.slice(2));
process.exit(code);
