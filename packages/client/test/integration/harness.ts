import type { Action, DiceSource, MatchConfig, MatchState, Player, SubMove } from '@bgf/engine';
import { seededDice } from '@bgf/engine';
import type { KeyPair, MatchSnapshot, PlayerProfile, Signer, Transport } from '@bgf/protocol';
import {
  PROTOCOL_VERSION,
  bytesToBase64Url,
  challengeBytes,
  createMemoryPair,
  generateKeyPair,
  signerFor,
} from '@bgf/protocol';
import { GameClient, MemoryMatchStore } from '../../src/index.js';
import { GameServer } from '@bgf/server';

export const HOST: PlayerProfile = { id: 'host-id', name: 'Alice' };
export const GUEST: PlayerProfile = { id: 'guest-id', name: 'Bob' };
export const STRANGER: PlayerProfile = { id: 'stranger-id', name: 'Mallory' };

// ---- keys: every test player owns a key pair, generated once per process ----
const keyCache = new Map<string, KeyPair>();

/** Generate (once) the key pairs for these profiles so `keyedProfile`/`signerOf` are synchronous. */
export async function ensureKeys(...profiles: PlayerProfile[]): Promise<void> {
  for (const p of profiles) {
    if (!keyCache.has(p.id)) keyCache.set(p.id, await generateKeyPair());
  }
}

export function keysFor(id: string): KeyPair {
  const k = keyCache.get(id);
  if (!k) throw new Error(`no keys generated for ${id}; call ensureKeys first`);
  return k;
}

/** The profile as the server sees it: with its public key. */
export function keyedProfile(base: PlayerProfile): PlayerProfile {
  return { ...base, publicKey: keysFor(base.id).publicKey };
}

export function signerOf(base: PlayerProfile): Signer {
  return signerFor(keysFor(base.id).privateKey);
}

/**
 * Raw-transport hello for tests that bypass GameClient: sends the keyed profile and answers the
 * server's challenge with the cached private key.
 */
export function rawHello(transport: Transport, base: PlayerProfile): void {
  const profile = keyedProfile(base);
  const signer = signerOf(base);
  transport.onMessage((m) => {
    const msg = m as { type?: string; nonce?: string; matchId?: string };
    if (msg.type !== 'challenge' || !msg.nonce || !msg.matchId) return;
    void signer(
      challengeBytes({ matchId: msg.matchId, profileId: profile.id, nonce: msg.nonce }),
    ).then((sig) => {
      if (transport.status === 'open')
        transport.send({ type: 'auth', signature: bytesToBase64Url(sig) });
    });
  });
  transport.send({ type: 'hello', protocol: PROTOCOL_VERSION, profile });
}

/** Let queued microtasks / macrotasks drain so messages propagate both ways. */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

export function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms = 1000) => (t += ms) };
}

export interface Harness {
  server: GameServer;
  host: GameClient;
  guest: GameClient;
  hostStore: MemoryMatchStore;
  guestStore: MemoryMatchStore;
  clock: ReturnType<typeof fakeClock>;
  /**
   * Connect another client (new transport) to the same server. Profiles with generated keys are
   * sent keyed and signed automatically; pass `legacy: true` for an unkeyed client, or a custom
   * `signer` (with a profile carrying its own `publicKey`) to impersonate.
   */
  connect(
    profile: PlayerProfile,
    opts?: {
      resumeSnapshot?: MatchSnapshot;
      store?: MemoryMatchStore;
      signer?: Signer;
      legacy?: boolean;
    },
  ): { client: GameClient; transport: Transport };
  /** Assert both clients hold identical authoritative state. */
  expectConverged(): void;
  close(): void;
}

