import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SavePlayerPrompt } from './SavePlayerPrompt';
import { renderWithProfile } from '../test/renderWithProfile';
import { createProfile, recordPasskey, resetProfilesForTests } from '../session/profiles';
import * as passkey from '../session/passkey';

describe('SavePlayerPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetProfilesForTests();
    createProfile('Alice');
    vi.restoreAllMocks();
    vi.spyOn(passkey, 'backupsAvailable').mockResolvedValue(true);
    vi.spyOn(passkey, 'passkeysLikelyWork').mockResolvedValue(true);
  });

  it('asks a player with no passkey, and "Not now" lasts until the app is next opened', async () => {
    const first = renderWithProfile('alice', <SavePlayerPrompt />);
    expect(await screen.findByTestId('save-player-prompt')).toBeTruthy();
    await userEvent.click(screen.getByTestId('save-player-later'));
    expect(screen.queryByTestId('save-player-prompt')).toBeNull();
    first.unmount();
    renderWithProfile('alice', <SavePlayerPrompt />);
    await Promise.resolve();
    expect(screen.queryByTestId('save-player-prompt')).toBeNull();
    sessionStorage.clear();
  });

  it('comes back on the next visit after "Not now"', async () => {
    sessionStorage.clear();
    renderWithProfile('alice', <SavePlayerPrompt />);
    expect(await screen.findByTestId('save-player-prompt')).toBeTruthy();
  });

  it('stays away for good for a test player', async () => {
    const first = renderWithProfile('alice', <SavePlayerPrompt />);
    await userEvent.click(await screen.findByTestId('save-player-off'));
    first.unmount();
    sessionStorage.clear();
    renderWithProfile('alice', <SavePlayerPrompt />);
    await Promise.resolve();
    expect(screen.queryByTestId('save-player-prompt')).toBeNull();
  });

  it('does not ask once the player is saved, nor where backups are not set up', async () => {
    recordPasskey('alice', { credentialId: 'x', createdAt: 1 });
    const first = renderWithProfile('alice', <SavePlayerPrompt />);
    await Promise.resolve();
    expect(screen.queryByTestId('save-player-prompt')).toBeNull();
    first.unmount();
    resetProfilesForTests();
    createProfile('Alice');
    vi.spyOn(passkey, 'backupsAvailable').mockResolvedValue(false);
    renderWithProfile('alice', <SavePlayerPrompt />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('save-player-prompt')).toBeNull();
  });

  it('saves with one tap and goes away', async () => {
    const save = vi.spyOn(passkey, 'saveWithPasskey').mockResolvedValue();
    renderWithProfile('alice', <SavePlayerPrompt />);
    await userEvent.click(await screen.findByTestId('save-player-now'));
    expect(save).toHaveBeenCalledWith('alice');
    expect(screen.queryByTestId('save-player-prompt')).toBeNull();
  });
});
