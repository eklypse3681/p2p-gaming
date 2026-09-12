import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadProfiles() {
  vi.resetModules();
  return import('./profiles');
}

describe('slugs', () => {
  it('derives url-safe slugs from names', async () => {
    const { slugify, prettifySlug, isValidSlug } = await loadProfiles();
    expect(slugify('Steve')).toBe('steve');
    expect(slugify('  Steve   Becker ')).toBe('steve-becker');
    expect(slugify('Élan!?')).toBe('elan');
    expect(slugify('')).toBe('player');
    expect(slugify('🎲🎲')).toBe('player');
    expect(slugify('join')).toBe('join-1');
    expect(slugify('x'.repeat(50))).toHaveLength(32);
    expect(prettifySlug('steve-2')).toBe('Steve 2');
    expect(prettifySlug('bob')).toBe('Bob');
    expect(isValidSlug('a')).toBe(true);
    expect(isValidSlug('steve-2')).toBe(true);
    expect(isValidSlug('Steve')).toBe(false);
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('-steve')).toBe(false);
    expect(isValidSlug('join')).toBe(false);
    expect(isValidSlug('demo')).toBe(false);
    expect(isValidSlug('a'.repeat(33))).toBe(false);
  });

  it('resolves collisions with -2, -3, …', async () => {
    const { uniqueSlug } = await loadProfiles();
    expect(uniqueSlug('Steve', [])).toBe('steve');
    expect(uniqueSlug('Steve', ['steve'])).toBe('steve-2');
    expect(uniqueSlug('Steve', ['steve', 'steve-2'])).toBe('steve-3');
  });
});

describe('profiles index', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('creates, lists (most recent first), updates, touches and deletes players', async () => {
    const m = await loadProfiles();
    const a = m.createProfile('Alice', { now: 100 });
    const b = m.createProfile('Bob', { now: 200 });
    expect(a.slug).toBe('alice');
    expect(b.slug).toBe('bob');
    expect(a.id).not.toBe(b.id);
    expect(m.listProfiles().map((p) => p.slug)).toEqual(['bob', 'alice']);
    expect(JSON.parse(localStorage.getItem(m.PROFILES_KEY)!).alice.name).toBe('Alice');

    m.updateProfile('alice', { name: '  Alice  Smith ', avatar: '🦊' });
    expect(m.getProfile('alice')).toMatchObject({ name: 'Alice Smith', avatar: '🦊', id: a.id });
    m.updateProfile('alice', { name: '   ' });
    expect(m.getProfile('alice')?.name).toBe('Alice Smith');

    m.touchProfile('alice', 300);
    expect(m.listProfiles().map((p) => p.slug)).toEqual(['alice', 'bob']);

    localStorage.setItem('bgf:settings:bob', '{"themeId":"classic"}');
    m.deleteProfile('bob');
    expect(m.listProfiles().map((p) => p.slug)).toEqual(['alice']);
    expect(localStorage.getItem('bgf:settings:bob')).toBeNull();
    expect(m.toPlayerProfile(m.getProfile('alice')!)).toEqual({
      id: a.id,
      name: 'Alice Smith',
      avatar: '🦊',
    });
  });

  it('second player with the same name gets the next slug', async () => {
    const m = await loadProfiles();
    expect(m.createProfile('Steve').slug).toBe('steve');
    expect(m.createProfile('Steve').slug).toBe('steve-2');
    expect(m.createProfile('steve').slug).toBe('steve-3');
    expect(() => m.createProfile('')).toThrow();
    expect(() => m.createProfile('X', { slug: 'join' })).toThrow();
    expect(() => m.createProfile('X', { slug: 'steve' })).toThrow();
  });

  it('ensureProfile auto-creates an unknown slug with a pretty name and keeps a known one', async () => {
    const m = await loadProfiles();
    const created = m.ensureProfile('steve-2');
    expect(created.name).toBe('Steve 2');
    expect(m.getProfile('steve-2')).toEqual(created);
    expect(m.ensureProfile('steve-2')).toEqual(created);
    expect(() => m.ensureProfile('Nope!')).toThrow();
  });

  it('notifies subscribers', async () => {
    const m = await loadProfiles();
    const spy = vi.fn();
    const off = m.subscribeProfiles(spy);
    m.createProfile('Zoe');
    expect(spy).toHaveBeenCalledTimes(1);
    off();
    m.createProfile('Yan');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('legacy migration', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('turns bgf:profile and bgf:profile:<ns> keys into players and queues their databases', async () => {
    localStorage.setItem(
      'bgf:profile',
      JSON.stringify({ id: 'id-steve', name: 'Steve', avatar: '🦋' }),
    );
    localStorage.setItem('bgf:profile:guest', JSON.stringify({ id: 'id-bob', name: 'Bob' }));
    localStorage.setItem('bgf:profile:blank', JSON.stringify({ id: 'id-blank', name: '' }));
    localStorage.setItem('bgf:settings', JSON.stringify({ themeId: 'classic' }));
    const m = await loadProfiles();
    const index = m.getProfilesIndex();
    expect(Object.keys(index).sort()).toEqual(['blank', 'bob', 'steve']);
    expect(index.steve).toMatchObject({ id: 'id-steve', name: 'Steve', avatar: '🦋' });
    expect(index.bob).toMatchObject({ id: 'id-bob', name: 'Bob' });
    expect(index.bob!.avatar).toBeTruthy();
    expect(index.blank).toMatchObject({ id: 'id-blank', name: 'Blank' });
    expect(JSON.parse(localStorage.getItem('bgf:settings:steve')!)).toEqual({ themeId: 'classic' });
    expect(JSON.parse(localStorage.getItem('bgf:settings:bob')!)).toEqual({ themeId: 'classic' });
    const pending = JSON.parse(localStorage.getItem(m.PENDING_DB_MIGRATIONS_KEY)!);
    expect(pending).toEqual(
      expect.arrayContaining([
        { db: 'bgf', slug: 'steve' },
        { db: 'bgf-guest', slug: 'bob' },
        { db: 'bgf-blank', slug: 'blank' },
      ]),
    );
    expect(localStorage.getItem(m.MIGRATED_KEY)).toBe('1');
  });

  it('skips a nameless default profile and never runs twice', async () => {
    localStorage.setItem('bgf:profile', JSON.stringify({ id: 'id-anon', name: '' }));
    let m = await loadProfiles();
    expect(m.getProfilesIndex()).toEqual({});
    // A legacy key appearing later (or the index being cleared) does not re-trigger migration.
    localStorage.removeItem(m.PROFILES_KEY);
    localStorage.setItem('bgf:profile', JSON.stringify({ id: 'id-late', name: 'Late' }));
    m = await loadProfiles();
    expect(m.getProfilesIndex()).toEqual({});
  });
});
