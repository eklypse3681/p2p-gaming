import type { EntropySource, GameDefinition, SnapshotStore, TableClientState } from '@bgf/table';
import { TableClient, TableServer } from '@bgf/table';
import type {
  Listener,
  PlayerProfile,
  Signer,
  TableSnapshot,
  TransportProvider,
} from '@bgf/protocol';
import { TransportError, generateRoomCode } from '@bgf/protocol';
import { SessionError, publicProfile } from './session';
import type { BaseSession } from './SessionRegistry';
import type { RandomnessChoice } from './entropy';
import { buildEntropy, randomnessOptions } from './entropy';
import type { FlowDeps, FlowOptions } from './retry';
import { cancelled, joinWithRetry, resumeWithRetry, throwIfAborted } from './retry';

/**
 * Sessions for games on the generic table core (`@bgf/table`). Backgammon predates the core and
 * keeps its own wrappers in `session.ts`; every newer game (OFC first) uses these, so adding a
 * game means supplying a `GameDefinition` and screens — nothing here changes.
 */

export type TableRole = 'host' | 'guest';

export interface TableSession<
  S = unknown,
  A = unknown,
  C = unknown,
  V = S,
  Cfg = unknown,
> extends BaseSession {
  role: TableRole;
  client: TableClient<S, A, Cfg, V>;
  server?: TableServer<S, A, C, V, Cfg>;
  provider: TransportProvider;
  gameId: string;
}

/** Persistence the session layer needs: put every snapshot, and look copies up for resume/join. */
export interface TableStore<S = unknown, A = unknown, Cfg = unknown> extends SnapshotStore<
  S,
  A,
  Cfg
> {
  get?(id: string): Promise<TableSnapshot<S, A, Cfg> | undefined>;
  findByCode?(code: string): Promise<TableSnapshot<S, A, Cfg> | undefined>;
}

export interface TableSessionDeps<
  S = unknown,
  A = unknown,
  C = unknown,
  V = S,
  Cfg = unknown,
> extends FlowDeps {
  provider: TransportProvider;
  store?: TableStore<S, A, Cfg>;
  joinTimeoutMs?: number;
  /**
   * A session this tab already runs under a room code (the registry's live session). Resuming a
   * table we are hosting must hand that back instead of joining our own server as a guest.
   */
  existingSession?: (code: string) => TableSession<S, A, C, V, Cfg> | undefined;
  /** Overridable for tests. May be asynchronous (`TableServer.create`). */
  createServer?: (
    opts: ConstructorParameters<typeof TableServer<S, A, C, V, Cfg>>[0],
  ) => TableServer<S, A, C, V, Cfg> | Promise<TableServer<S, A, C, V, Cfg>>;
  createClient?: (
    opts: ConstructorParameters<typeof TableClient<S, A, Cfg, V>>[0],
  ) => TableClient<S, A, Cfg, V>;
}

const DEFAULT_JOIN_TIMEOUT = 20_000;

function requireName(profile: PlayerProfile): void {
  if (!profile.name.trim()) throw new SessionError('no-name', 'Pick a name before playing');
}

function rejectMessage(reason: string | null, seats: number | null): string {
  switch (reason) {
    case 'full':
      return seats
        ? `That table already has ${seats} players`
        : 'That table already has all its players';
    case 'protocol':
      return 'The host is running a different version of the game';
    case 'wrong-match':
      return 'Your saved copy does not belong to that host';
    case 'unauthorized':
      return 'That seat belongs to a different key: this browser cannot prove it is that player';
    default:
      return 'The host declined the connection';
  }
}

