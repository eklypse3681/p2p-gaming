import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Command, TableConfig, TableState } from '@bgf/ofc-engine';
import { applyAll, cardKey, command, seededRng, view } from '@bgf/ofc-engine';
import { FakeOfcClient, botPlacement } from '../demo/fakeOfcClient';
import { OfcTable } from './OfcTable';

function tableFor(config: Partial<TableConfig>, opts: { seat?: number; seed?: number } = {}) {
  const client = new FakeOfcClient({
    config,
    mySeat: opts.seat ?? 0,
    autoPlay: false,
    botDelayMs: 0,
    seed: opts.seed ?? 21,
  });
  return client;
}

function Harness({
  client,
  send,
  onOpenLedger,
}: {
  client: FakeOfcClient;
  send?: (c: Command) => void;
  onOpenLedger?: () => void;
}) {
  return (
    <OfcTable
      state={client.getState()}
      send={send ?? client.send}
      names={client.names}
      mySeat={client.mySeat}
      reducedMotion
      onOpenLedger={onOpenLedger}
    />
  );
}

/** Advance the engine until it is seat 0's turn in a fresh pineapple hand. */
function dealToMe(client: FakeOfcClient) {
  client.apply(0, { type: 'start' });
  client.playBots();
}

describe('OfcTable', () => {
  it('renders the lobby with a deal button, then three seats with me at the bottom', () => {
    const client = tableFor({ variant: 'pineapple', seats: 3 });
    const { rerender } = render(<Harness client={client} />);
    expect(screen.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'lobby');
    expect(screen.getByTestId('start-hand-button')).toHaveTextContent('Deal first hand');
    expect(screen.getByTestId('turn-indicator')).toHaveTextContent('Waiting to start');

    act(() => dealToMe(client));
    rerender(<Harness client={client} />);
    const table = screen.getByTestId('ofc-table');
    expect(table).toHaveAttribute('data-phase', 'setting');
    expect(table).toHaveAttribute('data-seats', '3');
    const seats = screen.getAllByTestId(/^seat-\d$/);
    expect(seats).toHaveLength(3);
    expect(seats[2]).toHaveAttribute('data-me', 'true');
    expect(seats[0]).toHaveAttribute('data-me', 'false');
    expect(screen.getByTestId('deck-count')).toHaveTextContent('37');
    expect(screen.getByTestId('hand-number')).toHaveTextContent('Hand 1');
    // Opponents' undealt cards are hidden stacks; anything they set is open face; mine are in the tray.
    for (const seat of [1, 2]) {
      const sh = client.getTableState().hand!.seats[seat]!;
      if (sh.pending.length > 0) {
        expect(screen.getByTestId(`pending-hidden-${seat}`)).toHaveAttribute(
          'data-count',
          String(sh.pending.length),
        );
      } else {
        expect(Number(screen.getByTestId(`row-${seat}-bottom`).getAttribute('data-count'))).toBe(
          sh.rows.bottom.length,
        );
      }
    }
    expect(
      within(screen.getByTestId('pending-cards')).getAllByTestId(/^pending-card-/),
    ).toHaveLength(5);
    expect(screen.getByTestId('confirm-placement')).toBeDisabled();
    for (const row of ['top', 'middle', 'bottom']) {
      expect(screen.getByTestId(`row-0-${row}`)).toHaveAttribute('data-drop', 'true');
      expect(screen.getByTestId(`row-1-${row}`)).not.toHaveAttribute('data-drop');
    }
  });

  it('renders two seats and labels the 2-7 middle', () => {
    const client = tableFor({ variant: 'pineapple27', seats: 2 });
    act(() => dealToMe(client));
    render(<Harness client={client} />);
    expect(screen.getAllByTestId(/^seat-\d$/)).toHaveLength(2);
    expect(screen.getByTestId('row-0-middle')).toHaveTextContent('Middle · 2-7');
  });

  it('tap-then-tap places the initial five and confirm sends the placement', async () => {
    const user = userEvent.setup();
    const client = tableFor({ variant: 'pineapple', seats: 2 });
    act(() => dealToMe(client));
    const sent: Command[] = [];
    const { rerender } = render(<Harness client={client} send={(c) => sent.push(c)} />);
    const pending = client.getState().snapshot!.state.hand!.seats[0]!.pending;
    const rows = ['bottom', 'bottom', 'bottom', 'middle', 'top'] as const;
    for (let i = 0; i < 5; i++) {
      await user.click(screen.getByTestId(`pending-card-${cardKey(pending[i]!)}`));
      expect(screen.getByTestId(`pending-card-${cardKey(pending[i]!)}`)).toHaveAttribute(
        'data-selected',
        'true',
      );
      await user.click(screen.getByTestId(`row-0-${rows[i]}`));
    }
    expect(screen.getByTestId('row-0-bottom')).toHaveAttribute('data-count', '3');
    expect(screen.getByTestId('slot-0-bottom-2')).toHaveAttribute('data-provisional', 'true');
    expect(screen.getByTestId('confirm-placement')).toBeEnabled();
    await user.click(screen.getByTestId('confirm-placement'));
    expect(sent).toHaveLength(1);
    const cmd = sent[0] as Extract<Command, { type: 'place' }>;
    expect(cmd.placements.map((p) => p.row)).toEqual([...rows]);
    expect(cmd.discards).toEqual([]);
    // Apply it and check the rows are now committed (not provisional).
    act(() => {
      client.apply(0, cmd);
    });
    rerender(<Harness client={client} send={(c) => sent.push(c)} />);
    expect(screen.getByTestId('slot-0-bottom-2')).not.toHaveAttribute('data-provisional');
    expect(screen.getByTestId('turn-indicator')).toHaveTextContent(/Waiting for/);
  });

  it('pineapple turn: placing two derives the discard, keyboard works, undo re-enables', async () => {
    const user = userEvent.setup();
    const client = tableFor({ variant: 'pineapple', seats: 2 });
    act(() => {
      dealToMe(client);
      client.apply(0, botPlacement(client.getTableState(), 0));
      client.playBots();
    });
    const sent: Command[] = [];
    render(<Harness client={client} send={(c) => sent.push(c)} />);
    const three = client.getState().snapshot!.state.hand!.seats[0]!.pending;
    expect(three).toHaveLength(3);
    expect(screen.getByTestId('turn-indicator')).toHaveTextContent('place 2, discard 1');
    expect(screen.getByTestId('discard-slot')).toHaveAttribute('data-count', '0');
    // Keyboard: select a card and press the digit of a row with room, twice. The bot may have
    // filled any row with the first five cards, so pick the open rows from the state.
    const rows = client.getState().snapshot!.state.hand!.seats[0]!.rows;
    const capacity = { top: 3, middle: 5, bottom: 5 } as const;
    const digit = { top: '1', middle: '2', bottom: '3' } as const;
    const open: Array<'top' | 'middle' | 'bottom'> = [];
    for (const row of ['top', 'middle', 'bottom'] as const) {
      for (let k = rows[row].length; k < capacity[row]; k++) open.push(row);
    }
    const [rowA, rowB] = [open[0]!, open[1]!];
    await user.click(screen.getByTestId(`pending-card-${cardKey(three[0]!)}`));
    fireEvent.keyDown(window, { key: digit[rowA] });
    await user.click(screen.getByTestId(`pending-card-${cardKey(three[1]!)}`));
    fireEvent.keyDown(window, { key: digit[rowB] });
    expect(screen.getByTestId('discard-slot')).toHaveAttribute('data-count', '1');
    expect(screen.getByTestId(`discard-card-${cardKey(three[2]!)}`)).toBeInTheDocument();
    expect(screen.getByTestId('confirm-placement')).toBeEnabled();
    await user.click(screen.getByTestId('undo-placement'));
    expect(screen.getByTestId('confirm-placement')).toBeDisabled();
    expect(screen.getByTestId('discard-slot')).toHaveAttribute('data-count', '0');
    await user.click(screen.getByTestId(`pending-card-${cardKey(three[1]!)}`));
    await user.click(screen.getByTestId(`row-0-${rowB}`));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(sent).toHaveLength(1);
    const cmd = sent[0] as Extract<Command, { type: 'place' }>;
    expect(cmd.placements).toHaveLength(2);
    expect((cmd.discards ?? []).map(cardKey)).toEqual([cardKey(three[2]!)]);
  });

  it('drag and drop places a card on the row under the pointer', () => {
    const client = tableFor({ variant: 'ofc', seats: 2 });
    act(() => dealToMe(client));
    render(<Harness client={client} />);
    const pending = client.getState().snapshot!.state.hand!.seats[0]!.pending;
    const cardEl = screen.getByTestId(`pending-card-${cardKey(pending[0]!)}`);
    const target = screen.getByTestId('row-0-top');
    const original = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => target);
    fireEvent.pointerDown(cardEl, { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cardEl, { clientX: 40, clientY: 60, pointerId: 1 });
    expect(screen.getByTestId('drag-ghost')).toBeInTheDocument();
    expect(target).toHaveAttribute('data-over', 'true');
    fireEvent.pointerUp(cardEl, { clientX: 40, clientY: 60, pointerId: 1 });
    expect(screen.queryByTestId('drag-ghost')).not.toBeInTheDocument();
    expect(target).toHaveAttribute('data-count', '1');
    document.elementFromPoint = original;
  });

  it('shows hidden backs for a face-down Fantasyland seat and the showdown panel afterwards', () => {
    // Force seat 1 into Fantasyland by building a state with a fantasyland entitlement.
    const client = tableFor({ variant: 'pineapple', seats: 2 });
    const rng = seededRng(4);
    let s: TableState = { ...client.getTableState(), fantasyland: [0, 14] };
    s = applyAll(s, command(s, 0, { type: 'start' }, rng));
    // Seat 1 sets its 14 cards face down.
    s = applyAll(s, command(s, 1, botPlacement(s, 1), rng));
    const v = {
      ...client.getState(),
      snapshot: { ...client.getState().snapshot!, state: view(s, 0) },
    };
    render(<OfcTable state={v} send={() => {}} names={['Me', 'Bot']} mySeat={0} reducedMotion />);
    expect(screen.getByTestId('seat-1')).toHaveAttribute('data-fantasyland', 'true');
    expect(screen.getByTestId('fantasyland-badge-1')).toBeInTheDocument();
    expect(within(screen.getByTestId('row-1-bottom')).getAllByTestId('card-back')).toHaveLength(5);
    expect(within(screen.getByTestId('row-1-top')).getAllByTestId('card-back')).toHaveLength(3);
    expect(
      screen
        .queryAllByTestId(/^card-[2-9TJQKA][cdhs]$/)
        .filter((el) => el.closest('[data-testid="seat-1"]')),
    ).toHaveLength(0);
  });

  it('renders the showdown panel with totals, row results and a next-hand button', () => {
    const client = tableFor({ variant: 'ofc', seats: 3 }, { seed: 8 });
    act(() => {
      client.apply(0, { type: 'start' });
      for (let guard = 0; guard < 60 && client.getTableState().hand!.phase === 'setting'; guard++) {
        const st = client.getTableState();
        const seat = st.hand!.toAct!;
        client.apply(seat, botPlacement(st, seat));
      }
    });
    expect(client.getTableState().hand!.phase).toBe('showdown');
    const onOpenLedger = vi.fn();
    const first = render(<Harness client={client} onOpenLedger={onOpenLedger} />);
    expect(screen.getByTestId('ofc-table')).toHaveAttribute('data-phase', 'showdown');
    const panel = screen.getByTestId('showdown-panel');
    expect(within(panel).getAllByTestId(/^hand-total-\d$/)).toHaveLength(3);
    const totals = client.getTableState().hand!.result!.seats.map((s) => s.points);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect(screen.getByTestId(`hand-total-${i}`)).toHaveAttribute(
        'data-points',
        String(totals[i]),
      );
      for (const row of ['top', 'middle', 'bottom']) {
        expect(screen.getByTestId(`row-result-${i}-${row}`)).toHaveAttribute(
          'data-outcome',
          expect.stringMatching(/^(win|lose|tie)$/),
        );
      }
      expect(screen.getByTestId(`score-${i}`)).toBeInTheDocument();
    }
    expect(within(panel).getByTestId('hand-summary').children.length).toBe(3);
    fireEvent.click(within(panel).getByTestId('open-ledger'));
    expect(onOpenLedger).toHaveBeenCalled();
    first.unmount();
    const sent: Command[] = [];
    render(<Harness client={client} send={(c) => sent.push(c)} />);
    fireEvent.click(screen.getByTestId('start-hand-button'));
    expect(sent).toEqual([{ type: 'start' }]);
  });
});
