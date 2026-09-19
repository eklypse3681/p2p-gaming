import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@bgf/protocol';
import { PROTOCOL_VERSION, createMemoryPair } from '@bgf/protocol';
import type { EntropySource } from '@bgf/table';
import { segmentRngFor, verifySegment } from '@bgf/table';
import { GameServer } from '../src/index.js';

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A fake signed oracle; in seeded mode it is asked once per game, for the seed. */
function oracle() {
  let serial = 0;
  const labels: string[] = [];
  const source: EntropySource = {
    id: 'oracle',
    async draw(n, ctx) {
      labels.push(ctx.label);
      serial += 1;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = (i * 29 + serial * 3) & 0xff;
      return {
        bytes: out,
        proof: {
          kind: 'random.org-signed',
          random: { data: Array.from(out) },
          signature: 's',
          serialNumber: serial,
        },
        fetchedAt: 0,
        serialNumber: serial,
      };
    },
  };
  return { source, labels };
}

describe('backgammon with seeded randomness: one game, one committed seed', () => {
  it('commits at start-game, derives every roll from the seed, reveals at game over, and verifies', async () => {
    const o = oracle();
    const server = new GameServer({
      code: 'SEED',
      host: { id: 'h', name: 'H' },
      config: { length: 1 },
      randomness: { mode: 'seeded' },
      entropy: { source: o.source },
      now: () => 1,
    });
    const connect = (id: string) => {
      const [serverEnd, clientEnd] = createMemoryPair('raw');
      server.accept(serverEnd);
      const inbox: ServerMessage[] = [];
      clientEnd.onMessage((m) => inbox.push(m as ServerMessage));
      clientEnd.send({ type: 'hello', protocol: PROTOCOL_VERSION, profile: { id, name: id } });
      return { command: (c: unknown) => clientEnd.send({ type: 'command', command: c }), inbox };
    };
    const white = connect('h');
    const black = connect('g');
    await flush();
    expect(server.getSnapshot().randomness).toEqual({ provider: 'oracle', mode: 'seeded' });
    expect(o.labels).toEqual([]);

    white.command({ type: 'start-game' });
    await flush();
    expect(o.labels).toEqual(['seed']); // the game's seed, committed before any roll
    let snap = server.getSnapshot();
    let segment = snap.entropyAudit!.segments!.at(-1)!;
    expect(segment.seed).toBeUndefined();
    expect(segment.commitment).toMatch(/^[0-9a-f]{64}$/);
    // The guest received the commitment as part of a state message before the first roll.
    const guestCommit = black.inbox
      .filter((m): m is Extract<ServerMessage, { type: 'state' }> => m.type === 'state')
      .map(
        (m) =>
          (
            m.snapshot as { entropyAudit?: { segments?: { commitment: string }[] } }
          ).entropyAudit?.segments?.at(-1)?.commitment,
      );
    expect(guestCommit).toContain(segment.commitment);

    // Play the whole game with first-legal-move automation.
    const seatOf = (player: 'white' | 'black') => (player === 'white' ? white : black);
    for (let guard = 0; guard < 400; guard++) {
      const m = server.getSnapshot().match;
      const g = m.game!;
      if (g.phase.kind === 'over') break;
      if (g.phase.kind === 'opening') {
        if (g.phase.rolls.white === undefined) white.command({ type: 'opening-roll' });
        if (g.phase.rolls.black === undefined) black.command({ type: 'opening-roll' });
      } else if (g.phase.kind === 'to-roll') {
        seatOf(g.phase.player).command({ type: 'roll' });
      } else if (g.phase.kind === 'moving') {
        // Ask the engine for any legal play.
        const { legalPlays } = await import('@bgf/engine');
        const plays = legalPlays(g.board, g.phase.player, g.phase.dice);
        seatOf(g.phase.player).command({ type: 'play', play: plays[0] ?? [] });
      }
      await flush(4);
    }
    snap = server.getSnapshot();
    expect(snap.match.game!.phase.kind).toBe('over');
    expect(o.labels).toEqual(['seed']); // still just one request: every roll came from the seed
    segment = snap.entropyAudit!.segments!.find((s) => s.index === segment.index)!;
    expect(segment.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(segment.source!.proof.kind).toBe('random.org-signed');
    const check = verifySegment(snap, segment.index);
    expect(check.ok).toBe(true);
    expect(check.actions.length).toBeGreaterThan(2);
    // Every roll re-derives from the seed: die = draw + 1.
    for (const { index } of check.actions) {
      const rng = segmentRngFor(snap, index)!;
      const action = snap.actions[index]!;
      if (action.type === 'opening-roll') expect(action.die).toBe(rng.int(6) + 1);
      else if (action.type === 'roll' || action.type === 'free-roll') {
        expect(action.dice).toEqual([rng.int(6) + 1, rng.int(6) + 1]);
      }
    }
    // The colour-keyed snapshot round-trips the audit through the converters and resumes.
    const resumed = new GameServer({
      code: 'SEED',
      host: { id: 'h', name: 'H' },
      snapshot: snap,
      entropy: { source: o.source },
    });
    expect(resumed.getSnapshot().entropyAudit!.segments).toEqual(snap.entropyAudit!.segments);
    expect(resumed.getSnapshot().randomness).toEqual({ provider: 'oracle', mode: 'seeded' });
    server.close();
    resumed.close();
  });
});
