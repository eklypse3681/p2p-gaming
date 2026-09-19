import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PlayerProfile,
  RandomnessMode,
  TableSnapshot,
  TransportProvider,
} from '@bgf/protocol';
import { signerFor } from '@bgf/protocol';
import { TableClient, viewSnapshot } from '@bgf/table';
import type { TableConfig, TableState } from '@bgf/ofc-engine';
import {
  RULES_PRESETS,
  balances,
  describeRules,
  settlementPlan,
  unsettledBalances,
  validateTableConfig,
} from '@bgf/ofc-engine';
import type { Dealer, DealerEvent } from './dealer.js';
import { createDealer, defaultTransportFor, inviteLinkFor } from './dealer.js';
import type { DealerEntropyOptions, EntropySourceName } from './entropy.js';
import { isEntropySourceName } from './entropy.js';
import type { DealerGame } from './games.js';
import { definitionFor, isDealerGame } from './games.js';
import type { DealerProfile } from './profile.js';
import { loadOrCreateProfile, publicProfile } from './profile.js';
import type { DealerSettings } from './settings.js';
import { isRandomnessMode, loadSettings, saveSettings } from './settings.js';
import { deleteTable, listTables, loadTable } from './storage.js';

// ------------------------------------------------------------------------------- registry

export type TableStatus = 'running' | 'stopped';

/** Bookkeeping the runtime keeps about each table it has hosted (`<dataDir>/tables.json`). */
export interface RegistryEntry {
  id: string;
  code: string;
  game: DealerGame;
  /** Optional label shown in the console. */
  name: string;
  status: TableStatus;
  createdAt: number;
  updatedAt: number;
  seats: number;
}

export const REGISTRY_FILE = 'tables.json';
export const RULESETS_DIR = 'rulesets';

async function readRegistry(dataDir: string): Promise<Record<string, RegistryEntry>> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, REGISTRY_FILE), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, RegistryEntry> = {};
    for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const e = raw as Partial<RegistryEntry>;
      if (typeof e.code !== 'string' || !isDealerGame(e.game)) continue;
      out[id] = {
        id,
        code: e.code,
        game: e.game,
        name: typeof e.name === 'string' ? e.name : '',
        status: e.status === 'running' ? 'running' : 'stopped',
        createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
        updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
        seats: typeof e.seats === 'number' ? e.seats : 2,
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function writeRegistry(
  dataDir: string,
  registry: Record<string, RegistryEntry>,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, REGISTRY_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(registry, null, 2));
  await rename(tmp, path);
}

// --------------------------------------------------------------------------------- shapes

export interface SeatInfo {
  seat: number;
  name: string | null;
  connected: boolean;
  /** Live device count for the seat (0 when the table is stopped). */
  devices: number;
}

export interface TableInfo extends RegistryEntry {
  inviteLink: string;
  seatsInfo: SeatInfo[];
  occupied: number;
  seq: number;
  summary: unknown;
  /** Short human line, e.g. the OFC rules summary or the backgammon match length. */
  rules: string;
  randomness: { mode: RandomnessMode; provider: string } | null;
  dealer: PlayerProfile | null;
  /** Unattended play: whether the table acts on its own and what it has scheduled. */
  autopilot: { enabled: boolean; pending?: { reason: string; at: number } } | null;
  /** Readiness by seat (table flow). */
  ready: boolean[];
}

export interface ManagerEvent {
  seq: number;
  at: number;
  table?: string;
  type: string;
  message: string;
  data?: unknown;
}

export interface CreateTableOptions {
  game: DealerGame;
  /** Game config (OFC `TableConfig` partial or backgammon `MatchConfig` partial). */
  config?: unknown;
  seats?: number;
  name?: string;
  code?: string;
  entropy?: EntropySourceName;
  randomness?: RandomnessMode;
  fallback?: boolean;
  /** Table-level options (e.g. backgammon `homeSide`). */
  options?: Record<string, unknown>;
}

export interface ManagerOptions {
  dataDir: string;
  /** Transport per game; default PeerJS on the free cloud (`memoryProvider()` in tests). */
  transportFor?: (game: DealerGame) => TransportProvider;
  log?: (line: string) => void;
  now?: () => number;
  /** Ring-buffer size for events. */
  eventLimit?: number;
}

