import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PlayerCard } from './PlayerCard';
import type { PlayerCardProps } from './PlayerCard';

afterEach(cleanup);

const base: PlayerCardProps = {
  seat: 'black',
  name: 'Bob',
  isMe: false,
  present: true,
  connected: true,
  score: 0,
  pips: 167,
  onTurn: false,
};

describe('PlayerCard presence', () => {
  it('shows nothing extra while the player is here', () => {
    render(<PlayerCard {...base} />);
    expect(screen.getByTestId('player-card-black')).toHaveAttribute('data-presence', 'here');
    expect(screen.queryByTestId('presence-black')).not.toBeInTheDocument();
  });

  it('marks a seated player whose device dropped as away', () => {
    render(<PlayerCard {...base} connected={false} />);
    expect(screen.getByTestId('player-card-black')).toHaveAttribute('data-presence', 'away');
    expect(screen.getByTestId('presence-black')).toHaveTextContent('Away');
  });

  it('marks an empty seat as not here yet', () => {
    render(<PlayerCard {...base} present={false} connected={false} />);
    expect(screen.getByTestId('player-card-black')).toHaveAttribute('data-presence', 'empty');
    expect(screen.getByTestId('presence-black')).toHaveTextContent('Not here yet');
  });
});
