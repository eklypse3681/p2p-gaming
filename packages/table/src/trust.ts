import type { RandomnessMode } from '@bgf/protocol';

/**
 * Trust disclosure. Every game may be hosted in a player's browser, hidden information or not:
 * the game *declares* what a hosting device is able to see, the table turns that into a plain
 * description for the host and every guest, and people decide what they are happy to play.
 * Nothing here restricts who may host.
 */

/** What a game declares about itself. */
export interface TrustDeclaration {
  /** Some seats hold information other seats must not see (secret cards, hidden discards). */
  hiddenInformation: boolean;
  /**
   * Plain-language items a hosting device could read out of its own memory while a player at
   * that device is at the table. Empty for open-information games.
   */
  hostCanSee: string[];
  /** Optional extra sentence shown after the details. */
  notes?: string;
}

export type TrustLevel = 'open' | 'host-sees-hidden' | 'dealer';

export interface TrustDescription {
  level: TrustLevel;
  /** Short badge text: "Open information", "Host can see hidden cards", "Dealer-hosted". */
  title: string;
  /** Sentences a player can read before deciding to sit. */
  details: string[];
  hiddenInformation: boolean;
}

export interface TrustOptions {
  /** `null` = the hosting device takes no seat (dealer mode). */
  hostSeat: number | null | undefined;
  /** The table's declared randomness (`options.randomness`), if any. */
  randomness?: { mode?: RandomnessMode; provider?: string } | null;
}

export function trustTitle(level: TrustLevel): string {
  switch (level) {
    case 'open':
      return 'Open information';
    case 'host-sees-hidden':
      return 'Host can see hidden cards';
    case 'dealer':
      return 'Dealer-hosted';
  }
}

/** The declaration a definition carries, with `hiddenInformation` as the fallback. */
export function trustDeclarationOf(def: {
  trust?: TrustDeclaration;
  hiddenInformation?: boolean;
}): TrustDeclaration {
  if (def.trust) return def.trust;
  return { hiddenInformation: def.hiddenInformation ?? false, hostCanSee: [] };
}

function randomnessDetail(
  randomness: TrustOptions['randomness'],
  hidden: boolean,
  dealer: boolean,
): string {
  const mode = randomness?.mode ?? 'per-draw';
  const provider = randomness?.provider ?? 'crypto';
  const verifiable = provider !== 'crypto';
  const what = hidden ? 'card' : 'roll';
  if (mode === 'seeded') {
    if (dealer) {
      return verifiable
        ? `Seeded randomness: the dealer holds each hand's seed and reveals it afterwards; no player can know a ${what} early, and every hand can be re-derived and checked.`
        : `Seeded randomness from the dealer's device: the seed is revealed after each hand so the hand can be re-derived, but the seed itself is not independently verifiable.`;
    }
    return `Seeded randomness: the host knows the seed of the current hand, so a dishonest host could work out every upcoming ${what}. Fine among friends; pick per-draw or beacon mode otherwise.`;
  }
  if (mode === 'beacon') {
    return `Beacon randomness: each ${what} is bound to a future drand round, so nobody, host included, can know it early, and anyone can verify it.`;
  }
  return verifiable
    ? `Per-draw randomness from ${provider}: values are fetched at the moment they are needed, so nobody, host included, knows a ${what} early, and each draw carries a proof.`
    : `Randomness comes from the host's device at the moment it is needed; nobody knows a ${what} early, but the draws cannot be verified by others.`;
}

/**
 * Describe what the people at a table should know about who can see what, given how it is
 * hosted and how it draws randomness. Pure; safe to call in UIs and on either side.
 */
export function describeTrust(
  def: { trust?: TrustDeclaration; hiddenInformation?: boolean },
  opts: TrustOptions,
): TrustDescription {
  const decl = trustDeclarationOf(def);
  const dealer = opts.hostSeat === null;
  const hidden = decl.hiddenInformation;
  const level: TrustLevel = dealer ? 'dealer' : hidden ? 'host-sees-hidden' : 'open';
  const details: string[] = [];
  if (level === 'open') {
    details.push('Every player receives the whole game state; the host holds nothing secret.');
  } else if (level === 'host-sees-hidden') {
    details.push(
      'The host runs the table in their own browser, so their device holds information the other players cannot see. Their screen never shows it; reading it would take deliberate snooping.',
    );
    for (const item of decl.hostCanSee) details.push(`The host's device can see ${item}.`);
    details.push('Other players only ever receive their own hidden cards.');
  } else {
    details.push(
      hidden
        ? 'The hosting device deals and holds the hidden information but takes no seat; no player at the table can see another player’s hidden cards.'
        : 'The hosting device runs the table but takes no seat.',
    );
  }
  details.push(randomnessDetail(opts.randomness, hidden, dealer));
  if (decl.notes) details.push(decl.notes);
  return { level, title: trustTitle(level), details, hiddenInformation: hidden };
}
