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

const badge = () => screen.queryByTestId('fantasyland-badge-1');

describe('SeatPanel Fantasyland badge', () => {
  it('shows "Fantasyland" while a seat plays its hand there', () => {
    render(<SeatPanel seat={seat({ fantasyland: true })} size="sm" result={null} />);
    expect(badge()).toHaveTextContent('Fantasyland');
  });

  it('after the showdown, a Fantasyland seat that did not requalify shows nothing', () => {
    render(<SeatPanel seat={seat({ fantasyland: true })} size="sm" result={SHOWDOWN} />);
    expect(badge()).toBeNull();
  });

  it('after the showdown, a Fantasyland seat that requalified stays in', () => {
    render(
      <SeatPanel
        seat={seat({ fantasyland: true, fantasylandNext: 14 })}
        size="sm"
        result={SHOWDOWN}
      />,
    );
    expect(badge()).toHaveTextContent('Stays in Fantasyland · 14');
  });

  it('after the showdown, a seat that qualified gets "FL next hand"', () => {
    render(<SeatPanel seat={seat({ fantasylandNext: 14 })} size="sm" result={SHOWDOWN} />);
    expect(badge()).toHaveTextContent('FL next hand · 14');
  });
});
