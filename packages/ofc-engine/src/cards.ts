/**
 * Cards. A card is `{ rank, suit }` with rank 2..14 (11 J, 12 Q, 13 K, 14 A). The compact string
 * form (`'As'`, `'Td'`) is used for display, tests and any place a stable key is handy.
 */

export type Suit = 'c' | 'd' | 'h' | 's';
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

export const SUITS: readonly Suit[] = ['c', 'd', 'h', 's'];
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_CHARS = '23456789TJQKA';

export function rankChar(rank: Rank): string {
  return RANK_CHARS[rank - 2]!;
}

export function rankName(rank: Rank, plural = false): string {
  const names: Record<number, string> = {
    2: 'two',
    3: 'three',
    4: 'four',
    5: 'five',
    6: 'six',
    7: 'seven',
    8: 'eight',
    9: 'nine',
    10: 'ten',
    11: 'jack',
    12: 'queen',
    13: 'king',
    14: 'ace',
  };
  const n = names[rank]!;
  if (!plural) return n;
  return n === 'six' ? 'sixes' : `${n}s`;
}

export function cardToString(card: Card): string {
  return `${rankChar(card.rank)}${card.suit}`;
}

export function parseCard(s: string): Card {
  if (s.length !== 2) throw new Error(`bad card: ${s}`);
  const r = RANK_CHARS.indexOf(s[0]!.toUpperCase());
  const suit = s[1]!.toLowerCase() as Suit;
  if (r < 0 || !SUITS.includes(suit)) throw new Error(`bad card: ${s}`);
  return { rank: (r + 2) as Rank, suit };
}

/** Parse a space-separated list like `'As Kd 7c'`. */
export function cards(list: string): Card[] {
  return list.trim().split(/\s+/).filter(Boolean).map(parseCard);
}

export function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit;
}

export function cardKey(card: Card): string {
  return cardToString(card);
}

/** A full 52-card deck in canonical order (by suit, then rank). */
export function newDeck(): Card[] {
  const out: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) out.push({ rank, suit });
  return out;
}

export function isCard(v: unknown): v is Card {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as { rank?: unknown; suit?: unknown };
  return (
    typeof c.rank === 'number' &&
    Number.isInteger(c.rank) &&
    c.rank >= 2 &&
    c.rank <= 14 &&
    typeof c.suit === 'string' &&
    (SUITS as readonly string[]).includes(c.suit)
  );
}

export function removeCards(from: readonly Card[], remove: readonly Card[]): Card[] {
  const keys = new Set(remove.map(cardKey));
  return from.filter((c) => !keys.has(cardKey(c)));
}

export function hasDuplicates(list: readonly Card[]): boolean {
  return new Set(list.map(cardKey)).size !== list.length;
}
