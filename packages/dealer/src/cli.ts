import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DealerGame } from './games.js';
import { DEALER_GAMES, isDealerGame } from './games.js';
import type { EntropySourceName } from './entropy.js';
import { isEntropySourceName } from './entropy.js';
import { DEFAULT_APP_URL } from './dealer.js';

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface HostArgs {
  cmd: 'host';
  game: DealerGame;
  rules?: string;
  seats?: number;
  code?: string;
  name: string;
  entropy?: EntropySourceName;
  apiKey?: string;
  fallback: boolean;
  /** Take no seat (default). `--dealer=false` makes the runtime occupy seat 0. */
  dealer: boolean;
  data: string;
  appUrl: string;
}
export interface ResumeArgs {
  cmd: 'resume';
  target: string;
  name: string;
  entropy?: EntropySourceName;
  apiKey?: string;
  fallback: boolean;
  data: string;
  appUrl: string;
}
export interface ServeArgs {
  cmd: 'serve';
  port: number;
  host: string;
  data: string;
  token?: string;
  open: boolean;
  resumeAll: boolean;
  appUrl: string;
}
export type CliArgs =
  | HostArgs
  | ResumeArgs
  | ServeArgs
  | { cmd: 'list'; data: string }
  | { cmd: 'status'; target: string; data: string }
  | { cmd: 'stop'; target: string; data: string }
  | { cmd: 'help' };

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.P2P_DEALER_DATA ?? join(homedir(), '.p2p-dealer');
}

export const USAGE = `dealer — host a P2P Gaming table from a terminal

Usage:
  dealer host --game <backgammon|ofc> [--rules rules.json] [--seats N] [--code ABC123]
              [--name Dealer] [--entropy crypto|random.org|drand] [--api-key KEY] [--fallback]
              [--data DIR] [--app-url URL] [--dealer=false]
  dealer resume <id|code> [--entropy …] [--api-key KEY] [--data DIR] [--app-url URL]
  dealer serve [--port 7777] [--host 127.0.0.1] [--token T] [--open] [--resume-all] [--data DIR]
  dealer list [--data DIR]
  dealer status <id|code> [--data DIR]
  dealer stop <id|code> [--data DIR]

Data lives in ${defaultDataDir()} (override with --data or P2P_DEALER_DATA).
random.org keys may also come from RANDOM_ORG_API_KEY.`;

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

function tokenize(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return { positional, flags };
}

function str(flags: Parsed['flags'], key: string): string | undefined {
  const v = flags.get(key);
  if (v === undefined) return undefined;
  if (v === true) throw new CliError(`--${key} needs a value`);
  return v;
}

function bool(flags: Parsed['flags'], key: string): boolean {
  const v = flags.get(key);
  if (v === undefined) return false;
  if (v === true || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new CliError(`--${key} must be a boolean`);
}

function requireTarget(positional: string[], cmd: string): string {
  const target = positional[1];
  if (!target) throw new CliError(`dealer ${cmd} needs a table id or room code`);
  return target;
}

function known(flags: Parsed['flags'], allowed: string[]): void {
  for (const key of flags.keys()) {
    if (!allowed.includes(key)) throw new CliError(`unknown option --${key}`);
  }
}

const COMMON = ['data', 'app-url', 'entropy', 'api-key', 'fallback', 'name'];

/** Pure argument parser; throws `CliError` with a user-facing message. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const { positional, flags } = tokenize(argv);
  const cmd = positional[0];
  if (!cmd || cmd === 'help' || flags.has('help')) return { cmd: 'help' };
  const data = str(flags, 'data') ?? defaultDataDir(env);
  const appUrl = str(flags, 'app-url') ?? env.P2P_APP_URL ?? DEFAULT_APP_URL;
  const entropyRaw = str(flags, 'entropy');
  if (entropyRaw !== undefined && !isEntropySourceName(entropyRaw)) {
    throw new CliError(`--entropy must be one of crypto, random.org, drand (got "${entropyRaw}")`);
  }
  const entropy = entropyRaw as EntropySourceName | undefined;
  const apiKey = str(flags, 'api-key') ?? env.RANDOM_ORG_API_KEY;
  const fallback = bool(flags, 'fallback');
  const name = str(flags, 'name') ?? 'Dealer';

  switch (cmd) {
    case 'host': {
      known(flags, [...COMMON, 'game', 'rules', 'seats', 'code', 'dealer']);
      const game = str(flags, 'game');
      if (!game) throw new CliError(`--game is required (${DEALER_GAMES.join(' | ')})`);
      if (!isDealerGame(game)) {
        throw new CliError(`unknown game "${game}" (${DEALER_GAMES.join(' | ')})`);
      }
      const seatsRaw = str(flags, 'seats');
      let seats: number | undefined;
      if (seatsRaw !== undefined) {
        seats = Number(seatsRaw);
        if (!Number.isInteger(seats) || seats < 2 || seats > 8) {
          throw new CliError(`--seats must be an integer between 2 and 8`);
        }
      }
      const code = str(flags, 'code');
      if (code !== undefined && !/^[A-Za-z0-9]{4,12}$/.test(code)) {
        throw new CliError('--code must be 4–12 letters or digits');
      }
      return {
        cmd: 'host',
        game,
        rules: str(flags, 'rules'),
        seats,
        code: code?.toUpperCase(),
        name,
        entropy,
        apiKey,
        fallback,
        dealer: flags.has('dealer') ? bool(flags, 'dealer') : true,
        data,
        appUrl,
      };
    }
    case 'resume':
      known(flags, COMMON);
      return {
        cmd: 'resume',
        target: requireTarget(positional, 'resume'),
        name,
        entropy,
        apiKey,
        fallback,
        data,
        appUrl,
      };
    case 'serve': {
      known(flags, ['data', 'app-url', 'port', 'host', 'token', 'open', 'resume-all']);
      const portRaw = str(flags, 'port');
      const port = portRaw === undefined ? 7777 : Number(portRaw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new CliError('--port must be an integer between 0 and 65535');
      }
      return {
        cmd: 'serve',
        port,
        host: str(flags, 'host') ?? '127.0.0.1',
        data,
        token: str(flags, 'token') ?? env.P2P_DEALER_TOKEN,
        open: bool(flags, 'open'),
        resumeAll: bool(flags, 'resume-all'),
        appUrl,
      };
    }
    case 'list':
      known(flags, ['data']);
      return { cmd: 'list', data };
    case 'status':
      known(flags, ['data']);
      return { cmd: 'status', target: requireTarget(positional, 'status'), data };
    case 'stop':
      known(flags, ['data']);
      return { cmd: 'stop', target: requireTarget(positional, 'stop'), data };
    default:
      throw new CliError(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}
