import { describe, expect, it } from 'vitest';
import { GAMES, getGame, requireGame } from './registry';
import { GAME_IDS, isGameId } from './ids';
import { gamePath, routesFor } from './GameProvider';
import { RESERVED_SLUGS } from '../session/profiles';

describe('game registry', () => {
  it('registers backgammon and OFC with screens, demos and peer namespaces', () => {
    expect(GAMES.map((g) => g.id)).toEqual(['backgammon', 'ofc']);
    const ofc = requireGame('ofc');
    expect(ofc.name).toBe('Open Face Chinese Poker');
    expect(ofc.peerNamespace).toBe('ofc-v1');
    expect(ofc.screens.Host).toBeTypeOf('function');
    expect(ofc.Demo).toBeTypeOf('function');
    expect(ofc.describeSaved).toBeTypeOf('function');
    expect(routesFor('steve', 'ofc').game('t1')).toBe('/steve/ofc/game/t1');
    const bg = requireGame('backgammon');
    expect(bg.name).toBe('Backgammon');
    expect(bg.peerNamespace).toBe('backgammon-v1');
    expect(bg.screens.Home).toBeTypeOf('function');
    expect(bg.screens.Game).toBeTypeOf('function');
    expect(bg.Demo).toBeTypeOf('function');
    expect(getGame('chess')).toBeUndefined();
    expect(() => requireGame('chess' as never)).toThrow();
  });

  it('every game id is a known id and a reserved profile slug', () => {
    for (const g of GAMES) {
      expect(GAME_IDS).toContain(g.id);
      expect(isGameId(g.id)).toBe(true);
      expect(RESERVED_SLUGS).toContain(g.id);
    }
    expect(isGameId('steve')).toBe(false);
  });

  it('builds profile-scoped routes', () => {
    const r = routesFor('steve', 'backgammon');
    expect(r.home).toBe('/steve/backgammon/');
    expect(r.host).toBe('/steve/backgammon/host');
    expect(r.join()).toBe('/steve/backgammon/join');
    expect(r.join('ABC234')).toBe('/steve/backgammon/join/ABC234');
    expect(r.game('m1')).toBe('/steve/backgammon/game/m1');
    expect(r.history).toBe('/steve/backgammon/history');
    const viaDef = requireGame('backgammon').routes('steve');
    expect([viaDef.home, viaDef.host, viaDef.history, viaDef.join('X'), viaDef.game('m')]).toEqual([
      r.home,
      r.host,
      r.history,
      r.join('X'),
      r.game('m'),
    ]);
    expect(gamePath('steve', 'backgammon', 'history?match=m1')).toBe(
      '/steve/backgammon/history?match=m1',
    );
  });
});
