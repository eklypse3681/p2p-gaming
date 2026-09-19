import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LedgerEntry, Room, TableTemplate } from '@bgf/protocol';
import { PlatformApp } from './PlatformApp';
import type { ClubDetail } from './api';
import { FakeEventSource, OFC_PRESETS, installFakeApi } from '../test/fakeApi';
import { body, fakeDetail, fakeMe, fakePurchase, platformStatus } from '../test/platformFixtures';

const entry = (
  seq: number,
  kind: LedgerEntry['kind'],
  lines: LedgerEntry['lines'],
): LedgerEntry => ({
  seq,
  at: 1_700_000_000_000 + seq * 1000,
  kind,
  lines,
  prevHash: 'p',
  hash: `h${seq}`,
  signature: 's',
  ...(kind === 'grant' ? { ref: { note: 'welcome' } } : {}),
});

describe('ClubPage', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('platform-session-token', 'tok-1');
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.location.hash = '#/clubs/c1';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the economy, buys chips, approves a member, invites, adds a room and template, lists tables and ledger', async () => {
    let detail: ClubDetail = fakeDetail();
    const calls: Array<{ key: string; body: Record<string, unknown> }> = [];
    const fetchMock = installFakeApi({
      'GET /api/me': () => fakeMe(),
      'GET /api/presets': () => OFC_PRESETS,
      'GET /api/clubs/c1': () => detail,
      'POST /api/clubs/c1/purchase': (init) => {
        const b = body(init);
        calls.push({ key: 'purchase', body: b });
        const row = fakePurchase({
          id: 'p9',
          amount: Number(b.amount),
          method: b.method as 'dev',
          reference: null,
          status: 'paid',
          paidAt: 1,
        });
        detail = {
          ...detail,
          reserve: detail.reserve + row.amount,
          minted: detail.minted + row.amount,
          purchases: [...detail.purchases, row],
        };
        return row;
      },
      'POST /api/clubs/c1/members/m2/approve': () => {
        calls.push({ key: 'approve', body: {} });
        detail = {
          ...detail,
          pendingMembers: 0,
          members: detail.members.map((m) => (m.id === 'm2' ? { ...m, status: 'active' } : m)),
        };
        return detail;
      },
      'POST /api/clubs/c1/invites': (init) => {
        const b = body(init);
        calls.push({ key: 'invite', body: b });
        const invite = {
          clubId: 'c1',
          clubName: 'Thursday Club',
          address: 'c1',
          role: b.role as 'member',
          autoApprove: b.autoApprove as boolean,
          nonce: 'nonce-1',
          ...(b.maxUses ? { maxUses: Number(b.maxUses) } : {}),
        };
        detail = {
          ...detail,
          invites: [...detail.invites, { ...invite, uses: 0 }],
        };
        return {
          token: 'inv.token.signed',
          invite,
          link: 'http://app/#/club/join/inv.token.signed',
        };
      },
      'POST /api/clubs/c1/rooms': (init) => {
        const b = body(init);
        calls.push({ key: 'room', body: b });
        const room: Room = { id: 'r1', name: String(b.name), templates: [] };
        detail = { ...detail, rooms: [...detail.rooms, room] };
        return room;
      },
      'POST /api/clubs/c1/rooms/r1/templates': (init) => {
        const b = body(init) as unknown as Omit<TableTemplate, 'id'>;
        calls.push({ key: 'template', body: b as unknown as Record<string, unknown> });
        if (b.stakes.rake && b.stakes.rake.basisPoints < 200)
          throw Object.assign(new Error('rake must be at least 200 basis points'), {
            status: 400,
            code: 'bad-template',
          });
        const template: TableTemplate = { ...b, id: 'tp1' };
        detail = {
          ...detail,
          rooms: detail.rooms.map((r) =>
            r.id === 'r1' ? { ...r, templates: [...r.templates, template] } : r,
          ),
        };
        return template;
      },
      'GET /api/clubs/c1/tables': () => detail.tables,
      'GET /api/clubs/c1/ledger': () => ({
        total: 2,
        entries: [
          entry(2, 'grant', [
            { account: 'house', amount: -20_000 },
            { account: 'm1', amount: 20_000 },
          ]),
          entry(1, 'mint', [{ account: 'house', amount: 620_000 }]),
        ],
      }),
      'POST /api/clubs/c1/verify': () => ({
        ok: true,
        entries: 2,
        totals: { minted: 620_000, burned: 0, reserve: 600_000, circulation: 20_000 },
      }),
    });
    render(<PlatformApp status={platformStatus()} />);

    // Overview: economy cards and the live stream.
    expect(await screen.findByTestId('club-page')).toHaveAttribute('data-role', 'owner');
    expect(screen.getByTestId('stat-reserve')).toHaveTextContent('5,000.00 USDC');
    expect(screen.getByTestId('stat-circulation')).toHaveTextContent('1,200.00 USDC');
    expect(screen.getByTestId('stat-minted')).toHaveTextContent('6,200.00 USDC');
    expect(screen.getByTestId('stat-burned')).toHaveTextContent('0.00 USDC');
    expect(screen.getByTestId('stat-members')).toHaveTextContent('1 active · 1 pending · 1 online');
    expect(FakeEventSource.instances[0]!.url).toBe('/api/clubs/c1/events?token=tok-1');
    FakeEventSource.instances[0]!.onopen?.();
    await waitFor(() =>
      expect(screen.getByTestId('live-indicator')).toHaveAttribute('data-live', 'open'),
    );

    // Buy chips with the dev method (offered because status.dev is true).
    await userEvent.selectOptions(screen.getByTestId('buy-method'), 'dev');
    expect(screen.queryByTestId('buy-reference')).not.toBeInTheDocument();
    const amount = screen.getByTestId('buy-amount');
    await userEvent.clear(amount);
    await userEvent.type(amount, '100000');
    await userEvent.click(screen.getByTestId('buy-submit'));
    await waitFor(() => expect(calls.find((c) => c.key === 'purchase')).toBeTruthy());
    expect(calls.find((c) => c.key === 'purchase')!.body).toEqual({
      amount: 100000,
      method: 'dev',
    });
    await waitFor(() =>
      expect(screen.getByTestId('stat-reserve')).toHaveTextContent('6,000.00 USDC'),
    );
    expect(screen.getByTestId('purchase-p9')).toHaveAttribute('data-status', 'paid');

    // Members: approve the pending one.
    await userEvent.click(screen.getByTestId('tab-members'));
    expect(screen.getByTestId('member-m2')).toHaveAttribute('data-status', 'pending');
    expect(screen.queryByTestId('ban-m1')).not.toBeInTheDocument(); // the owner cannot be banned
    await userEvent.click(screen.getByTestId('approve-m2'));
    await waitFor(() =>
      expect(screen.getByTestId('member-m2')).toHaveAttribute('data-status', 'active'),
    );
    expect(screen.getByTestId('grant-m2')).toBeInTheDocument();

    // Invites: link, token and QR.
    await userEvent.click(screen.getByTestId('tab-invites'));
    expect(screen.getByTestId('no-invites')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('invite-max-uses'), '5');
    await userEvent.click(screen.getByTestId('create-invite'));
    expect(await screen.findByTestId('invite-result')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'invite')!.body).toEqual({
      role: 'member',
      autoApprove: true,
      maxUses: 5,
    });
    expect(screen.getByTestId('invite-link')).toHaveValue(
      'http://app/#/club/join/inv.token.signed',
    );
    expect(screen.getByTestId('invite-token')).toHaveValue('inv.token.signed');
    await waitFor(() => expect(screen.getByTestId('qr').querySelector('svg')).toBeTruthy());
    expect(await screen.findByTestId('invite-nonce-1')).toHaveTextContent('0/5 used');
    expect(screen.getByTestId('revoke-invite-nonce-1')).toBeInTheDocument();

    // Rooms: add a room, then an OFC template; rake below the minimum is refused client-side.
    await userEvent.click(screen.getByTestId('tab-rooms'));
    expect(screen.getByTestId('no-rooms')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('room-name'), 'Main room');
    await userEvent.click(screen.getByTestId('add-room'));
    expect(await screen.findByTestId('room-r1')).toHaveTextContent('Main room');
    expect(calls.find((c) => c.key === 'room')!.body).toEqual({ name: 'Main room' });
    await userEvent.click(screen.getByTestId('add-template-r1'));
    const form = screen.getByTestId('template-form');
    expect(form).toHaveAttribute('data-mode', 'add');
    await userEvent.click(await within(form).findByTestId('preset-standard-pineapple'));
    expect(within(form).getByTestId('rules-editor')).toHaveAttribute(
      'data-preset',
      'standard-pineapple',
    );
    await userEvent.type(within(form).getByTestId('template-name'), 'Pineapple 1/2');
    const cpp = within(form).getByTestId('stakes-chips-per-point');
    await userEvent.clear(cpp);
    await userEvent.type(cpp, '50');
    const bps = within(form).getByTestId('stakes-rake-bps');
    await userEvent.clear(bps);
    await userEvent.type(bps, '100');
    expect(within(form).getByTestId('template-error')).toHaveTextContent(
      'at least 200 basis points',
    );
    await userEvent.click(within(form).getByTestId('save-template'));
    expect(calls.find((c) => c.key === 'template')).toBeUndefined();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/rooms/r1/templates')),
    ).toHaveLength(0);
    await userEvent.clear(bps);
    await userEvent.type(bps, '250');
    expect(within(form).queryByTestId('template-error')).not.toBeInTheDocument();
    await userEvent.click(within(form).getByTestId('save-template'));
    expect(await screen.findByTestId('template-tp1')).toHaveTextContent('Pineapple 1/2');
    expect(screen.getByTestId('template-tp1')).toHaveTextContent('rake 2.5%');
    const sent = calls.find((c) => c.key === 'template')!.body as unknown as Omit<
      TableTemplate,
      'id'
    >;
    expect(sent).toMatchObject({
      name: 'Pineapple 1/2',
      game: 'ofc',
      seats: 2,
      stakes: { chipsPerPoint: 50, rake: { basisPoints: 250 } },
      alwaysOpen: false,
    });
    expect((sent.config as { variant: string }).variant).toBe('pineapple');
    expect(sent.randomness).toBeUndefined();

    // Live tables.
    await userEvent.click(screen.getByTestId('tab-tables'));
    expect(await screen.findByTestId('table-t1')).toHaveAttribute('data-status', 'open');
    expect(screen.getByTestId('table-t1')).toHaveTextContent('CLUB01');
    expect(screen.getByTestId('table-t1')).toHaveTextContent('1/2 seats · Ann (200.00 USDC)');
    expect(screen.getByTestId('close-table-t1')).toBeInTheDocument();

    // Ledger: entries, verification and the kind filter.
    await userEvent.click(screen.getByTestId('tab-ledger'));
    expect(await screen.findByTestId('ledger-entry-2')).toHaveTextContent(
      'house −200.00 USDC · Ann +200.00 USDC — welcome',
    );
    expect(screen.getByTestId('ledger-entry-1')).toHaveAttribute('data-kind', 'mint');
    expect(screen.getByTestId('ledger-page')).toHaveTextContent('page 1 of 1 · 2 entries');
    expect(screen.getByTestId('ledger-next')).toBeDisabled();
    await userEvent.click(screen.getByTestId('verify-ledger'));
    expect(await screen.findByTestId('verify-result')).toHaveAttribute('data-ok', 'true');
    expect(screen.getByTestId('verify-result')).toHaveTextContent('2 entries verified');
    await userEvent.selectOptions(screen.getByTestId('ledger-kind'), 'grant');
    expect(screen.queryByTestId('ledger-entry-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('ledger-entry-2')).toBeInTheDocument();

    // A platform event lands in the activity log and refreshes the detail.
    detail = { ...detail, online: ['m1', 'm2'] };
    FakeEventSource.instances[0]!.emit({
      seq: 41,
      clubId: 'c1',
      type: 'joined',
      message: 'joined m2',
      at: Date.now(),
      dataJson: null,
    });
    await userEvent.click(screen.getByTestId('tab-overview'));
    await waitFor(() => expect(screen.getByTestId('event-log')).toHaveTextContent('joined m2'));
    await waitFor(() =>
      expect(screen.getByTestId('stat-members')).toHaveTextContent(
        '2 active · 0 pending · 2 online',
      ),
    );
  });

  it('hides admin sections and actions from a plain member', async () => {
    installFakeApi({
      'GET /api/me': () => fakeMe({ profileId: 'm2', name: 'Bob' }),
      'GET /api/clubs/c1': () =>
        fakeDetail({
          role: 'member',
          members: [
            { id: 'm1', name: 'Ann', role: 'owner', status: 'active', joinedAt: 1 },
            { id: 'm2', name: 'Bob', role: 'member', status: 'active', joinedAt: 2 },
          ],
          purchases: [],
          invites: [],
          requests: [],
        }),
      'GET /api/clubs/c1/statements/m2': () => ({
        memberId: 'm2',
        balance: 15_000,
        entries: [],
        history: [
          {
            seq: 3,
            at: 3,
            kind: 'grant',
            amount: 15_000,
            balance: 15_000,
            description: 'Grant from the club',
          },
        ],
        head: { seq: 3, hash: 'abc', signature: 's' },
      }),
    });
    window.location.hash = '#/clubs/c1?tab=statements';
    render(<PlatformApp status={platformStatus()} />);
    expect(await screen.findByTestId('club-page')).toHaveAttribute('data-role', 'member');
    expect(screen.queryByTestId('tab-ledger')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tab-invites')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tab-requests')).not.toBeInTheDocument();
    expect(screen.getByTestId('panel-statements')).toBeInTheDocument();
    expect(await screen.findByTestId('statement-balance')).toHaveTextContent('150.00 USDC');
    expect(screen.getByTestId('statement-line-3')).toHaveTextContent('Grant from the club');
    expect(screen.getByTestId('statement-line-3')).toHaveTextContent('+150.00 USDC');
    expect(screen.queryByTestId('statement-member')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('tab-members'));
    expect(screen.queryByTestId('grant-m1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('role-m2')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('tab-overview'));
    expect(screen.queryByTestId('buy-form')).not.toBeInTheDocument();
  });
});
