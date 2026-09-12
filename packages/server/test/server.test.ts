import { describe, expect, it } from 'vitest';
import { scriptedDice } from '@bgf/engine';
import type { ServerMessage } from '@bgf/protocol';
import { PROTOCOL_VERSION, createMemoryPair } from '@bgf/protocol';
import { GameServer } from '../src/index.js';

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Raw-transport client: no GameClient, so this suite has no dependency on @bgf/client. */
function rawClient(server: GameServer, profile = { id: 'p', name: 'P' }) {
  const [serverEnd, clientEnd] = createMemoryPair('raw');
  server.accept(serverEnd);
  const inbox: ServerMessage[] = [];
  clientEnd.onMessage((m) => inbox.push(m as ServerMessage));
  clientEnd.send({ type: 'hello', protocol: PROTOCOL_VERSION, profile });
  return { transport: clientEnd, inbox, send: (m: unknown) => clientEnd.send(m) };
}

describe('GameServer (raw transports)', () => {
  it('creates a fresh match with the host seated and drives a game through actions', async () => {
    const server = new GameServer({ code: 'RAW1', host: { id: 'h', name: 'H' }, dice: scriptedDice([5, 2, 6, 1]), now: () => 42, matchId: 'fixed' });
    const snap = server.getSnapshot();
    expect(snap).toMatchObject({ id: 'fixed', code: 'RAW1', seq: 0, createdAt: 42, players: { white: { id: 'h' }, black: null }, hostSeat: 'white' });
    const changes: (string | undefined)[] = [];
    server.onChange((_, a) => changes.push(a?.type));
    const host = rawClient(server, { id: 'h', name: 'H' });
    const guest = rawClient(server, { id: 'g', name: 'G' });
    await flush();
    expect(host.inbox[0]).toMatchObject({ type: 'welcome', seat: 'white' });
    expect(guest.inbox[0]).toMatchObject({ type: 'welcome', seat: 'black' });
    host.send({ type: 'start-game' });
    host.send({ type: 'opening-roll' });
    guest.send({ type: 'opening-roll' });
    await flush();
    expect(server.getSnapshot().match.game!.phase).toMatchObject({ kind: 'moving', player: 'white', dice: [5, 2] });
    expect(server.getSnapshot().seq).toBe(3);
    expect(changes).toEqual([undefined, undefined, 'start-game', 'opening-roll', 'opening-roll']);
    const states = guest.inbox.filter((m) => m.type === 'state');
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect(states.at(-1)).toMatchObject({ type: 'state', action: { type: 'opening-roll', player: 'black', die: 2 }, by: 'black' });
    host.send({ type: 'play', play: [{ from: 13, to: 8, die: 5 }, { from: 13, to: 11, die: 2 }] });
    await flush();
    expect(server.getSnapshot().match.game!.phase).toEqual({ kind: 'to-roll', player: 'black' });
    expect(server.getSnapshot().match.game!.history.at(-1)).toMatchObject({ type: 'move', play: [{ from: 13, to: 8, die: 5, hit: false }, { from: 13, to: 11, die: 2, hit: false }] });
    server.close();
    await flush();
    expect(host.transport.status).toBe('closed');
    expect(guest.transport.status).toBe('closed');
  });

  it('never throws on hostile input and rejects unknown seats', async () => {
    const server = new GameServer({ code: 'RAW2', host: { id: 'h', name: 'H' } });
    const a = rawClient(server, { id: 'h', name: 'H' });
    const b = rawClient(server, { id: 'g', name: 'G' });
    const c = rawClient(server, { id: 'x', name: 'X' });
    await flush();
    expect(c.inbox).toEqual([{ type: 'rejected', reason: 'full', message: expect.any(String) }]);
    for (const junk of [1, [], { type: 'play', play: [{}] }, { type: 'chat' }, { type: 'offer-resign', stakes: 1 }]) a.send(junk);
    await flush();
    expect(a.inbox.filter((m) => m.type === 'error').length).toBe(5);
    expect(server.connectedSeats().length).toBe(2);
    b.send({ type: 'roll' });
    await flush();
    expect(b.inbox.at(-1)).toMatchObject({ type: 'error', code: 'wrong-phase' });
    server.close();
  });

  it('accept after close closes the transport immediately', () => {
    const server = new GameServer({ code: 'RAW3', host: { id: 'h', name: 'H' } });
    server.close();
    const [serverEnd] = createMemoryPair();
    server.accept(serverEnd);
    expect(serverEnd.status).toBe('closed');
  });
});
