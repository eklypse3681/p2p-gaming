import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadSettings() {
  vi.resetModules();
  return import('./settings');
}

describe('settings', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('keys settings by player slug, with a global fallback', async () => {
    const { settingsKey } = await loadSettings();
    expect(settingsKey('steve')).toBe('bgf:settings:steve');
    expect(settingsKey('')).toBe('bgf:settings');
  });

  it('keeps players isolated', async () => {
    const { getSettings, updateSettings } = await loadSettings();
    updateSettings('alice', { boardSet: 'walnut-green', pieceSet: 'sky-navy' });
    updateSettings('bob', { flipBoard: true });
    expect(getSettings('alice').boardSet).toBe('walnut-green');
    expect(getSettings('alice').pieceSet).toBe('sky-navy');
    expect(getSettings('alice').flipBoard).toBe(false);
    expect(getSettings('bob').boardSet).toBe('midnight-slate');
    expect(getSettings('bob').flipBoard).toBe(true);
    expect(JSON.parse(localStorage.getItem('bgf:settings:alice')!).pieceSet).toBe('sky-navy');
    expect(JSON.parse(localStorage.getItem('bgf:settings:bob')!).flipBoard).toBe(true);
    expect(localStorage.getItem('bgf:settings')).toBeNull();
  });

  it('defaults the home-side preference to following the table', async () => {
    const { getSettings } = await loadSettings();
    expect(getSettings('x').homeSidePreference).toBe('table');
  });

  it('migrates a stored per-viewer homeSide into an explicit preference', async () => {
    localStorage.setItem(
      'bgf:settings:x',
      JSON.stringify({ themeId: 'classic', homeSide: 'right' }),
    );
    const { getSettings } = await loadSettings();
    const s = getSettings('x');
    expect(s.homeSidePreference).toBe('right');
    expect('homeSide' in s).toBe(false);
    expect('themeId' in s).toBe(false);
  });

  it('migrates a legacy themeId into look, board set and piece set', async () => {
    localStorage.setItem('bgf:settings:a', JSON.stringify({ themeId: 'classic' }));
    localStorage.setItem('bgf:settings:b', JSON.stringify({ themeId: 'midnight' }));
    localStorage.setItem('bgf:settings:c', JSON.stringify({ themeId: 'no-such-theme' }));
    localStorage.setItem('bgf:settings:d', JSON.stringify({ themeId: 'paper/marine/sky-navy' }));
    localStorage.setItem(
      'bgf:settings:e',
      JSON.stringify({
        themeId: 'classic',
        look: 'slate',
        boardSet: 'carbon',
        pieceSet: 'jade-charcoal',
      }),
    );
    const { getSettings, DEFAULT_SETTINGS } = await loadSettings();
    expect(getSettings('a')).toMatchObject({
      look: 'warm-light',
      boardSet: 'walnut-green',
      pieceSet: 'ivory-ebony',
    });
    expect(getSettings('b')).toMatchObject({
      look: 'midnight',
      boardSet: 'midnight-slate',
      pieceSet: 'pearl-obsidian',
    });
    expect(getSettings('c')).toMatchObject({
      look: DEFAULT_SETTINGS.look,
      boardSet: DEFAULT_SETTINGS.boardSet,
      pieceSet: DEFAULT_SETTINGS.pieceSet,
    });
    expect(getSettings('d')).toMatchObject({
      look: 'paper',
      boardSet: 'marine',
      pieceSet: 'sky-navy',
    });
    // explicit parts win over a stale themeId
    expect(getSettings('e')).toMatchObject({
      look: 'slate',
      boardSet: 'carbon',
      pieceSet: 'jade-charcoal',
    });
  });

  it('persists the three appearance ids', async () => {
    const { getSettings, updateSettings } = await loadSettings();
    updateSettings('x', { look: 'paper', boardSet: 'oak-sand', pieceSet: 'rose-gold-graphite' });
    const stored = JSON.parse(localStorage.getItem('bgf:settings:x')!);
    expect(stored).toMatchObject({
      look: 'paper',
      boardSet: 'oak-sand',
      pieceSet: 'rose-gold-graphite',
    });
    expect(getSettings('x').look).toBe('paper');
  });

  it('leaves an explicit preference alone even if a legacy value is also present', async () => {
    localStorage.setItem(
      'bgf:settings:x',
      JSON.stringify({ homeSide: 'right', homeSidePreference: 'table' }),
    );
    const { getSettings } = await loadSettings();
    expect(getSettings('x').homeSidePreference).toBe('table');
  });

  it('persists preference changes and resets per player', async () => {
    const { getSettings, updateSettings, resetSettings } = await loadSettings();
    updateSettings('x', { homeSidePreference: 'left' });
    expect(getSettings('x').homeSidePreference).toBe('left');
    expect(JSON.parse(localStorage.getItem('bgf:settings:x') ?? '{}').homeSidePreference).toBe(
      'left',
    );
    resetSettings('x');
    expect(getSettings('x').homeSidePreference).toBe('table');
  });

  it('resolves the effective side from the preference and the table', async () => {
    const { effectiveHomeSide } = await loadSettings();
    expect(effectiveHomeSide('table', 'left')).toBe('left');
    expect(effectiveHomeSide('table', 'right')).toBe('right');
    expect(effectiveHomeSide('left', 'right')).toBe('left');
    expect(effectiveHomeSide('right', 'left')).toBe('right');
  });
});
