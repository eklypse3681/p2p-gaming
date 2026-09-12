import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProfile } from '../test/renderWithProfile';
import { Handoff } from './Handoff';
import { IDENTITY_PREFIX, decodeTransferCode } from '../session/transfer';
import { getProfile } from '../session/profiles';

describe('Handoff', () => {
  it('shows a QR code and a copyable hand-off link carrying this player', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProfile('alice', <Handoff code="ABC234" />, { game: 'backgammon' });
    const link = screen.getByTestId('handoff-link') as HTMLInputElement;
    expect(link.value).toContain(`#/backgammon/join/ABC234?import=${IDENTITY_PREFIX}`);
    const code = link.value.slice(link.value.indexOf('?import=') + '?import='.length);
    expect(decodeTransferCode(code).profile.id).toBe(getProfile('alice')!.id);
    await waitFor(() =>
      expect(screen.getByTestId('handoff-qr').querySelector('svg')).not.toBeNull(),
    );
    await userEvent.click(screen.getByTestId('copy-handoff'));
    expect(writeText).toHaveBeenCalledWith(link.value);
    expect(screen.getByTestId('copy-handoff')).toHaveTextContent('Copied');
  });
});
