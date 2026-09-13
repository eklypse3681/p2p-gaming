import { useSyncExternalStore } from 'react';
import { SyncManager, OFF_STATUS } from './SyncManager';
import type { SyncStatus } from './SyncManager';
import { LocalSyncStore } from './store';
import { getDevice } from './device';
import { hasWebCrypto } from './crypto';
import { getProfile, getSecrets, subscribeProfiles } from '../profiles';
import { getSettings, subscribeSettings } from '../settings';
import { getProvider, getTransportName } from '../providers';

/**
 * One SyncManager per player currently open in this tab. `ProfileProvider` attaches when a
 * profile route mounts and detaches when it unmounts; the manager runs only while the player's
 * `sync` setting is on and the browser can do it.
 */

interface Entry {
  manager: SyncManager;
  refs: number;
  syncKey: string;
  cleanup: (() => void)[];
}

const entries = new Map<string, Entry>();
const OFF = { ...OFF_STATUS };

/** Can this browser sync at all (WebCrypto, and WebRTC when the transport is PeerJS)? */
export function syncSupported(): { ok: boolean; reason: string | null } {
  if (typeof window === 'undefined') return { ok: false, reason: 'no browser' };
  if (!hasWebCrypto()) return { ok: false, reason: 'WebCrypto is not available in this browser' };
  if (getTransportName() === 'peerjs' && typeof RTCPeerConnection === 'undefined') {
    return { ok: false, reason: 'WebRTC is not available in this browser' };
  }
  return { ok: true, reason: null };
}

function createEntry(slug: string): Entry | null {
  const record = getProfile(slug);
  if (!record) return null;
  const manager = new SyncManager({
    store: new LocalSyncStore(slug),
    provider: getProvider(slug, 'sync'),
    device: getDevice(),
  });
  return { manager, refs: 0, syncKey: getSecrets(slug)?.syncKey ?? '', cleanup: [] };
}

function apply(slug: string, entry: Entry): void {
  const record = getProfile(slug);
  if (!record) return;
  const enabled = getSettings(slug).sync !== false;
  const support = syncSupported();
  if (!enabled) {
    entry.manager.stop('Sync is off for this player');
    return;
  }
  if (!support.ok) {
    entry.manager.stop(support.reason);
    return;
  }
  const syncKey = getSecrets(slug)?.syncKey ?? '';
  if (!syncKey) {
    entry.manager.stop('This player is locked: unlock it to sync');
    return;
  }
  if (syncKey !== entry.syncKey) {
    // Rotated (or just unlocked): the old group is gone; meet the new one.
    entry.syncKey = syncKey;
    entry.manager.stop('sync key changed');
  }
  entry.manager.start();
}

/** Start syncing `slug` (idempotent, ref-counted). Returns the detach function. */
export function attachSync(slug: string): () => void {
  let entry = entries.get(slug);
  if (!entry) {
    const created = createEntry(slug);
    if (!created) return () => {};
    entry = created;
    entries.set(slug, entry);
    const e = entry;
    e.cleanup.push(
      subscribeSettings(slug, () => apply(slug, e)),
      subscribeProfiles(() => apply(slug, e)),
    );
  }
  entry.refs++;
  apply(slug, entry);
  const e = entry;
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    e.refs--;
    if (e.refs > 0) return;
    for (const c of e.cleanup) c();
    e.manager.stop();
    entries.delete(slug);
  };
}

export function getSyncManager(slug: string): SyncManager | null {
  return entries.get(slug)?.manager ?? null;
}

/** Stop and start again (new key, changed network settings). */
export function restartSync(slug: string): void {
  const entry = entries.get(slug);
  if (!entry) return;
  entry.manager.stop('restarting');
  entries.delete(slug);
  const refs = entry.refs;
  for (const c of entry.cleanup) c();
  const fresh = createEntry(slug);
  if (!fresh) return;
  fresh.refs = refs;
  fresh.cleanup.push(
    subscribeSettings(slug, () => apply(slug, fresh)),
    subscribeProfiles(() => apply(slug, fresh)),
  );
  entries.set(slug, fresh);
  apply(slug, fresh);
}

const registryListeners = new Set<() => void>();
function notifyRegistry(): void {
  for (const l of Array.from(registryListeners)) l();
}

/** Live sync status of a player; `OFF` when no manager is attached. */
export function useSyncStatus(slug: string): SyncStatus {
  const subscribe = (l: () => void) => {
    registryListeners.add(l);
    const m = entries.get(slug)?.manager;
    const unsubManager = m ? m.subscribe(l) : () => {};
    return () => {
      registryListeners.delete(l);
      unsubManager();
    };
  };
  const get = () => entries.get(slug)?.manager.getStatus() ?? OFF;
  return useSyncExternalStore(subscribe, get, () => OFF);
}

/** For tests. */
export function resetSyncRegistryForTests(): void {
  for (const [slug, e] of Array.from(entries)) {
    for (const c of e.cleanup) c();
    e.manager.stop();
    entries.delete(slug);
  }
  notifyRegistry();
}
