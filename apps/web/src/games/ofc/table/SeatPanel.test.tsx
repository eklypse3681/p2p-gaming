import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { HandResult } from '@bgf/ofc-engine';
import { SeatPanel } from './SeatPanel';
import type { RowModel, SeatModel } from './model';

afterEach(cleanup);

const row = (r: 'top' | 'middle' | 'bottom'): RowModel =>
  ({
    row: r,
    label: r,
    cards: [],
    provisional: [],
    capacity: r === 'top' ? 3 : 5,
  }) as unknown as RowModel;

function seat(over: Partial<SeatModel>): SeatModel {
  return {
    seat: 1,
    name: 'Steve Phone',
    isMe: false,
    toAct: false,
    fantasyland: false,
    faceDown: false,
    hiddenCount: 0,
    hidden: false,
    done: true,
    pendingCount: 0,
    discardCount: 1,
    rows: { top: row('top'), middle: row('middle'), bottom: row('bottom') },
    score: 0,
    balance: null,
    result: null,
    foul: null,
    present: true,
    fantasylandNext: 0,
    ...over,
  };
}

// Only its presence matters to the badges: "the hand is over".
const SHOWDOWN = { seats: [], pairs: [] } as unknown as HandResult;

const played = () => screen.queryByTestId('fantasyland-badge-1');
const next = () => screen.queryByTestId('fantasyland-next-1');

describe('SeatPanel Fantasyland badges', () => {
  it('during a hand: "Fantasyland" for a seat playing in it', () => {
    render(<SeatPanel seat={seat({ fantasyland: true })} size="sm" result={null} />);
    expect(played()).toHaveTextContent('Fantasyland');
    expect(next()).toBeNull();
  });

  it('after the showdown, a Fantasyland hand that did not requalify is only marked as one', () => {
    render(<SeatPanel seat={seat({ fantasyland: true })} size="sm" result={SHOWDOWN} />);
    expect(played()).toHaveTextContent('FL hand');
    expect(next()).toBeNull();
  });

  it('after the showdown, a Fantasyland hand that requalified says so separately', () => {
    render(
      <SeatPanel
        seat={seat({ fantasyland: true, fantasylandNext: 14 })}
        size="sm"
        result={SHOWDOWN}
      />,
    );
    expect(played()).toHaveTextContent('FL hand');
    expect(next()).toHaveTextContent('Requalified · 14');
  });

  it('after the showdown, a seat that qualified gets "FL next hand"', () => {
    render(<SeatPanel seat={seat({ fantasylandNext: 14 })} size="sm" result={SHOWDOWN} />);
    expect(played()).toBeNull();
    expect(next()).toHaveTextContent('FL next hand · 14');
  });
});
