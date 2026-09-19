/**
 * Matchmaking: the club finds you a game.
 *
 * A member says what they are willing to play and waits; the club forms a table when enough
 * compatible people are queued and hands each of them a seat. How a club decides who to put
 * together — first come, stakes bands, rating windows that widen as the wait grows — is its
 * own business. This file fixes only the lifecycle and the vocabulary, so a client written
 * once works against every implementation.
 */

import type { SeatGrant } from './api.js';

export interface StakesBand {
  /** Chips per point, in minor units. */
  min?: number;
  max?: number;
}

export interface MatchCriteria {
  /** Game id, e.g. 'backgammon' or 'ofc'. Required: nobody queues for "anything". */
  game: string;
  /** Acceptable table templates by id. Empty or absent means any template of this game. */
  templateIds?: string[];
  /** Acceptable table sizes. Absent means any size the club offers. */
  seats?: number[];
  stakes?: StakesBand;
  /** Whether the result should count towards the club's ratings. */
  rated?: boolean;
  /**
   * Widest rating gap the member will accept at the moment of queueing. A club may widen this
   * itself as the wait grows; it never narrows it.
   */
  ratingWindow?: number;
  /** Whether a software opponent is acceptable. Defaults to true. */
  allowSoftware?: boolean;
}

export interface MatchEstimate {
  /** The club's guess at the remaining wait. Informational, never a promise. */
  waitMs?: number;
  /** How many members are queued for something compatible, including this one. */
  queueDepth?: number;
}

export interface MatchTicket {
  id: string;
  memberId: string;
  criteria: MatchCriteria;
  queuedAt: number;
  /** After this the club drops the ticket. Absent means it waits until cancelled. */
  expiresAt?: number;
  estimate?: MatchEstimate;
}

export type MatchCancelReason = 'member' | 'expired' | 'left' | 'unavailable';

/** Pushed to a queued member as their ticket progresses. */
export type MatchEvent =
  | { kind: 'queued'; ticket: MatchTicket }
  | { kind: 'estimate'; ticketId: string; estimate: MatchEstimate }
  | { kind: 'matched'; ticketId: string; grant: SeatGrant }
  | { kind: 'cancelled'; ticketId: string; reason: MatchCancelReason };

function bandsOverlap(a?: StakesBand, b?: StakesBand): boolean {
  const aMin = a?.min ?? 0;
  const aMax = a?.max ?? Number.MAX_SAFE_INTEGER;
  const bMin = b?.min ?? 0;
  const bMax = b?.max ?? Number.MAX_SAFE_INTEGER;
  return aMin <= bMax && bMin <= aMax;
}

function listsOverlap(a?: readonly (string | number)[], b?: readonly (string | number)[]): boolean {
  if (!a?.length || !b?.length) return true; // absent means "no preference"
  return a.some((x) => b.includes(x));
}

/**
 * Could these two members be seated at the same table? A necessary condition, not a
 * sufficient one: a club still applies its own policy, ratings and table sizes on top.
 */
export function criteriaCompatible(a: MatchCriteria, b: MatchCriteria): boolean {
  if (a.game !== b.game) return false;
  if ((a.rated ?? false) !== (b.rated ?? false)) return false;
  if (!listsOverlap(a.templateIds, b.templateIds)) return false;
  if (!listsOverlap(a.seats, b.seats)) return false;
  if (!bandsOverlap(a.stakes, b.stakes)) return false;
  return true;
}

/** Rating gap both members are willing to accept. */
export function ratingWindowFor(a: MatchCriteria, b: MatchCriteria): number {
  const wa = a.ratingWindow ?? Number.MAX_SAFE_INTEGER;
  const wb = b.ratingWindow ?? Number.MAX_SAFE_INTEGER;
  return Math.min(wa, wb);
}

/** The table a policy is being asked to fill. */
export interface MatchTemplateInfo {
  id: string;
  game: string;
  seats: number;
}

export interface MatchGroupInput {
  /** Queued tickets that could sit at this template, already filtered by the club. */
  tickets: readonly MatchTicket[];
  template: MatchTemplateInfo;
  now: number;
}

/**
 * Who gets seated with whom.
 *
 * The queue itself belongs to the club, because `queue`, `unqueue` and `MatchEvent` are the
 * interface every client codes against. The decision is not interface, so it is injected: a
 * club running a play-money lobby wants ratings, widening windows and metrics, while a private
 * club of six friends wants whoever turned up. Both use the same queue.
 *
 * A policy may keep state — it is told when tickets arrive, leave and get seated — but it must
 * never return a group whose members are not mutually compatible, which is the one thing the
 * conformance suite checks on the club's behalf.
 */
export interface MatchPolicy {
  /** Which queued tickets to seat together, if any. Return `[]` for none. */
  group(input: MatchGroupInput): MatchTicket[][];
  onQueued?(ticket: MatchTicket): void;
  onDequeued?(ticketId: string, reason: MatchCancelReason): void;
  /** Called once a group has actually been seated, which `group` alone cannot know. */
  onMatched?(tickets: readonly MatchTicket[], table: { id: string; templateId: string }): void;
  /** How often the club should ask. Default 500ms. */
  tickMs?: number;
}

/** Oldest first, mutually compatible, no opinion about ratings. */
export function referenceMatchPolicy(): MatchPolicy {
  return {
    group: ({ tickets, template }) => proposeMatches(tickets, template.seats),
  };
}

/**
 * Group queued tickets into the largest compatible sets of the requested size, oldest first.
 * A reference policy: simple, fair, and enough to run a play-money lobby. Implementations are
 * free to do better, and the conformance suite only requires that whoever is matched was
 * mutually compatible.
 */
export function proposeMatches(
  tickets: readonly MatchTicket[],
  seats: number,
  ratings?: Record<string, number>,
): MatchTicket[][] {
  const pool = [...tickets].sort((x, y) => x.queuedAt - y.queuedAt);
  const used = new Set<string>();
  const groups: MatchTicket[][] = [];

  for (const head of pool) {
    if (used.has(head.id)) continue;
    const group = [head];
    for (const other of pool) {
      if (group.length >= seats) break;
      if (used.has(other.id) || other.id === head.id) continue;
      if (!group.every((g) => criteriaCompatible(g.criteria, other.criteria))) continue;
      if (ratings) {
        const gap = (memberId: string) => ratings[memberId] ?? 0;
        const tooFar = group.some(
          (g) =>
            Math.abs(gap(g.memberId) - gap(other.memberId)) >
            ratingWindowFor(g.criteria, other.criteria),
        );
        if (tooFar) continue;
      }
      group.push(other);
    }
    if (group.length >= seats) {
      for (const t of group) used.add(t.id);
      groups.push(group);
    }
  }
  return groups;
}
