import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryProvider } from '@bgf/protocol';
import { DEFAULT_SETTINGS } from '../settings';
import { SyncManager } from './SyncManager';
import { MemorySyncStore, snap } from './testing';

const flush = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 2));
};

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function manager(store: MemorySyncStore, provider = shared, label = 'Chrome · macOS') {
  return new SyncManager({
    store,
    provider,
    device: { id: `dev-${label}-${Math.random().toString(36).slice(2, 6)}`, label },
    backoff: { baseMs: 10, maxMs: 40 },
    pushDebounceMs: 5,
    joinTimeoutMs: 500,
  });
}

let shared = memoryProvider();
const managers: SyncManager[] = [];
const start = (m: SyncManager) => {
  managers.push(m);
  m.start();
  return m;
};

beforeEach(() => {
  shared = memoryProvider();
});
afterEach(() => {
  for (const m of managers.splice(0)) m.stop();
});

const connected = (m: SyncManager) =>
  ['hub', 'connected'].includes(m.getStatus().state) && m.getStatus().devices.length > 0;

describe('SyncManager', () => {
  it('two devices converge on matches (both ways, newer seq wins) and settings (last write wins)', async () => {
    const a = new MemorySyncStore();
    const b = new MemorySyncStore();
    a.matches.set('backgammon/m1', snap('m1', 3));
    a.matches.set('backgammon/shared', snap('shared', 2));
    b.matches.set('backgammon/m2', snap('m2', 1));
    b.matches.set('backgammon/shared', snap('shared', 5));
    a.settingsData = { settings: { ...DEFAULT_SETTINGS, look: 'paper' }, updatedAt: 100 };
    b.settingsData = { settings: { ...DEFAULT_SETTINGS, look: 'slate' }, updatedAt: 50 };
    a.profileData = { name: 'Alice', avatar: '🦊', updatedAt: 5 };
    b.profileData = { name: 'Ali', avatar: '🐙', updatedAt: 9 };

    const ma = start(manager(a, shared, 'Chrome · macOS'));
    await until(() => ma.getStatus().state === 'hub');
    const mb = start(manager(b, shared, 'Safari · iPhone'));
    await until(() => connected(ma) && connected(mb));
    await until(() => a.matches.size === 3 && b.matches.size === 3);
    expect(a.matches.get('backgammon/m2')?.seq).toBe(1);
    expect(b.matches.get('backgammon/m1')?.seq).toBe(3);
    expect(a.matches.get('backgammon/shared')?.seq).toBe(5);
    expect(b.matches.get('backgammon/shared')?.seq).toBe(5);
    await until(() => b.settingsData.settings.look === 'paper');
    expect(b.settingsData.updatedAt).toBe(100);
    await until(() => a.profileData.name === 'Ali');
    expect(a.profileData).toEqual({ name: 'Ali', avatar: '🐙', updatedAt: 9 });
    expect(ma.getStatus().devices[0]?.label).toBe('Safari · iPhone');
    expect(mb.getStatus().devices[0]?.label).toBe('Chrome · macOS');
    expect(ma.getStatus().lastSyncAt).not.toBeNull();
  });

  it('pushes live changes after connecting, without echo loops', async () => {
    const a = new MemorySyncStore();
    const b = new MemorySyncStore();
    const ma = start(manager(a));
    await until(() => ma.getStatus().state === 'hub');
    const mb = start(manager(b));
    await until(() => connected(ma) && connected(mb));

    b.localPut(snap('live', 1));
    await until(() => a.matches.has('backgammon/live'));
    a.localPut(snap('live', 2));
    await until(() => b.matches.get('backgammon/live')?.seq === 2);
    a.localSettings({ pieceSet: 'sky-navy' }, 500);
    await until(() => b.settingsData.settings.pieceSet === 'sky-navy');
    b.localProfile('Alicia', 600);
    await until(() => a.profileData.name === 'Alicia');
    // an unnamed change makes peers re-check manifests
    a.matches.set('backgammon/quiet', snap('quiet', 1));
    a.emit({ kind: 'unknown' });
    await until(() => b.matches.has('backgammon/quiet'));
    await flush();
    expect(a.matches.size).toBe(2);
    expect(b.matches.size).toBe(2);
  });

  it('a third device is relayed through the hub', async () => {
    const a = new MemorySyncStore();
    const b = new MemorySyncStore();
    const c = new MemorySyncStore();
    const ma = start(manager(a, shared, 'hub'));
    await until(() => ma.getStatus().state === 'hub');
    const mb = start(manager(b, shared, 'b'));
    const mc = start(manager(c, shared, 'c'));
    await until(() => ma.getStatus().devices.length === 2 && connected(mb) && connected(mc));
    b.localPut(snap('from-b', 4));
    await until(() => c.matches.get('backgammon/from-b')?.seq === 4);
    expect(a.matches.get('backgammon/from-b')?.seq).toBe(4);
    c.localPut(snap('from-c', 1));
    await until(() => b.matches.has('backgammon/from-c') && a.matches.has('backgammon/from-c'));
  });

  it('when the hub stops, a client becomes the hub and syncs new devices', async () => {
    const a = new MemorySyncStore();
    const b = new MemorySyncStore();
    const ma = start(manager(a));
    await until(() => ma.getStatus().state === 'hub');
    const mb = start(manager(b));
    await until(() => connected(mb));
    ma.stop();
    await until(() => mb.getStatus().state === 'hub');
    const c = new MemorySyncStore();
    c.matches.set('backgammon/late', snap('late', 1));
    const mc = start(manager(c));
    await until(() => connected(mc) && b.matches.has('backgammon/late'));
    expect(ma.getStatus().state).toBe('off');
  });

  it('rejects a device with the wrong key', async () => {
    const a = new MemorySyncStore('alice-id', 'right-key');
    const b = new MemorySyncStore('alice-id', 'right-key');
    const ma = start(manager(a));
    await until(() => ma.getStatus().state === 'hub');
    // Same address (we cheat: same key for the address), wrong secret for the MAC.
    const bad = new MemorySyncStore('alice-id', 'right-key');
    Object.defineProperty(bad, 'syncKey', { get: () => 'wrong-key' });
    // The address is derived from syncKey too, so force the impostor onto the hub's room by
    // giving it the right key for hosting/joining but a wrong one for authentication.
    const addressKey = 'right-key';
    const impostor = new SyncManager({
      store: new Proxy(bad, {
        get(target, prop) {
          if (prop === 'syncKey') return 'wrong-key';
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
      provider: {
        name: 'wrapped',
        host: async () => shared.host(await addressOf(addressKey)),
        join: async (_code, opts) => shared.join(await addressOf(addressKey), opts),
      },
      device: { id: 'impostor', label: 'Impostor' },
      backoff: { baseMs: 10, maxMs: 40 },
      pushDebounceMs: 5,
    });
    managers.push(impostor);
    bad.matches.set('backgammon/evil', snap('evil', 1));
    impostor.start();
    await flush(60);
    expect(a.matches.has('backgammon/evil')).toBe(false);
    expect(ma.getStatus().devices).toHaveLength(0);
    expect(impostor.getStatus().devices).toHaveLength(0);
    // Both sides verify; whichever finishes first hangs up, so at least one records the failure.
    expect([ma, impostor].some((m) => /wrong key/.test(m.getStatus().lastError ?? ''))).toBe(true);
    // A legitimate device still connects fine.
    const mb = start(manager(b));
    await until(() => connected(mb));
  });

  it('stop() is clean and start() is idempotent', async () => {
    const a = new MemorySyncStore();
    const ma = manager(a);
    managers.push(ma);
    ma.start();
    ma.start();
    await until(() => ma.getStatus().state === 'hub');
    ma.stop('paused');
    expect(ma.getStatus()).toMatchObject({ state: 'off', devices: [], reason: 'paused' });
    ma.start();
    await until(() => ma.getStatus().state === 'hub');
  });
});

async function addressOf(key: string): Promise<string> {
  const { syncAddress } = await import('./crypto');
  return syncAddress(key);
}