export function mapTableTransportError(e: unknown): SessionError {
  if (e instanceof SessionError) return e;
  if (e instanceof TransportError) {
    switch (e.code) {
      case 'not-found':
        return new SessionError('not-found', 'No one is hosting that code right now');
      case 'timeout':
        return new SessionError('timeout', 'Could not reach the host (timed out)');
      case 'address-taken':
        return new SessionError('address-taken', 'That code is already being hosted');
      case 'unsupported':
        return new SessionError(
          'unsupported',
          'This browser does not support the selected transport',
        );
      default:
        return new SessionError('network', e.message);
    }
  }
  return new SessionError('unknown', e instanceof Error ? e.message : String(e));
}

/** Resolve once the client is welcomed; reject if it is rejected, disconnects, or times out. */
export function awaitTableJoined<V, A, Cfg>(
  client: { getState(): TableClientState<V, A, Cfg>; subscribe(l: () => void): () => void },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const onAbort = () => finish(cancelled());
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    if (signal?.aborted) {
      done = true;
      reject(cancelled());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    const check = () => {
      const s = client.getState();
      if (s.status === 'joined') finish();
      else if (s.status === 'rejected') {
        finish(
          new SessionError(
            'rejected',
            rejectMessage(s.rejectReason, s.snapshot?.seats.length ?? null),
          ),
        );
      } else if (s.status === 'disconnected') {
        finish(new SessionError('disconnected', 'The connection closed before the game started'));
      }
    };
    const timer = setTimeout(
      () => finish(new SessionError('timeout', 'The host did not answer in time')),
      timeoutMs,
    );
    const unsub = client.subscribe(check);
    check();
  });
}

function makeDisposer(parts: {
  client: { close(): void };
  server?: { close(): void };
  listener?: Listener;
  unsub?: () => void;
}): () => void {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const step of [
      () => parts.unsub?.(),
      () => parts.client.close(),
      () => parts.listener?.close(),
      () => parts.server?.close(),
    ]) {
      try {
        step();
      } catch {
        /* ignore */
      }
    }
  };
}

async function hostWithServer<S, A, C, V, Cfg>(
  def: GameDefinition<S, A, C, V, Cfg>,
  server: TableServer<S, A, C, V, Cfg>,
  code: string,
  profile: PlayerProfile,
  signer: Signer | undefined,
  deps: TableSessionDeps<S, A, C, V, Cfg>,
  signal?: AbortSignal,
): Promise<TableSession<S, A, C, V, Cfg>> {
  const createClient = deps.createClient ?? ((o) => new TableClient<S, A, Cfg, V>(o));
  let listener: Listener;
  try {
    throwIfAborted(signal);
    listener = await deps.provider.host(code);
  } catch (e) {
    server.close();
    throw mapTableTransportError(e);
  }
  if (signal?.aborted) {
    listener.close();
    server.close();
    throw cancelled();
  }
  const unsub = listener.onConnection((t) => server.accept(t));
  const local = server.connectLocal();
  const client = createClient({ transport: local, profile, signer, store: deps.store });
  const dispose = makeDisposer({ client, server, listener, unsub });
  try {
    await awaitTableJoined(client, deps.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT, signal);
    throwIfAborted(signal);
  } catch (e) {
    dispose();
    throw mapTableTransportError(e);
  }
  const snapshot = client.getState().snapshot ?? server.getSnapshot();
  return {
    matchId: snapshot.id,
    code,
    role: 'host',
    client,
    server,
    provider: deps.provider,
    gameId: def.id,
    dispose,
  };
}

export interface HostTableOptions<Cfg> {
  profile: PlayerProfile;
  signer?: Signer;
  /** Abort while hosting; whatever was created is disposed. */
  signal?: AbortSignal;
  config: Cfg;
  /** Number of seats (clamped to the definition's range). */
  seats?: number;
  /** Seat the host takes; ignored when `dealer` is set. Default 0. */
  hostSeat?: number;
  /** Host as a non-playing dealer: every seat is filled by guests (`hostSeat: null`). */
  dealer?: boolean;
  /** Where the table's randomness comes from and how it is bound to actions. */
  randomness?: RandomnessChoice;
  /**
   * Unattended play: the table deals, starts the next hand and settles by itself, reacting to
   * seats, presence and readiness. Default: on (dealer-hosted tables are always unattended
   * unless this is explicitly false).
   */
  autopilot?: boolean;
  /** Table-level options the game does not interpret. */
  options?: Record<string, unknown>;
}

