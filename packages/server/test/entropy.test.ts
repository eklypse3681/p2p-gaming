import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@bgf/protocol';
import { PROTOCOL_VERSION, createMemoryPair } from '@bgf/protocol';
import type { EntropySource } from '@bgf/table';
import { checkSerials, drawsMatch } from '@bgf/table';
import { GameServer } from '../src/index.js';

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A fake signed oracle with consecutive serial numbers. */
function oracle() {
  let serial = 7;
  const labels: string[] = [];
  const source: EntropySource = {
    id: 'oracle',
    async draw(n, ctx) {
      labels.push(ctx.label);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = (i * 31 + serial) & 0xff;
      serial += 1;
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

describe('backgammon dice drawn just in time', () => {
  it('requests bytes only when a roll happens and annotates opening rolls and rolls', async () => {
    const o = oracle();
    const server = new GameServer({
      code: 'ENT',
      host: { id: 'h', name: 'H' },
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
    expect(o.labels).toEqual([]); // creating the table draws nothing
    white.command({ type: 'start-game' });
    white.command({ type: 'opening-roll' });
    black.command({ type: 'opening-roll' });
    await flush();
    expect(o.labels).toEqual(['opening-roll', 'opening-roll']);
    const snap = server.getSnapshot();
    expect(snap.randomness).toEqual({ provider: 'oracle', mode: 'per-draw' });
    const labels = snap.actions.map((a, i) => [
      a.type,
      snap.actionMeta?.[i]?.entropy?.label ?? null,
    ]);
    expect(labels[0]).toEqual(['start-game', null]);
    expect(labels[1]).toEqual(['opening-roll', 'opening-roll']);
    expect(labels[2]).toEqual(['opening-roll', 'opening-roll']);
    const rec = snap.actionMeta![1]!.entropy!;
    expect(rec).toMatchObject({
      provider: 'oracle',
      fallback: false,
      draws: [{ n: 6, value: expect.any(Number) }],
    });
    expect(rec.sources[0]!.proof.kind).toBe('random.org-signed');
    // The die in the action is the recorded draw plus one.
    const opening = snap.actions[1] as { die: number };
    expect(opening.die).toBe(rec.draws[0]!.value + 1);
    expect(drawsMatch(rec)).toBe(true);
    const records = Object.values(snap.actionMeta!).map((m) => m.entropy!);
    expect(checkSerials(records)).toEqual({ ok: true, gaps: [] });

    // The persisted (colour-keyed) snapshot round-trips the audit through the converters.
    const resumed = new GameServer({
      code: snap.code,
      host: { id: 'h', name: 'H' },
      snapshot: server.getSnapshot(),
      entropy: { source: o.source },
    });
    expect(resumed.getSnapshot().actionMeta).toEqual(server.getSnapshot().actionMeta);
    expect(resumed.getSnapshot().randomness).toEqual({ provider: 'oracle', mode: 'per-draw' });
    server.close();
    resumed.close();
  });
});
