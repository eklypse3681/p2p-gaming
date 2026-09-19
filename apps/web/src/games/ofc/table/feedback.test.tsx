import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Command, HandResult, TableState } from '@bgf/ofc-engine';
import { applyAll, cardKey, cards, command, defaultConfig, seededRng, view } from '@bgf/ofc-engine';
import { FakeOfcClient, botPlacement } from '../demo/fakeOfcClient';
import { OfcTable } from './OfcTable';
import { buildTableModel, pairwiseFor, rowRoyalty, signed, sortCards } from './model';

function playToShowdown(client: FakeOfcClient) {
  client.apply(0, { type: 'start' });
  for (let guard = 0; guard < 80 && client.getTableState().hand!.phase === 'setting'; guard++) {
    const st = client.getTableState();
    const seat = st.hand!.toAct;
    if (seat === null) break;
    client.apply(seat, botPlacement(st, seat));
  }
}

describe('showdown feedback: pairwise columns and royalty stamps', () => {
  it('pairwiseFor flips the sign for the second seat of a pair and covers every opponent', () => {
    const result: HandResult = {
      hand: 1,
      seats: [],
      transfers: [],
      pairs: [
        { a: 0, b: 1, rows: { top: 1, middle: -1, bottom: 1 }, scoop: 0, royalties: 2, net: 3 },
        { a: 0, b: 2, rows: { top: 1, middle: 1, bottom: 1 }, scoop: 3, royalties: -1, net: 5 },
        { a: 1, b: 2, rows: { top: 0, middle: -1, bottom: -1 }, scoop: 0, royalties: 0, net: -2 },
      ],
    };
    expect(pairwiseFor(result, 0).map((l) => l.total)).toEqual([3, 5]);
    const bob = pairwiseFor(result, 1);
    expect(bob.map((l) => l.opponent)).toEqual([0, 2]);
    expect(bob[0]).toEqual({
      opponent: 0,
      rows: { top: -1, middle: 1, bottom: -1 },
      scoop: 0,
      royalties: -2,
      total: -3,
    });
    expect(pairwiseFor(result, 2)[0]!.scoop).toBe(-3);
    expect(signed(3)).toBe('+3');
    expect(signed(-1)).toBe('−1');
    expect(signed(0)).toBe('0');
  });

  it('sortCards orders low, high and by suit and keeps the dealt order otherwise', () => {
    const hand = cards('Kd 2s 9h 2c Ah');
    expect(sortCards(hand, 'dealt').map(cardKey)).toEqual(['Kd', '2s', '9h', '2c', 'Ah']);
    expect(sortCards(hand, 'low').map(cardKey)).toEqual(['2c', '2s', '9h', 'Kd', 'Ah']);
    expect(sortCards(hand, 'high').map(cardKey)).toEqual(['Ah', 'Kd', '9h', '2c', '2s']);
    expect(sortCards(hand, 'suit').map(cardKey)).toEqual(['2c', 'Kd', 'Ah', '9h', '2s']);
  });

  it('rowRoyalty follows the table rules for complete rows only', () => {
    const config = defaultConfig({ variant: 'pineapple' });
    expect(rowRoyalty(cards('Qs Qh 4d'), 'top', config)).toBe(7);
    expect(rowRoyalty(cards('Qs Qh'), 'top', config)).toBe(0);
    expect(rowRoyalty(cards('2s 3s 4s 5s 6s'), 'bottom', config)).toBe(15);
    expect(rowRoyalty(cards('2s 3s 4s 5s 6s'), 'middle', config)).toBe(30);
    const off = defaultConfig({
      variant: 'pineapple',
      royalties: { ...config.royalties, enabled: false },
    });
    expect(rowRoyalty(cards('Qs Qh 4d'), 'top', off)).toBe(0);
  });

  it('renders one column per opponent with signed, coloured cells and no win/lose words', () => {
    const client = new FakeOfcClient({
      config: { variant: 'ofc', seats: 3 },
      autoPlay: false,
      botDelayMs: 0,
      seed: 8,
    });
    act(() => playToShowdown(client));
    const result = client.getTableState().hand!.result!;
    render(
      <OfcTable
        state={client.getState()}
        send={() => {}}
        names={client.names}
        mySeat={0}
        reducedMotion
      />,
    );
    const panel = screen.getByTestId('showdown-panel');
    const blocks = within(panel).getAllByTestId(/^showdown-seat-\d$/);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toHaveAttribute('data-me', 'true'); // the viewer first
    expect(within(panel).getByTestId('pair-0-vs-1')).toHaveTextContent('vs Ada');
    expect(within(panel).getByTestId('pair-0-vs-2')).toHaveTextContent('vs Grace');
    expect(within(panel).getByTestId('pair-1-vs-2')).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/\b(won|lost|tie)\b/);
    // Every cell is signed and coloured by sign; totals match the engine.
    const me = pairwiseFor(result, 0);
    const cellsFor = (block: HTMLElement) =>
      Array.from(block.querySelectorAll<HTMLElement>('td[data-points]'));
    const myCells = cellsFor(blocks[0]!);
    expect(myCells.length).toBe(6 * 2);
    for (const cell of myCells) {
      const n = Number(cell.dataset.points);
      expect(cell.dataset.sign).toBe(n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero');
      if (n !== 0) expect(cell.textContent).toMatch(n > 0 ? /^\+\d+$/ : /^−\d+$/);
    }
    const totalCells = blocks[0]!.querySelectorAll<HTMLElement>('tr:last-child td[data-points]');
    expect(Array.from(totalCells).map((c) => Number(c.dataset.points))).toEqual(
      me.map((l) => l.total),
    );
    expect(screen.getByTestId('hand-total-0')).toHaveAttribute(
      'data-points',
      String(result.seats[0]!.points),
    );
    // Row results are still exposed for tests but carry no text.
    expect(screen.getByTestId('row-result-0-top')).toHaveTextContent('');
  });

  it('stamps rows that earn a royalty during play; incomplete rows get none', () => {
    const client = new FakeOfcClient({
      config: { variant: 'pineapple', seats: 2 },
      autoPlay: false,
      botDelayMs: 0,
    });
    const rng = seededRng(3);
    let s: TableState = client.getTableState();
    s = applyAll(s, command(s, 0, { type: 'start' }, rng));
    // Test-only state surgery: give seat 0 a pair of queens on top and two cards on the bottom.
    const seats = s.hand!.seats.map((sh, i) =>
      i === 0
        ? {
            ...sh,
            pending: [],
            rows: { top: cards('Qs Qh 3d'), middle: [], bottom: cards('2c 5c') },
          }
        : sh,
    );
    s = { ...s, hand: { ...s.hand!, seats } };
    const state = {
      ...client.getState(),
      snapshot: { ...client.getState().snapshot!, state: view(s, 0) },
    };
    render(
      <OfcTable state={state} send={() => {}} names={['Me', 'Bot']} mySeat={0} reducedMotion />,
    );
    const stamp = screen.getByTestId('royalty-stamp-0-top');
    expect(stamp).toHaveAttribute('data-points', '7');
    expect(stamp).toHaveTextContent('+7');
    expect(stamp).not.toHaveAttribute('data-void');
    expect(screen.queryByTestId('royalty-stamp-0-bottom')).not.toBeInTheDocument();
  });

  it('a fouled seat at showdown shows its stamps struck through', () => {
    const client = new FakeOfcClient({
      config: { variant: 'ofc', seats: 2 },
      autoPlay: false,
      botDelayMs: 0,
      seed: 9,
    });
    const rng = seededRng(9);
    let s: TableState = client.getTableState();
    s = applyAll(s, command(s, 0, { type: 'start' }, rng));
    // Seat 0: trips on top (royalty 22) over a weak middle: a foul. Seat 1: a clean hand.
    const seats = s.hand!.seats.map((sh, i) => ({
      ...sh,
      pending: [],
      done: true,
      rows:
        i === 0
          ? {
              top: cards('As Ah Ad'),
              middle: cards('2c 3c 4d 5h 7s'),
              bottom: cards('Kh Qd Jc 9s 8h'),
            }
          : {
              top: cards('2s 3s 4h'),
              middle: cards('5c 6c 7d 8c Ts'),
              bottom: cards('Js Qc Kd Ac 9d'),
            },
    }));
    s = { ...s, hand: { ...s.hand!, seats } };
    s = applyAll(s, [{ type: 'showdown' }]);
    const result = s.hand!.result!;
    expect(result.seats[0]!.fouled).toBe(true);
    expect(result.seats[0]!.royalties).toBe(0); // forfeited by the engine
    expect(rowRoyalty(cards('As Ah Ad'), 'top', s.config)).toBe(22);
    const state = {
      ...client.getState(),
      snapshot: { ...client.getState().snapshot!, state: view(s, 0) },
    };
    render(
      <OfcTable state={state} send={() => {}} names={['Me', 'Bot']} mySeat={0} reducedMotion />,
    );
    expect(screen.getByTestId('royalty-stamp-0-top')).toHaveAttribute('data-void', 'true');
    expect(screen.getByTestId('showdown-seat-0')).toHaveAttribute('data-fouled', 'true');
    expect(screen.getByTestId('pair-0-vs-1')).toBeInTheDocument();
  });
});