/** The `entropy` server option for a choice (undefined when none was made). */
export function entropyFor(
  choice: RandomnessChoice | undefined,
): { source: EntropySource; fallback: boolean } | undefined {
  if (!choice) return undefined;
  const built = buildEntropy(choice);
  return { source: built.source, fallback: built.fallback };
}

/** Create a brand-new table: run the server here and connect our own client to it. */
export async function hostTable<S, A, C, V, Cfg>(
  def: GameDefinition<S, A, C, V, Cfg>,
  rawOpts: HostTableOptions<Cfg>,
  deps: TableSessionDeps<S, A, C, V, Cfg>,
): Promise<TableSession<S, A, C, V, Cfg>> {
  const profile = publicProfile(rawOpts.profile);
  requireName(profile);
  const createServer = deps.createServer ?? ((o) => TableServer.create<S, A, C, V, Cfg>(o));
  const code = generateRoomCode();
  const randomness = rawOpts.randomness;
  const server = await createServer({
    def,
    code,
    host: profile,
    hostSeat: rawOpts.dealer ? null : (rawOpts.hostSeat ?? 0),
    seats: rawOpts.seats,
    config: rawOpts.config,
    options: {
      ...(rawOpts.options ?? {}),
      ...(randomness ? { randomness: randomnessOptions(randomness) } : {}),
      autopilot: rawOpts.autopilot ?? true,
    },
    ...(randomness ? { entropy: entropyFor(randomness) } : {}),
  });
  return hostWithServer(def, server, code, profile, rawOpts.signer, deps, rawOpts.signal);
}

export interface JoinTableOptions<S, A, Cfg> {
  code: string;
  profile: PlayerProfile;
  signer?: Signer;
  /** Our persisted copy, offered to the host (only useful for games without hidden information). */
  resumeSnapshot?: TableSnapshot<S, A, Cfg>;
  /** Tries before giving up when the host does not answer (default 1). */
  attempts?: number;
}

async function joinOnce<S, A, C, V, Cfg>(
  def: GameDefinition<S, A, C, V, Cfg>,
  rawOpts: JoinTableOptions<S, A, Cfg>,
  deps: TableSessionDeps<S, A, C, V, Cfg>,
  signal?: AbortSignal,
): Promise<TableSession<S, A, C, V, Cfg>> {
  const profile = publicProfile(rawOpts.profile);
  const createClient = deps.createClient ?? ((o) => new TableClient<S, A, Cfg, V>(o));
  const timeoutMs = deps.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT;
  let resumeSnapshot = rawOpts.resumeSnapshot;
  if (!resumeSnapshot && !def.hiddenInformation && deps.store?.findByCode) {
    try {
      resumeSnapshot = await deps.store.findByCode(rawOpts.code);
    } catch {
      /* ignore lookup failures */
    }
  }
  // A seat's redacted view can never be adopted by the host; do not even offer it.
  if (resumeSnapshot && (def.hiddenInformation || resumeSnapshot.view)) resumeSnapshot = undefined;
  let transport;
  try {
    throwIfAborted(signal);
    transport = await deps.provider.join(rawOpts.code, { timeoutMs });
  } catch (e) {
    throw mapTableTransportError(e);
  }
  if (signal?.aborted) {
    transport.close();
    throw cancelled();
  }
  const client = createClient({
    transport,
    profile,
    signer: rawOpts.signer,
    store: deps.store,
    resumeSnapshot,
  });
  const dispose = makeDisposer({ client });
  try {
    await awaitTableJoined(client, timeoutMs, signal);
    throwIfAborted(signal);
  } catch (e) {
    dispose();
    throw mapTableTransportError(e);
  }
  const snapshot = client.getState().snapshot!;
  return {
    matchId: snapshot.id,
    code: rawOpts.code,
    role: 'guest',
    client,
    provider: deps.provider,
    gameId: def.id,
    dispose,
  };
}

