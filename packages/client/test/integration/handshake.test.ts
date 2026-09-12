import { describe, expect, it } from 'vitest';
import { createMemoryPair, PROTOCOL_VERSION } from '@bgf/protocol';
import { GameClient } from '../../src/index.js';
import { GUEST, HOST, STRANGER, flush, makeHarness } from './harness.js';

describe('handshake', () => {
  it('welcomes host and guest into their seats', async () => {
    const h = await makeHarness();
    expect(h.host.getState().status).toBe('joined');
    expect(h.host.getState().seat).toBe('white');
    expect(h.guest.getState().status).toBe('joined');
    expect(h.guest.getState().seat).toBe('black');
    const snap = h.host.getState().snapshot!;
    expect(snap.players.white).toEqual(HOST);
    expect(snap.players.black).toEqual(GUEST);
    expect(snap.code).toBe('TEST42');
    expect(snap.hostSeat).toBe('white');
    expect(h.server.connectedSeats().sort()).toEqual(['black', 'white']);
    expect(h.host.getState().presence).toEqual({ white: true, black: true });
    expect(h.guest.getState().presence).toEqual({ white: true, black: true });
    h.expectConverged();
    h.close();
  });

  it('host may take the black seat', async () => {
    const h = await makeHarness({ hostSeat: 'black' });
    expect(h.host.getState().seat).toBe('black');
    expect(h.guest.getState().seat).toBe('white');
    expect(h.host.getState().snapshot!.hostSeat).toBe('black');
    h.close();
  });

  it('rejects a third profile as full', async () => {
    const h = await makeHarness();
    const { client, transport } = h.connect(STRANGER);
    await flush();
    expect(client.getState().status).toBe('rejected');
    expect(client.getState().rejectReason).toBe('full');
    expect(transport.status).toBe('closed');
    expect(h.server.connectedSeats().length).toBe(2);
    h.close();
  });

  it('reconnecting with a known profile replaces the live connection without a presence blip', async () => {
    const h = await makeHarness();
    const presence: boolean[] = [];
    h.host.subscribe(() => presence.push(h.host.getState().presence.black));
    const { client: guest2 } = h.connect({ ...GUEST, name: 'Bobby' });
    await flush();
    expect(guest2.getState().status).toBe('joined');
    expect(guest2.getState().seat).toBe('black');
    expect(h.guest.getState().status).toBe('disconnected');
    expect(presence.every((p) => p)).toBe(true);
    expect(h.host.getState().snapshot!.players.black!.name).toBe('Bobby');
    expect(h.server.connectedSeats().length).toBe(2);
    guest2.close();
    h.close();
  });

  it('rejects a protocol mismatch', async () => {
    const h = await makeHarness({ withGuest: false });
    const [serverEnd, raw] = createMemoryPair();
    h.server.accept(serverEnd);
    const got: unknown[] = [];
    raw.onMessage((m) => got.push(m));
    raw.send({ type: 'hello', protocol: PROTOCOL_VERSION + 1, profile: GUEST });
    await flush();
    expect(got).toEqual([expect.objectContaining({ type: 'rejected', reason: 'protocol' })]);
    expect(raw.status).toBe('closed');
    h.close();
  });

  it('rejects a non-hello first message and garbage', async () => {
    const h = await makeHarness({ withGuest: false });
    for (const first of [{ type: 'roll' }, 'hello', 42, null, { type: 'hello', protocol: 1, profile: { id: '' } }]) {
      const [serverEnd, raw] = createMemoryPair();
      h.server.accept(serverEnd);
      const got: unknown[] = [];
      raw.onMessage((m) => got.push(m));
      raw.send(first);
      await flush();
      expect(got).toEqual([expect.objectContaining({ type: 'rejected', reason: 'bad-hello' })]);
      expect(raw.status).toBe('closed');
    }
    h.close();
  });

  it('a malformed message after joining yields an error but keeps the seat', async () => {
    const h = await makeHarness({ withGuest: false });
    const [serverEnd, raw] = createMemoryPair();
    h.server.accept(serverEnd);
    const got: { type: string; code?: string }[] = [];
    raw.onMessage((m) => got.push(m as { type: string }));
    raw.send({ type: 'hello', protocol: PROTOCOL_VERSION, profile: GUEST });
    await flush();
    raw.send({ type: 'play', play: 'nope' });
    raw.send({ type: 'wat' });
    raw.send({ type: 'hello', protocol: PROTOCOL_VERSION, profile: GUEST });
    await flush();
    const errors = got.filter((m) => m.type === 'error');
    expect(errors.map((e) => e.code)).toEqual(['bad-message', 'bad-message', 'already-joined']);
    expect(raw.status).toBe('open');
    expect(h.server.connectedSeats()).toContain('black');
    h.close();
  });

  it('client sends hello once the transport opens and handles a server that is closed', async () => {
    const h = await makeHarness({ withGuest: false });
    h.server.close();
    const [serverEnd, clientEnd] = createMemoryPair();
    h.server.accept(serverEnd);
    const client = new GameClient({ transport: clientEnd, profile: GUEST, pingIntervalMs: 0 });
    await flush();
    expect(client.getState().status).toBe('disconnected');
    expect(h.host.getState().status).toBe('disconnected');
  });
});