export class ManagerError extends Error {
  constructor(
    public readonly code: 'not-found' | 'running' | 'stopped' | 'invalid' | 'refused',
    message: string,
  ) {
    super(message);
    this.name = 'ManagerError';
  }
}

interface Running {
  dealer: Dealer;
  /** The dealer's own client, used for dealer-only commands (OFC start / settle / adjust). */
  client: TableClient<unknown, unknown, unknown, unknown>;
  unsubscribe: () => void;
}

/**
 * One process, many tables. Wraps `createDealer` with a persisted registry, settings, an event
 * feed and dealer-command access, and is what the HTTP console drives.
 */
export class DealerManager {
  readonly dataDir: string;
  private readonly transportFor: (game: DealerGame) => TransportProvider;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly eventLimit: number;
  private settingsCache: DealerSettings;
  private registry: Record<string, RegistryEntry> = {};
  private running = new Map<string, Running>();
  private events: ManagerEvent[] = [];
  private eventSeq = 0;
  private listeners = new Set<(event: ManagerEvent) => void>();
  private profile: DealerProfile | null = null;

  private constructor(opts: ManagerOptions, settings: DealerSettings) {
    this.dataDir = opts.dataDir;
    this.transportFor = opts.transportFor ?? defaultTransportFor;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.eventLimit = opts.eventLimit ?? 500;
    this.settingsCache = settings;
  }

  static async open(opts: ManagerOptions): Promise<DealerManager> {
    const settings = await loadSettings(opts.dataDir);
    const m = new DealerManager(opts, settings);
    m.registry = await readRegistry(opts.dataDir);
    // Tables that exist on disk but were never registered (older CLI runs) show up as stopped.
    for (const record of await listTables(opts.dataDir)) {
      const id = record.snapshot.id;
      if (!m.registry[id]) {
        m.registry[id] = {
          id,
          code: record.snapshot.code,
          game: record.game,
          name: '',
          status: 'stopped',
          createdAt: record.snapshot.createdAt,
          updatedAt: record.snapshot.updatedAt,
          seats: record.snapshot.seats.length,
        };
      }
    }
    return m;
  }

  // ----------------------------------------------------------------------------- settings

  settings(): DealerSettings {
    return { ...this.settingsCache };
  }

  async updateSettings(patch: Partial<DealerSettings>): Promise<DealerSettings> {
    const { normalizeSettings } = await import('./settings.js');
    // A masked key coming back from the console means "keep the current one".
    const next = { ...patch } as Record<string, unknown>;
    if (typeof next.randomOrgApiKey === 'string' && next.randomOrgApiKey.startsWith('••••')) {
      delete next.randomOrgApiKey;
    }
    this.settingsCache = normalizeSettings({ ...this.settingsCache, ...next }, this.settingsCache);
    await saveSettings(this.dataDir, this.settingsCache);
    this.emit({ type: 'settings', message: 'settings updated' });
    return this.settings();
  }

  async dealerProfile(): Promise<PlayerProfile> {
    return publicProfile(await this.ensureProfile());
  }

  private async ensureProfile(): Promise<DealerProfile> {
    if (!this.profile) {
      this.profile = await loadOrCreateProfile(this.dataDir, this.settingsCache.dealerName);
    }
    return this.profile;
  }

  // ------------------------------------------------------------------------------- events

  private emit(event: Omit<ManagerEvent, 'seq' | 'at'>): void {
    const full: ManagerEvent = { seq: ++this.eventSeq, at: this.now(), ...event };
    this.events.push(full);
    if (this.events.length > this.eventLimit)
      this.events.splice(0, this.events.length - this.eventLimit);
    this.log(`${event.table ? `[${event.table.slice(0, 8)}] ` : ''}${event.message}`);
    for (const l of Array.from(this.listeners)) l(full);
  }

  recentEvents(limit = 100, table?: string): ManagerEvent[] {
    const all = table ? this.events.filter((e) => e.table === table) : this.events;
    return all.slice(-limit);
  }

