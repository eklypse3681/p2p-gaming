import type { PlayerProfile, Signer, Transport, TransportProvider } from '@bgf/protocol';
import { TransportError, bytesToBase64Url, clubChallengeBytes } from '@bgf/protocol';
import type { ClubApi } from '@bgf/club-spec';
import { CLUB_SPEC_VERSION, isClubError, isRetryable as clubRetryable } from '@bgf/club-spec';
import { RemoteClub } from '@bgf/club';
import { SessionError, mapTransportError } from '../session/session';
import type { FlowOptions } from '../session/retry';
import { joinWithRetry } from '../session/retry';
import { getProvider } from '../session/providers';
import type { ClubClientApi } from './types';
import { ClubApiClient } from './ClubApiClient';
import { friendlyClubError } from './errors';
import { FakeClubClient } from './testing/FakeClubClient';

export const CLUB_JOIN_TIMEOUT_MS = 15_000;
export const CLUB_JOIN_ATTEMPTS = 3;

export interface ClubSession {
  clubId: string;
  address: string;
  client: ClubClientApi;
  /** The invite used to join; kept so a reconnect can present it again while pending. */
  invite?: string;
  dispose(): void;
}

export interface ClubConnectOptions {
  slug: string;
  clubId: string;
  address: string;
  profile: PlayerProfile;
  signer?: Signer;
  invite?: string;
}

export interface ClubConnectDeps {
  provider?: TransportProvider;
  /**
   * Test seam: build the store from a transport directly, skipping the handshake. Production
   * goes through `RemoteClub`, which opens its own connections.
   */
  createClient?: (opts: {
    transport: Transport;
    profile: PlayerProfile;
    signer?: Signer;
    invite?: string;
  }) => ClubClientApi;
  /** Test seam: supply the club interface itself, for driving a real `ClubServer` in-process. */
  createApi?: (opts: {
    provider: TransportProvider;
    address: string;
    invite?: string;
    timeoutMs: number;
  }) => ClubApi;
  timeoutMs?: number;
  attempts?: number;
}

/**
 * The `?fakeclub=1` development flag swaps the transport for an in-memory club so the screens
 * can be walked without a club runtime. Never active in production builds.
 */
export function fakeClubEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('fakeclub') === '1';
}

/**
 * A club's own failures, in the session vocabulary.
 *
 * The spec fixes the codes so a client written once reacts correctly to every implementation.
 * `isRetryable` decides whether the join loop bothers trying again: a club that is up but busy
 * is worth another attempt, and one that has banned you is not.
 */
export function mapClubError(e: unknown): SessionError {
  if (e instanceof SessionError) return e;
  // `isClubError` is a structural check, and a TransportError carries a string `code` too, so
  // the transport has to be ruled out first or its failures would be read as club refusals.
  if (e instanceof TransportError) return mapTransportError(e);
  if (isClubError(e)) {
    const message = friendlyClubError(e.code, e.message);
    if (clubRetryable(e.code)) return new SessionError('network', message);
    switch (e.code) {
      case 'unauthorized':
      case 'not-a-member':
      case 'pending':
      case 'banned':
      case 'version':
        return new SessionError('rejected', message);
      case 'unsupported':
        return new SessionError('unsupported', message);
      default:
        return new SessionError('unknown', message);
    }
  }
  return mapTransportError(e);
}

/** A club that never answers is a stall, not a refusal: time it out so the loop can retry. */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SessionError('timeout', `The club did not ${what} (timed out)`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Resolve once the club admits us; reject on rejection, disconnect or timeout. */
export function awaitClubJoined(client: ClubClientApi, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const s = client.getState();
      if (s.status === 'joined') {
        cleanup();
        resolve();
      } else if (s.status === 'rejected') {
        cleanup();
        reject(new SessionError('rejected', s.error?.message ?? `Rejected: ${s.rejectReason}`));
      } else if (s.status === 'disconnected') {
        cleanup();
        reject(new SessionError('disconnected', 'The club closed the connection'));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new SessionError('timeout', 'The club did not answer (timed out)'));
    }, timeoutMs);
    const unsub = client.subscribe(check);
    const cleanup = () => {
      clearTimeout(timer);
      unsub();
    };
    check();
  });
}

