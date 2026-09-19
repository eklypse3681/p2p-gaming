import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionBar } from './ActionBar';
import {
  makeState,
  movingWhiteActions,
  blackToRollActions,
  freeBoardState,
  A,
} from '../test/state';

function fakeClient() {
  return {
    startGame: vi.fn(),
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
    ready: vi.fn(),
  };
}

describe('ActionBar', () => {
  it('offers Start game before the first game', async () => {
    const client = fakeClient();
    render(<ActionBar state={makeState()} client={client} />);
    expect(screen.getByTestId('status-text')).toHaveTextContent(/start the first game/i);
    await userEvent.click(screen.getByTestId('start-game-button'));
    expect(client.startGame).toHaveBeenCalled();
    expect(screen.queryByTestId('roll-button')).not.toBeInTheDocument();
  });

  it('shows the opening roll button', async () => {
    const client = fakeClient();
    render(<ActionBar state={makeState({ actions: [A.start] })} client={client} />);
    await userEvent.click(screen.getByTestId('opening-roll-button'));
    expect(client.openingRoll).toHaveBeenCalled();
  });

  it('while moving: done disabled until complete, undo disabled until staged', () => {
    const client = fakeClient();
    render(<ActionBar state={makeState({ actions: movingWhiteActions() })} client={client} />);
    expect(screen.getByTestId('done-button')).toBeDisabled();
    expect(screen.getByTestId('undo-button')).toBeDisabled();
    expect(screen.queryByTestId('roll-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('resign-button')).toBeInTheDocument();
  });

  it('done enabled when the draft is complete', async () => {
    const client = fakeClient();
    const base = makeState({ actions: movingWhiteActions() });
    const state = {
      ...base,
      draft: { ...base.draft, complete: true, played: base.draft.next.slice(0, 1) },
    };
    render(<ActionBar state={state} client={client} />);
    await userEvent.click(screen.getByTestId('done-button'));
    expect(client.commit).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('undo-button'));
    expect(client.unstage).toHaveBeenCalled();
  });

  it('to-roll: roll and double; resign menu offers three stakes', async () => {
    const client = fakeClient();
    render(
      <ActionBar
        state={makeState({ actions: blackToRollActions(), seat: 'black' })}
        client={client}
      />,
    );
    await userEvent.click(screen.getByTestId('roll-button'));
    expect(client.roll).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('double-button'));
    expect(client.double).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('resign-button'));
    await userEvent.click(screen.getByTestId('resign-gammon'));
    expect(client.offerResign).toHaveBeenCalledWith('gammon');
  });

  it('responding to a double shows take/drop only for the responder', async () => {
    const client = fakeClient();
    const actions = [...blackToRollActions(), { type: 'double', player: 'black' } as const];
    render(<ActionBar state={makeState({ actions, seat: 'white' })} client={client} />);
    await userEvent.click(screen.getByTestId('take-button'));
    expect(client.take).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('drop-button'));
    expect(client.drop).toHaveBeenCalled();
    expect(screen.queryByTestId('roll-button')).not.toBeInTheDocument();
  });

  it('leave button calls onLeave', async () => {
    const onLeave = vi.fn();
    render(<ActionBar state={makeState()} client={fakeClient()} onLeave={onLeave} />);
    await userEvent.click(screen.getByTestId('leave-button'));
    expect(onLeave).toHaveBeenCalled();
  });

  describe('free board', () => {
    it('shows roll, cube, record result and reset instead of turn controls', async () => {
      const client = fakeClient();
      render(<ActionBar state={freeBoardState()} client={client} />);
      expect(screen.getByTestId('status-text')).toHaveTextContent(/free board/i);
      expect(screen.queryByTestId('opening-roll-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('done-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('double-button')).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('roll-button'));
      expect(client.freeRoll).toHaveBeenCalled();
      expect(client.roll).not.toHaveBeenCalled();
      expect(screen.getByTestId('resign-button')).toBeInTheDocument();
    });

    it('cube menu sets value and owner (a cube at 1 stays centred)', async () => {
      const client = fakeClient();
      render(<ActionBar state={freeBoardState()} client={client} />);
      await userEvent.click(screen.getByTestId('cube-button'));
      expect(screen.getByTestId('cube-menu')).toBeInTheDocument();
      await userEvent.click(screen.getByTestId('cube-value-4'));
      expect(client.setCube).toHaveBeenLastCalledWith(4, 'center');
      await userEvent.click(screen.getByTestId('cube-owner-black'));
      // state still says value 1 → owning the cube bumps it to 2
      expect(client.setCube).toHaveBeenLastCalledWith(2, 'black');
      await userEvent.click(screen.getByTestId('cube-value-1'));
      expect(client.setCube).toHaveBeenLastCalledWith(1, 'center');
    });

    it('record result asks for confirmation, then records winner and stakes', async () => {
      const client = fakeClient();
      render(<ActionBar state={freeBoardState({ seat: 'black' })} client={client} />);
      await userEvent.click(screen.getByTestId('record-result-button'));
      await userEvent.click(screen.getByTestId('result-white-gammon'));
      expect(client.recordResult).not.toHaveBeenCalled();
      expect(screen.getByTestId('confirm-result-panel')).toHaveTextContent(/Alice/);
      await userEvent.click(screen.getByTestId('cancel-result'));
      expect(screen.queryByTestId('confirm-result')).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('result-black-single'));
      await userEvent.click(screen.getByTestId('confirm-result'));
      expect(client.recordResult).toHaveBeenCalledWith('black', 'single');
      expect(screen.queryByTestId('record-result-menu')).not.toBeInTheDocument();
    });

    it('reset asks for confirmation', async () => {
      const client = fakeClient();
      render(<ActionBar state={freeBoardState()} client={client} />);
      await userEvent.click(screen.getByTestId('reset-board-button'));
      await userEvent.click(screen.getByTestId('cancel-reset'));
      expect(client.resetBoard).not.toHaveBeenCalled();
      await userEvent.click(screen.getByTestId('reset-board-button'));
      await userEvent.click(screen.getByTestId('confirm-reset'));
      expect(client.resetBoard).toHaveBeenCalled();
    });

    it('column layout uses short labels with full names as tooltips and offers More', async () => {
      const onMore = vi.fn();
      render(
        <ActionBar
          state={freeBoardState()}
          client={fakeClient()}
          layout="column"
          showStatus={false}
          onMore={onMore}
        />,
      );
      expect(screen.queryByTestId('status-text')).not.toBeInTheDocument();
      expect(screen.getByTestId('record-result-button')).toHaveTextContent('Score');
      expect(screen.getByTestId('record-result-button')).toHaveAttribute('title', 'Record result…');
      await userEvent.click(screen.getByTestId('more-button'));
      expect(onMore).toHaveBeenCalled();
    });
  });
});
