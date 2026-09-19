import type { Listener, PlayerProfile, TableSnapshot, TransportProvider } from '@bgf/protocol';
import { generateRoomCode } from '@bgf/protocol';
import type { TableServerOptions } from '@bgf/table';
import { TableServer } from '@bgf/table';
import { peerJsProvider } from '@bgf/transport-peerjs';
import type { AnyDefinition, DealerGame } from './games.js';
import { definitionFor, describeTable } from './games.js';
import type { DealerProfile } from './profile.js';
import { loadOrCreateProfile, publicProfile } from './profile.js';
import { loadTable, saveTable } from './storage.js';
import type { DealerEntropyOptions } from './entropy.js';
import { entropySourceFor } from './entropy.js';

export const DEFAULT_APP_URL = 'https://eklypse3681.github.io/p2p-gaming/';

/**
 * The table core supports a non-playing host (`hostSeat: null`): the dealer's profile is recorded
 * as `options.dealer`, takes no seat, and every seat is filled by guests. That is the runtime's
 * default; `dealerSeat: false` makes the dealer occupy seat 0 instead (a headless player host).
 */
export const DEALER_SEAT_SUPPORTED = true;

export interface DealerOptions {
  game: DealerGame;
  /** Game configuration (a backgammon `MatchConfig` partial or an OFC `TableConfig` partial). */
  config?: unknown;
  /** Seats at the table (clamped to the game's range). */
  seats?: number;
  /** Room code; generated when absent. */
  code?: string;
  /** Where the profile and tables live. */
  dataDir: string;
  /** The dealer's display name. */
  profile?: { name: string };
  entropy?: DealerEntropyOptions;
  /** Transport; defaults to PeerJS on the free cloud under the game's namespace. */
  transport?: TransportProvider;
  /** Resume a persisted table by id or code instead of creating one. */
  resume?: string;
  /** Take no seat (dealer mode, default true) — see {@link DEALER_SEAT_SUPPORTED}. */
  dealerSeat?: boolean;
  /** Base URL of the web app, for invite links. */
  appUrl?: string;
  /** Table-level options passed through to the server (e.g. `homeSide`). */
  options?: Record<string, unknown>;
  log?: (line: string) => void;
  now?: () => number;
}

export type DealerEvent =
  | { type: 'hosted'; code: string; inviteLink: string }
  | { type: 'seat'; seat: number; name: string; connected: boolean }
  | { type: 'action'; seq: number; action: unknown }
  | { type: 'saved'; path: string }
  | { type: 'stopped' }
  /** The unattended table scheduled, applied, dropped or was refused a decision. */
  | { type: 'autopilot'; kind: 'scheduled' | 'applied' | 'cancelled' | 'refused'; message: string }
  | { type: 'error'; message: string };

export interface Dealer {
  readonly game: DealerGame;
  readonly code: string;
  readonly tableId: string;
  readonly inviteLink: string;
  readonly profile: PlayerProfile;
  readonly server: TableServer<unknown, unknown, unknown, unknown, unknown>;
  /** Host the table on the transport. Resolves once the room code is registered. */
  start(): Promise<void>;
  /** Persist and close everything. */
  stop(): Promise<void>;
  snapshot(): TableSnapshot;
  describe(): string;
  onEvent(listener: (event: DealerEvent) => void): () => void;
}

/**
 * The table's seat count and the game config must agree. OFC carries `seats` inside its config,
 * so a rules file may set it; an explicit `--seats` wins and is written back into the config.
 */
export function reconcileSeats(
  game: DealerGame,
  seats: number | undefined,
  config: unknown,
): { seats: number | undefined; config: unknown } {
  if (game !== 'ofc') return { seats, config };
  const cfg = (config && typeof config === 'object' ? { ...(config as object) } : {}) as {
    seats?: number;
  };
  if (seats !== undefined) return { seats, config: { ...cfg, seats } };
  if (typeof cfg.seats === 'number') return { seats: cfg.seats, config: cfg };
  return { seats: undefined, config: cfg };
}

export function inviteLinkFor(appUrl: string, game: DealerGame, code: string): string {
  const base = appUrl.endsWith('/') ? appUrl : `${appUrl}/`;
  return `${base}#/${game}/join/${code}`;
}

export function defaultTransportFor(game: DealerGame): TransportProvider {
  return peerJsProvider({ namespace: `${game}-v1` });
}

