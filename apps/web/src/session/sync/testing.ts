import type { MatchSnapshot } from '@bgf/protocol';
import { newMatch } from '@bgf/engine';
import { DEFAULT_SETTINGS } from '../settings';
import type { SyncChange, SyncStore } from './protocol';

/** Test doubles for the sync layer (not shipped). */

export function snap(id: string, seq: number, updatedAt = 1000): MatchSnapshot {
  const match = newMatch({ length: 3 });
  return {
    id,
    code: `C${id.toUpperCase()}`,
    seq,
    createdAt: updatedAt - 100,
    updatedAt,
    config: match.config,
    players: { white: { id: 'alice-id', name: 'Alice' }, black: null },
    hostSeat: 'white',
    actions: [],
    match,
    chat: [],
  };
}

/** In-memory SyncStore for tests. */
export class MemorySyncStore implements SyncStore {
  profileData = { name: 'Alice', avatar: '🦊', updatedAt: 10 };
  settingsData = { settings: { ...DEFAULT_SETTINGS }, updatedAt: 10 };
  matches = new Map<string, MatchSnapshot>(); // key game/id
  private listeners = new Set<(c: SyncChange) => void>();
  constructor(
    public readonly profileId = 'alice-id',
    public readonly syncKey = 'shared-secret',
  ) {}
  profile() {
    return { ...this.profileData };
  }
  applyProfile(p: { name: string; avatar: string; updatedAt: number }) {
    if (p.updatedAt <= this.profileData.updatedAt) return false;
    this.profileData = { ...p };
    return true;
  }
  settings() {
    return { settings: { ...this.settingsData.settings }, updatedAt: this.settingsData.updatedAt };
  }
  applySettings(s: { settings: typeof DEFAULT_SETTINGS; updatedAt: number }) {
    if (s.updatedAt <= this.settingsData.updatedAt) return false;
    this.settingsData = { settings: { ...s.settings }, updatedAt: s.updatedAt };
    return true;
  }
  async listMatches(game: 'backgammon') {
    return Array.from(this.matches.entries())
      .filter(([k]) => k.startsWith(`${game}/`))
      .map(([, v]) => v);
  }
  async getMatch(game: 'backgammon', id: string) {
    return this.matches.get(`${game}/${id}`);
  }
  async putMatch(game: 'backgammon', snapshot: MatchSnapshot) {
    this.matches.set(`${game}/${snapshot.id}`, snapshot);
    this.emit({ kind: 'match', game, id: snapshot.id });
  }
  onChange(listener: (c: SyncChange) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Simulate a local edit (tests). */
  emit(c: SyncChange) {
    for (const l of Array.from(this.listeners)) l(c);
  }
  localPut(snapshot: MatchSnapshot) {
    this.matches.set(`backgammon/${snapshot.id}`, snapshot);
    this.emit({ kind: 'match', game: 'backgammon', id: snapshot.id });
  }
  localSettings(patch: Partial<typeof DEFAULT_SETTINGS>, updatedAt: number) {
    this.settingsData = { settings: { ...this.settingsData.settings, ...patch }, updatedAt };
    this.emit({ kind: 'settings' });
  }
  localProfile(name: string, updatedAt: number) {
    this.profileData = { ...this.profileData, name, updatedAt };
    this.emit({ kind: 'profile' });
  }
}
