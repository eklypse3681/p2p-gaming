import type { SoakOptions } from './run.js';
import { formatReport, runSoak } from './run.js';

export interface ParsedArgs {
  options: SoakOptions;
  json: boolean;
  help: boolean;
}

const USAGE = `soak — play many hands/games with bots through the real table server

  pnpm soak --game ofc --variant pineapple27 --seats 3 --hands 200
  pnpm soak --game backgammon --games 50
  pnpm soak --game ofc --provider peerjs --code ABC123 --dealer runtime   # join a running table
  pnpm soak --club --members 3 --hands 50 [--variant pineapple27] [--json]  # hosted club soak (needs the platform runtime)
  pnpm soak --lobby --members 12 --minutes 2 [--rounds 4] [--games ofc,backgammon] [--json]  # the house lobby, end to end (needs the platform runtime)

options
  --game ofc|backgammon      (required)
  --variant ofc|pineapple|pineapple27
  --seats N                  OFC 2..3 (default 3), backgammon 2
  --hands N | --games N      target (defaults 100 / 20)
  --provider memory|peerjs   transport (default memory)
  --dealer inline|runtime    host a dealer-mode table here (default) or join --code
  --code ABC123              room code (random when inline)
  --entropy crypto|random.org|drand  --api-key KEY
  --randomness per-draw|seeded|beacon
  --seed N                   deterministic bots (and table randomness with crypto entropy)
  --timeout MS
  --json                     machine-readable report
`;

export function parseArgs(argv: string[]): ParsedArgs {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'json' || key === 'help') {
      o[key] = true;
      continue;
    }
    if (next === undefined || next.startsWith('--')) throw new Error(`--${key} needs a value`);
    o[key] = next;
    i++;
  }
  if (o.help) return { options: { game: 'ofc' }, json: false, help: true };
  const game = o.game;
  if (game !== 'ofc' && game !== 'backgammon') throw new Error('--game must be ofc or backgammon');
  const num = (k: string): number | undefined => {
    const v = o[k];
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${k} must be a positive number`);
    return n;
  };
  const oneOf = <T extends string>(k: string, values: readonly T[]): T | undefined => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (!values.includes(v as T)) throw new Error(`--${k} must be one of ${values.join('|')}`);
    return v as T;
  };
  const options: SoakOptions = {
    game,
    variant: oneOf('variant', ['ofc', 'pineapple', 'pineapple27'] as const),
    seats: num('seats'),
    hands: num('hands'),
    games: num('games'),
    provider: oneOf('provider', ['memory', 'peerjs'] as const),
    dealer: oneOf('dealer', ['inline', 'runtime'] as const),
    code: typeof o.code === 'string' ? o.code.toUpperCase() : undefined,
    entropy: oneOf('entropy', ['crypto', 'random.org', 'drand'] as const),
    apiKey: typeof o['api-key'] === 'string' ? o['api-key'] : process.env.RANDOM_ORG_API_KEY,
    randomness: oneOf('randomness', ['per-draw', 'seeded', 'beacon'] as const),
    seed: num('seed'),
    timeoutMs: num('timeout'),
  };
  if (options.dealer === 'runtime' && !options.code)
    throw new Error('--dealer runtime needs --code');
  if (options.game === 'backgammon' && options.seats !== undefined && options.seats !== 2)
    throw new Error('backgammon has two seats');
  return { options, json: !!o.json, help: false };
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(String((e as Error).message));
    console.error(USAGE);
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  let lastShown = -1;
  const report = await runSoak({
    ...parsed.options,
    onProgress: parsed.json
      ? undefined
      : ({ completed, target }) => {
          if (
            completed === target ||
            completed - lastShown >= Math.max(1, Math.floor(target / 10))
          ) {
            lastShown = completed;
            process.stderr.write(`\r${completed}/${target}`);
          }
        },
  });
  if (!parsed.json) process.stderr.write('\n');
  console.log(parsed.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}
