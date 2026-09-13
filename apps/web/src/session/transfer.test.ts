import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { createIdbKeyvalMock } from '../test/idbKeyvalMock';
import type { MatchSnapshot } from '@bgf/protocol';
import { newMatch } from '@bgf/engine';

vi.mock('idb-keyval', async () => {
  const { createIdbKeyvalMock } = await import('../test/idbKeyvalMock');
  return createIdbKeyvalMock();
});
import * as idbMocked from 'idb-keyval';
const mock = idbMocked as unknown as ReturnType<typeof createIdbKeyvalMock>;

import {
  EXPORT_FORMAT,
  IDENTITY_PREFIX,
  encodeIdentityCode,
  identityCodeFor,
  TRANSFER_PREFIX,
  TransferError,
  decodeTransferCode,
  describeImport,
  encodeTransferCode,
  exportFileName,
  exportFromTransferCode,
  exportProfile,
  importFromText,
  importProfile,
  parseProfileExport,
  sanitizeSettings,
  transferCodeFor,
} from './transfer';
import type { ProfileExport } from './transfer';
import { createProfile, getProfile, getProfilesIndex, resetProfilesForTests } from './profiles';
import {
  DEFAULT_SETTINGS,
  getSettings,
  resetSettingsCacheForTests,
  updateSettings,
} from './settings';
import { getMatchStore, setMatchStoreForTests } from './matchStore';

function snap(id: string, seq: number, updatedAt = 1000): MatchSnapshot {
  const match = newMatch({ length: 3 });
  return {
    id,
    code: `C${id.toUpperCase()}`,
    seq,
    createdAt: updatedAt - 100,
    updatedAt,
    config: match.config,
    players: { white: { id: 'alice-id', name: 'Alice' }, black: null },
    hostSeat: 'white',
    actions: [],
    match,
    chat: [],
  };
}

const identity = { id: 'alice-id', name: 'Alice', avatar: '🦊', createdAt: 5 };

function exportOf(overrides: Partial<ProfileExport> = {}): ProfileExport {
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: 10,
    profile: identity,
    settings: { ...DEFAULT_SETTINGS, look: 'paper', boardSet: 'marine' },
    matches: {},
    ...overrides,
  };
}

describe('transfer codes', () => {
  it('round-trips identity and settings and rejects garbage', () => {
    const settings = { ...DEFAULT_SETTINGS, look: 'slate', pieceSet: 'sky-navy' };
    const code = encodeTransferCode(identity, settings);
    expect(code.startsWith(TRANSFER_PREFIX)).toBe(true);
    expect(code).not.toMatch(/[+/=]/); // base64url, safe to paste anywhere
    expect(decodeTransferCode(code)).toEqual({ profile: identity, settings });
    expect(decodeTransferCode(`  ${code}\n`)).toEqual({ profile: identity, settings });
    expect(decodeTransferCode(encodeTransferCode(identity))).toEqual({ profile: identity });

    expect(() => decodeTransferCode('hello')).toThrow(TransferError);
    expect(() => decodeTransferCode(`${TRANSFER_PREFIX}!!!not-base64!!!`)).toThrow(/damaged/);
    // Valid base64 of the wrong shape
    expect(() => decodeTransferCode(`${TRANSFER_PREFIX}${btoa('{"x":1}')}`)).toThrow(/identity/);
    // Tampered payload
    const tampered = code.slice(0, -4) + 'AAAA';
    expect(() => decodeTransferCode(tampered)).toThrow(TransferError);
  });

  it('a code without settings imports with default settings', () => {
    const data = exportFromTransferCode(encodeTransferCode(identity), 77);
    expect(data.settings).toEqual(DEFAULT_SETTINGS);
    expect(data.matches).toEqual({});
    expect(data.exportedAt).toBe(77);
    expect(data.profile).toEqual(identity);
  });
});

