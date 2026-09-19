import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describeTrust } from '@bgf/table';
import { ofcDefinition } from '@bgf/ofc-engine';
import { backgammonDefinition } from '@bgf/server';
import { TrustBadge, TrustPanel } from './TrustPanel';

describe('TrustPanel / TrustBadge', () => {
  it('shows the level, title and every detail for a player-hosted hidden-information game', () => {
    const trust = describeTrust(ofcDefinition, {
      hostSeat: 0,
      randomness: { mode: 'per-draw', provider: 'random.org' },
    });
    render(<TrustPanel trust={trust} />);
    const panel = screen.getByTestId('trust-panel');
    expect(panel).toHaveAttribute('data-level', 'host-sees-hidden');
    expect(panel).toHaveTextContent('Host can see hidden cards');
    expect(panel).toHaveTextContent('not yet placed');
    expect(panel).toHaveTextContent('Pineapple discards');
    expect(panel).toHaveTextContent('Fantasyland');
    expect(panel).toHaveTextContent('nobody, host included, knows a card early');
  });

  it('is open for backgammon and dealer for a non-playing host', () => {
    render(<TrustPanel trust={describeTrust(backgammonDefinition, { hostSeat: 0 })} />);
    expect(screen.getByTestId('trust-panel')).toHaveAttribute('data-level', 'open');
    render(<TrustPanel trust={describeTrust(ofcDefinition, { hostSeat: null })} />);
    expect(screen.getAllByTestId('trust-panel')[1]).toHaveAttribute('data-level', 'dealer');
  });

  it('the badge opens the details on tap', async () => {
    const user = userEvent.setup();
    render(<TrustBadge trust={describeTrust(ofcDefinition, { hostSeat: 0 })} />);
    const badge = screen.getByTestId('trust-badge');
    expect(badge).toHaveAttribute('data-level', 'host-sees-hidden');
    expect(badge).toHaveAttribute('title', expect.stringContaining('Pineapple discards'));
    expect(screen.queryByTestId('trust-details')).toBeNull();
    await user.click(badge);
    expect(screen.getByTestId('trust-details')).toHaveTextContent('Host can see hidden cards');
  });
});
