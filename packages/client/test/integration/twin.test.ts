import { describe, expect, it } from 'vitest';
import { twinIdFor } from '@bgf/server';
import { GUEST, HOST, STRANGER, flush, makeHarness } from './harness.js';

/**
 * The same person opening the match in a second tab (same profile id) while the first tab is
 * still connected should get the other seat, not kick the first tab off its own seat.
 */
describe('same profile in a second tab', () => {
  it('seats the second connection as the opponent and keeps the first one joined', async () => {
    const h = await makeHarness({ withGuest: false });
    const { client: twin } = h.connect(HOST);
    await flush();
    expect(h.host.getState().status).toBe('joined');
    expect(h.host.getState().seat).toBe('white');
    expect(twin.getState().status).toBe('joined');
    expect(twin.getState().seat).toBe('black');
    const snap = h.host.getState().snapshot!;
    expect(snap.players.white).toEqual(HOST);
    expect(snap.players.black).toEqual({ ...HOST, id: twinIdFor(HOST.id), name: 'Alice (2)' });
    expect(h.server.connectedSeats().sort()).toEqual(['black', 'white']);
    expect(h.host.getState().presence).toEqual({ white: true, black: true });
    twin.close();
    h.close();
  });

  it('the twin tab may reconnect and always gets the twin seat back', async () => {
    const h = await makeHarness({ withGuest: false });
    const { client: twin } = h.connect(HOST);
    await flush();
    twin.close();
    await flush();
    const { client: twin2 } = h.connect(HOST);
    await flush();
    expect(twin2.getState().seat).toBe('black');
    expect(h.host.getState().status).toBe('joined');
    expect(h.host.getState().seat).toBe('white');
    twin2.close();
    h.close();
  });

  it('a genuine reconnect (seat not live) still gets the original seat', async () => {
    const h = await makeHarness();
    h.guest.close();
    await flush();
    const { client: guest2 } = h.connect(GUEST);
    await flush();
    expect(guest2.getState().seat).toBe('black');
    expect(h.host.getState().snapshot!.players.black).toEqual(GUEST);
    guest2.close();
    h.close();
  });

  it('once a twin holds the other seat a third profile is turned away', async () => {
    const h = await makeHarness({ withGuest: false });
    const { client: twin } = h.connect(HOST);
    await flush();
    const { client: stranger } = h.connect(STRANGER);
    await flush();
    expect(stranger.getState().status).toBe('rejected');
    expect(stranger.getState().rejectReason).toBe('full');
    twin.close();
    h.close();
  });

  it('with a real opponent already seated, the same profile replaces its own connection as before', async () => {
    const h = await makeHarness();
    const { client: hostAgain } = h.connect(HOST);
    await flush();
    expect(hostAgain.getState().seat).toBe('white');
    expect(h.host.getState().status).toBe('disconnected');
    expect(h.guest.getState().status).toBe('joined');
    hostAgain.close();
    h.close();
  });
});
