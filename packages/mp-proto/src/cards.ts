/**
 * Card encoding.
 *
 * A card must become a group element that can be turned back into a card after decryption.
 * `mul(G, cardIndex)` would make decoding a discrete logarithm, so instead each of the 52 cards
 * is hashed to the curve once and a lookup table maps the 32-byte encoding back to the index.
 * The table is public and fixed, so every participant builds the identical one.
 *
 * The mapping is deliberately *not* secret. Secrecy comes from ElGamal encryption and the
 * shuffle, never from how a card is represented.
 */
import { Point, hashToPoint, type Pt } from './group.ts';

export const DECK_SIZE = 52;
const DST = 'bgf/mp-proto/card/v1';

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['c', 'd', 'h', 's'] as const;

export function cardName(index: number): string {
  if (index < 0 || index >= DECK_SIZE) throw new RangeError(`card index ${index} out of range`);
  return `${RANKS[index % 13]}${SUITS[Math.floor(index / 13)]}`;
}

let cachedPoints: Pt[] | null = null;
let cachedTable: Map<string, number> | null = null;

/** The 52 card points, in index order. Computed once per process. */
export function cardPoints(): Pt[] {
  if (!cachedPoints) {
    cachedPoints = Array.from({ length: DECK_SIZE }, (_, i) =>
      hashToPoint(`card:${i}:${cardName(i)}`, DST),
    );
  }
  return cachedPoints;
}

/** Encoding → card index. This is what makes decryption decodable in constant time. */
export function decodeTable(): Map<string, number> {
  if (!cachedTable) {
    cachedTable = new Map();
    cardPoints().forEach((p, i) => cachedTable!.set(p.toHex(), i));
  }
  return cachedTable;
}

export function cardToPoint(index: number): Pt {
  const p = cardPoints()[index];
  if (!p) throw new RangeError(`card index ${index} out of range`);
  return p;
}

/** Returns the card index, or null when the point is not a card (a failed or tampered decrypt). */
export function pointToCard(p: Pt): number | null {
  return decodeTable().get(p.toHex()) ?? null;
}

export function assertDistinctCardPoints(): void {
  const seen = new Set(cardPoints().map((p) => p.toHex()));
  if (seen.size !== DECK_SIZE) throw new Error('card encoding collision');
  if (seen.has(Point.ZERO.toHex())) throw new Error('a card encodes to the identity element');
}
