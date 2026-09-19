import type { GameDefinition } from './GameProvider';
import type { GameId } from './ids';
import { backgammon } from './backgammon';
import { ofc } from './ofc';

/**
 * Every game the app knows about. To add one, create `src/games/<id>/` with its screens, export a
 * `GameDefinition`, add the id to `GAME_IDS` in `ids.ts`, and list it here. Routing, the hub, the
 * picker, storage keys and the PeerJS namespace all follow from the definition.
 */
export const GAMES: readonly GameDefinition[] = [backgammon, ofc];

export function getGame(id: string | undefined): GameDefinition | undefined {
  return GAMES.find((g) => g.id === id);
}

export function requireGame(id: GameId): GameDefinition {
  const g = getGame(id);
  if (!g) throw new Error(`unknown game: ${id}`);
  return g;
}
