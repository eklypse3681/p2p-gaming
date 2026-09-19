import { useSyncExternalStore } from 'react';
import type { ClubCurrency } from '@bgf/protocol';
import { readJson, writeJson } from '../session/storage';

/** A club this player has joined, remembered per player so the Clubs screen can list it. */
export interface JoinedClub {
  clubId: string;
  name: string;
  /** Transport address (PeerJS id under the `club-v1` namespace); usually the club id. */
  address: string;
  currency: ClubCurrency;
  lastSeen: number;
  /** Last known balance in minor units. */
  balance?: number;
  /** The invite we joined with, re-sent on reconnect while membership is pending. */
  invite?: string;
}

export function clubsKey(slug: string): string {
  return `bgf:clubs:${slug}`;
}

const listeners = new Set<() => void>();
function notify(): void {
  for (const l of Array.from(listeners)) l();
}

export function listJoinedClubs(slug: string): JoinedClub[] {
  const raw = readJson<JoinedClub[]>(clubsKey(slug));
  return Array.isArray(raw) ? raw.slice().sort((a, b) => b.lastSeen - a.lastSeen) : [];
}

export function rememberClub(slug: string, club: JoinedClub): void {
  const rest = listJoinedClubs(slug).filter((c) => c.clubId !== club.clubId);
  writeJson(clubsKey(slug), [{ ...club, lastSeen: club.lastSeen || Date.now() }, ...rest]);
  notify();
}

export function updateClub(slug: string, clubId: string, patch: Partial<JoinedClub>): void {
  const all = listJoinedClubs(slug);
  const idx = all.findIndex((c) => c.clubId === clubId);
  if (idx < 0) return;
  all[idx] = { ...all[idx]!, ...patch };
  writeJson(clubsKey(slug), all);
  notify();
}

export function forgetClub(slug: string, clubId: string): void {
  writeJson(
    clubsKey(slug),
    listJoinedClubs(slug).filter((c) => c.clubId !== clubId),
  );
  notify();
}

export function getJoinedClub(slug: string, clubId: string): JoinedClub | undefined {
  return listJoinedClubs(slug).find((c) => c.clubId === clubId);
}

const cache = new Map<string, { raw: string | null; value: JoinedClub[] }>();
function snapshotFor(slug: string): JoinedClub[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(clubsKey(slug));
  } catch {
    raw = null;
  }
  const hit = cache.get(slug);
  if (hit && hit.raw === raw) return hit.value;
  const value = listJoinedClubs(slug);
  cache.set(slug, { raw, value });
  return value;
}

export function useJoinedClubs(slug: string): JoinedClub[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      const onStorage = (e: StorageEvent) => {
        if (e.key === clubsKey(slug)) l();
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(l);
        window.removeEventListener('storage', onStorage);
      };
    },
    () => snapshotFor(slug),
    () => snapshotFor(slug),
  );
}