describe('Fantasyland layout', () => {
  function flClient() {
    return new FakeOfcClient({
      config: { variant: 'pineapple', seats: 3 },
      autoPlay: false,
      botDelayMs: 0,
      seed: 5,
      fantasylandForMe: 14,
    });
  }

  it('hides opponents behind the panel until my hand is set, with working sort buttons', async () => {
    const user = userEvent.setup();
    const client = flClient();
    act(() => {
      client.apply(0, { type: 'start' });
      client.playBots(); // the normal seats set their five cards
    });
    const model = buildTableModel(client.getState(), 0, client.names);
    expect(model.settingFantasyland).toBe(true);
    expect(model.seats.filter((s) => !s.isMe).every((s) => s.hidden)).toBe(true);
    const sent: Command[] = [];
    const { rerender } = render(
      <OfcTable
        state={client.getState()}
        send={(c) => sent.push(c)}
        names={client.names}
        mySeat={0}
        reducedMotion
      />,
    );
    expect(screen.getByTestId('fantasyland-panel')).toHaveTextContent('set your 14 cards');
    expect(screen.getByTestId('seat-hidden-1')).toBeInTheDocument();
    expect(screen.getByTestId('seat-hidden-2')).toBeInTheDocument();
    expect(screen.queryByTestId('seat-1')).not.toBeInTheDocument();
    // No opponent card is in the DOM at all.
    expect(screen.queryAllByTestId(/^card-[2-9TJQKA][cdhs]$/).length).toBe(14);
    const keysNow = () =>
      screen
        .getAllByTestId(/^pending-card-/)
        .map((el) => el.dataset.testid!.slice('pending-card-'.length));
    await user.click(screen.getByTestId('sort-low'));
    const low = keysNow();
    const rank = (k: string) => '23456789TJQKA'.indexOf(k[0]!);
    for (let i = 1; i < low.length; i++)
      expect(rank(low[i]!)).toBeGreaterThanOrEqual(rank(low[i - 1]!));
    await user.click(screen.getByTestId('sort-high'));
    const high = keysNow();
    for (let i = 1; i < high.length; i++)
      expect(rank(high[i]!)).toBeLessThanOrEqual(rank(high[i - 1]!));
    await user.click(screen.getByTestId('sort-suit'));
    const suit = keysNow().map((k) => k[1]);
    expect(suit).toEqual(suit.slice().sort());
    // Place 13 by keyboard: bottom ×5, middle ×5, top ×3; the 14th becomes the discard.
    const keys = ['3', '3', '3', '3', '3', '2', '2', '2', '2', '2', '1', '1', '1'];
    for (const k of keys) {
      await user.click(screen.getAllByTestId(/^pending-card-/)[0]!);
      fireEvent.keyDown(window, { key: k });
    }
    expect(screen.getByTestId('discard-slot')).toHaveAttribute('data-count', '1');
    expect(screen.getByTestId('confirm-placement')).toBeEnabled();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(sent).toHaveLength(1);
    const cmd = sent[0] as Extract<Command, { type: 'place' }>;
    expect(cmd.placements).toHaveLength(13);
    expect(cmd.discards).toHaveLength(1);
    act(() => client.apply(0, cmd));
    rerender(
      <OfcTable
        state={client.getState()}
        send={(c) => sent.push(c)}
        names={client.names}
        mySeat={0}
        reducedMotion
      />,
    );
    expect(screen.queryByTestId('fantasyland-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('seat-1')).toBeInTheDocument();
    expect(Number(screen.getByTestId('row-1-bottom').getAttribute('data-count'))).toBeGreaterThan(
      0,
    );
  });

  it('a normal seat sees an opponent in Fantasyland as backs and keeps the usual layout', () => {
    const client = new FakeOfcClient({
      config: { variant: 'pineapple', seats: 2 },
      mySeat: 1,
      names: ['FL bot', 'Me'],
      autoPlay: false,
      botDelayMs: 0,
      seed: 5,
    });
    const rng = seededRng(2);
    let s: TableState = { ...client.getTableState(), fantasyland: [14, 0] };
    s = applyAll(s, command(s, 0, { type: 'start' }, rng));
    s = applyAll(s, command(s, 0, botPlacement(s, 0), rng));
    const state = {
      ...client.getState(),
      snapshot: { ...client.getState().snapshot!, state: view(s, 1) },
    };
    render(
      <OfcTable state={state} send={() => {}} names={client.names} mySeat={1} reducedMotion />,
    );
    expect(screen.queryByTestId('fantasyland-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('seat-0')).toHaveAttribute('data-hidden', 'true');
    expect(within(screen.getByTestId('row-0-bottom')).getAllByTestId('card-back')).toHaveLength(5);
    expect(screen.getByTestId('pending-cards')).toBeInTheDocument();
  });
});
