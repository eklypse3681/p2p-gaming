/**
 * Game identifiers. Kept in a dependency-free module so storage code (profiles, match stores)
 * can reference them without importing screens.
 */
export const GAME_IDS = ['backgammon', 'ofc'] as const;
export type GameId = (typeof GAME_IDS)[number];
export const DEFAULT_GAME: GameId = 'backgammon';

export function isGameId(value: unknown): value is GameId {
  return typeof value === 'string' && (GAME_IDS as readonly string[]).includes(value);
}
