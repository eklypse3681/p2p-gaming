import { describe, expect, it } from 'vitest';
import { GameServer } from '../src/index.js';

const host = { id: 'h', name: 'H' };

describe('table layout (homeSide)', () => {
  it("defaults a new match to home boards on the host's left", () => {
    const server = new GameServer({ code: 'HS1', host });
    expect(server.getSnapshot().homeSide).toBe('left');
  });

  it('stores an explicit layout', () => {
    const server = new GameServer({ code: 'HS2', host, homeSide: 'right', hostSeat: 'black' });
    expect(server.getSnapshot()).toMatchObject({ homeSide: 'right', hostSeat: 'black' });
  });

  it('keeps the layout when constructed from a snapshot and fills in the default for old ones', () => {
    const original = new GameServer({ code: 'HS3', host, homeSide: 'right' }).getSnapshot();
    expect(new GameServer({ code: 'x', host, snapshot: original }).getSnapshot().homeSide).toBe(
      'right',
    );
    const { homeSide: _dropped, ...legacy } = original;
    void _dropped;
    expect(new GameServer({ code: 'x', host, snapshot: legacy }).getSnapshot().homeSide).toBe(
      'left',
    );
    expect(GameServer.verifySnapshot(legacy).homeSide).toBe('left');
  });
});