  subscribe(listener: (event: ManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------------------------- tables

  private entropyFor(source: EntropySourceName, fallback = false): DealerEntropyOptions {
    return {
      source,
      apiKey: this.settingsCache.randomOrgApiKey || undefined,
      fallback,
    };
  }

  async create(opts: CreateTableOptions): Promise<TableInfo> {
    if (!isDealerGame(opts.game))
      throw new ManagerError('invalid', `unknown game ${String(opts.game)}`);
    const source = opts.entropy ?? this.settingsCache.defaultEntropy;
    if (!isEntropySourceName(source))
      throw new ManagerError('invalid', `unknown randomness source ${source}`);
    const mode = opts.randomness ?? this.settingsCache.defaultRandomness;
    if (!isRandomnessMode(mode))
      throw new ManagerError('invalid', `unknown randomness mode ${mode}`);
    if (mode === 'beacon' && source !== 'drand') {
      throw new ManagerError('invalid', 'beacon randomness needs the drand source');
    }
    if (source === 'random.org' && !this.settingsCache.randomOrgApiKey) {
      throw new ManagerError('invalid', 'random.org needs an API key (Settings)');
    }
    let config = opts.config;
    if (opts.game === 'ofc' && config !== undefined) {
      const checked = validateTableConfig(config);
      if (!checked.ok) throw new ManagerError('invalid', checked.errors.join('; '));
      config = checked.config;
    }
    await this.ensureProfile();
    let dealer: Dealer;
    try {
      dealer = await createDealer({
        game: opts.game,
        config,
        seats: opts.seats,
        code: opts.code,
        dataDir: this.dataDir,
        profile: { name: this.settingsCache.dealerName },
        entropy: this.entropyFor(source, opts.fallback),
        transport: this.transportFor(opts.game),
        appUrl: this.settingsCache.appUrl,
        options: { ...(opts.options ?? {}), randomness: { mode } },
        now: this.now,
      });
    } catch (e) {
      throw new ManagerError('invalid', (e as Error).message);
    }
    const t = this.now();
    this.registry[dealer.tableId] = {
      id: dealer.tableId,
      code: dealer.code,
      game: opts.game,
      name: (opts.name ?? '').trim().slice(0, 60),
      status: 'running',
      createdAt: t,
      updatedAt: t,
      seats: dealer.snapshot().seats.length,
    };
    await writeRegistry(this.dataDir, this.registry);
    await this.attach(dealer);
    this.emit({
      table: dealer.tableId,
      type: 'created',
      message: `created ${opts.game} table ${dealer.code}`,
      data: { code: dealer.code, game: opts.game },
    });
    return this.info(dealer.tableId);
  }

  async resume(idOrCode: string): Promise<TableInfo> {
    const record = await loadTable(this.dataDir, idOrCode);
    if (!record) throw new ManagerError('not-found', `no saved table matches "${idOrCode}"`);
    const id = record.snapshot.id;
    if (this.running.has(id)) return this.info(id);
    if (record.snapshot.view)
      throw new ManagerError('refused', 'that copy is a view; only a host copy can be resumed');
    const declared = (record.snapshot.options?.randomness as { provider?: string } | undefined)
      ?.provider;
    const source: EntropySourceName = isEntropySourceName(declared) ? declared : 'crypto';
    if (source === 'random.org' && !this.settingsCache.randomOrgApiKey) {
      throw new ManagerError(
        'invalid',
        'this table draws from random.org; add the API key in Settings first',
      );
    }
    await this.ensureProfile();
    let dealer: Dealer;
    try {
      dealer = await createDealer({
        game: record.game,
        resume: id,
        dataDir: this.dataDir,
        profile: { name: this.settingsCache.dealerName },
        entropy: this.entropyFor(source),
        transport: this.transportFor(record.game),
        appUrl: this.settingsCache.appUrl,
        now: this.now,
      });
    } catch (e) {
      throw new ManagerError('refused', (e as Error).message);
    }
    const entry = this.registry[id] ?? {
      id,
      code: record.snapshot.code,
      game: record.game,
      name: '',
      createdAt: record.snapshot.createdAt,
      seats: record.snapshot.seats.length,
    };
    this.registry[id] = { ...entry, status: 'running', updatedAt: this.now() } as RegistryEntry;
    await writeRegistry(this.dataDir, this.registry);
    await this.attach(dealer);
    this.emit({
      table: id,
      type: 'resumed',
      message: `resumed ${record.game} table ${record.snapshot.code}`,
    });
    return this.info(id);
  }

  /** Resume every table the registry marks as running (after a process restart). */
  async resumeAll(): Promise<TableInfo[]> {
    const out: TableInfo[] = [];
    for (const entry of Object.values(this.registry)) {
      if (entry.status !== 'running' || this.running.has(entry.id)) continue;
      try {
        out.push(await this.resume(entry.id));
      } catch (e) {
        this.registry[entry.id] = { ...entry, status: 'stopped' };
        this.emit({
          table: entry.id,
          type: 'error',
          message: `could not resume ${entry.code}: ${(e as Error).message}`,
        });
      }
    }
    await writeRegistry(this.dataDir, this.registry);
    return out;
  }

  private async attach(dealer: Dealer): Promise<void> {
    const profile = await this.ensureProfile();
    const client = new TableClient<unknown, unknown, unknown, unknown>({
      transport: dealer.server.connectLocal(),
      profile: publicProfile(profile),
      signer: signerFor(profile.privateKey),
      pingIntervalMs: 0,
    });
    const id = dealer.tableId;
    const unsubscribe = dealer.onEvent((e: DealerEvent) => {
      switch (e.type) {
        case 'seat':
          this.emit({
            table: id,
            type: 'seat',
            message: `${e.name} ${e.connected ? 'joined' : 'left'} seat ${e.seat}`,
            data: e,
          });
          break;
        case 'action':
          this.emit({ table: id, type: 'action', message: `action #${e.seq}`, data: e });
          this.touch(id);
          break;
        case 'autopilot':
          this.emit({ table: id, type: 'autopilot', message: e.message, data: e });
          break;
        case 'error':
          this.emit({ table: id, type: 'error', message: e.message });
          break;
        case 'stopped':
          this.emit({ table: id, type: 'stopped', message: 'table stopped' });
          break;
        default:
          break;
      }
    });
    this.running.set(id, { dealer, client, unsubscribe });
    await dealer.start();
  }

  private touch(id: string): void {
    const entry = this.registry[id];
    if (!entry) return;
    this.registry[id] = { ...entry, updatedAt: this.now() };
    void writeRegistry(this.dataDir, this.registry);
  }

  async stop(id: string): Promise<TableInfo> {
    const run = this.running.get(id);
    if (!run) throw new ManagerError('stopped', 'table is not running');
    run.unsubscribe();
    run.client.close();
    await run.dealer.stop();
    this.running.delete(id);
    const entry = this.registry[id];
    if (entry) this.registry[id] = { ...entry, status: 'stopped', updatedAt: this.now() };
    await writeRegistry(this.dataDir, this.registry);
    this.emit({ table: id, type: 'stopped', message: `stopped ${entry?.code ?? id}` });
    return this.info(id);
  }

  async remove(id: string, opts: { purge?: boolean } = {}): Promise<void> {
    if (this.running.has(id))
      throw new ManagerError('running', 'stop the table before removing it');
    const entry = this.registry[id];
    if (!entry && !(await loadTable(this.dataDir, id)))
      throw new ManagerError('not-found', 'no such table');
    delete this.registry[id];
    await writeRegistry(this.dataDir, this.registry);
    if (opts.purge) await deleteTable(this.dataDir, id);
    this.emit({
      table: id,
      type: 'removed',
      message: `removed ${entry?.code ?? id}${opts.purge ? ' (purged)' : ''}`,
    });
  }

  async close(): Promise<void> {
    for (const id of Array.from(this.running.keys())) {
      const run = this.running.get(id)!;
      run.unsubscribe();
      run.client.close();
      await run.dealer.stop();
      this.running.delete(id);
    }
    // Stopping the process is not the same as stopping the tables: they resume with --resume-all.
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  async snapshotOf(id: string): Promise<TableSnapshot | null> {
    const run = this.running.get(id);
    if (run) return run.dealer.snapshot();
    const record = await loadTable(this.dataDir, id);
    return record?.snapshot ?? null;
  }

  /** The table as any spectator may see it: hidden information redacted. */
  async publicSnapshot(id: string): Promise<TableSnapshot | null> {
    const snapshot = await this.snapshotOf(id);
    if (!snapshot) return null;
    const entry = this.registry[id];
    const game = entry?.game ?? (isDealerGame(snapshot.gameId) ? snapshot.gameId : null);
    if (!game) return null;
    return viewSnapshot(definitionFor(game), snapshot, null) as TableSnapshot;
  }

  /** Public audit data for the fairness panel: proofs and records, no hidden state. */
  async audit(
    id: string,
  ): Promise<Pick<
    TableSnapshot,
    'id' | 'code' | 'seq' | 'options' | 'actionMeta' | 'entropyAudit'
  > | null> {
    const snapshot = await this.publicSnapshot(id);
    if (!snapshot) return null;
    return {
      id: snapshot.id,
      code: snapshot.code,
      seq: snapshot.seq,
      options: snapshot.options,
      ...(snapshot.actionMeta ? { actionMeta: snapshot.actionMeta } : {}),
      ...(snapshot.entropyAudit ? { entropyAudit: snapshot.entropyAudit } : {}),
    };
  }

  async info(id: string): Promise<TableInfo> {
    const entry = this.registry[id];
    if (!entry) throw new ManagerError('not-found', 'no such table');
    const run = this.running.get(id);
    const snapshot = await this.snapshotOf(id);
    const def = definitionFor(entry.game);
    const seats = snapshot?.seats ?? new Array<null>(entry.seats).fill(null);
    const connected = new Set(run ? run.dealer.server.connectedSeats() : []);
    const seatsInfo: SeatInfo[] = seats.map((p, i) => ({
      seat: i,
      name: p?.name ?? null,
      connected: connected.has(i),
      devices: run ? run.dealer.server.connectionCount(i) : 0,
    }));
    const randomness = snapshot?.options?.randomness as
      { mode?: RandomnessMode; provider: string } | undefined;
    return {
      ...entry,
      status: run ? 'running' : 'stopped',
      inviteLink: inviteLinkFor(this.settingsCache.appUrl, entry.game, entry.code),
      seatsInfo,
      occupied: seatsInfo.filter((s) => s.name !== null).length,
      seq: snapshot?.seq ?? 0,
      summary: snapshot ? (def.summary?.(snapshot.state) ?? null) : null,
      rules: snapshot ? describeConfig(entry.game, snapshot.config) : '',
      randomness: randomness
        ? { mode: randomness.mode ?? 'per-draw', provider: randomness.provider }
        : null,
      dealer: snapshot?.dealer ?? null,
      autopilot: run ? run.dealer.server.autopilotStatus() : null,
      ready: run ? run.dealer.server.readiness() : [],
    };
  }

  async list(): Promise<TableInfo[]> {
    const out: TableInfo[] = [];
    for (const id of Object.keys(this.registry)) out.push(await this.info(id));
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** OFC only: balances, unsettled amounts, the settlement plan and the ledger entries. */
  async ledger(id: string): Promise<{
    balances: number[];
    unsettled: number[];
    plan: Array<{ from: number; to: number; points: number; amount: number }>;
    entries: TableState['ledger'];
    multiplier: number;
    mode: 'up' | 'buyin';
    buyIn: number | null;
    names: (string | null)[];
  } | null> {
    const entry = this.registry[id];
    const snapshot = await this.snapshotOf(id);
    if (!entry || !snapshot || entry.game !== 'ofc') return null;
    const state = snapshot.state as TableState;
    return {
      balances: balances(state),
      unsettled: unsettledBalances(state),
      plan: settlementPlan(state),
      entries: state.ledger,
      multiplier: state.config.scoring.multiplier,
      mode: state.config.scoring.mode,
      buyIn: state.config.scoring.buyIn ?? null,
      names: snapshot.seats.map((s) => s?.name ?? null),
    };
  }

  /**
   * Send a dealer-only command (OFC `start` / `settle` / `adjust`) through the dealer's own
   * client. Resolves with the new seq, or throws with the server's rule error.
   */
  async sendDealerCommand(id: string, command: unknown): Promise<{ seq: number }> {
    const run = this.running.get(id);
    if (!run) throw new ManagerError('stopped', 'table is not running');
    const { client, dealer } = run;
    const deadline = Date.now() + 5000;
    while (client.getState().role !== 'dealer') {
      if (client.getState().status === 'rejected')
        throw new ManagerError('refused', 'dealer client was rejected');
      if (Date.now() > deadline)
        throw new ManagerError('refused', 'dealer client is not connected');
      await new Promise((r) => setTimeout(r, 20));
    }
    const before = dealer.snapshot().seq;
    const errorsBefore = client.getState().error?.at ?? 0;
    if (!client.send(command)) throw new ManagerError('refused', 'could not send the command');
    const until = Date.now() + 15_000;
    for (;;) {
      const seq = dealer.snapshot().seq;
      if (seq > before) return { seq };
      const err = client.getState().error;
      if (err && err.at > errorsBefore) throw new ManagerError('refused', err.message);
      if (Date.now() > until) throw new ManagerError('refused', 'the table did not answer');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ------------------------------------------------------------------------------ rulesets

  async listRulesets(): Promise<Array<{ name: string; config: TableConfig; description: string }>> {
    let names: string[];
    try {
      names = await readdir(join(this.dataDir, RULESETS_DIR));
    } catch {
      return [];
    }
    const out: Array<{ name: string; config: TableConfig; description: string }> = [];
    for (const file of names.sort()) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(
          await readFile(join(this.dataDir, RULESETS_DIR, file), 'utf8'),
        ) as unknown;
        const checked = validateTableConfig(raw);
        if (checked.ok)
          out.push({
            name: file.slice(0, -5),
            config: checked.config,
            description: describeRules(checked.config),
          });
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  }

  async saveRuleset(name: string, raw: unknown): Promise<{ name: string; config: TableConfig }> {
    const safe = name
      .trim()
      .replace(/[^A-Za-z0-9 _-]/g, '')
      .slice(0, 40);
    if (!safe) throw new ManagerError('invalid', 'rule set needs a name');
    const checked = validateTableConfig(raw);
    if (!checked.ok) throw new ManagerError('invalid', checked.errors.join('; '));
    await mkdir(join(this.dataDir, RULESETS_DIR), { recursive: true });
    await writeFile(
      join(this.dataDir, RULESETS_DIR, `${safe}.json`),
      JSON.stringify(checked.config, null, 2),
    );
    return { name: safe, config: checked.config };
  }

  async deleteRuleset(name: string): Promise<void> {
    const safe = name
      .trim()
      .replace(/[^A-Za-z0-9 _-]/g, '')
      .slice(0, 40);
    await rm(join(this.dataDir, RULESETS_DIR, `${safe}.json`), { force: true });
  }
}

// -------------------------------------------------------------------------------- presets

export interface GamePreset {
  id: string;
  name: string;
  description: string;
  config: unknown;
}

/** Named starting points per game, for the console's "New table" form. */
export function presetsFor(game: DealerGame): GamePreset[] {
  if (game === 'ofc') return RULES_PRESETS.map((p) => ({ ...p, config: p.config }));
  return [
    {
      id: 'match-1',
      name: '1-point match',
      description: 'Single game, no cube decisions.',
      config: { length: 1, crawford: true, jacoby: false },
    },
    {
      id: 'match-3',
      name: '3-point match',
      description: 'Short match with the Crawford rule.',
      config: { length: 3, crawford: true, jacoby: false },
    },
    {
      id: 'match-5',
      name: '5-point match',
      description: 'The usual club length.',
      config: { length: 5, crawford: true, jacoby: false },
    },
    {
      id: 'match-7',
      name: '7-point match',
      description: 'Longer match, cube play matters.',
      config: { length: 7, crawford: true, jacoby: false },
    },
    {
      id: 'match-11',
      name: '11-point match',
      description: 'Tournament length.',
      config: { length: 11, crawford: true, jacoby: false },
    },
    {
      id: 'money',
      name: 'Money session',
      description: 'Unlimited games, Jacoby rule on.',
      config: { length: 0, crawford: false, jacoby: true },
    },
    {
      id: 'free-board',
      name: 'Free board',
      description: 'No rule enforcement: a physical board.',
      config: { length: 0, crawford: false, jacoby: false, rules: 'free' },
    },
  ];
}

/** One line describing a table's configuration for lists. */
export function describeConfig(game: DealerGame, config: unknown): string {
  if (game === 'ofc') {
    const checked = validateTableConfig(config);
    return checked.ok ? describeRules(checked.config) : 'OFC';
  }
  const c = (config ?? {}) as {
    length?: number;
    crawford?: boolean;
    jacoby?: boolean;
    rules?: string;
  };
  const match = !!c.length && c.length > 0;
  const parts = [match ? `${c.length}-point match` : 'Money session'];
  // Crawford only applies to match play, Jacoby only to money play.
  if (match && c.crawford) parts.push('Crawford');
  if (!match && c.jacoby) parts.push('Jacoby');
  if (c.rules === 'free') parts.push('free board');
  return parts.join(' · ');
}
