import { describe, expect, it } from 'vitest';
import { replay, seededDice } from '@bgf/engine';
import type { MatchSnapshot } from '@bgf/protocol';
import { GameServer } from '@bgf/server';
import { GameClient, MemoryMatchStore } from '../../src/index.js';
import {
  GUEST,
  HOST,
  autoPlay,
  clientFor,
  currentGame,
  flush,
  keyedProfile,
  makeHarness,
  signerOf,
  startAndOpen,
} from './harness.js';

/** Snapshot as it would have been `drop` actions ago. */
function olderSnapshot(s: MatchSnapshot, drop: number): MatchSnapshot {
  const actions = s.actions.slice(0, s.actions.length - drop);
  return { ...s, actions, seq: s.seq - drop, match: replay(s.config, actions) };
}

async function playSomeTurns(turns: number) {
  const h = await makeHarness({ dice: seededDice(99) });
  await startAndOpen(h);
  for (let i = 0; i < turns; i++) {
    const g = currentGame(h.host);
    if (g.phase.kind === 'to-roll') clientFor(h, g.phase.player).roll();
    else if (g.phase.kind === 'moving') autoPlay(clientFor(h, g.phase.player));
    await flush();
  }
  h.host.sendChat('brb');
  await flush();
  return h;
}

describe('resume', () => {
  it('adopts the guest snapshot when it is newer than the host copy', async () => {
    const h = await playSomeTurns(6);
    const latest = h.guestStore.peek(h.server.getSnapshot().id)!;
    expect(latest.seq).toBe(h.server.getSnapshot().seq);
    h.close();

    const stale = olderSnapshot(latest, 2);
    const server = new GameServer({
      code: latest.code,
      host: keyedProfile(HOST),
      snapshot: stale,
      dice: seededDice(1),
    });
    expect(server.getSnapshot().seq).toBe(latest.seq - 2);
    const hostStore = new MemoryMatchStore();
    const host = new GameClient({
      transport: server.connectLocal(),
      profile: keyedProfile(HOST),
      signer: signerOf(HOST),
      resumeSnapshot: stale,
      store: hostStore,
      pingIntervalMs: 0,
    });
    await flush();
    expect(host.getState().snapshot!.seq).toBe(stale.seq);
    const { client: guest } = await makeGuest(server, latest);
    await flush();
    expect(guest.getState().status).toBe('joined');
    expect(guest.getState().seat).toBe('black');
    expect(guest.getState().snapshot!.seq).toBe(latest.seq);
    expect(host.getState().snapshot!.seq).toBe(latest.seq);
    expect(host.getState().snapshot!.match).toEqual(latest.match);
    expect(host.getState().chat.map((c) => c.text)).toEqual(['brb']);
    expect(hostStore.peek(latest.id)!.seq).toBe(latest.seq);
    expect(server.getSnapshot().players).toEqual({
      white: keyedProfile(HOST),
      black: keyedProfile(GUEST),
    });
    // Play continues from the adopted state.
    const g = currentGame(host);
    if (g.phase.kind === 'to-roll') (g.phase.player === 'white' ? host : guest).roll();
    await flush();
    expect(JSON.stringify(host.getState().snapshot)).toBe(
      JSON.stringify(guest.getState().snapshot),
    );
    guest.close();
    host.close();
    server.close();
  });

  it('keeps the host snapshot when it is newer than the guest copy', async () => {
    const h = await playSomeTurns(6);
    const latest = h.server.getSnapshot();
    h.close();
    const stale = olderSnapshot(latest, 3);
    const server = new GameServer({
      code: latest.code,
      host: keyedProfile(HOST),
      snapshot: latest,
    });
    const host = new GameClient({
      transport: server.connectLocal(),
      profile: keyedProfile(HOST),
      signer: signerOf(HOST),
      resumeSnapshot: latest,
      pingIntervalMs: 0,
    });
    const { client: guest } = await makeGuest(server, stale);
    await flush();
    expect(guest.getState().snapshot!.seq).toBe(latest.seq);
    expect(server.getSnapshot().seq).toBe(latest.seq);
    expect(guest.getState().error).toBeNull();
    guest.close();
    host.close();
    server.close();
  });

  it('the former guest can host the resumed match; seats follow profile ids', async () => {
    const h = await playSomeTurns(4);
    const latest = h.guestStore.peek(h.server.getSnapshot().id)!;
    h.close();
    const server = new GameServer({
      code: latest.code,
      host: keyedProfile(GUEST),
      snapshot: latest,
    });
    const bob = new GameClient({
      transport: server.connectLocal(),
      profile: keyedProfile(GUEST),
      signer: signerOf(GUEST),
      resumeSnapshot: latest,
      pingIntervalMs: 0,
    });
    await flush();
    expect(bob.getState().seat).toBe('black');
    const { client: alice } = await makeGuest(server, olderSnapshot(latest, 1), HOST);
    await flush();
    expect(alice.getState().seat).toBe('white');
    expect(alice.getState().snapshot!.seq).toBe(latest.seq);
    expect(server.getSnapshot().hostSeat).toBe('white'); // original creator's seat is preserved
    const g = currentGame(bob);
    if (g.phase.kind === 'to-roll') (g.phase.player === 'white' ? alice : bob).roll();
    await flush();
    expect(JSON.stringify(alice.getState().snapshot)).toBe(JSON.stringify(bob.getState().snapshot));
    alice.close();
    bob.close();
    server.close();
  });

  it('refuses a newer snapshot whose action log does not replay, keeping the host copy', async () => {
    const h = await playSomeTurns(4);
    const latest = h.server.getSnapshot();
    h.close();
    const forged: MatchSnapshot = {
      ...latest,
      seq: latest.seq + 5,
      actions: [
        ...latest.actions,
        { type: 'take', player: 'white' },
        { type: 'take', player: 'white' },
      ],
    };
    const server = new GameServer({
      code: latest.code,
      host: keyedProfile(HOST),
      snapshot: latest,
    });
    const host = new GameClient({
      transport: server.connectLocal(),
      profile: keyedProfile(HOST),
      signer: signerOf(HOST),
      pingIntervalMs: 0,
    });
    const { client: guest } = await makeGuest(server, forged);
    await flush();
    expect(guest.getState().status).toBe('joined');
    expect(guest.getState().error?.code).toBe('bad-snapshot');
    expect(guest.getState().snapshot!.seq).toBe(latest.seq);
    expect(server.getSnapshot().seq).toBe(latest.seq);
    guest.close();
    host.close();
    server.close();
  });

  it('rejects a snapshot from a different match', async () => {
    const h = await playSomeTurns(2);
    const latest = h.server.getSnapshot();
    h.close();
    const server = new GameServer({
      code: latest.code,
      host: keyedProfile(HOST),
      snapshot: latest,
    });
    const { client: guest } = await makeGuest(server, { ...latest, id: 'some-other-match' });
    await flush();
    expect(guest.getState().status).toBe('rejected');
    expect(guest.getState().rejectReason).toBe('wrong-match');
    server.close();
  });

  it('constructor verifies the action log and rejects a corrupt snapshot', async () => {
    const h = await playSomeTurns(2);
    const latest = h.server.getSnapshot();
    h.close();
    const corrupt: MatchSnapshot = {
      ...latest,
      actions: [{ type: 'roll', player: 'white', dice: [1, 1] }],
    };
    expect(
      () => new GameServer({ code: 'X', host: keyedProfile(HOST), snapshot: corrupt }),
    ).toThrow();
    // A trusted-but-stale cached `match` is ignored in favour of the replayed log.
    const withBogusMatch: MatchSnapshot = {
      ...latest,
      match: { ...latest.match, score: { white: 99, black: 99 } },
    };
    const server = new GameServer({
      code: 'X',
      host: keyedProfile(HOST),
      snapshot: withBogusMatch,
    });
    expect(server.getSnapshot().match.score).toEqual(latest.match.score);
    server.close();
  });
});

