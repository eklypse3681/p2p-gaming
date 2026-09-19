/**
 * Bytes per hand: encodings, compression, and effective size inside a git pack.
 *   node scripts/run.mjs bench-sizes.ts [--hands 10000] [--smart 300] [--games 3000] [--json out.json]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { git } from './src/gitstore.ts';
import {
  binary,
  chunkSizes,
  shortJson,
  sizes,
  verboseJson,
  type AnyRecord,
  type SizeRow,
} from './src/record.ts';
import { bgGames, ofcHands } from './src/play.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '1');
const HANDS = Number(args.get('hands') ?? 10_000);
const SMART = Number(args.get('smart') ?? 300);
const GAMES = Number(args.get('games') ?? 3_000);
const JSON_OUT = args.get('json');
const root = mkdtempSync(join(tmpdir(), 'gitsizes-'));

function avg(rows: SizeRow[]): SizeRow {
  const keys = Object.keys(rows[0]!) as Array<keyof SizeRow>;
  const out = {} as SizeRow;
  for (const k of keys) out[k] = Math.round(rows.reduce((a, r) => a + r[k], 0) / rows.length);
  return out;
}
function packBytes(dir: string): number {
  const c = Object.fromEntries(
    git(['count-objects', '-v'], { cwd: dir })
      .split('\n')
      .map((l) => l.split(': '))
      .map(([k, v]) => [k, Number(v)]),
  );
  return (c['size-pack'] ?? 0) * 1024;
}

/**
 * Store `records` in a bare repo as blobs referenced by one tree (so gc keeps them), either one
 * blob per record or one blob per chunk of K records, then measure the pack after aggressive gc.
 * Returns effective bytes per record (pack bytes / records).
 */
function packPerRecord(
  records: AnyRecord[],
  mode: 'json' | 'bin',
  chunk: number,
): { perRecord: number; packBytes: number; treeBytes: number; gcMs: number } {
  const dir = join(
    root,
    `pack-${mode}-${chunk}-${records.length}-${Math.random().toString(36).slice(2, 6)}`,
  );
  git(['init', '-q', '--bare', dir], { cwd: root });
  git(['config', 'gc.auto', '0'], { cwd: dir });
  // fast-import stream: blobs with marks, then one commit whose tree references them.
  const parts: Buffer[] = [];
  let mark = 1;
  const files: string[] = [];
  const pushBlob = (data: Buffer, path: string) => {
    parts.push(Buffer.from(`blob\nmark :${mark}\ndata ${data.length}\n`), data, Buffer.from('\n'));
    files.push(`M 100644 :${mark} ${path}\n`);
    mark++;
  };
  if (chunk <= 1) {
    for (const r of records) {
      const path = `hands/${String(r.n).padStart(7, '0')}.${mode === 'json' ? 'json' : 'bin'}`;
      pushBlob(mode === 'json' ? Buffer.from(shortJson(r)) : binary(r), path);
    }
  } else {
    for (let i = 0; i < records.length; i += chunk) {
      const slice = records.slice(i, i + chunk);
      const data =
        mode === 'json'
          ? Buffer.from(slice.map(shortJson).join('\n') + '\n')
          : Buffer.concat(
              slice.map((r) => {
                const b = binary(r, true);
                const len = Buffer.alloc(2);
                len.writeUInt16BE(b.length);
                return Buffer.concat([len, b]);
              }),
            );
      pushBlob(
        data,
        `chunks/${String(i / chunk).padStart(6, '0')}.${mode === 'json' ? 'ndjson' : 'bin'}`,
      );
    }
  }
  const msg = 'records';
  parts.push(
    Buffer.from(
      `commit refs/heads/main\ncommitter p2p <p@p> 1789257600 +0000\ndata ${msg.length}\n${msg}\n${files.join('')}\n`,
    ),
  );
  git(['fast-import', '--quiet'], { cwd: dir, input: Buffer.concat(parts) });
  const t = performance.now();
  git(['gc', '-q', '--aggressive', '--prune=now'], { cwd: dir });
  const gcMs = performance.now() - t;
  const tree = git(['rev-parse', 'main^{tree}'], { cwd: dir });
  const treeBytes = Number(git(['cat-file', '-s', tree], { cwd: dir }));
  const pb = packBytes(dir);
  return { perRecord: Math.round(pb / records.length), packBytes: pb, treeBytes, gcMs };
}