/** Join a table someone else is hosting, retrying while the host may not be there yet. */
export async function joinTable<S, A, C, V, Cfg>(
  def: GameDefinition<S, A, C, V, Cfg>,
  rawOpts: JoinTableOptions<S, A, Cfg>,
  deps: TableSessionDeps<S, A, C, V, Cfg>,
  flow: FlowOptions = {},
): Promise<TableSession<S, A, C, V, Cfg>> {
  requireName(publicProfile(rawOpts.profile));
  return joinWithRetry(
    () => joinOnce(def, rawOpts, deps, flow.signal),
    rawOpts.attempts ?? 1,
    flow,
    deps,
  );
}

export interface ResumeTableOptions<S, A, Cfg> {
  snapshot: TableSnapshot<S, A, Cfg>;
  profile: PlayerProfile;
  signer?: Signer;
  /** Randomness source to use when re-hosting (the mode comes from the saved table). */
  randomness?: RandomnessChoice;
}

/** Name of the seat that hosted a snapshot, for messages. */
export function hostNameOf(snapshot: TableSnapshot): string {
  if (snapshot.hostSeat === null) return snapshot.dealer?.name ?? 'the dealer';
  return snapshot.seats[snapshot.hostSeat]?.name ?? 'the host';
}

/**
 * Resume a saved table. A full copy (ours when we hosted, or any copy of a game without hidden
 * information) is re-hosted under its room code, or joined when someone already hosts it. A
 * seat's redacted view cannot run a server, so it can only rejoin the host — and reports
 * `host-offline` while the host is not there. Stalled signalling is retried with backoff; pass
 * `flow.signal` to abort and `flow.onProgress` to show what is happening. If this tab already
 * runs a live session under the code, that session is returned untouched.
 */
export async function resumeTable<S, A, C, V, Cfg>(
  def: GameDefinition<S, A, C, V, Cfg>,
  rawOpts: ResumeTableOptions<S, A, Cfg>,
  deps: TableSessionDeps<S, A, C, V, Cfg>,
  flow: FlowOptions = {},
): Promise<TableSession<S, A, C, V, Cfg>> {
  const profile = publicProfile(rawOpts.profile);
  requireName(profile);
  const { snapshot } = rawOpts;
  const existing = deps.existingSession?.(snapshot.code);
  if (existing) return existing;
  const viewOnly = !!snapshot.view;
  const hostOnce = viewOnly
    ? undefined
    : async () => {
        const live = deps.existingSession?.(snapshot.code);
        if (live) return live;
        const createServer = deps.createServer ?? ((o) => TableServer.create<S, A, C, V, Cfg>(o));
        let server: TableServer<S, A, C, V, Cfg>;
        try {
          server = await createServer({
            def,
            snapshot,
            code: snapshot.code,
            host: profile,
            ...(rawOpts.randomness ? { entropy: entropyFor(rawOpts.randomness) } : {}),
          });
        } catch (e) {
          throw new SessionError(
            'unknown',
            `The saved copy could not be verified: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return hostWithServer(
          def,
          server,
          snapshot.code,
          profile,
          rawOpts.signer,
          deps,
          flow.signal,
        );
      };
  const joinOnceStep = async () => {
    // Never join a code this tab is hosting: that would seat us as a guest of our own server.
    const live = deps.existingSession?.(snapshot.code);
    if (live) return live;
    return joinOnce(
      def,
      { code: snapshot.code, profile, signer: rawOpts.signer, resumeSnapshot: snapshot },
      deps,
      flow.signal,
    );
  };
  return resumeWithRetry(
    { hostOnce, joinOnce: joinOnceStep, hostName: hostNameOf(snapshot) },
    flow,
    deps,
  );
}
