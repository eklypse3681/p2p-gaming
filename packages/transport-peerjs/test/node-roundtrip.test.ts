import { describe, expect, it } from 'vitest';
import { installNodeWebRtcSync, isWebRtcSupported, peerJsProvider } from '../src/index.js';

/**
 * Real network: hosts with one provider and joins from another, both in this Node process, through
 * the free PeerJS cloud and a genuine WebRTC data channel (node-datachannel).
 *
 *   E2E_NETWORK=1 pnpm vitest run --project transport-peerjs -t node
 */
describe.skipIf(!process.env.E2E_NETWORK)('PeerJS from Node over the real cloud', () => {
  it('installs WebRTC, hosts, joins and exchanges a message', { timeout: 60_000 }, async () => {
    expect(installNodeWebRtcSync()).toBe(true);
    expect(isWebRtcSupported()).toBe(true);
    const code = `NODE${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const namespace = `test-${Date.now()}`;
    const hostSide = peerJsProvider({ namespace, keepaliveMs: 0 });
    const guestSide = peerJsProvider({ namespace, keepaliveMs: 0 });
    const listener = await hostSide.host(code);
    const received = new Promise<unknown>((resolve) => {
      listener.onConnection((t) => {
        t.onMessage((m) => {
          t.send({ echo: m });
          resolve(m);
        });
      });
    });
    const guest = await guestSide.join(code, { timeoutMs: 30_000 });
    const reply = new Promise<unknown>((resolve) => guest.onMessage(resolve));
    guest.send({ hello: 'from node' });
    expect(await received).toEqual({ hello: 'from node' });
    expect(await reply).toEqual({ echo: { hello: 'from node' } });
    guest.close();
    listener.close();
  });
});