/**
 * The handshake, as the app performs it: read what the club is, prove who we are, and hand the
 * live interface to the store the screens read. Every step is bounded, so a club that stops
 * answering halfway becomes a retry rather than a hang.
 */
async function handshake(
  api: ClubApi,
  opts: ClubConnectOptions,
  timeoutMs: number,
): Promise<ClubApiClient> {
  if (!opts.signer) {
    throw new SessionError('rejected', 'This player has no key to prove who they are.');
  }
  const { nonce, clubId } = await withTimeout(
    api.challenge(opts.profile.id),
    timeoutMs,
    'offer a challenge',
  );
  const signature = bytesToBase64Url(
    await opts.signer(clubChallengeBytes({ clubId, profileId: opts.profile.id, nonce })),
  );
  const session = await withTimeout(
    api.authenticate({
      profile: opts.profile,
      signature,
      nonce,
      spec: CLUB_SPEC_VERSION,
      ...(opts.invite ? { invite: opts.invite } : {}),
    }),
    timeoutMs,
    'answer the handshake',
  );
  const info = await withTimeout(api.info(), timeoutMs, 'describe itself');
  const lobby = await withTimeout(api.lobby(session), timeoutMs, 'send the lobby');
  return new ClubApiClient({ api, session, profile: opts.profile, info, lobby });
}

/** Connect to a club with retries; the returned session is live (`joined`). */
export async function connectClub(
  opts: ClubConnectOptions,
  flow: FlowOptions = {},
  deps: ClubConnectDeps = {},
): Promise<ClubSession> {
  const timeoutMs = deps.timeoutMs ?? CLUB_JOIN_TIMEOUT_MS;
  const attempts = deps.attempts ?? CLUB_JOIN_ATTEMPTS;
  if (!deps.createClient && !deps.createApi && fakeClubEnabled()) {
    const client = new FakeClubClient({ profile: opts.profile, autoMatchMs: 1500 });
    return {
      clubId: opts.clubId,
      address: opts.address,
      client,
      invite: opts.invite,
      dispose: () => client.close(),
    };
  }
  const provider = deps.provider ?? getProvider(opts.slug, 'club');

  const joinOnce = async (): Promise<ClubSession> => {
    if (deps.createClient) {
      let transport: Transport;
      try {
        transport = await provider.join(opts.address, { timeoutMs });
      } catch (e) {
        throw mapTransportError(e);
      }
      const client = deps.createClient({
        transport,
        profile: opts.profile,
        signer: opts.signer,
        invite: opts.invite,
      });
      try {
        await awaitClubJoined(client, timeoutMs);
      } catch (e) {
        client.close();
        throw e;
      }
      return {
        clubId: opts.clubId,
        address: opts.address,
        client,
        invite: opts.invite,
        dispose: () => client.close(),
      };
    }

    const remote = deps.createApi
      ? deps.createApi({ provider, address: opts.address, invite: opts.invite, timeoutMs })
      : new RemoteClub({
          connect: () => provider.join(opts.address, { timeoutMs }),
          ...(opts.invite ? { invite: opts.invite } : {}),
        });
    // The hello carries the profile, and `challenge` is only given an id, so the real one has
    // to be registered before the handshake starts or the club records a member named by id.
    if (remote instanceof RemoteClub) remote.register(opts.profile);
    const dispose = () => {
      if (remote instanceof RemoteClub) remote.closeAll();
    };
    let client: ClubApiClient;
    try {
      client = await handshake(remote, opts, timeoutMs);
    } catch (e) {
      dispose();
      throw mapClubError(e);
    }
    return {
      clubId: opts.clubId,
      address: opts.address,
      client,
      invite: opts.invite,
      dispose: () => {
        client.close();
        dispose();
      },
    };
  };

  const session = await joinWithRetry(joinOnce, attempts, flow);
  if (flow.signal?.aborted) {
    session.dispose();
    throw new SessionError('cancelled', 'Cancelled');
  }
  return session;
}
