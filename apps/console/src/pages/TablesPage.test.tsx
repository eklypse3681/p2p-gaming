import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HashRouter } from 'react-router';
import { ToastProvider } from '../components/Toast';
import { TablesPage } from './TablesPage';
import { FakeEventSource, fakeTable, installFakeApi } from '../test/fakeApi';

describe('TablesPage', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists tables from the API, stops one, and refreshes on live events', async () => {
    let stopped = false;
    const fetchMock = installFakeApi({
      'GET /api/tables': () => [
        fakeTable({ status: stopped ? 'stopped' : 'running' }),
        fakeTable({
          id: 'tbl-2',
          code: 'ZZZ999',
          game: 'backgammon',
          name: '',
          status: 'stopped',
          summary: { score: { white: 2, black: 1 }, gameNumber: 3, winner: null },
        }),
      ],
      'POST /api/tables/tbl-1/stop': () => {
        stopped = true;
        return fakeTable({ status: 'stopped' });
      },
    });
    render(
      <HashRouter>
        <ToastProvider>
          <TablesPage />
        </ToastProvider>
      </HashRouter>,
    );
    const card = await screen.findByTestId('table-card-tbl-1');
    expect(card).toHaveTextContent('Friday');
    expect(card).toHaveTextContent('2/3 seats · Bob, Carol');
    expect(card).toHaveTextContent('Hand 1 · +3 / -3 / 0');
    expect(screen.getByTestId('table-card-tbl-2')).toHaveTextContent('Backgammon');
    expect(screen.getByTestId('table-card-tbl-2')).toHaveTextContent('Game 3 · 2–1');
    expect(
      screen.getByTestId('table-card-tbl-2').querySelector('[data-testid=card-resume]'),
    ).toBeInTheDocument();

    await userEvent.click(card.querySelector('[data-testid=card-stop]')!);
    await waitFor(() =>
      expect(screen.getByTestId('table-card-tbl-1')).toHaveAttribute('data-status', 'stopped'),
    );
    expect(
      fetchMock.mock.calls.some(
        ([u, i]) => String(u).endsWith('/api/tables/tbl-1/stop') && i?.method === 'POST',
      ),
    ).toBe(true);

    // A live event triggers a reload of the list.
    const before = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/tables')).length;
    FakeEventSource.instances[0]!.emit({
      seq: 9,
      at: Date.now(),
      type: 'seat',
      message: 'Dana joined seat 2',
      table: 'tbl-1',
    });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/tables')).length,
      ).toBeGreaterThan(before),
    );
  });

  it('shows the empty state', async () => {
    installFakeApi({ 'GET /api/tables': () => [] });
    render(
      <HashRouter>
        <ToastProvider>
          <TablesPage />
        </ToastProvider>
      </HashRouter>,
    );
    expect(await screen.findByTestId('empty')).toBeInTheDocument();
    expect(screen.getByTestId('new-table-button')).toHaveAttribute('href', '#/new');
  });
});
