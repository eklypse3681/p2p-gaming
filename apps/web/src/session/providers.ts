import type { TransportProvider } from '@bgf/protocol';
import { broadcastChannelProvider, memoryProvider } from '@bgf/protocol';
import { peerJsProvider } from '@bgf/transport-peerjs';
import type { Settings } from './settings';
import { getSettings, parseIceServers } from './settings';
import type { GameId } from '../games/ids';

export type TransportName = 'memory' | 'broadcast' | 'peerjs';
export const DEFAULT_TRANSPORT: TransportName = 'peerjs';

export function getTransportName(): TransportName {
  if (typeof window === 'undefined') return DEFAULT_TRANSPORT;
  const raw = new URLSearchParams(window.location.search).get('transport');
  if (raw === 'memory' || raw === 'broadcast' || raw === 'peerjs') return raw;
  return DEFAULT_TRANSPORT;
}

const cache = new Map<string, TransportProvider>();

function peerKey(s: Settings): string {
  return JSON.stringify([s.peer, s.iceServers]);
}

/** A game, the device-to-device profile sync channel, or the club lobby channel. */
export type Channel = GameId | 'sync' | 'club';

/** PeerJS id namespace per channel: room codes of different games (and sync) never collide. */
export function peerNamespaceFor(channel: Channel): string {
  return `${channel}-v1`;
}

/**
 * Memoised provider for a player and game. The transport comes from `?transport=` (default
 * PeerJS); the PeerJS server / ICE options come from that player's settings, and the id namespace
 * from the game.
 */
export function getProvider(
  slug: string,
  channel: Channel,
  name: TransportName = getTransportName(),
): TransportProvider {
  const settings = getSettings(slug);
  const namespace = peerNamespaceFor(channel);
  const key = name === 'peerjs' ? `peerjs:${namespace}:${peerKey(settings)}` : `${name}:${channel}`;
  const existing = cache.get(key);
  if (existing) return existing;
  let provider: TransportProvider;
  if (name === 'memory') provider = memoryProvider();
  else if (name === 'broadcast') provider = broadcastChannelProvider();
  else provider = peerJsProvider({ ...peerOptionsFromSettings(settings), namespace });
  cache.set(key, provider);
  return provider;
}

export function peerOptionsFromSettings(settings: Settings) {
  const { peer, iceServers } = settings;
  const opts: {
    host?: string;
    port?: number;
    path?: string;
    secure?: boolean;
    key?: string;
    iceServers?: RTCIceServer[];
  } = {};
  if (peer.host.trim()) {
    opts.host = peer.host.trim();
    const port = Number(peer.port);
    if (Number.isFinite(port) && port > 0) opts.port = port;
    if (peer.path.trim()) opts.path = peer.path.trim();
    opts.secure = peer.secure;
    if (peer.key.trim()) opts.key = peer.key.trim();
  }
  const ice = parseIceServers(iceServers);
  if (ice.length) opts.iceServers = ice;
  return opts;
}

/** For tests. */
export function resetProviderCache(): void {
  cache.clear();
}
