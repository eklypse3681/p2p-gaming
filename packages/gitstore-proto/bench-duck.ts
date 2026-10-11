/**
 * History tier: Parquet via DuckDB, hot append logs, sealing cost, and analytical queries.
 *   node scripts/run.mjs bench-duck.ts [--hands 10000] [--games 3000] [--json out.json]
 */
import { DuckDBInstance } from '@duckdb/node-api';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { zstdCompressSync, constants as zc } from 'node:zlib';
import { binary, shortJson, type AnyRecord } from './src/record.ts';
import { bgGames, ofcHands } from './src/play.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '1');
const HANDS = Number(args.get('hands') ?? 10_000);
const GAMES = Number(args.get('games') ?? 3_000);
const JSON_OUT = args.get('json');
const root = mkdtempSync(join(tmpdir(), 'duck-'));
const results: Record<string, unknown> = {};

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}
function dirBytes(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return total;
}
function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function memberName(club: string, seat: number): string {
  return `${club}-member-${seat}`;
}
/** NDJSON row for DuckDB's JSON reader: blobs as base64, hashes as hex. */
function ndRow(r: AnyRecord, clubOf: (r: AnyRecord) => string): string {
  const club = clubOf(r);
  const base = {
    club,
    tbl: r.t,
    hand_no: r.n,
    game: r.g,
    seats: r.g === 'ofc' ? r.deals.length : 2,
    s0: r.s0,
    s1: r.s1,
    ph: r.ph === 'genesis' ? '00'.repeat(32) : r.ph,
    seed: r.seed ?? null,
    started_at: r.at[0],
    ended_at: r.at[1],
    day: dayOf(r.at[0]),
    members: Array.from({ length: r.g === 'ofc' ? r.deals.length : 2 }, (_, i) =>
      memberName(club, i),
    ),
    payload: binary(r, true).toString('base64'),
    rake: r.g === 'ofc' ? r.res.rake : Math.ceil(r.res.points * 0.02),
    points:
      r.g === 'ofc'
        ? r.res.pts
        : [
            r.res.winner ? -r.res.points : r.res.points,
            r.res.winner ? r.res.points : -r.res.points,
          ],
    transfers: r.res.tr.map(([from, to, points]) => ({ from, to, points })),
  };
  return JSON.stringify(base);
}