export async function createDealer(opts: DealerOptions): Promise<Dealer> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  const appUrl = opts.appUrl ?? DEFAULT_APP_URL;
  const dealerProfile: DealerProfile = await loadOrCreateProfile(opts.dataDir, opts.profile?.name);
  const host = publicProfile(dealerProfile);

  const dealerSeat = opts.dealerSeat ?? true;
  if (dealerSeat && !DEALER_SEAT_SUPPORTED) {
    throw new Error(
      'dealer mode (taking no seat) is not available in this build; the dealer occupies seat 0',
    );
  }

  let game = opts.game;
  let def: AnyDefinition = definitionFor(game);
  let serverOpts: TableServerOptions<unknown, unknown, unknown, unknown, unknown>;

  if (opts.resume) {
    const record = await loadTable(opts.dataDir, opts.resume);
    if (!record) throw new Error(`no saved table matches "${opts.resume}"`);
    if (record.snapshot.view)
      throw new Error('that copy is a view; only a host copy can be resumed');
    game = record.game;
    def = definitionFor(game);
    serverOpts = { def, code: record.snapshot.code, host, snapshot: record.snapshot, now };
  } else {
    const code = (opts.code ?? generateRoomCode()).toUpperCase();
    const { seats, config } = reconcileSeats(game, opts.seats, opts.config);
    serverOpts = {
      def,
      code,
      host,
      hostSeat: dealerSeat ? null : 0,
      seats,
      config,
      options: opts.options,
      now,
    };
  }
  if (opts.entropy) {
    serverOpts.entropy = {
      source: entropySourceFor(opts.entropy),
      fallback: opts.entropy.fallback ?? false,
      purpose: 'dealer',
    };
  }

  const server = await TableServer.create(serverOpts);
  const transport = opts.transport ?? defaultTransportFor(game);
  const listeners = new Set<(event: DealerEvent) => void>();
  const emit = (event: DealerEvent) => {
    for (const l of Array.from(listeners)) l(event);
  };
  let listener: Listener | null = null;
  let known = new Set<number>();
  let stopped = false;
  let saving: Promise<void> = Promise.resolve();

  const persist = () => {
    const snapshot = server.getSnapshot();
    saving = saving
      .then(() => saveTable(opts.dataDir, game, snapshot))
      .then((path) => emit({ type: 'saved', path }))
      .catch((e: unknown) => emit({ type: 'error', message: `save failed: ${String(e)}` }));
  };

  const syncSeats = () => {
    const current = new Set(server.connectedSeats());
    const seats = server.getSnapshot().seats;
    for (const seat of current) {
      if (!known.has(seat)) {
        const name = seats[seat]?.name ?? `seat ${seat}`;
        log(`${name} joined seat ${seat}`);
        emit({ type: 'seat', seat, name, connected: true });
      }
    }
    for (const seat of known) {
      if (!current.has(seat)) {
        const name = seats[seat]?.name ?? `seat ${seat}`;
        log(`${name} left seat ${seat}`);
        emit({ type: 'seat', seat, name, connected: false });
      }
    }
    known = current;
  };

  server.onChange((snapshot, action) => {
    if (action !== undefined) {
      log(`#${snapshot.seq} ${JSON.stringify(action).slice(0, 160)}`);
      emit({ type: 'action', seq: snapshot.seq, action });
    }
    syncSeats();
    persist();
  });
  server.onAutopilot((e) => {
    const message =
      e.kind === 'scheduled'
        ? `autopilot: ${e.reason} (at ${new Date(e.at).toISOString()})`
        : e.kind === 'applied'
          ? `autopilot: ${e.reason} (#${e.seq})`
          : e.kind === 'cancelled'
            ? `autopilot: dropped "${e.reason}"`
            : `autopilot: "${e.reason}" refused — ${e.code}: ${e.message}`;
    log(message);
    emit({ type: 'autopilot', kind: e.kind, message });
  });

  const dealer: Dealer = {
    game,
    get code() {
      return server.getSnapshot().code;
    },
    get tableId() {
      return server.getSnapshot().id;
    },
    get inviteLink() {
      return inviteLinkFor(appUrl, game, server.getSnapshot().code);
    },
    profile: host,
    server,
    async start() {
      if (listener || stopped) return;
      listener = await transport.host(this.code);
      listener.onConnection((t) => {
        server.accept(t);
        t.onStatus(() => setTimeout(syncSeats, 0));
        // The seat is assigned after the (async) handshake; look again shortly.
        setTimeout(syncSeats, 250);
        setTimeout(syncSeats, 1500);
      });
      persist();
      log(`hosting ${game} as ${host.name} · code ${this.code}`);
      emit({ type: 'hosted', code: this.code, inviteLink: this.inviteLink });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      listener?.close();
      listener = null;
      server.close();
      persist();
      await saving;
      emit({ type: 'stopped' });
    },
    snapshot: () => server.getSnapshot(),
    describe: () => describeTable(game, server.getSnapshot()),
    onEvent(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return dealer;
}
