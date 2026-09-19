import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cardKey } from '@bgf/ofc-engine';
import { FakeOfcClient, botPlacement } from './fakeOfcClient';
import { OfcTableDemo } from './OfcTableDemo';

describe('OfcTableDemo', () => {
  it('renders and lets the local player deal and play through a hand with instant bots', async () => {
    const user = userEvent.setup();
    render(<OfcTableDemo instant initialSeats={2} initialVariant="ofc" />);
    expect(screen.getByTestId('ofc-demo')).toBeInTheDocument();
    await user.click(screen.getByTestId('start-hand-button'));
    // The bots have played up to our turn (or we act first): either way we now hold 5 cards.
    expect(screen.getByTestId('pending-cards')).toBeInTheDocument();
    let guard = 0;
    while (screen.queryByTestId('showdown-panel') === null && guard++ < 20) {
      const cards = screen.getAllByTestId(/^pending-card-/);
      // place every dealt card: first ones bottom, then middle, then top
      for (const el of cards) {
        await user.click(el);
        const bottom = screen.getByTestId('row-0-bottom');
        const middle = screen.getByTestId('row-0-middle');
        const top = screen.getByTestId('row-0-top');
        const target = bottom.hasAttribute('data-drop')
          ? bottom
          : middle.hasAttribute('data-drop')
            ? middle
            : top;
        await user.click(target);
        if (screen.getByTestId('confirm-placement').hasAttribute('disabled') === false) break;
      }
      await user.click(screen.getByTestId('confirm-placement'));
    }
    expect(screen.getByTestId('showdown-panel')).toBeInTheDocument();
    expect(screen.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'showdown');
  });

  it('switching the variant starts a fresh table', async () => {
    const user = userEvent.setup();
    render(<OfcTableDemo instant />);
    await user.selectOptions(screen.getByTestId('demo-variant'), 'pineapple27');
    expect(screen.getByTestId('ofc-table')).toHaveAttribute('data-variant', 'pineapple27');
    expect(screen.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'lobby');
  });
});

describe('FakeOfcClient', () => {
  it('plays bots synchronously and keeps the view consistent with the engine', () => {
    const client = new FakeOfcClient({
      config: { variant: 'pineapple', seats: 3 },
      autoPlay: false,
      botDelayMs: 0,
    });
    client.apply(0, { type: 'start' });
    client.playBots();
    const st = client.getTableState();
    expect(st.hand!.toAct === 0 || st.hand!.seats[0]!.pending.length > 0).toBe(true);
    const mine = client.getState().snapshot!.state.hand!.seats[0]!.pending.map(cardKey);
    expect(mine).toEqual(st.hand!.seats[0]!.pending.map(cardKey));
    act(() => {
      client.apply(0, botPlacement(st, 0));
    });
    expect(client.getState().snapshot!.seq).toBeGreaterThan(0);
  });
});
