import { describe, expect, it } from 'vitest';
import { newMatch, startGame } from '@bgf/engine';
import type { MatchState } from '@bgf/engine';
import { currentGame, flush, makeHarness } from './harness.js';

/** A match with a game in progress in the given phase. */
function positioned(game: Partial<MatchState['game'] & object>): MatchState {
  const m = startGame(newMatch({ length: 5 }));
  return { ...m, game: { ...m.game!, ...game } };
}

describe('a move that arrives by mail', () => {
  it('is applied as if the seat had sent it live; everyone connected sees it', async () => {
    const h = await makeHarness({
      initialMatch: positioned({ phase: { kind: 'to-roll', player: 'black' } }),
    });
    await flush();
    // Black (the guest) is away; their roll arrives by mail.
    h.guest.close();
    await flush();
    const before = h.server.getSnapshot().seq;
    const { errors } = await h.server.deliver('black', {
      type: 'command',
      command: { type: 'roll' },
    });
    expect(errors).toEqual([]);
    expect(h.server.getSnapshot().seq).toBe(before + 1);
    await flush();
    expect(currentGame(h.host).phase.kind).toBe('moving');
    h.close();
  });

  it('gets back what the table would have told the seat, and changes nothing', async () => {
    const h = await makeHarness({
      initialMatch: positioned({ phase: { kind: 'to-roll', player: 'white' } }),
    });
    await flush();
    const before = h.server.getSnapshot().seq;
    const out = await h.server.deliver('black', { type: 'command', command: { type: 'roll' } });
    expect(out.errors.map((e) => e.code)).toEqual(['not-your-turn']);
    expect(h.server.getSnapshot().seq).toBe(before);
    h.close();
  });

  it('only takes what a seat may send for itself', async () => {
    const h = await makeHarness();
    await flush();
    const out = await h.server.deliver('black', { type: 'bye' });
    expect(out.errors.map((e) => e.code)).toEqual(['bad-message']);
    const chat = await h.server.deliver('black', { type: 'chat', text: 'see you tomorrow' });
    expect(chat.errors).toEqual([]);
    expect(h.server.getSnapshot().chat.at(-1)?.text).toBe('see you tomorrow');
    h.close();
  });
});
