import type { MatchCriteria } from '@bgf/club-spec';

/**
 * A queued matchmaking ticket, remembered per player so a reload does not silently drop you out
 * of the queue. The club is the authority on whether the ticket still lives; this only records
 * what we asked for, so the lobby can re-queue on the way back in.
 */

export interface QueuedRecord {
  clubId: string;
  ticketId: string;
  criteria: MatchCriteria;
  queuedAt: number;
}

const key = (slug: string) => `bgf:club-queue:${slug}`;

function read(slug: string): QueuedRecord[] {
  try {
    const raw = localStorage.getItem(key(slug));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedRecord[]) : [];
  } catch {
    return [];
  }
}

function write(slug: string, records: QueuedRecord[]): void {
  try {
    if (records.length === 0) localStorage.removeItem(key(slug));
    else localStorage.setItem(key(slug), JSON.stringify(records));
  } catch {
    /* storage unavailable: queueing still works, it just will not survive a reload */
  }
}

export function rememberQueue(slug: string, record: QueuedRecord): void {
  write(slug, [...read(slug).filter((r) => r.clubId !== record.clubId), record]);
}

export function getQueue(slug: string, clubId: string): QueuedRecord | undefined {
  return read(slug).find((r) => r.clubId === clubId);
}

export function forgetQueue(slug: string, clubId: string): void {
  write(
    slug,
    read(slug).filter((r) => r.clubId !== clubId),
  );
}