async function main() {
  const results: Record<string, unknown> = {};
  const t0 = performance.now();
  const p27 = ofcHands({ variant: 'pineapple27', seats: 3, hands: HANDS, seed: 11, play: 'quick' });
  const pin = ofcHands({
    variant: 'pineapple',
    seats: 3,
    hands: Math.min(HANDS, 2000),
    seed: 12,
    play: 'quick',
  });
  const classic = ofcHands({
    variant: 'ofc',
    seats: 3,
    hands: Math.min(HANDS, 2000),
    seed: 13,
    play: 'quick',
  });
  const smart = ofcHands({
    variant: 'pineapple27',
    seats: 3,
    hands: SMART,
    seed: 14,
    play: 'smart',
  });
  const seeded = p27.slice(0, 500).map((r) => ({ ...r, seed: 'a'.repeat(64) }));
  const bg = bgGames({ games: GAMES, seed: 15 });
  const genMs = performance.now() - t0;
  console.log(
    `generated ${p27.length} p27 + ${pin.length} pineapple + ${classic.length} classic + ${smart.length} smart + ${bg.length} bg games in ${(genMs / 1000).toFixed(1)} s`,
  );

  const perRecord: Record<string, SizeRow> = {
    'OFC Pineapple 2-7 (3 seats, quick)': avg(p27.slice(0, 500).map(sizes)),
    'OFC Pineapple 2-7 (3 seats, smart bot)': avg(smart.map(sizes)),
    'OFC Pineapple (3 seats)': avg(pin.slice(0, 500).map(sizes)),
    'OFC classic (3 seats)': avg(classic.slice(0, 500).map(sizes)),
    'OFC Pineapple 2-7 + 32-byte seed': avg(seeded.map(sizes)),
    'Backgammon game (2 seats)': avg(bg.slice(0, 500).map(sizes)),
  };
  results['perRecord'] = perRecord;
  console.table(perRecord);
  const actsPerBg = bg.reduce((a, r) => a + r.acts.length, 0) / bg.length;
  results['bgActionsPerGame'] = actsPerBg;
  console.log(
    'backgammon actions per game (avg)',
    actsPerBg.toFixed(1),
    '| verbose sample bytes',
    verboseJson(bg[0]!).length,
  );

  const chunks: Record<string, unknown> = {};
  for (const [name, rs] of [
    ['OFC 2-7', p27],
    ['Backgammon', bg],
  ] as const) {
    for (const k of [100, 1000]) {
      const c = chunkSizes(rs.slice(0, k));
      chunks[`${name} chunk ${k}`] = Object.fromEntries(
        Object.entries(c).map(([kk, v]) => [kk + '/rec', Math.round(v / k)]),
      );
    }
  }
  results['chunkPerRecord'] = chunks;
  console.table(chunks);

  const pack: Record<string, unknown> = {};
  for (const [name, rs] of [
    ['OFC 2-7', p27],
    ['Backgammon', bg],
  ] as const) {
    for (const mode of ['json', 'bin'] as const) {
      for (const k of [1, 100, 1000]) {
        const r = packPerRecord(rs, mode, k);
        pack[`${name} ${mode} ×${k === 1 ? 'blob/record' : k + '/blob'} (n=${rs.length})`] = r;
        console.log(name, mode, k, JSON.stringify(r));
      }
    }
  }
  results['pack'] = pack;
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  rmSync(root, { recursive: true, force: true });
}
main().catch((e) => {
  console.error(e);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