export interface HarnessOptions {
  dice?: DiceSource;
  config?: Partial<MatchConfig>;
  hostSeat?: Player;
  initialMatch?: MatchState;
  snapshot?: MatchSnapshot;
  withGuest?: boolean;
  guestResume?: MatchSnapshot;
  hostResume?: MatchSnapshot;
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  await ensureKeys(HOST, GUEST, STRANGER);
  const clock = fakeClock();
  const server = new GameServer({
    code: 'TEST42',
    host: keyedProfile(HOST),
    hostSeat: opts.hostSeat,
    config: opts.config,
    dice: opts.dice ?? seededDice(7),
    now: clock.now,
    initialMatch: opts.initialMatch,
    snapshot: opts.snapshot,
  });
  const hostStore = new MemoryMatchStore();
  const guestStore = new MemoryMatchStore();
  const clientOpts = { pingIntervalMs: 0, previewThrottleMs: 0, now: clock.now };
  const host = new GameClient({
    transport: server.connectLocal(),
    profile: keyedProfile(HOST),
    signer: signerOf(HOST),
    store: hostStore,
    resumeSnapshot: opts.hostResume,
    ...clientOpts,
  });
  const others: GameClient[] = [];
  const connect: Harness['connect'] = (profile, o = {}) => {
    const [serverEnd, clientEnd] = createMemoryPair('guest');
    server.accept(serverEnd);
    let sent = profile;
    let signer = o.signer;
    if (!o.legacy && !signer && keyCache.has(profile.id) && !profile.publicKey) {
      sent = keyedProfile(profile);
      signer = signerOf(profile);
    }
    const client = new GameClient({
      transport: clientEnd,
      profile: sent,
      signer,
      store: o.store,
      resumeSnapshot: o.resumeSnapshot,
      ...clientOpts,
    });
    others.push(client);
    return { client, transport: clientEnd };
  };
  let guest: GameClient;
  if (opts.withGuest === false) {
    guest = undefined as unknown as GameClient;
  } else {
    guest = connect(GUEST, { store: guestStore, resumeSnapshot: opts.guestResume }).client;
  }
  await flush();
  const h: Harness = {
    server,
    host,
    guest,
    hostStore,
    guestStore,
    clock,
    connect,
    expectConverged() {
      const s = JSON.stringify(server.getSnapshot());
      const joined = [host, guest, ...others].filter((c) => c && c.getState().status === 'joined');
      for (const c of joined) {
        if (JSON.stringify(c.getState().snapshot) !== s) {
          throw new Error(
            `client ${c.profile.name} (${c.getState().seat}) diverged from the server: seq ${c.getState().snapshot?.seq} vs ${server.getSnapshot().seq}`,
          );
        }
      }
    },
    close() {
      host.close();
      guest?.close();
      server.close();
    },
  };
  return h;
}

export function clientFor(h: Harness, seat: Player): GameClient {
  return h.host.getState().seat === seat ? h.host : h.guest;
}

/** Stage the first legal sub-move repeatedly until the draft is complete, then commit. */
export function autoPlay(
  client: GameClient,
  pick: (next: SubMove[]) => SubMove = (n) => n[0]!,
): SubMove[] {
  let guard = 0;
  while (!client.getState().draft.complete) {
    const next = client.getState().draft.next;
    if (next.length === 0) throw new Error('no next moves but draft incomplete');
    client.stage(pick(next));
    if (++guard > 8) throw new Error('autoPlay runaway');
  }
  const played = client.getState().draft.played;
  client.commit();
  return played;
}

export function currentGame(client: GameClient) {
  const g = client.getState().snapshot?.match.game;
  if (!g) throw new Error('no game');
  return g;
}

/** Start the game and complete the opening roll (re-rolling ties) so a player is on move. */
export async function startAndOpen(h: Harness): Promise<Player> {
  h.host.startGame();
  await flush();
  for (let i = 0; i < 20; i++) {
    const g = currentGame(h.host);
    if (g.phase.kind !== 'opening') break;
    if (g.phase.rolls.white === undefined) clientFor(h, 'white').openingRoll();
    if (g.phase.rolls.black === undefined) clientFor(h, 'black').openingRoll();
    await flush();
  }
  const g = currentGame(h.host);
  if (g.phase.kind !== 'moving')
    throw new Error(`expected moving after opening, got ${g.phase.kind}`);
  return g.phase.player;
}

/**
 * Play the current game to completion with the "first legal move" policy. Returns the actions
 * applied. Both clients roll/play as their turns come.
 */
export async function playOut(h: Harness, maxTurns = 600): Promise<Action[]> {
  const actions: Action[] = [];
  const unsub = h.server.onChange((_, a) => a && actions.push(a));
  for (let i = 0; i < maxTurns; i++) {
    const g = currentGame(h.host);
    const ph = g.phase;
    if (ph.kind === 'over') break;
    if (ph.kind === 'to-roll') clientFor(h, ph.player).roll();
    else if (ph.kind === 'moving') autoPlay(clientFor(h, ph.player));
    else throw new Error(`playOut cannot handle phase ${ph.kind}`);
    await flush();
    h.expectConverged();
  }
  unsub();
  if (currentGame(h.host).phase.kind !== 'over') throw new Error('game did not finish');
  return actions;
}
