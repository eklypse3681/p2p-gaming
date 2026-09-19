import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformApp } from './PlatformApp';
import type { PurchaseRow } from './api';
import { FakeEventSource, installFakeApi } from '../test/fakeApi';
import { fakeMe, fakePurchase, fakeSummary, platformStatus } from '../test/platformFixtures';

describe('OperatorPage', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('platform-session-token', 'tok-1');
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    window.location.hash = '#/operator';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists clubs, marks a pending purchase paid and follows the operator feed', async () => {
    let purchases: PurchaseRow[] = [
      fakePurchase({ id: 'p1', status: 'pending' }),
      fakePurchase({
        id: 'p2',
        status: 'paid',
        method: 'dev',
        reference: null,
        paidAt: 5,
        amount: 50_000,
      }),
    ];
    let paid: string | null = null;
    installFakeApi({
      'GET /api/me': () => fakeMe({ operator: true }),
      'GET /api/operator/clubs': () => [
        {
          ...fakeSummary(),
          sales: purchases.filter((p) => p.status === 'paid').reduce((a, p) => a + p.amount, 0),
          pendingPurchases: purchases.filter((p) => p.status === 'pending').length,
        },
      ],
      'GET /api/operator/purchases': () => purchases,
      'GET /api/operator/report': () => ({ at: 1, clubs: [{ ...fakeSummary(), purchases: 0 }] }),
      'POST /api/operator/purchases/p1/paid': () => {
        paid = 'p1';
        purchases = purchases.map((p) => (p.id === 'p1' ? { ...p, status: 'paid', paidAt: 9 } : p));
        return purchases[0];
      },
    });
    render(<PlatformApp status={platformStatus()} />);
    expect(await screen.findByTestId('operator-page')).toBeInTheDocument();
    expect(screen.getByTestId('nav-operator')).toBeInTheDocument();
    expect(FakeEventSource.instances[0]!.url).toBe('/api/operator/events?token=tok-1');

    const club = await screen.findByTestId('operator-club-c1');
    expect(club).toHaveTextContent('Thursday Club');
    expect(club).toHaveTextContent('sales 500.00 USDC');
    expect(club).toHaveTextContent('1 pending');
    expect(await screen.findByTestId('report-clubs')).toHaveTextContent('1');

    expect(await screen.findByTestId('purchase-p1')).toHaveAttribute('data-status', 'pending');
    expect(screen.getByTestId('purchase-p1')).toHaveTextContent('1,000.00 USDC');
    expect(screen.getByTestId('purchase-p1')).toHaveTextContent('manual · INV-1');
    expect(screen.queryByTestId('mark-paid-p2')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('mark-paid-p1'));
    await waitFor(() => expect(paid).toBe('p1'));
    await waitFor(() =>
      expect(screen.getByTestId('purchase-p1')).toHaveAttribute('data-status', 'paid'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('operator-club-c1')).toHaveTextContent('sales 1,500.00 USDC'),
    );
    expect(screen.queryByTestId('mark-paid-p1')).not.toBeInTheDocument();

    FakeEventSource.instances[0]!.emit({
      seq: 7,
      clubId: 'c1',
      type: 'purchase',
      message: 'Thursday Club: 100000 chips minted into the reserve',
      at: Date.now(),
      dataJson: '{"purchaseId":"p1"}',
    });
    await waitFor(() =>
      expect(screen.getByTestId('operator-feed')).toHaveTextContent(
        '[Thursday Club] Thursday Club: 100000 chips',
      ),
    );
  });

  it('sends non-operators back to their clubs', async () => {
    installFakeApi({ 'GET /api/me': () => fakeMe({ operator: false }) });
    render(<PlatformApp status={platformStatus()} />);
    expect(await screen.findByTestId('clubs-page')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-operator')).not.toBeInTheDocument();
  });
});