async function main() {
  const t0 = performance.now();
  const p27 = ofcHands({ variant: 'pineapple27', seats: 3, hands: HANDS, seed: 11, play: 'quick' });
  const bg = bgGames({ games: GAMES, seed: 15 });
  // Spread hands across 10 clubs and ~14 days so partitioning is meaningful.
  const clubOf = (r: AnyRecord) => `club${r.n % 10}`;
  const spread = (rs: AnyRecord[]) =>
    rs.map((r, i) => ({
      ...r,
      at: [
        1_789_257_600_000 + Math.floor(i / (rs.length / 14)) * 86_400_000 + (i % 100) * 60_000,
        1_789_257_600_000 +
          Math.floor(i / (rs.length / 14)) * 86_400_000 +
          (i % 100) * 60_000 +
          240_000,
      ] as [number, number],
    }));
  const hands = spread(p27);
  const games = spread(bg);
  console.log(
    `generated ${hands.length} hands + ${games.length} games in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );

  // ---- hot append paths ----------------------------------------------------------------------
  const appendResults: Record<string, unknown> = {};
  for (const [name, encode] of [
    ['jsonl', (r: AnyRecord) => Buffer.from(shortJson(r) + '\n')],
    [
      'jsonl+zstd frame',
      (r: AnyRecord) => {
        const z = zstdCompressSync(Buffer.from(shortJson(r) + '\n'), {
          params: { [zc.ZSTD_c_compressionLevel]: 3 },
        });
        const len = Buffer.alloc(4);
        len.writeUInt32BE(z.length);
        return Buffer.concat([len, z]);
      },
    ],
    [
      'binary length-prefixed',
      (r: AnyRecord) => {
        const b = binary(r, true);
        const len = Buffer.alloc(2);
        len.writeUInt16BE(b.length);
        return Buffer.concat([len, b]);
      },
    ],
  ] as const) {
    const file = join(root, `log-${name.replace(/\W+/g, '_')}.bin`);
    const fd = openSync(file, 'a');
    const lat: number[] = [];
    const latNoSync: number[] = [];
    const t = performance.now();
    for (const r of hands.slice(0, 2000)) {
      const buf = encode(r);
      const a = performance.now();
      writeSync(fd, buf);
      const b = performance.now();
      fsyncSync(fd);
      lat.push(performance.now() - a);
      latNoSync.push(b - a);
    }
    closeSync(fd);
    appendResults[name] = {
      n: 2000,
      bytesPerHand: Math.round(statSync(file).size / 2000),
      appendFsync: { p50: pct(lat, 50), p95: pct(lat, 95) },
      appendNoFsync: { p50: pct(latNoSync, 50), p95: pct(latNoSync, 95) },
      totalMs: performance.now() - t,
    };
  }
  results['append'] = appendResults;
  console.table(appendResults);

  // ---- DuckDB: load, Parquet sizes, partitioned write, sealing cost, queries -------------------
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  const nd = join(root, 'hands.ndjson');
  writeFileSync(nd, hands.map((r) => ndRow(r, clubOf)).join('\n') + '\n');
  const ndBg = join(root, 'games.ndjson');
  writeFileSync(ndBg, games.map((r) => ndRow(r, clubOf)).join('\n') + '\n');
  const load = async (table: string, file: string) => {
    const t = performance.now();
    await conn.run(
      `CREATE OR REPLACE TABLE ${table} AS SELECT club, tbl, hand_no::INTEGER AS hand_no, game, seats::TINYINT AS seats, unhex(s0) AS s0, unhex(s1) AS s1, unhex(ph) AS ph, seed, started_at::BIGINT AS started_at, ended_at::BIGINT AS ended_at, day::DATE AS day, members, from_base64(payload) AS payload, rake::INTEGER AS rake, points::INTEGER[] AS points, transfers FROM read_json('${file}', format='newline_delimited', columns={club:'VARCHAR', tbl:'VARCHAR', hand_no:'INTEGER', game:'VARCHAR', seats:'INTEGER', s0:'VARCHAR', s1:'VARCHAR', ph:'VARCHAR', seed:'VARCHAR', started_at:'BIGINT', ended_at:'BIGINT', day:'VARCHAR', members:'VARCHAR[]', payload:'VARCHAR', rake:'INTEGER', points:'INTEGER[]', transfers:'STRUCT(\"from\" INTEGER, \"to\" INTEGER, points INTEGER)[]'})`,
    );
    return performance.now() - t;
  };
  const loadHandsMs = await load('hands', nd);
  const loadGamesMs = await load('games', ndBg);
  const count = (await conn.runAndReadAll('SELECT count(*) FROM hands')).getRows()[0]![0];
  console.log(
    'loaded',
    count,
    'hands in',
    loadHandsMs.toFixed(0),
    'ms;',
    games.length,
    'games in',
    loadGamesMs.toFixed(0),
    'ms',
  );

  const parquet: Record<string, unknown> = {};
  for (const [table, n] of [
    ['hands', hands.length],
    ['games', games.length],
  ] as const) {
    for (const rg of [10_000, 100_000]) {
      for (const [variant, select] of [
        ['full', '*'],
        [
          'no-hashes',
          'club, tbl, hand_no, game, seats, seed, started_at, ended_at, day, members, payload, rake, points, transfers',
        ],
      ] as const) {
        const file = join(root, `${table}-${variant}-rg${rg}.parquet`);
        const t = performance.now();
        await conn.run(
          `COPY (SELECT ${select} FROM ${table}) TO '${file}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${rg})`,
        );
        const ms = performance.now() - t;
        const bytes = statSync(file).size;
        parquet[`${table} ${variant} rg=${rg}`] = {
          rows: n,
          bytes,
          perRow: Math.round(bytes / n),
          writeMs: Math.round(ms),
        };
      }
    }
  }
  results['parquet'] = parquet;
  console.table(parquet);

  // Column-level breakdown for the hands table (Parquet metadata).
  const meta = await conn.runAndReadAll(
    `SELECT path_in_schema AS col, sum(total_compressed_size) AS compressed, sum(total_uncompressed_size) AS raw FROM parquet_metadata('${join(root, 'hands-full-rg10000.parquet')}') GROUP BY 1 ORDER BY 2 DESC`,
  );
  const cols = meta
    .getRows()
    .map((r) => ({
      col: String(r[0]),
      compressedPerRow: Math.round(Number(r[1]) / hands.length),
      rawPerRow: Math.round(Number(r[2]) / hands.length),
    }));
  results['handsColumns'] = cols;
  console.table(cols);

  // Partitioned lake layout: club=<id>/day=<date>/*.parquet
  const lake = join(root, 'lake');
  mkdirSync(lake);
  const tp = performance.now();
  await conn.run(
    `COPY hands TO '${lake}' (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (club, day), OVERWRITE_OR_IGNORE)`,
  );
  const partitionMs = performance.now() - tp;
  const files = (
    await conn.runAndReadAll(`SELECT count(*) FROM glob('${lake}/**/*.parquet')`)
  ).getRows()[0]![0];
  results['lake'] = {
    files: Number(files),
    bytes: dirBytes(lake),
    perRow: Math.round(dirBytes(lake) / hands.length),
    writeMs: Math.round(partitionMs),
  };
  console.log('lake', JSON.stringify(results['lake']));

  // Sealing cost: JSONL log → Parquet for 1k and 10k hands (fresh table each time).
  const seal: Record<string, unknown> = {};
  for (const n of [1000, 10000]) {
    const file = join(root, `seal-${n}.ndjson`);
    writeFileSync(
      file,
      hands
        .slice(0, n)
        .map((r) => ndRow(r, clubOf))
        .join('\n') + '\n',
    );
    const t = performance.now();
    await conn.run(
      `CREATE OR REPLACE TABLE seal AS SELECT * FROM read_json('${file}', format='newline_delimited', columns={club:'VARCHAR', tbl:'VARCHAR', hand_no:'INTEGER', game:'VARCHAR', seats:'INTEGER', s0:'VARCHAR', s1:'VARCHAR', ph:'VARCHAR', seed:'VARCHAR', started_at:'BIGINT', ended_at:'BIGINT', day:'VARCHAR', members:'VARCHAR[]', payload:'VARCHAR', rake:'INTEGER', points:'INTEGER[]', transfers:'STRUCT(\"from\" INTEGER, \"to\" INTEGER, points INTEGER)[]'})`,
    );
    await conn.run(
      `COPY (SELECT club, tbl, hand_no, game, seats, unhex(s0) s0, unhex(s1) s1, unhex(ph) ph, seed, started_at, ended_at, "day"::DATE AS "day", members, from_base64(payload) AS payload, rake, points, transfers FROM seal) TO '${join(root, `seal-${n}.parquet`)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    seal[`seal ${n} hands`] = {
      ms: Math.round(performance.now() - t),
      parquetBytes: statSync(join(root, `seal-${n}.parquet`)).size,
    };
  }
  results['seal'] = seal;
  console.table(seal);

  // Queries over the sealed lake (hive partitioning), median of 5 runs after a warm-up.
  const q = async (name: string, sql: string) => {
    await conn.runAndReadAll(sql);
    const times: number[] = [];
    let rows = 0;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const r = await conn.runAndReadAll(sql);
      times.push(performance.now() - t);
      rows = r.getRows().length;
    }
    return { name, rows, medianMs: Number(pct(times, 50).toFixed(2)) };
  };
  const src = `read_parquet('${lake}/**/*.parquet', hive_partitioning=true)`;
  const queries = [
    await q(
      'hands by member (club3-member-1)',
      `SELECT club, count(*) AS hands, sum(points[2]) AS net FROM ${src} WHERE list_contains(members, 'club3-member-1') GROUP BY club`,
    ),
    await q(
      'rake by club by day',
      `SELECT club, day, sum(rake) AS rake, count(*) AS hands FROM ${src} GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
    await q(
      'one table, last 50 hands',
      `SELECT hand_no, started_at, rake FROM ${src} WHERE club = 'club7' AND tbl = 't1' ORDER BY hand_no DESC LIMIT 50`,
    ),
    await q(
      'single day, all clubs, totals',
      `SELECT count(*), sum(rake) FROM ${src} WHERE day = DATE '2026-09-20'`,
    ),
  ];
  results['queries'] = queries;
  console.table(queries);

  // Arrow IPC availability (needs the arrow extension; may be unavailable offline).
  try {
    await conn.run(
      `COPY (SELECT * FROM hands LIMIT 1000) TO '${join(root, 'hands.arrows')}' (FORMAT ARROWS)`,
    );
    results['arrow'] = { available: true, bytesPer1000: statSync(join(root, 'hands.arrows')).size };
  } catch (e) {
    results['arrow'] = {
      available: false,
      error: String((e as Error).message)
        .split('\n')[0]
        ?.slice(0, 160),
    };
  }
  console.log('arrow', JSON.stringify(results['arrow']));

  conn.closeSync();
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  rmSync(root, { recursive: true, force: true });
}
main().catch((e) => {
  console.error(e);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
