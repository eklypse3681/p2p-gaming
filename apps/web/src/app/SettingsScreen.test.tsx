import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsScreen } from './SettingsScreen';
import { renderWithProfile } from '../test/renderWithProfile';
import { resetSettings, resetSettingsCacheForTests, settingsKey } from '../session/settings';
import { createProfile, getProfile, resetProfilesForTests } from '../session/profiles';
import { getBoardSet, getLook, getPieceSet } from '../themes';

const KEY = settingsKey('alice');

/** Render the settings screen on a tab: '' for General, or a game id. */
function renderSettings(tab = '') {
  return renderWithProfile('alice', <SettingsScreen />, {
    route: tab ? `/settings/${tab}` : '/settings',
    uiPath: 'settings/:game?',
  });
}

describe('SettingsScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSettingsCacheForTests();
    resetSettings('alice');
    resetProfilesForTests();
    createProfile('Alice');
  });

  it('persists a chosen board and piece set for this player only and applies them', async () => {
    renderSettings('backgammon');
    await userEvent.click(screen.getByTestId('board-marine'));
    await userEvent.click(screen.getByTestId('pieces-sky-navy'));
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    expect(stored.boardSet).toBe('marine');
    expect(stored.pieceSet).toBe('sky-navy');
    expect(stored.look).toBe('midnight');
    expect(localStorage.getItem(settingsKey('bob'))).toBeNull();
    expect(document.documentElement.dataset.themeId).toBe('midnight/marine/sky-navy');
    expect(document.documentElement.style.getPropertyValue('--board-felt')).toBe(
      getBoardSet('marine').felt,
    );
    expect(document.documentElement.style.getPropertyValue('--piece-white-fill')).toBe(
      getPieceSet('sky-navy').white.fill,
    );
    expect(screen.getByTestId('board-marine')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('pieces-sky-navy')).toHaveAttribute('aria-checked', 'true');
  });

  it('a preset sets all three parts and a look switches the chrome', async () => {
    renderSettings('backgammon');
    await userEvent.click(screen.getByTestId('preset-classic'));
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')).toMatchObject({
      look: 'warm-light',
      boardSet: 'walnut-green',
      pieceSet: 'ivory-ebony',
    });
    expect(document.documentElement.dataset.themeId).toBe('classic');
    expect(screen.getByTestId('preset-classic')).toHaveAttribute('aria-pressed', 'true');
    // The look is the whole app's, so it lives on the General tab.
    await userEvent.click(screen.getByTestId('settings-tab-general'));
    await userEvent.click(screen.getByTestId('look-paper'));
    expect(document.documentElement.style.getPropertyValue('--ui-accent')).toBe(
      getLook('paper').ui.accent,
    );
    expect(document.documentElement.dataset.themeId).toBe('paper/walnut-green/ivory-ebony');
    await userEvent.click(screen.getByTestId('settings-tab-backgammon'));
    expect(screen.getByTestId('preset-classic')).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggles flip board and reduced motion', async () => {
    renderSettings('backgammon');
    await userEvent.click(screen.getByRole('switch', { name: 'Flip board' }));
    await userEvent.click(screen.getByTestId('settings-tab-general'));
    await userEvent.selectOptions(screen.getByTestId('reduced-motion-select'), 'on');
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    expect(stored.flipBoard).toBe(true);
    expect(stored.reducedMotion).toBe('on');
    expect(document.documentElement.dataset.reducedMotion).toBe('true');
  });

  it('defaults the home board side to following the table and persists an override', async () => {
    renderSettings('backgammon');
    expect(screen.getByTestId('home-side-table')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('home-side-left')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('home-side-right')).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(screen.getByTestId('home-side-right'));
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    expect(stored.homeSidePreference).toBe('right');
    expect(screen.getByTestId('home-side-right')).toHaveAttribute('aria-checked', 'true');
  });

  it('edits the player name and avatar, and can remove the player', async () => {
    renderSettings();
    expect(screen.getByTestId('profile-section')).toHaveTextContent('#/alice/');
    await userEvent.clear(screen.getByTestId('player-name-input'));
    await userEvent.type(screen.getByTestId('player-name-input'), 'Alicia');
    expect(getProfile('alice')?.name).toBe('Alicia');
    await userEvent.click(screen.getByTestId('avatar-🦊'));
    expect(getProfile('alice')?.avatar).toBe('🦊');
    await userEvent.click(screen.getByTestId('remove-profile'));
    await userEvent.click(screen.getByTestId('remove-profile-confirm'));
    expect(getProfile('alice')).toBeNull();
    expect(screen.getByTestId('picker-route')).toBeInTheDocument();
  });
});

