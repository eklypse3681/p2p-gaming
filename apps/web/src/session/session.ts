import type { MatchConfig, Player } from '@bgf/engine';
import type { GameClientApi, MatchStore } from '@bgf/client';
import { GameClient } from '@bgf/client';
import { GameServer } from '@bgf/server';
import type {
  Listener,
  MatchSnapshot,
  PlayerProfile,
  TransportProvider,
  HomeSide,
} from '@bgf/protocol';
import { TransportError, generateRoomCode } from '@bgf/protocol';

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
      | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export interface SessionDeps {
  provider: TransportProvider;
  store?: MatchStore & { findByCode?(code: string): Promise<MatchSnapshot | undefined> };
  /** Overridable for tests. */
  createServer?: (opts: ConstructorParameters<typeof GameServer>[0]) => GameServer;
  createClient?: (opts: ConstructorParameters<typeof GameClient>[0]) => GameClientApi;
  joinTimeoutMs?: number;
}

const DEFAULT_JOIN_TIMEOUT = 20_000;

function requireName(profile: PlayerProfile): void {
  if (!profile.name.trim()) throw new SessionError('no-name', 'Pick a name before playing');
}

/** Resolve once the client is welcomed; reject if it is rejected, disconnects, or times out. */
export function awaitJoined(client: GameClientApi, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
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
    default:
      return 'The host declined the connection';
  }
}

function mapTransportError(e: unknown): SessionError {
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
): Promise<Session> {
  const createClient = deps.createClient ?? ((o) => new GameClient(o));
  let listener: Listener;
  try {
    listener = await deps.provider.host(code);
  } catch (e) {
    server.close();
    throw mapTransportError(e);
  }
  const unsub = listener.onConnection((t) => server.accept(t));
  const local = server.connectLocal();
  const client = createClient({ transport: local, profile, store: deps.store });
  const dispose = makeDisposer({ client, server, listener, unsub });
  try {
    await awaitJoined(client, deps.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT);
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
  config: Partial<MatchConfig>;
  hostSeat?: Player;
  /** Table layout: side of the home boards as seen from the host. Default 'left'. */
  homeSide?: HomeSide;
}

/** Create a brand-new match: run the server here and connect our own client to it. */
export async function hostNewMatch(opts: HostOptions, deps: SessionDeps): Promise<Session> {
  requireName(opts.profile);
  const createServer = deps.createServer ?? ((o) => new GameServer(o));
  const code = generateRoomCode();
  const server = createServer({
    code,
    host: opts.profile,
    config: opts.config,
    hostSeat: opts.hostSeat ?? 'white',
    homeSide: opts.homeSide ?? 'left',
  });
  return hostWithServer(server, code, opts.profile, deps);
}

export interface JoinOptions {
  code: string;
  profile: PlayerProfile;
  /** Sent in the hello so the host can adopt our copy if it is newer. */
  resumeSnapshot?: MatchSnapshot;
}

/** Join a match someone else is hosting. */
export async function joinMatch(opts: JoinOptions, deps: SessionDeps): Promise<Session> {
  requireName(opts.profile);
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
    transport = await deps.provider.join(opts.code, { timeoutMs });
  } catch (e) {
    throw mapTransportError(e);
  }
  const client = createClient({
    transport,
    profile: opts.profile,
    store: deps.store,
    resumeSnapshot,
  });
  const dispose = makeDisposer({ client });
  try {
    await awaitJoined(client, timeoutMs);
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

export interface ResumeOptions {
  snapshot: MatchSnapshot;
  profile: PlayerProfile;
}

/**
 * Resume a saved match. Try to host under its room code; if someone (the other player) already
 * hosts it, join them instead, offering our snapshot so the newer copy wins.
 */
export async function resumeMatch(opts: ResumeOptions, deps: SessionDeps): Promise<Session> {
  requireName(opts.profile);
  const createServer = deps.createServer ?? ((o) => new GameServer(o));
  const { snapshot, profile } = opts;
  const server = createServer({ snapshot, code: snapshot.code, host: profile });
  try {
    return await hostWithServer(server, snapshot.code, profile, deps);
  } catch (e) {
    if (!(e instanceof SessionError) || e.code !== 'address-taken') throw e;
  }
  return joinMatch({ code: snapshot.code, profile, resumeSnapshot: snapshot }, deps);
}
