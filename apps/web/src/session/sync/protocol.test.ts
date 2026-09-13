import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings';
import { MemorySyncStore, snap } from './testing';
import {
  SYNC_PROTOCOL,
  applyData,
  buildManifest,
  collectData,
  diffManifests,
  isEmptyData,
  isEmptyWant,
  mergeMatch,
  parseSyncMessage,
} from './protocol';

describe('sync protocol codec', () => {
  const hello = {
    type: 'sync-hello',
    protocol: SYNC_PROTOCOL,
    profileId: 'p',
    deviceId: 'd',
    deviceLabel: 'Chrome · macOS',
    nonce: 'a'.repeat(32),
  };

  it('accepts well-formed messages and rejects malformed ones', () => {
    expect(parseSyncMessage(hello)).toEqual(hello);
    expect(parseSyncMessage({ ...hello, nonce: 'zz' })).toBeNull();
    expect(parseSyncMessage({ ...hello, profileId: 5 })).toBeNull();
    expect(parseSyncMessage({ type: 'sync-auth', mac: 'f'.repeat(64) })).toEqual({
      type: 'sync-auth',
      mac: 'f'.repeat(64),
    });
    expect(parseSyncMessage({ type: 'sync-auth', mac: 'short' })).toBeNull();
    const manifest = {
      type: 'manifest',
      profile: { updatedAt: 1 },
      settings: { updatedAt: 2 },
      matches: { backgammon: [{ id: 'm', seq: 3, updatedAt: 4 }], chess: [{ id: 'x' }] },
    };
    expect(parseSyncMessage(manifest)).toEqual({
      type: 'manifest',
      profile: { updatedAt: 1 },
      settings: { updatedAt: 2 },
      matches: { backgammon: [{ id: 'm', seq: 3, updatedAt: 4 }] }, // unknown games dropped
    });
    expect(parseSyncMessage({ ...manifest, matches: { backgammon: [{ id: 'm' }] } })).toBeNull();
    expect(
      parseSyncMessage({ type: 'want', profile: 'yes', matches: { backgammon: ['a'] } }),
    ).toEqual({ type: 'want', profile: false, settings: false, matches: { backgammon: ['a'] } });
    expect(parseSyncMessage({ type: 'want', matches: { backgammon: [1] } })).toBeNull();
    const data = parseSyncMessage({
      type: 'data',
      profile: { name: 'Al', avatar: '🦊', updatedAt: 5 },
      settings: { settings: { look: 'paper', bogus: 1 }, updatedAt: 6 },
      matches: { backgammon: [snap('m1', 2)] },
    });
    expect(data).not.toBeNull();
    if (data?.type !== 'data') throw new Error('expected data');
    expect(data.profile).toEqual({ name: 'Al', avatar: '🦊', updatedAt: 5 });
    expect(data.settings?.settings.look).toBe('paper');
    expect((data.settings?.settings as unknown as Record<string, unknown>).bogus).toBeUndefined();
    expect(data.matches?.backgammon?.[0]?.id).toBe('m1');
    expect(
      parseSyncMessage({ type: 'data', matches: { backgammon: [{ id: 'nope' }] } }),
    ).toBeNull();
    expect(parseSyncMessage({ type: 'data', profile: { name: '', updatedAt: 1 } })).toBeNull();
    expect(parseSyncMessage({ type: 'bye' })).toEqual({ type: 'bye' });
    expect(parseSyncMessage({ type: 'launch-missiles' })).toBeNull();
    expect(parseSyncMessage('hello')).toBeNull();
    expect(parseSyncMessage(null)).toBeNull();
  });
});

describe('manifest diff and merge rules', () => {
  it('asks only for what is missing or newer', () => {
    const local = {
      profile: { updatedAt: 10 },
      settings: { updatedAt: 20 },
      matches: {
        backgammon: [
          { id: 'a', seq: 5, updatedAt: 1 },
          { id: 'b', seq: 2, updatedAt: 1 },
        ],
      },
    };
    const remote = {
      profile: { updatedAt: 11 },
      settings: { updatedAt: 20 },
      matches: {
        backgammon: [
          { id: 'a', seq: 5, updatedAt: 9 }, // equal seq: keep local even if "newer"
          { id: 'b', seq: 3, updatedAt: 1 }, // higher seq: want
          { id: 'c', seq: 1, updatedAt: 1 }, // missing: want
        ],
      },
    };
    const want = diffManifests(local, remote);
    expect(want).toEqual({ profile: true, settings: false, matches: { backgammon: ['b', 'c'] } });
    expect(isEmptyWant(want)).toBe(false);
    expect(diffManifests(remote, local)).toEqual({ profile: false, settings: false, matches: {} });
    expect(isEmptyWant(diffManifests(remote, local))).toBe(true);
  });

  it('mergeMatch: higher seq wins, equal keeps local', () => {
    expect(mergeMatch(undefined, snap('m', 1))).toBe('add');
    expect(mergeMatch(snap('m', 1), snap('m', 2))).toBe('update');
    expect(mergeMatch(snap('m', 2), snap('m', 2))).toBe('skip');
    expect(mergeMatch(snap('m', 3), snap('m', 2))).toBe('skip');
  });

  it('collects and applies data with last-write-wins for profile and settings', async () => {
    const store = new MemorySyncStore();
    store.matches.set('backgammon/a', snap('a', 5));
    store.matches.set('backgammon/b', snap('b', 2));
    const manifest = await buildManifest(store);
    expect(manifest.matches.backgammon?.map((r) => r.id).sort()).toEqual(['a', 'b']);
    const data = await collectData(store, {
      profile: true,
      settings: true,
      matches: { backgammon: ['a', 'missing'] },
    });
    expect(data.profile?.name).toBe('Alice');
    expect(data.settings?.updatedAt).toBe(10);
    expect(data.matches?.backgammon?.map((m) => m.id)).toEqual(['a']);
    expect(isEmptyData(data)).toBe(false);
    expect(isEmptyData({})).toBe(true);

    const other = new MemorySyncStore();
    other.matches.set('backgammon/a', snap('a', 7)); // newer locally
    other.profileData = { name: 'Old', avatar: '🦊', updatedAt: 3 };
    other.settingsData = { settings: { ...DEFAULT_SETTINGS }, updatedAt: 50 }; // newer locally
    const result = await applyData(other, {
      profile: { name: 'Alice', avatar: '🐙', updatedAt: 10 },
      settings: { settings: { ...DEFAULT_SETTINGS, look: 'paper' }, updatedAt: 10 },
      matches: { backgammon: [snap('a', 5), snap('b', 2), snap('c', 1)] },
    });
    expect(result).toEqual({
      profile: true,
      settings: false,
      matchesAdded: 2,
      matchesUpdated: 0,
      matchesSkipped: 1,
    });
    expect(other.profileData).toEqual({ name: 'Alice', avatar: '🐙', updatedAt: 10 });
    expect(other.settingsData.settings.look).toBe(DEFAULT_SETTINGS.look);
    expect(other.matches.get('backgammon/a')?.seq).toBe(7);
    // an update
    const r2 = await applyData(other, { matches: { backgammon: [snap('b', 9)] } });
    expect(r2.matchesUpdated).toBe(1);
    expect(other.matches.get('backgammon/b')?.seq).toBe(9);
  });
});
