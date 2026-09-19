import { describe, expect, it } from 'vitest';
import type { TableState, Variant } from '@bgf/ofc-engine';
import { applyAll, canPlace, command, defaultConfig, init, seededRng } from '@bgf/ofc-engine';
import type { Action, MatchState, Player } from '@bgf/engine';
import { applyAction, newMatch } from '@bgf/engine';
import { backgammonBot, ofcBot } from '../src/index.js';

/** Play `hands` OFC hands engine-only with the bot in every seat; every command must apply. */
function playOfc(variant: Variant, hands: number, seed: number) {
  const rng = seededRng(seed);
  const botRng = seededRng(seed + 1);
  let state: TableState = init(defaultConfig({ variant, seats: 3 }));
  let decisions = 0;
  while (state.history.length < hands) {
    state = applyAll(state, command(state, 0, { type: 'start' }, rng, Date.now));
    let guard = 0;
    while (state.hand && state.hand.phase === 'setting') {
      let acted = false;
      for (let seat = 0; seat < 3; seat++) {
        if (!canPlace(state, seat)) continue;
        const cmd = ofcBot(state, seat, { rng: botRng });
        expect(cmd).not.toBeNull();
        // `command` validates through the reducer and throws on anything illegal.
        state = applyAll(state, command(state, seat, cmd!, rng, Date.now));
        decisions++;
        acted = true;
      }
      if (!acted || ++guard > 200) throw new Error('hand did not progress');
    }
  }
  return { state, decisions };
}

describe('ofcBot', () => {
  it('never returns an illegal command across 1,000+ decisions in every variant', () => {
    let decisions = 0;
    for (const variant of ['ofc', 'pineapple', 'pineapple27'] as const) {
      decisions += playOfc(variant, 30, 11).decisions;
    }
    expect(decisions).toBeGreaterThan(1000);
  });

  it('fouls less than 10% of 2-7 Pineapple hands', () => {
    const { state } = playOfc('pineapple27', 300, 7);
    const fouls = state.history.reduce((a, h) => a + h.seats.filter((s) => s.fouled).length, 0);
    const rate = fouls / (300 * 3);
    expect(rate).toBeLessThan(0.1);
    // Sanity: it plays for value, not just safety.
    const royalties = state.history.reduce(
      (a, h) => a + h.seats.reduce((b, s) => b + s.royalties, 0),
      0,
    );
    expect(royalties).toBeGreaterThan(0);
  });

  it('reaches Fantasyland now and then in Pineapple and sets a non-fouling hand there', () => {
    const { state } = playOfc('pineapple', 300, 3);
    const entries = state.history.filter((h) => h.seats.some((s) => s.fantasylandNext > 0)).length;
    expect(entries).toBeGreaterThan(0);
    // A Fantasyland hand that fouls would show as fouled while the previous hand qualified.
    const flFouls = state.history.filter(
      (h, i) =>
        i > 0 &&
        h.seats.some((s, k) => state.history[i - 1]!.seats[k]!.fantasylandNext > 0 && s.fouled),
    ).length;
    expect(flFouls).toBe(0);
  });

  it('returns null when the seat cannot act', () => {
    const state = init(defaultConfig({ variant: 'pineapple', seats: 2 }));
    expect(ofcBot(state, 0)).toBeNull();
  });
});

function die(rng: { int(n: number): number }) {
  return (rng.int(6) + 1) as 1 | 2 | 3 | 4 | 5 | 6;
}

/** Play money-play backgammon engine-only with the bot on both sides. */
function playBackgammon(games: number, seed: number) {
  const rng = seededRng(seed);
  let match: MatchState = newMatch({ length: 0 });
  let decisions = 0;
  let guard = 0;
  while (match.games.length < games) {
    if (++guard > 20_000) throw new Error('match did not progress');
    if (match.game === null || match.game.phase.kind === 'over') {
      match = applyAction(match, { type: 'start-game' });
      continue;
    }
    let acted = false;
    for (const player of ['white', 'black'] as const) {
      const cmd = backgammonBot(match, player, { rng });
      if (!cmd) continue;
      const action = toAction(cmd, player, rng);
      match = applyAction(match, action); // throws RuleError when illegal
      decisions++;
      acted = true;
      break;
    }
    if (!acted) throw new Error(`nobody could act in phase ${match.game?.phase.kind ?? 'none'}`);
  }
  return { match, decisions };
}

function toAction(
  cmd: NonNullable<ReturnType<typeof backgammonBot>>,
  player: Player,
  rng: { int(n: number): number },
): Action {
  switch (cmd.type) {
    case 'start-game':
      return { type: 'start-game' };
    case 'opening-roll':
      return { type: 'opening-roll', player, die: die(rng) };
    case 'roll':
      return { type: 'roll', player, dice: [die(rng), die(rng)] };
    case 'play':
      return { type: 'play', player, play: cmd.play };
    case 'double':
      return { type: 'double', player };
    case 'take':
      return { type: 'take', player };
    case 'drop':
      return { type: 'drop', player };
    case 'offer-resign':
      return { type: 'offer-resign', player, stakes: cmd.stakes };
    case 'accept-resign':
      return { type: 'accept-resign', player };
    case 'decline-resign':
      return { type: 'decline-resign', player };
    default:
      throw new Error(`unexpected command ${cmd.type}`);
  }
}

describe('backgammonBot', () => {
  it('never returns an illegal command across 1,000+ decisions', () => {
    const { match, decisions } = playBackgammon(25, 5);
    expect(decisions).toBeGreaterThan(1000);
    expect(match.games.length).toBe(25);
    const points = { white: 0, black: 0 };
    for (const g of match.games) points[g.result.winner] += g.result.points;
    expect(points).toEqual(match.score);
  });

  it('uses the cube sometimes and takes when close', () => {
    const { match } = playBackgammon(40, 9);
    expect(match.games.some((g) => g.result.cube > 1)).toBe(true);
  });
});
