import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FlowControls } from './FlowControls';
import type { FlowProps } from './FlowControls';

function flow(over: Partial<FlowProps> = {}): FlowProps {
  return {
    autopilot: true,
    ready: [false, false, false],
    present: [true, true, true],
    resetRequests: [false, false, false],
    countdownAt: null,
    mySeat: 0,
    names: ['Ada', 'Bob', 'Cy'],
    seatCount: 3,
    setReady: vi.fn(),
    requestReset: vi.fn(),
    ...over,
  };
}

describe('FlowControls (between hands on an unattended table)', () => {
  it('shows who is ready, lets me toggle my readiness, and names who we wait for', () => {
    const f = flow({ ready: [false, true, false] });
    render(<FlowControls flow={f} over={false} />);
    expect(screen.getByTestId('ready-0')).toHaveAttribute('data-ready', 'false');
    expect(screen.getByTestId('ready-1')).toHaveAttribute('data-ready', 'true');
    expect(screen.getByTestId('flow-status')).toHaveTextContent(
      'Waiting for Ada and Cy to be ready',
    );
    const btn = screen.getByTestId('ready-button');
    expect(btn).toHaveTextContent("I'm ready");
    fireEvent.click(btn);
    expect(f.setReady).toHaveBeenCalledWith(true);
    expect(screen.queryByTestId('start-hand-button')).toBeNull();
  });

  it('reports an absent player instead of readiness, and hides my buttons when I have no seat', () => {
    render(
      <FlowControls flow={flow({ present: [true, false, true], mySeat: null })} over={false} />,
    );
    expect(screen.getByTestId('flow-status')).toHaveTextContent('Waiting for Bob to come back');
    expect(screen.queryByTestId('ready-button')).toBeNull();
    expect(screen.queryByTestId('settle-request-button')).toBeNull();
  });

  it('reset requests: my button toggles the request and the line says who is waiting', () => {
    const f = flow({ resetRequests: [true, false, false] });
    render(<FlowControls flow={f} over={false} />);
    expect(screen.getByTestId('settle-requests')).toHaveTextContent(
      'Ada wants to reset the scores · waiting for Bob and Cy',
    );
    const btn = screen.getByTestId('settle-request-button');
    expect(btn).toHaveTextContent('Cancel reset');
    fireEvent.click(btn);
    expect(f.requestReset).toHaveBeenCalledWith(false);
  });

  describe('countdown', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
    });
    afterEach(() => vi.useRealTimers());

    it('counts down to the scheduled hand and hides the ready button meanwhile', () => {
      render(<FlowControls flow={flow({ countdownAt: 15_000 })} over={false} />);
      expect(screen.getByTestId('next-hand-countdown')).toHaveTextContent('5 s');
      expect(screen.getByTestId('flow-status')).toHaveTextContent('Next hand in 5 s');
      expect(screen.queryByTestId('ready-button')).toBeNull();
    });
  });

  it('says the table is over and offers nothing when it is', () => {
    render(<FlowControls flow={flow()} over={true} />);
    expect(screen.getByTestId('flow-status')).toHaveTextContent('The table is over.');
    expect(screen.queryByTestId('ready-button')).toBeNull();
  });
});
