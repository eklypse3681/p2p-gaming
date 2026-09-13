import { describe, expect, it } from 'vitest';
import { generateKeyPair, signerFor } from '@bgf/protocol';
import { GameClient } from '../../src/index.js';
import { GameServer } from '@bgf/server';
import {
  GUEST,
  HOST,
  STRANGER,
  flush,
  keyedProfile,
  keysFor,
  makeHarness,
  startAndOpen,
} from './harness.js';

describe('seat authentication', () => {
  it('binds each seat to the key that first took it and welcomes signed devices', async () => {
    const h = await makeHarness();
    const snap = h.server.getSnapshot();
    expect(snap.players.white?.publicKey).toBe(keysFor(HOST.id).publicKey);
    expect(snap.players.black?.publicKey).toBe(keysFor(GUEST.id).publicKey);
    expect(h.host.getState().status).toBe('joined');
    expect(h.guest.getState().status).toBe('joined');
    // A second device with the same key joins the same seat.
    const { client: phone } = h.connect(GUEST);
    await flush();
    expect(phone.getState().status).toBe('joined');
    expect(phone.getState().seat).toBe('black');
    expect(h.guest.getState().status).toBe('joined');
    phone.close();
    h.close();
  });

  it("refuses an impostor who knows the guest's id but not their key", async () => {
    const h = await makeHarness();
    const other = await generateKeyPair();
    const { client: impostor } = h.connect(
      { ...GUEST, publicKey: other.publicKey },
      { signer: signerFor(other.privateKey) },
    );
    await flush();
    expect(impostor.getState().status).toBe('rejected');
    expect(impostor.getState().rejectReason).toBe('unauthorized');
    expect(h.guest.getState().status).toBe('joined');
    expect(h.server.connectedSeats().sort()).toEqual(['black', 'white']);
    expect(h.server.getSnapshot().players.black?.publicKey).toBe(keysFor(GUEST.id).publicKey);
    h.close();
  });

  it('refuses a device that claims the right key but cannot sign for it', async () => {
    const h = await makeHarness();
    const other = await generateKeyPair();
    const { client: liar } = h.connect(keyedProfile(GUEST), {
      signer: signerFor(other.privateKey),
    });
    await flush();
    expect(liar.getState().status).toBe('rejected');
    expect(liar.getState().rejectReason).toBe('unauthorized');
    // ...and an unkeyed hello for a bound seat is refused too.
    const { client: legacy } = h.connect(GUEST, { legacy: true });
    await flush();
    expect(legacy.getState().status).toBe('rejected');
    expect(legacy.getState().rejectReason).toBe('unauthorized');
    h.close();
  });

  it('a client without a signer cannot take a keyed seat', async () => {
    const h = await makeHarness({ withGuest: false });
    const transport = h.server.connectLocal();
    const unsigned = new GameClient({
      transport,
      profile: keyedProfile(STRANGER),
      pingIntervalMs: 0,
    });
    await flush();
    expect(unsigned.getState().status).toBe('rejected');
    expect(unsigned.getState().rejectReason).toBe('unauthorized');
    unsigned.close();
    h.close();
  });

  it('legacy unkeyed players still play, and their seat is bound on the first keyed hello', async () => {
    const h = await makeHarness({ withGuest: false });
    const legacy = { id: 'old-timer', name: 'Olive' };
    const { client: first } = h.connect(legacy, { legacy: true });
    await flush();
    expect(first.getState().status).toBe('joined');
    expect(first.getState().seat).toBe('black');
    expect(h.server.getSnapshot().players.black?.publicKey).toBeUndefined();

    const keys = await generateKeyPair();
    const { client: upgraded } = h.connect(
      { ...legacy, publicKey: keys.publicKey },
      { signer: signerFor(keys.privateKey) },
    );
    await flush();
    expect(upgraded.getState().status).toBe('joined');
    expect(h.server.getSnapshot().players.black?.publicKey).toBe(keys.publicKey);
    expect(first.getState().snapshot?.players.black?.publicKey).toBe(keys.publicKey);

    const other = await generateKeyPair();
    const { client: later } = h.connect(
      { ...legacy, publicKey: other.publicKey },
      { signer: signerFor(other.privateKey) },
    );
    await flush();
    expect(later.getState().rejectReason).toBe('unauthorized');
    h.close();
  });

  it('adopting a newer snapshot never replaces a bound key', async () => {
    const h = await makeHarness();
    const before = h.server.getSnapshot();
    await startAndOpen(h);
    const newer = h.server.getSnapshot();
    expect(newer.seq).toBeGreaterThan(before.seq);
    h.close();

    // A fresh server from the OLD copy; the guest offers the newer copy with a forged white key.
    const forged = await generateKeyPair();
    const server = new GameServer({
      snapshot: before,
      code: before.code,
      host: keyedProfile(HOST),
    });
    const offered = {
      ...newer,
      players: {
        ...newer.players,
        white: { ...newer.players.white!, publicKey: forged.publicKey },
      },
    };
    const guestTransport = server.connectLocal();
    const guest = new GameClient({
      transport: guestTransport,
      profile: keyedProfile(GUEST),
      signer: signerFor(keysFor(GUEST.id).privateKey),
      resumeSnapshot: offered,
      pingIntervalMs: 0,
    });
    await flush();
    expect(guest.getState().status).toBe('joined');
    const adopted = server.getSnapshot();
    expect(adopted.seq).toBe(newer.seq);
    expect(adopted.players.white?.publicKey).toBe(keysFor(HOST.id).publicKey);
    guest.close();
    server.close();
  });
});
