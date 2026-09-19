import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { TableConfig, TableState } from '@bgf/ofc-engine';
import { applyAll, defaultConfig, init } from '@bgf/ofc-engine';
import type { TableClientState } from '@bgf/table';
import type { PlayerProfile } from '@bgf/protocol';
import type { ClientState } from '@bgf/client';

vi.mock('idb-keyval', async () => {
  const { createIdbKeyvalMock } = await import('../test/idbKeyvalMock');
  return createIdbKeyvalMock();
});
vi.mock('../session/providers', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../session/providers');
  return { ...actual, getProvider: () => ({ name: 'memory' }), getTransportName: () => 'memory' };
});

import { GameScreen as OfcGameScreen } from './ofc/GameScreen';
import { GameScreen as BackgammonGameScreen } from './backgammon/GameScreen';
import { renderWithProfile } from '../test/renderWithProfile';
import { makeState } from '../test/state';
import { createProfile, resetProfilesForTests } from '../session/profiles';

const ALICE: PlayerProfile = { id: 'a', name: 'Alice' };
const BOB: PlayerProfile = { id: 'b', name: 'Bob' };
const DEALER: PlayerProfile = { id: 'd', name: 'Dana', avatar: '🎩' };

function fakeClient<S>(state: S) {
  return {
    getState: () => state,
    subscribe: () => () => {},
    send: vi.fn(),
    sendChat: vi.fn(),
    close: vi.fn(),
    profile: DEALER,
  };
}

describe('dealer role rendering', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProfilesForTests();
    createProfile('Dana');
  });

  it('OFC: the dealer sees a dealer bar with deal/settle/adjust, no own rows, and the dealer chip', () => {
    const config: TableConfig = defaultConfig({ variant: 'pineapple', seats: 2 });
    const state: TableState = applyAll(init(config), []);
    const snapshot = {
      id: 'table-1',
      code: 'DEAL01',
      seq: 0,
      createdAt: 1,
      updatedAt: 1,
      gameId: 'ofc',
      config,
      seats: [ALICE, BOB],
      hostSeat: null,
      dealer: DEALER,
      // Manual dealing: this test checks the hands-on dealer bar; the unattended bar has its own.
      options: { randomness: { mode: 'seeded', provider: 'crypto' }, autopilot: false },
      initialState: state,
      actions: [],
      state,
      chat: [],
    };
    const clientState: TableClientState<TableState> = {
      status: 'joined',
      rejectReason: null,
      seat: null,
      role: 'dealer',
      dealer: { profile: DEALER, connected: true },
      snapshot,
      lastAction: null,
      previews: {},
      presence: [true, true],
      ready: [false, false],
      autopilot: null,
      chat: [],
      latencyMs: null,
      error: null,
    };
    const session = {
      matchId: 'table-1',
      code: 'DEAL01',
      role: 'host' as const,
      client: fakeClient(clientState),
      provider: { name: 'memory' },
      gameId: 'ofc',
      dispose: vi.fn(),
    };
    renderWithProfile('dana', <OfcGameScreen />, {
      game: 'ofc',
      route: '/game/table-1',
      uiPath: 'game/:matchId',
      sessions: [['dana', 'ofc', session as never]],
    });
    expect(screen.getByTestId('game-screen')).toHaveAttribute('data-role', 'dealer');
    expect(screen.getByTestId('game-screen')).toHaveAttribute('data-seat', '');
    expect(screen.getByTestId('dealer-bar')).toBeInTheDocument();
    expect(screen.getByTestId('start-hand-button')).toBeEnabled();
    expect(screen.getByTestId('settle-button')).toBeInTheDocument();
    expect(screen.getByTestId('adjust-button')).toBeInTheDocument();
    expect(screen.getByTestId('dealer-chip')).toHaveTextContent('Dana');
    expect(screen.getAllByTestId('dealer-badge')[0]).toHaveTextContent('Dealt by Dana (you)');
    expect(document.querySelector('[data-testid^="seat-"][data-me="true"]')).toBeNull();
    expect(screen.getAllByTestId('status-text')[0]).toHaveTextContent(/deal the first hand/i);
    fireEvent.click(screen.getByTestId('start-hand-button'));
    expect(session.client.send).toHaveBeenCalledWith({ type: 'start' });
  });

  it('backgammon: the dealer gets a spectator board, a dealer bar and both seats as guests', () => {
    const state: ClientState = makeState({
      seat: null,
      overrides: { role: 'dealer', dealer: { profile: DEALER, connected: true } },
    });
    const session = {
      matchId: state.snapshot!.id,
      code: state.snapshot!.code,
      role: 'host' as const,
      client: {
        ...fakeClient(state),
        stage: vi.fn(),
        unstage: vi.fn(),
        clearDraft: vi.fn(),
        commit: vi.fn(),
        destinations: () => [],
        startGame: vi.fn(),
        openingRoll: vi.fn(),
        roll: vi.fn(),
        double: vi.fn(),
        take: vi.fn(),
        drop: vi.fn(),
        offerResign: vi.fn(),
        acceptResign: vi.fn(),
        declineResign: vi.fn(),
        freeRoll: vi.fn(),
        freeMove: vi.fn(),
        setCube: vi.fn(),
        resetBoard: vi.fn(),
        recordResult: vi.fn(),
      },
      provider: { name: 'memory' },
      dispose: vi.fn(),
    };
    renderWithProfile('dana', <BackgammonGameScreen />, {
      game: 'backgammon',
      route: `/game/${state.snapshot!.id}`,
      uiPath: 'game/:matchId',
      sessions: [['dana', 'backgammon', session as never]],
    });
    expect(screen.getByTestId('game-screen')).toHaveAttribute('data-role', 'dealer');
    expect(screen.getByTestId('dealer-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('roll-button')).toBeNull();
    expect(screen.queryByTestId('done-button')).toBeNull();
    expect(screen.getByTestId('board')).toBeInTheDocument();
    expect(screen.getAllByTestId('dealer-badge')[0]).toHaveTextContent('Dealt by Dana (you)');
    expect(screen.getByTestId('fairness-button')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('fairness-button-bar'));
    expect(screen.getByTestId('fairness-panel')).toBeInTheDocument();
  });
});
