import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { CliArgs, HostArgs, ResumeArgs, ServeArgs } from './cli.js';
import { DealerManager } from './manager.js';
import { startConsoleServer } from './console-server.js';
import type { DealerGame } from './games.js';
import type { TransportProvider } from '@bgf/protocol';
import { memoryProvider } from '@bgf/protocol';
import { defaultTransportFor } from './dealer.js';
import { CliError, USAGE, parseArgs } from './cli.js';
import type { Dealer, DealerOptions } from './dealer.js';
import { createDealer } from './dealer.js';
import { describeTable } from './games.js';
import { clearStop, listTables, loadTable, requestStop, stopRequested } from './storage.js';

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Resolves when the process should stop (SIGINT/SIGTERM). Tests inject their own. */
  waitForSignal?: () => Promise<void>;
  /** Poll interval for `dealer stop` marker files. */
  stopPollMs?: number;
}

export async function loadRules(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new CliError(`could not parse rules file ${path}: ${(e as Error).message}`);
  }
}

function signalPromise(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

async function serve(dealer: Dealer, io: Io): Promise<void> {
  const stop = () => dealer.stop();
  dealer.onEvent((e) => {
    if (e.type === 'error') io.error(e.message);
  });
  await dealer.start();
  io.log(`Room code:    ${dealer.code}`);
  io.log(`Invite link:  ${dealer.inviteLink}`);
  io.log(`Table id:     ${dealer.tableId}`);
  io.log(`This terminal holds the table. Keep it running; Ctrl-C saves and stops.`);
  await clearStop(dealer.server.getSnapshot().id, dealer.tableId).catch(() => {});
  const pollMs = io.stopPollMs ?? 1000;
  const waitSignal = io.waitForSignal ?? signalPromise;
  await Promise.race([
    waitSignal(),
    (async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (await stopRequested(dealerData(dealer), dealer.tableId)) return;
      }
    })(),
  ]);
  io.log('stopping…');
  await stop();
  await clearStop(dealerData(dealer), dealer.tableId).catch(() => {});
  io.log(`saved ${dealer.describe()}`);
}

// The data dir is not part of the Dealer surface; keep it on a side table.
const dataDirs = new WeakMap<Dealer, string>();
function dealerData(dealer: Dealer): string {
  return dataDirs.get(dealer) ?? '';
}

async function runHost(args: HostArgs, io: Io): Promise<number> {
  const config = args.rules ? await loadRules(args.rules) : undefined;
  const options: DealerOptions = {
    game: args.game,
    config,
    seats: args.seats,
    code: args.code,
    dataDir: args.data,
    profile: { name: args.name },
    entropy: args.entropy
      ? { source: args.entropy, apiKey: args.apiKey, fallback: args.fallback }
      : undefined,
    dealerSeat: args.dealer,
    appUrl: args.appUrl,
    log: io.log,
  };
  const dealer = await createDealer(options);
  dataDirs.set(dealer, args.data);
  await serve(dealer, io);
  return 0;
}

async function runResume(args: ResumeArgs, io: Io): Promise<number> {
  const dealer = await createDealer({
    game: 'backgammon', // replaced by the saved table's game
    resume: args.target,
    dataDir: args.data,
    profile: { name: args.name },
    entropy: args.entropy
      ? { source: args.entropy, apiKey: args.apiKey, fallback: args.fallback }
      : undefined,
    appUrl: args.appUrl,
    log: io.log,
  });
  dataDirs.set(dealer, args.data);
  await serve(dealer, io);
  return 0;
}

/**
 * `P2P_DEALER_TRANSPORT=memory` swaps PeerJS for an in-process transport (console end-to-end
 * tests); everything else is unchanged.
 */
export function transportFactory(
  env: NodeJS.ProcessEnv = process.env,
): (game: DealerGame) => TransportProvider {
  if (env.P2P_DEALER_TRANSPORT === 'memory') {
    const shared = memoryProvider();
    return () => shared;
  }
  return defaultTransportFor;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    spawn(cmd[0]!, cmd.slice(1), { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* best effort */
  }
}

async function runServe(args: ServeArgs, io: Io): Promise<number> {
  const manager = await DealerManager.open({
    dataDir: args.data,
    transportFor: transportFactory(),
    log: io.log,
  });
  if (args.appUrl && args.appUrl !== manager.settings().appUrl && process.env.P2P_APP_URL) {
    await manager.updateSettings({ appUrl: args.appUrl });
  }
  const server = await startConsoleServer({
    manager,
    port: args.port,
    host: args.host,
    token: args.token,
    log: io.log,
  });
  io.log(`Dealer console: ${server.url}`);
  io.log(`Data:           ${args.data}`);
  io.log('Tables keep running while this process is up; Ctrl-C saves and stops.');
  if (args.resumeAll) {
    const resumed = await manager.resumeAll();
    if (resumed.length) io.log(`resumed ${resumed.length} table${resumed.length === 1 ? '' : 's'}`);
  }
  if (args.open) openBrowser(server.url);
  const waitSignal = io.waitForSignal ?? signalPromise;
  await waitSignal();
  io.log('stopping…');
  await manager.close();
  await server.close();
  return 0;
}

export async function main(argv: string[], io: Io = console): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.error(e instanceof CliError ? e.message : String(e));
    return 2;
  }
  try {
    switch (args.cmd) {
      case 'help':
        io.log(USAGE);
        return 0;
      case 'host':
        return await runHost(args, io);
      case 'resume':
        return await runResume(args, io);
      case 'serve':
        return await runServe(args, io);
      case 'list': {
        const tables = await listTables(args.data);
        if (tables.length === 0) {
          io.log('no saved tables');
          return 0;
        }
        for (const t of tables) {
          io.log(`${t.snapshot.id}  ${describeTable(t.game, t.snapshot)}`);
        }
        return 0;
      }
      case 'status': {
        const record = await loadTable(args.data, args.target);
        if (!record) {
          io.error(`no saved table matches "${args.target}"`);
          return 1;
        }
        io.log(describeTable(record.game, record.snapshot));
        io.log(`saved ${new Date(record.savedAt).toISOString()}`);
        return 0;
      }
      case 'stop': {
        const record = await loadTable(args.data, args.target);
        if (!record) {
          io.error(`no saved table matches "${args.target}"`);
          return 1;
        }
        await requestStop(args.data, record.snapshot.id);
        io.log(
          `stop requested for ${record.snapshot.code}; a running dealer stops within a second`,
        );
        return 0;
      }
    }
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