describe('parseProfileExport', () => {
  it('accepts objects and JSON text, filling defaults', () => {
    const parsed = parseProfileExport(
      JSON.stringify(exportOf({ matches: { backgammon: [snap('m1', 3)] } })),
    );
    expect(parsed.profile).toEqual(identity);
    expect(parsed.settings.look).toBe('paper');
    expect(parsed.matches.backgammon?.[0]?.id).toBe('m1');
    const minimal = parseProfileExport({
      format: EXPORT_FORMAT,
      version: 1,
      profile: { id: 'x', name: '  Bob  ' },
    });
    expect(minimal.profile.name).toBe('Bob');
    expect(minimal.profile.avatar).toBeTruthy();
    expect(minimal.settings).toEqual(DEFAULT_SETTINGS);
    expect(minimal.matches).toEqual({});
  });

  it('rejects the wrong format, version, identity or match shapes', () => {
    expect(() => parseProfileExport('not json')).toThrow(/not a P2P Gaming/);
    expect(() => parseProfileExport({ format: 'other', version: 1, profile: identity })).toThrow(
      /not a P2P Gaming/,
    );
    expect(() => parseProfileExport(exportOf({ version: 2 as never }))).toThrow(/version 2/);
    expect(() => parseProfileExport(exportOf({ profile: { ...identity, id: '' } }))).toThrow(
      /no id/,
    );
    expect(() => parseProfileExport(exportOf({ profile: { ...identity, name: '   ' } }))).toThrow(
      /no name/,
    );
    expect(() =>
      parseProfileExport(exportOf({ matches: { backgammon: [{ id: 'm1' }] } as never })),
    ).toThrow(/malformed/);
    expect(() => parseProfileExport(exportOf({ matches: 'nope' as never }))).toThrow(/malformed/);
  });

  it('ignores games this build does not know and sanitises settings', () => {
    const parsed = parseProfileExport(
      exportOf({
        matches: { chess: [snap('c1', 1)], backgammon: [snap('m1', 1)] } as never,
        settings: {
          look: 'paper',
          bogus: true,
          sound: 'yes',
          peer: { host: 'h', port: 9 },
        } as never,
      }),
    );
    expect(Object.keys(parsed.matches)).toEqual(['backgammon']);
    expect(parsed.settings.look).toBe('paper');
    expect(parsed.settings.sound).toBe(DEFAULT_SETTINGS.sound); // wrong type → default
    expect((parsed.settings as unknown as Record<string, unknown>).bogus).toBeUndefined();
    expect(parsed.settings.peer).toEqual({ ...DEFAULT_SETTINGS.peer, host: 'h' }); // port wrong type
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ themeId: 'classic' }).look).toBe('warm-light'); // legacy migration applies
  });
});