async function makeGuest(server: GameServer, resumeSnapshot: MatchSnapshot, profile = GUEST) {
  const { createMemoryPair } = await import('@bgf/protocol');
  const [serverEnd, clientEnd] = createMemoryPair('resume');
  server.accept(serverEnd);
  const client = new GameClient({
    transport: clientEnd,
    profile: keyedProfile(profile),
    signer: signerOf(profile),
    resumeSnapshot,
    pingIntervalMs: 0,
  });
  return { client, transport: clientEnd };
}

describe('resume keeps the table layout', () => {
  it("adopting a newer guest snapshot keeps the host copy's homeSide and hostSeat", async () => {
    const h = await playSomeTurns(4);
    const latest = h.guestStore.peek(h.server.getSnapshot().id)!;
    h.close();

    // The host's copy is older but carries a different table layout than the guest's copy claims.
    const stale: MatchSnapshot = { ...olderSnapshot(latest, 2), homeSide: 'right' };
    const server = new GameServer({
      code: latest.code,
      host: keyedProfile(HOST),
      snapshot: stale,
      dice: seededDice(1),
    });
    expect(server.getSnapshot().homeSide).toBe('right');
    const host = new GameClient({
      transport: server.connectLocal(),
      profile: keyedProfile(HOST),
      signer: signerOf(HOST),
      resumeSnapshot: stale,
      pingIntervalMs: 0,
    });
    await flush();
    const { client: guest } = await makeGuest(server, {
      ...latest,
      homeSide: 'left',
      hostSeat: 'black',
    });
    await flush();
    expect(guest.getState().snapshot!.seq).toBe(latest.seq);
    expect(server.getSnapshot()).toMatchObject({
      homeSide: 'right',
      hostSeat: 'white',
      code: latest.code,
    });
    expect(guest.getState().snapshot!.homeSide).toBe('right');
    expect(host.getState().snapshot!.homeSide).toBe('right');
    guest.close();
    host.close();
    server.close();
  });
});
