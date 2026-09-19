import type { Signer } from '@bgf/protocol';
import type { MatchConfig, Player } from '@bgf/engine';
import type { GameClientApi, MatchStore } from '@bgf/client';
import { GameClient } from '@bgf/client';
import { GameServer } from '@bgf/server';
import type { GameServerOptions } from '@bgf/server';
import type {
  Listener,
  MatchSnapshot,
  PlayerProfile,
  TransportProvider,
  HomeSide,
} from '@bgf/protocol';
import { TransportError, generateRoomCode } from '@bgf/protocol';
import type { RandomnessChoice } from './entropy';
import { buildEntropy, randomnessOptions } from './entropy';
import type { FlowDeps, FlowOptions } from './retry';
import { cancelled, joinWithRetry, resumeWithRetry, throwIfAborted } from './retry';

export type SessionRole = 'host' | 'guest';

export interface Session {
  matchId: string;
  code: string;
  role: SessionRole;
  client: GameClientApi;
  server?: GameServer;
  provider: TransportProvider;
  dispose(): void;
}

export class SessionError extends Error {
  constructor(
    public readonly code:
      | 'no-name'
      | 'rejected'
      | 'not-found'
      | 'timeout'
      | 'network'
      | 'address-taken'
      | 'disconnected'
      | 'unsupported'
      | 'host-offline'
      | 'cancelled'
      | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export interface SessionDeps extends FlowDeps {
  provider: TransportProvider;
  store?: MatchStore & { findByCode?(code: string): Promise<MatchSnapshot | undefined> };
  /** A session this tab already runs under a room code (see `TableSessionDeps.existingSession`). */
  existingSession?: (code: string) => Session | undefined;
  /** Overridable for tests. May be asynchronous (`GameServer.create`). */
  createServer?: (opts: GameServerOptions) => GameServer | Promise<GameServer>;
  createClient?: (opts: ConstructorParameters<typeof GameClient>[0]) => GameClientApi;
  joinTimeoutMs?: number;
}

const DEFAULT_JOIN_TIMEOUT = 20_000;

function requireName(profile: PlayerProfile): void {
  if (!profile.name.trim()) throw new SessionError('no-name', 'Pick a name before playing');
}

/**
 * What opponents may see: id, name, avatar and the public key — nothing else. Profile records
 * carry secrets (private key, device-sync key); this is the boundary that keeps them out of
 * every `hello` and snapshot.
 */
export function publicProfile(profile: PlayerProfile): PlayerProfile {
  const out: PlayerProfile = { id: profile.id, name: profile.name };
  if (profile.avatar) out.avatar = profile.avatar;
  if (profile.publicKey) out.publicKey = profile.publicKey;
  return out;
}

/** Resolve once the client is welcomed; reject if it is rejected, disconnects, or times out. */
export function awaitJoined(
  client: GameClientApi,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const onAbort = () => finish(cancelled());
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      unsub();
      if (err) reject(err);
      else resolve();
    };
    const check = () => {
      const s = client.getState();
      if (s.status === 'joined') finish();
      else if (s.status === 'rejected') {
        finish(new SessionError('rejected', rejectMessage(s.rejectReason)));
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

function rejectMessage(reason: string | null): string {
  switch (reason) {
    case 'full':
      return 'That match already has two players';
    case 'protocol':
      return 'The host is running a different version of the game';
    case 'wrong-match':
      return 'Your saved match does not belong to that host';
    case 'unauthorized':
      return 'That seat belongs to a different key: this browser cannot prove it is that player';
    default:
      return 'The host declined the connection';
  }
}

export function mapTransportError(e: unknown): SessionError {
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

function makeDisposer(parts: {
  client: GameClientApi;
  server?: GameServer;
  listener?: Listener;
  unsub?: () => void;
}): () => void {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      parts.unsub?.();
    } catch {
      /* ignore */
    }
    try {
      parts.client.close();
    } catch {
      /* ignore */
    }
    try {
      parts.listener?.close();
    } catch {
      /* ignore */
    }
    try {
      parts.server?.close();
    } catch {
      /* ignore */
    }
  };
}

async function hostWithServer(
  server: GameServer,
  code: string,
  profile: PlayerProfile,
  deps: SessionDeps,
  signer?: Signer,
  signal?: AbortSignal,
): Promise<Session> {
  const createClient = deps.createClient ?? ((o) => new GameClient(o));
  let listener: Listener;
  try {
    throwIfAborted(signal);
    listener = await deps.provider.host(code);
  } catch (e) {
    server.close();
    throw mapTransportError(e);
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
    await awaitJoined(client, deps.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT, signal);
    throwIfAborted(signal);
  } catch (e) {
    dispose();
    throw mapTransportError(e);
  }
  const snapshot = client.getState().snapshot ?? server.getSnapshot();
  return {
    matchId: snapshot.id,
    code,
    role: 'host',
    client,
    server,
    provider: deps.provider,
    dispose,
  };
}

export interface HostOptions {
  profile: PlayerProfile;
  /** Signs the seat challenge with the player's private key (see `useProfile().ready`). */
  signer?: Signer;
  /** Abort while hosting; whatever was created is disposed. */
  signal?: AbortSignal;
  config: Partial<MatchConfig>;
  hostSeat?: Player;
  /** Host as a non-playing dealer: both colours are guests and this device only relays. */
  dealer?: boolean;
  /** Where the dice come from and how they are bound to rolls. */
  randomness?: RandomnessChoice;
  /** Table layout: side of the home boards as seen from the host. Default 'left'. */
  homeSide?: HomeSide;
  /** Unattended table (default true): games start when both players are here / ready. */
  autopilot?: boolean;
}

/** The `entropy` server option for a choice (undefined when none was made). */
export function matchEntropyFor(
  choice: RandomnessChoice | undefined,
): GameServerOptions['entropy'] {
  if (!choice) return undefined;
  const built = buildEntropy(choice);
  return { source: built.source, fallback: built.fallback };
}

/** Create a brand-new match: run the server here and connect our own client to it. */
export async function hostNewMatch(rawOpts: HostOptions, deps: SessionDeps): Promise<Session> {
  const opts = { ...rawOpts, profile: publicProfile(rawOpts.profile) };
  requireName(opts.profile);
  const createServer = deps.createServer ?? ((o) => GameServer.create(o));
  const code = generateRoomCode();
  const randomness = opts.randomness;
  const server = await createServer({
    code,
    host: opts.profile,
    config: opts.config,
    hostSeat: opts.dealer ? null : (opts.hostSeat ?? 'white'),
    homeSide: opts.homeSide ?? 'left',
    autopilot: opts.autopilot ?? true,
    ...(randomness
      ? {
          randomness: { mode: randomnessOptions(randomness).mode },
          entropy: matchEntropyFor(randomness),
        }
      : {}),
  });
  return hostWithServer(server, code, opts.profile, deps, opts.signer, opts.signal);
}

export interface JoinOptions {
  code: string;
  profile: PlayerProfile;
  signer?: Signer;
  /** Sent in the hello so the host can adopt our copy if it is newer. */
  resumeSnapshot?: MatchSnapshot;
  /** Tries before giving up when the host does not answer (default 1). */
  attempts?: number;
}

async function joinOnce(
  rawOpts: JoinOptions,
  deps: SessionDeps,
  signal?: AbortSignal,
): Promise<Session> {
  const opts = { ...rawOpts, profile: publicProfile(rawOpts.profile) };
  const createClient = deps.createClient ?? ((o) => new GameClient(o));
  const timeoutMs = deps.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT;
  let resumeSnapshot = opts.resumeSnapshot;
  if (!resumeSnapshot && deps.store?.findByCode) {
    try {
      resumeSnapshot = await deps.store.findByCode(opts.code);
    } catch {
      /* ignore lookup failures */
    }
  }
  let transport;
  try {
    throwIfAborted(signal);
    transport = await deps.provider.join(opts.code, { timeoutMs });
  } catch (e) {
    throw mapTransportError(e);
  }
  if (signal?.aborted) {
    transport.close();
    throw cancelled();
  }
  const client = createClient({
    transport,
    profile: opts.profile,
    signer: opts.signer,
    store: deps.store,
    resumeSnapshot,
  });
  const dispose = makeDisposer({ client });
  try {
    await awaitJoined(client, timeoutMs, signal);
    throwIfAborted(signal);
  } catch (e) {
    dispose();
    throw mapTransportError(e);
  }
  const snapshot = client.getState().snapshot!;
  return {
    matchId: snapshot.id,
    code: opts.code,
    role: 'guest',
    client,
    provider: deps.provider,
    dispose,
  };
}

/** Join a match someone else is hosting, retrying while the host may not be there yet. */
export async function joinMatch(
  rawOpts: JoinOptions,
  deps: SessionDeps,
  flow: FlowOptions = {},
): Promise<Session> {
  requireName(publicProfile(rawOpts.profile));
  return joinWithRetry(
    () => joinOnce(rawOpts, deps, flow.signal),
    rawOpts.attempts ?? 1,
    flow,
    deps,
  );
}

export interface ResumeOptions {
  snapshot: MatchSnapshot;
  profile: PlayerProfile;
  signer?: Signer;
  /** Randomness source to use when re-hosting (the mode comes from the saved match). */
  randomness?: RandomnessChoice;
}

/**
 * Resume a saved match. Try to host under its room code (retrying a stale `address-taken` a few
 * times); if the other player really hosts it, join them instead, offering our snapshot so the
 * newer copy wins. Stalled signalling is retried with backoff; `flow.signal` aborts. If this tab
 * already runs a live session under the code, that session is returned untouched.
 */
export async function resumeMatch(
  rawOpts: ResumeOptions,
  deps: SessionDeps,
  flow: FlowOptions = {},
): Promise<Session> {
  const opts = { ...rawOpts, profile: publicProfile(rawOpts.profile) };
  requireName(opts.profile);
  const { snapshot, profile } = opts;
  const existing = deps.existingSession?.(snapshot.code);
  if (existing) return existing;
  const hostOnce = async () => {
    const live = deps.existingSession?.(snapshot.code);
    if (live) return live;
    const createServer = deps.createServer ?? ((o) => GameServer.create(o));
    const server = await createServer({
      snapshot,
      code: snapshot.code,
      host: profile,
      ...(opts.randomness ? { entropy: matchEntropyFor(opts.randomness) } : {}),
    });
    return hostWithServer(server, snapshot.code, profile, deps, opts.signer, flow.signal);
  };
  const joinOnceStep = async () => {
    const live = deps.existingSession?.(snapshot.code);
    if (live) return live;
    return joinOnce(
      { code: snapshot.code, profile, signer: opts.signer, resumeSnapshot: snapshot },
      deps,
      flow.signal,
    );
  };
  const hostName = snapshot.players[snapshot.hostSeat]?.name ?? snapshot.dealer?.name ?? 'the host';
  return resumeWithRetry({ hostOnce, joinOnce: joinOnceStep, hostName }, flow, deps);
}