describe('import / export', () => {
  beforeEach(() => {
    localStorage.clear();
    mock.dbs.clear();
    setMatchStoreForTests();
    resetSettingsCacheForTests();
    resetProfilesForTests();
  });

  it('creates a new player with the imported id, settings and matches', async () => {
    const result = await importProfile(
      exportOf({ matches: { backgammon: [snap('m1', 2), snap('m2', 1)] } }),
      { now: 500 },
    );
    expect(result).toEqual({
      slug: 'alice',
      created: true,
      matchesAdded: 2,
      matchesUpdated: 0,
      matchesSkipped: 0,
    });
    expect(getProfile('alice')).toMatchObject({ id: 'alice-id', name: 'Alice', avatar: '🦊' });
    expect(getSettings('alice').look).toBe('paper');
    expect(JSON.parse(localStorage.getItem('bgf:settings:alice') ?? '{}').boardSet).toBe('marine');
    expect((await getMatchStore('alice', 'backgammon').list()).map((m) => m.id).sort()).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('a different player with the same name gets the next free slug', async () => {
    createProfile('Alice', { id: 'someone-else' });
    const result = await importProfile(exportOf());
    expect(result.slug).toBe('alice-2');
    expect(result.created).toBe(true);
    expect(getProfilesIndex()['alice']?.id).toBe('someone-else');
    expect(getProfilesIndex()['alice-2']?.id).toBe('alice-id');
  });

  it('merges into an existing player with the same id: identity updated, settings kept, newer matches win', async () => {
    createProfile('Ally', { slug: 'ally', id: 'alice-id', avatar: '🐸' });
    updateSettings('ally', { look: 'slate' });
    const store = getMatchStore('ally', 'backgammon');
    await store.put(snap('m1', 5)); // ours is newer
    await store.put(snap('m2', 1)); // theirs is newer
    await store.put(snap('m3', 4)); // equal → keep ours

    const result = await importProfile(
      exportOf({
        matches: { backgammon: [snap('m1', 2), snap('m2', 3), snap('m3', 4), snap('m4', 1)] },
      }),
    );
    expect(result).toEqual({
      slug: 'ally',
      created: false,
      matchesAdded: 1,
      matchesUpdated: 1,
      matchesSkipped: 2,
    });
    expect(getProfile('ally')).toMatchObject({ name: 'Alice', avatar: '🦊', id: 'alice-id' });
    expect(getSettings('ally').look).toBe('slate'); // not replaced when merging
    expect((await store.get('m1'))?.seq).toBe(5);
    expect((await store.get('m2'))?.seq).toBe(3);
    expect((await store.get('m3'))?.seq).toBe(4);
    expect((await store.get('m4'))?.seq).toBe(1);
    expect(Object.keys(getProfilesIndex())).toEqual(['ally']); // no duplicate player
  });

  it('replaceSettings overrides the merge default either way', async () => {
    createProfile('Ally', { slug: 'ally', id: 'alice-id' });
    updateSettings('ally', { look: 'slate' });
    await importProfile(exportOf(), { replaceSettings: true });
    expect(getSettings('ally').look).toBe('paper');

    await importProfile(exportOf({ profile: { ...identity, id: 'new-id', name: 'Newbie' } }), {
      replaceSettings: false,
    });
    expect(getSettings('newbie')).toEqual(DEFAULT_SETTINGS);
  });

  it('exports identity, settings and every saved match, and round-trips through a file', async () => {
    createProfile('Alice', { id: 'alice-id', avatar: '🦊', now: 5 });
    updateSettings('alice', { look: 'paper', boardSet: 'marine' });
    await getMatchStore('alice', 'backgammon').put(snap('m1', 3));
    const data = await exportProfile('alice', 99);
    expect(data.format).toBe(EXPORT_FORMAT);
    expect(data.version).toBe(1);
    expect(data.exportedAt).toBe(99);
    expect(data.profile).toMatchObject({
      id: 'alice-id',
      name: 'Alice',
      avatar: '🦊',
      createdAt: 5,
    });
    expect(data.profile.syncKey).toBe(getProfile('alice')!.syncKey);
    expect(data.settings.look).toBe('paper');
    expect(data.matches.backgammon?.map((m) => m.id)).toEqual(['m1']);
    expect(exportFileName('alice')).toBe('p2p-gaming-alice.json');

    // Another browser: nothing there yet.
    localStorage.clear();
    mock.dbs.clear();
    setMatchStoreForTests();
    resetSettingsCacheForTests();
    resetProfilesForTests();
    const result = await importFromText(JSON.stringify(data));
    expect(result.slug).toBe('alice');
    expect(getProfile('alice')?.id).toBe('alice-id');
    expect(getSettings('alice').boardSet).toBe('marine');
    expect((await getMatchStore('alice', 'backgammon').get('m1'))?.seq).toBe(3);
    await expect(exportProfile('nobody')).rejects.toThrow(/no player/);
  });

  it('importFromText accepts a transfer code too', async () => {
    createProfile('Alice', { id: 'alice-id', avatar: '🦊' });
    updateSettings('alice', { pieceSet: 'sky-navy' });
    const code = transferCodeFor('alice');
    localStorage.clear();
    resetSettingsCacheForTests();
    resetProfilesForTests();
    const result = await importFromText(`\n${code}\n`);
    expect(result).toMatchObject({ slug: 'alice', created: true, matchesAdded: 0 });
    expect(getSettings('alice').pieceSet).toBe('sky-navy');
    expect(describeImport(result, 'Alice')).toBe('Imported Alice as #/alice/');
    expect(
      describeImport(
        { slug: 'a', created: false, matchesAdded: 2, matchesUpdated: 1, matchesSkipped: 0 },
        'A',
      ),
    ).toBe('Updated A as #/a/ (2 matches added, 1 updated)');
    await expect(importFromText('junk')).rejects.toThrow(TransferError);
  });
});

describe('identity codes (hand-off)', () => {
  it('round-trips id, name and avatar and imports as the same player', async () => {
    const { encodeIdentityCode, identityCodeFor, isTransferCode } = await import('./transfer');
    const code = encodeIdentityCode({ id: 'phone-id', name: 'Dana', avatar: '🦉' });
    expect(code.startsWith(IDENTITY_PREFIX)).toBe(true);
    expect(isTransferCode(code)).toBe(true);
    expect(decodeTransferCode(code)).toEqual({
      profile: expect.objectContaining({ id: 'phone-id', name: 'Dana', avatar: '🦉' }),
    });
    const result = await importFromText(code);
    expect(result.created).toBe(true);
    expect(getProfilesIndex()[result.slug]).toMatchObject({ id: 'phone-id', name: 'Dana' });
    expect(getSettings(result.slug)).toEqual(DEFAULT_SETTINGS);
    // Importing again merges: settings are left alone, the name follows the code.
    updateSettings(result.slug, { pieceSet: 'sky-navy' });
    const again = await importFromText(encodeIdentityCode({ id: 'phone-id', name: 'Dana K' }));
    expect(again.created).toBe(false);
    expect(again.slug).toBe(result.slug);
    expect(getProfilesIndex()[result.slug]!.name).toBe('Dana K');
    expect(getSettings(result.slug).pieceSet).toBe('sky-navy');
    expect(identityCodeFor(result.slug).startsWith(IDENTITY_PREFIX)).toBe(true);
  });

  it('rejects damaged identity codes', () => {
    expect(() => decodeTransferCode(`${IDENTITY_PREFIX}!!!`)).toThrow(TransferError);
    expect(() => decodeTransferCode(`${IDENTITY_PREFIX}e30`)).toThrow(/no id/);
  });
});

describe('sync key travels only in your own codes', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSettingsCacheForTests();
    resetProfilesForTests();
    setMatchStoreForTests();
  });

  it('transfer and identity codes carry the key; importing adopts it', async () => {
    createProfile('Alice', { id: 'alice-id', syncKey: 'key-from-laptop' });
    const transfer = transferCodeFor('alice');
    expect(decodeTransferCode(transfer).profile.syncKey).toBe('key-from-laptop');
    const identity = identityCodeFor('alice');
    expect(identity.startsWith(IDENTITY_PREFIX)).toBe(true);
    expect(decodeTransferCode(identity).profile.syncKey).toBe('key-from-laptop');

    // A fresh browser: created with the same id AND the same key.
    resetProfilesForTests();
    const created = await importFromText(identity);
    expect(created.created).toBe(true);
    expect(getProfile(created.slug)).toMatchObject({ id: 'alice-id', syncKey: 'key-from-laptop' });

    // An existing copy with an older key adopts the incoming one (the owner rotated it).
    createProfile('Alice', { id: 'alice-id', syncKey: 'stale' });
    const merged = await importFromText(
      encodeIdentityCode({ id: 'alice-id', name: 'Alice', syncKey: 'rotated' }),
    );
    expect(merged.created).toBe(false);
    expect(getProfile(merged.slug)?.syncKey).toBe('rotated');
    // Codes without a key leave the local key alone.
    await importFromText(encodeIdentityCode({ id: 'alice-id', name: 'Alice' }));
    expect(getProfile(merged.slug)?.syncKey).toBe('rotated');
  });
});

