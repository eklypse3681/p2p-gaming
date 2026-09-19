import type { GameDefinition } from '@bgf/table';
import type { TableSnapshot } from '@bgf/protocol';
import { backgammonDefinition } from '@bgf/server';
import { ofcDefinition } from '@bgf/ofc-engine';

/** Games the dealer can host. Adding one means adding a definition here. */
export const DEALER_GAMES = ['backgammon', 'ofc'] as const;
export type DealerGame = (typeof DEALER_GAMES)[number];

export type AnyDefinition = GameDefinition<unknown, unknown, unknown, unknown, unknown>;

export function isDealerGame(value: unknown): value is DealerGame {
  return typeof value === 'string' && (DEALER_GAMES as readonly string[]).includes(value);
}

export function definitionFor(game: DealerGame): AnyDefinition {
  switch (game) {
    case 'backgammon':
      return backgammonDefinition as unknown as AnyDefinition;
    case 'ofc':
      return ofcDefinition as unknown as AnyDefinition;
  }
}

/** One line of game status for `dealer status` / logs, from the definition's summary. */
export function describeTable(game: DealerGame, snapshot: TableSnapshot): string {
  const def = definitionFor(game);
  const summary = def.summary?.(snapshot.state) as Record<string, unknown> | undefined;
  const seats = snapshot.seats.map((s, i) => `${i}:${s ? s.name : '—'}`).join('  ');
  const parts = [`${game}`, `code ${snapshot.code}`, `seq ${snapshot.seq}`, `seats ${seats}`];
  if (summary) {
    const bits = Object.entries(summary)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    if (bits.length) parts.push(bits.join(' '));
  }
  return parts.join(' · ');
}
