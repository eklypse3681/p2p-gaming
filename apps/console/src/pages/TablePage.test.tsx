import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HashRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../components/Toast';
import { TablePage } from './TablePage';
import { FakeEventSource, fakeTable, installFakeApi } from '../test/fakeApi';

describe('TablePage', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.location.hash = '#/tables/tbl-1';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows seats, invite, ledger and appends live events; dealer commands go through the API', async () => {
    const commands: unknown[] = [];
    let seq = 4;
    installFakeApi({
      'GET /api/tables/tbl-1': () => ({
        ...fakeTable({ seq }),
        events: [
          { seq: 1, at: 0, type: 'created', message: 'created ofc table ABC123', table: 'tbl-1' },
        ],
      }),
      'GET /api/tables/tbl-1/ledger': () => ({
        balances: [3, -3, 0],
        unsettled: [3, -3, 0],
        plan: [{ from: 1, to: 0, points: 3, amount: 1.5 }],
        entries: [{ type: 'hand' }],
        multiplier: 0.5,
        mode: 'up',
        buyIn: null,
        names: ['Bob', 'Carol', null],
      }),
      'POST /api/tables/tbl-1/command': (init) => {
        commands.push((JSON.parse(String(init.body)) as { command: unknown }).command);
        seq += 1;
        return { seq };
      },
    });
    render(
      <HashRouter>
        <ToastProvider>
          <Routes>
            <Route path="/tables/:id" element={<TablePage />} />
          </Routes>
        </ToastProvider>
      </HashRouter>,
    );
    expect(await screen.findByTestId('room-code')).toHaveTextContent('ABC123');
    expect(screen.getByTestId('invite-link')).toHaveValue('http://app/#/ofc/join/ABC123');
    expect(screen.getByTestId('seat-0')).toHaveAttribute('data-connected', 'true');
    expect(screen.getByTestId('seat-2')).toHaveTextContent('open seat');
    expect(screen.getByTestId('event-log')).toHaveTextContent('created ofc table ABC123');
    expect(await screen.findByTestId('ledger-balance-0')).toHaveTextContent('3 pts');
    expect(screen.getByTestId('ledger-plan')).toHaveTextContent('Carol pays Bob 1.50');
    await waitFor(() => expect(screen.getByTestId('qr').querySelector('svg')).toBeTruthy());

    await userEvent.click(screen.getByTestId('deal-button'));
    await waitFor(() => expect(commands).toEqual([{ type: 'start' }]));

    // Live event lands in the log without a reload.
    FakeEventSource.instances[0]!.emit({
      seq: 7,
      at: Date.now(),
      type: 'seat',
      message: 'Dana joined seat 2',
      table: 'tbl-1',
    });
    await waitFor(() =>
      expect(screen.getByTestId('event-log')).toHaveTextContent('Dana joined seat 2'),
    );
    // Events for other tables are ignored.
    FakeEventSource.instances[0]!.emit({
      seq: 8,
      at: Date.now(),
      type: 'seat',
      message: 'elsewhere',
      table: 'other',
    });
    expect(screen.getByTestId('event-log')).not.toHaveTextContent('elsewhere');

    // Adjust flow.
    await userEvent.click(screen.getByTestId('adjust-button'));
    await userEvent.selectOptions(screen.getByTestId('adjust-seat'), '1');
    const pts = screen.getByTestId('adjust-points');
    await userEvent.clear(pts);
    await userEvent.type(pts, '-2');
    await userEvent.type(screen.getByTestId('adjust-note'), 'late');
    await userEvent.click(screen.getByTestId('confirm-adjust'));
    await waitFor(() =>
      expect(commands[1]).toEqual({ type: 'adjust', seat: 1, points: -2, note: 'late' }),
    );
  });
});