describe('keys and password-locked players', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetSettingsCacheForTests();
    resetProfilesForTests();
    setMatchStoreForTests();
  });

  it('codes carry the key pair; an export of a locked player carries the encrypted block instead', async () => {
    const { ensureKeys, lockProfile, getSecrets } = await import('./profiles');
    createProfile('Alice', { id: 'alice-id', syncKey: 'sk' });
    const keys = (await ensureKeys('alice'))!;
    const decoded = decodeTransferCode(identityCodeFor('alice')).profile;
    expect(decoded.publicKey).toBe(keys.publicKey);
    expect(decoded.privateKey).toBe(keys.privateKey);
    expect(decodeTransferCode(transferCodeFor('alice')).profile.privateKey).toBe(keys.privateKey);

    await lockProfile('alice', 'open-sesame', { iterations: 1000 });
    // Still unlocked in this tab: codes work and stay plain.
    expect(decodeTransferCode(identityCodeFor('alice')).profile.privateKey).toBe(keys.privateKey);
    const exported = await exportProfile('alice');
    expect(exported.profile.privateKey).toBe(keys.privateKey);
    expect(exported.profile.secrets).toBeUndefined();
    // Locked in this tab: only the encrypted block can leave.
    const { lockNow } = await import('./profiles');
    lockNow('alice');
    expect(getSecrets('alice')).toBeNull();
    expect(() => identityCodeFor('alice')).toThrow(TransferError);
    expect(() => transferCodeFor('alice')).toThrow(/unlock/i);
    const lockedExport = await exportProfile('alice');
    expect(lockedExport.profile.privateKey).toBeUndefined();
    expect(lockedExport.profile.syncKey).toBeUndefined();
    expect(lockedExport.profile.secrets?.alg).toBe('pbkdf2-aes-gcm');

    // Importing that export elsewhere needs the password, and the player arrives locked but
    // usable in this tab.
    resetProfilesForTests();
    sessionStorage.clear();
    await expect(importProfile(lockedExport)).rejects.toMatchObject({ code: 'password-required' });
    await expect(importProfile(lockedExport, { password: 'nope' })).rejects.toMatchObject({
      code: 'wrong-password',
    });
    const result = await importProfile(lockedExport, { password: 'open-sesame' });
    expect(result.created).toBe(true);
    const record = getProfile(result.slug)!;
    expect(record.secrets?.alg).toBe('pbkdf2-aes-gcm');
    expect(record.publicKey).toBe(keys.publicKey);
    expect(record.privateKey).toBeUndefined();
    expect(getSecrets(result.slug)).toEqual({ privateKey: keys.privateKey, syncKey: 'sk' });
  });

  it('refuses to merge a different key for the same id unless the user confirms', async () => {
    const { ensureKeys, getSecrets } = await import('./profiles');
    createProfile('Alice', { id: 'alice-id', syncKey: 'sk' });
    const local = (await ensureKeys('alice'))!;
    const other = encodeIdentityCode({
      id: 'alice-id',
      name: 'Alice',
      publicKey: 'A'.repeat(87),
      privateKey: 'B'.repeat(40),
      syncKey: 'other-sk',
    });
    await expect(importFromText(other)).rejects.toMatchObject({ code: 'key-mismatch' });
    expect(getProfile('alice')!.publicKey).toBe(local.publicKey);
    expect(getSecrets('alice')!.syncKey).toBe('sk');
    const merged = await importFromText(other, { replaceKey: true });
    expect(merged.created).toBe(false);
    expect(getProfile('alice')!.publicKey).toBe('A'.repeat(87));
    expect(getSecrets('alice')).toEqual({ privateKey: 'B'.repeat(40), syncKey: 'other-sk' });
    // The same key again is not a mismatch.
    await expect(importFromText(other)).resolves.toMatchObject({ created: false });
  });

  it('updating a locked player from a code needs its password here', async () => {
    const { ensureKeys, lockProfile, lockNow, getSecrets } = await import('./profiles');
    createProfile('Alice', { id: 'alice-id', syncKey: 'sk' });
    const keys = (await ensureKeys('alice'))!;
    await lockProfile('alice', 'open-sesame', { iterations: 1000 });
    lockNow('alice');
    const code = encodeIdentityCode({
      id: 'alice-id',
      name: 'Alice',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      syncKey: 'rotated',
    });
    await expect(importFromText(code)).rejects.toMatchObject({ code: 'password-required' });
    await expect(importFromText(code, { password: 'nope' })).rejects.toMatchObject({
      code: 'wrong-password',
    });
    await importFromText(code, { password: 'open-sesame' });
    expect(getProfile('alice')!.secrets?.alg).toBe('pbkdf2-aes-gcm');
    expect(getSecrets('alice')).toBeNull(); // still locked in this tab
    const { unlockProfile } = await import('./profiles');
    expect(await unlockProfile('alice', 'open-sesame')).toBe(true);
    expect(getSecrets('alice')!.syncKey).toBe('rotated');
  });
});