describe('SettingsScreen tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSettingsCacheForTests();
    resetSettings('alice');
    resetProfilesForTests();
    createProfile('Alice');
  });

  it('keeps each game’s settings off the General tab', () => {
    renderSettings();
    expect(screen.getByTestId('settings-tab-general')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('settings-tab-backgammon')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-ofc')).toBeInTheDocument();
    expect(screen.getByTestId('look-paper')).toBeInTheDocument();
    expect(screen.queryByTestId('board-marine')).toBeNull();
    expect(screen.queryByTestId('home-side-table')).toBeNull();
    expect(screen.queryByTestId('ofc-settings')).toBeNull();
  });

  it('shows only that game’s settings on its tab', () => {
    renderSettings('backgammon');
    expect(screen.getByTestId('settings-tab-backgammon')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('board-marine')).toBeInTheDocument();
    expect(screen.queryByTestId('look-paper')).toBeNull();
    expect(screen.queryByTestId('profile-section')).toBeNull();
    expect(screen.queryByTestId('ofc-settings')).toBeNull();
  });

  it('persists the OFC deck colours and tray sort', async () => {
    renderSettings('ofc');
    expect(screen.queryByTestId('board-marine')).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Four-colour deck' }));
    await userEvent.selectOptions(screen.getByTestId('ofc-tray-sort'), 'suit');
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')).toMatchObject({
      ofcFourColor: true,
      ofcTraySort: 'suit',
    });
  });

  it('falls back to General for a game it does not know', () => {
    renderSettings('chess');
    expect(screen.getByTestId('profile-section')).toBeInTheDocument();
  });
});

describe('SettingsScreen transfer', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSettingsCacheForTests();
    resetSettings('alice');
    resetProfilesForTests();
    createProfile('Alice', { id: 'alice-id', avatar: '🦊' });
  });

  it('exports the player as a JSON download', async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:fake';
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderSettings('backgammon');
    await userEvent.click(screen.getByTestId('board-marine'));
    await userEvent.click(screen.getByTestId('settings-tab-general'));
    await userEvent.click(screen.getByTestId('export-profile'));
    expect(await screen.findByTestId('transfer-note')).toHaveTextContent('p2p-gaming-alice.json');
    expect(click).toHaveBeenCalledTimes(1);
    expect(blobs).toHaveLength(1);
    const data = JSON.parse(await blobs[0]!.text());
    expect(data).toMatchObject({
      format: 'p2p-gaming-profile',
      version: 1,
      profile: { id: 'alice-id', name: 'Alice', avatar: '🦊' },
      settings: { boardSet: 'marine' },
      matches: {},
    });
    click.mockRestore();
  });

  it('copies a transfer code and shows it as a fallback', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderSettings();
    await userEvent.click(screen.getByTestId('copy-transfer-code'));
    const code = (await screen.findByTestId('transfer-code')) as HTMLTextAreaElement;
    expect(code.value.startsWith('p2pg1.')).toBe(true);
    expect(writeText).toHaveBeenCalledWith(code.value);
    const { decodeTransferCode } = await import('../session/transfer');
    expect(decodeTransferCode(code.value).profile).toMatchObject({ id: 'alice-id', name: 'Alice' });
    expect(screen.getByTestId('transfer-note')).toHaveTextContent(/copied/i);
  });

  it('has a Devices section: sync toggle persists and rotating the key changes it', async () => {
    renderSettings();
    const section = screen.getByTestId('sync-section');
    expect(section).toBeInTheDocument();
    // jsdom has no WebRTC, so the status explains why it is unavailable
    expect(screen.getByTestId('sync-status')).toHaveAttribute('data-state', 'off');
    await userEvent.click(screen.getByRole('switch', { name: /sync between my devices/i }));
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').sync).toBe(false);
    expect(screen.getByTestId('sync-status')).toHaveTextContent(/off/i);
    const before = getProfile('alice')!.syncKey;
    await userEvent.click(screen.getByTestId('rotate-sync-key'));
    await userEvent.click(screen.getByTestId('rotate-sync-key-confirm'));
    expect(getProfile('alice')!.syncKey).not.toBe(before);
    expect(screen.getByTestId('rotate-note')).toBeInTheDocument();
  });
});

describe('SettingsScreen: randomness', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSettingsCacheForTests();
    resetSettings('alice');
    resetProfilesForTests();
    createProfile('Alice');
  });

  it('persists source, mode, key and fallback per player; beacon needs drand', async () => {
    renderSettings();
    const section = screen.getByTestId('randomness-section');
    expect(section).toBeInTheDocument();
    expect(screen.getByTestId('source-crypto')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('mode-beacon')).toBeDisabled();
    await userEvent.click(screen.getByTestId('source-random-org'));
    await userEvent.type(screen.getByTestId('random-org-key'), 'my-key');
    await userEvent.click(screen.getByTestId('mode-seeded'));
    await userEvent.click(screen.getByTestId('fallback-toggle'));
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    expect(stored).toMatchObject({
      entropySource: 'random.org',
      randomnessMode: 'seeded',
      randomOrgKey: 'my-key',
      entropyFallback: true,
    });
    expect(screen.getByTestId('randomness-safety')).toHaveAttribute('data-safety', 'trusted-host');
    await userEvent.click(screen.getByTestId('source-drand'));
    expect(screen.getByTestId('mode-beacon')).not.toBeDisabled();
    await userEvent.click(screen.getByTestId('mode-beacon'));
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')).toMatchObject({
      entropySource: 'drand',
      randomnessMode: 'beacon',
    });
    expect(screen.getByTestId('randomness-safety')).toHaveAttribute('data-safety', 'safe');
    expect(localStorage.getItem(settingsKey('bob'))).toBeNull();
  });
});
