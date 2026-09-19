import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Action } from '@bgf/engine';
import type { ClientState } from '@bgf/client';
import { ActionBar } from './ActionBar';
import { HostTableOptions, useHostTableChoice } from './HostTableOptions';
import { RulesEditor } from '../games/ofc/rules/RulesEditor';
import { defaultConfig } from '@bgf/ofc-engine';
import { makeState } from '../test/state';

function client() {
  return {
    startGame: vi.fn(),
    ready: vi.fn(),
    openingRoll: vi.fn(),
    roll: vi.fn(),
    double: vi.fn(),
    take: vi.fn(),
    drop: vi.fn(),
    offerResign: vi.fn(),
    acceptResign: vi.fn(),
    declineResign: vi.fn(),
    commit: vi.fn(),
    unstage: vi.fn(),
    clearDraft: vi.fn(),
    freeRoll: vi.fn(),
    setCube: vi.fn(),
    resetBoard: vi.fn(),
    recordResult: vi.fn(),
  };
}

/** Actions of a match whose first game has just ended by a drop. */
function finishedGame(): Action[] {
  return [
    { type: 'start-game' },
    { type: 'opening-roll', player: 'white', die: 5 },
    { type: 'opening-roll', player: 'black', die: 2 },
    {
      type: 'play',
      player: 'white',
      play: [
        { from: 13, to: 8, die: 5, hit: false },
        { from: 6, to: 4, die: 2, hit: false },
      ],
    },
    { type: 'double', player: 'black' },
    { type: 'drop', player: 'white' },
  ];
}

function withAutopilot(state: ClientState, ready = { white: false, black: false }): ClientState {
  return {
    ...state,
    ready,
    snapshot: state.snapshot ? { ...state.snapshot, autopilot: true } : null,
  };
}

describe('backgammon action bar on an unattended table', () => {
  it('offers Ready instead of Next game once a game is over, and reports the opponent', async () => {
    const c = client();
    const state = withAutopilot(makeState({ actions: finishedGame() }), {
      white: false,
      black: true,
    });
    render(<ActionBar state={state} client={c} />);
    expect(screen.queryByTestId('start-game-button')).toBeNull();
    const btn = screen.getByTestId('ready-button');
    expect(btn).toHaveAttribute('data-ready', 'false');
    expect(screen.getByTestId('ready-indicator')).toHaveTextContent(/is ready/);
    await userEvent.click(btn);
    expect(c.ready).toHaveBeenCalledWith(true);
    expect(c.startGame).not.toHaveBeenCalled();
  });

  it('says the first game starts by itself instead of showing Start game', () => {
    const c = client();
    render(<ActionBar state={withAutopilot(makeState())} client={c} />);
    expect(screen.queryByTestId('start-game-button')).toBeNull();
    expect(screen.getByTestId('auto-start-note')).toBeInTheDocument();
  });

  it('keeps the manual buttons when the table is not unattended', () => {
    const c = client();
    render(<ActionBar state={makeState({ actions: finishedGame() })} client={c} />);
    expect(screen.getByTestId('start-game-button')).toBeInTheDocument();
    expect(screen.queryByTestId('ready-button')).toBeNull();
  });
});

function Harness({ onChange }: { onChange: (v: { manualDealing: boolean }) => void }) {
  const [choice, setChoice] = useHostTableChoice();
  return (
    <HostTableOptions
      value={choice}
      onChange={(next) => {
        setChoice(next);
        onChange(next);
      }}
      dealerHelp="help"
    />
  );
}

describe('host table options', () => {
  it('runs unattended by default and exposes a Manual dealing toggle', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const toggle = screen.getByTestId('manual-dealing') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ manualDealing: true }));
  });
});

describe('rules editor: table flow', () => {
  it('edits the flow options and reports a countdown delay in seconds', () => {
    const onChange = vi.fn();
    const config = defaultConfig({ variant: 'pineapple', seats: 2 });
    const { rerender } = render(<RulesEditor value={config} onChange={onChange} slug="test" />);
    expect(screen.getByTestId('flow-next-ready')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('flow-delay')).toBeNull();
    fireEvent.click(screen.getByTestId('flow-next-countdown'));
    const next = onChange.mock.lastCall![0] as typeof config;
    expect(next.flow?.nextHand).toBe('countdown');
    rerender(<RulesEditor value={next} onChange={onChange} slug="test" />);
    const delay = screen.getByTestId('flow-delay') as HTMLInputElement;
    expect(delay.value).toBe('8');
    fireEvent.change(delay, { target: { value: '12' } });
    expect((onChange.mock.lastCall![0] as typeof config).flow?.nextHandDelayMs).toBe(12_000);
    fireEvent.click(screen.getByLabelText('Reset the scores when everyone asks'));
    expect((onChange.mock.lastCall![0] as typeof config).flow?.settleOnConsensus).toBe(false);
  });
});
