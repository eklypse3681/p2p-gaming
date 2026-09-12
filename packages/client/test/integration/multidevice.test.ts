import { describe, expect, it } from 'vitest';
import { MAX_CONNECTIONS_PER_SEAT } from '@bgf/server';
import {
  GUEST,
  HOST,
  STRANGER,
  autoPlay,
  clientFor,
  flush,
  makeHarness,
  startAndOpen,
} from './harness.js';

/**
 * One player, several devices. A hello with a seated profile id joins that seat's set of
 * connections: every device gets every state, any device may act, presence only changes when the
 * first device arrives or the last one leaves.
 */
describe('one player on several devices', () => {
  it('a second device joins the same seat and both stay joined', async () => {
    const h = await makeHarness();
    const { client: phone } = h.connect(HOST);
    await flush();
    expect(h.host.getState().status).toBe('joined');
    expect(h.host.getState().seat).toBe('white');
    expect(phone.getState().status).toBe('joined');
    expect(phone.getState().seat).toBe('white');
    expect(h.server.connectionCount('white')).toBe(2);
    expect(h.server.connectionCount('black')).toBe(1);
    expect(h.server.connectedSeats().sort()).toEqual(['black', 'white']);
    // The roster is unchanged: no twin, no "(2)".
    expect(h.host.getState().snapshot!.players.white).toEqual(HOST);
    expect(h.host.getState().snapshot!.players.black).toEqual(GUEST);
    h.expectConverged();
    phone.close();
    h.close();
  });

  it('every device receives every state and either device may act', async () => {
    const h = await makeHarness();
    const { client: phone } = h.connect(HOST);
    await flush();
    h.host.startGame();
    await flush();
    h.expectConverged();
    // Opening roll from the laptop, the guest's roll, then a move from the phone.
    for (let i = 0; i < 20; i++) {
      const g = h.host.getState().snapshot!.match.game!;
      if (g.phase.kind !== 'opening') break;
      if (g.phase.rolls.white === undefined) h.host.openingRoll();
      if (g.phase.rolls.black === undefined) h.guest.openingRoll();
      await flush();
    }
    const game = h.host.getState().snapshot!.match.game!;
    expect(game.phase.kind).toBe('moving');
    if (game.phase.kind === 'moving' && game.phase.player === 'white') {
      expect(phone.getState().draft.next.length).toBeGreaterThan(0);
      autoPlay(phone);
    } else {
      autoPlay(h.guest);
    }
    await flush();
    h.expectConverged();
    expect(phone.getState().snapshot!.seq).toBe(h.host.getState().snapshot!.seq);
    expect(phone.getState().lastAction?.action.type).toBe('play');
    phone.close();
    h.close();
  });

  it('presence stays on while any device remains and turns off when the last one leaves', async () => {
    const h = await makeHarness();
    const seen: boolean[] = [];
    h.guest.subscribe(() => seen.push(h.guest.getState().presence.white));
    const { client: phone } = h.connect(HOST);
    await flush();
    expect(seen.every((p) => p)).toBe(true); // no blip when the second device joined
    h.host.close(); // laptop leaves
    await flush();
    expect(h.guest.getState().presence.white).toBe(true);
    expect(h.server.connectionCount('white')).toBe(1);
    phone.close(); // last device leaves
    await flush();
    expect(h.guest.getState().presence.white).toBe(false);
    expect(h.server.connectedSeats()).toEqual(['black']);
    h.close();
  });

  it('a dead transport is dropped without disturbing the other device', async () => {
    const h = await makeHarness();
    const { client: phone, transport } = h.connect(HOST);
    await flush();
    transport.close(); // network drops under the phone
    await flush();
    expect(phone.getState().status).toBe('disconnected');
    expect(h.host.getState().status).toBe('joined');
    expect(h.guest.getState().presence.white).toBe(true);
    expect(h.server.connectionCount('white')).toBe(1);
    h.close();
  });

  it('caps devices per seat by dropping the oldest', async () => {
    const h = await makeHarness();
    const extras = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_SEAT; i++) {
      extras.push(h.connect(HOST).client);
      await flush();
    }
    // The original local connection was the oldest and has been dropped.
    expect(h.server.connectionCount('white')).toBe(MAX_CONNECTIONS_PER_SEAT);
    expect(h.host.getState().status).toBe('disconnected');
    expect(extras.every((c) => c.getState().status === 'joined')).toBe(true);
    expect(h.guest.getState().presence.white).toBe(true);
    for (const c of extras) c.close();
    h.close();
  });

  it('a third profile is still turned away', async () => {
    const h = await makeHarness();
    const { client: phone } = h.connect(HOST);
    await flush();
    const { client: stranger } = h.connect(STRANGER);
    await flush();
    expect(stranger.getState().status).toBe('rejected');
    expect(stranger.getState().rejectReason).toBe('full');
    phone.close();
    h.close();
  });

  it('a device arriving with a newer snapshot brings the table up to date', async () => {
    const h = await makeHarness();
    await startAndOpen(h);
    autoPlay(
      clientFor(
        h,
        h.host.getState().snapshot!.match.game!.phase.kind === 'moving'
          ? (h.host.getState().snapshot!.match.game!.phase as { player: 'white' | 'black' }).player
          : 'white',
      ),
    );
    await flush();
    const newer = h.host.getState().snapshot!;
    // Rebuild an older server from before that move and connect the phone with the newer copy.
    const older = { ...newer, seq: newer.seq - 1, actions: newer.actions.slice(0, -1) };
    const h2 = await makeHarness({ snapshot: older, withGuest: false });
    expect(h2.host.getState().snapshot!.seq).toBe(newer.seq - 1);
    const { client: phone } = h2.connect(HOST, { resumeSnapshot: newer });
    await flush();
    expect(phone.getState().seat).toBe('white');
    expect(h2.host.getState().snapshot!.seq).toBe(newer.seq);
    expect(h2.server.connectionCount('white')).toBe(2);
    phone.close();
    h2.close();
    h.close();
  });
});
