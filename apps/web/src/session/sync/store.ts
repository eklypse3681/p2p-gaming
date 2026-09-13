import type { MatchSnapshot } from '@bgf/protocol';
import type { SyncChange, SyncProfile, SyncSettings, SyncStore } from './protocol';
import { getProfile, subscribeProfiles, updateProfile } from '../profiles';
import { getSettings, getSettingsUpdatedAt, replaceSettings, subscribeSettings } from '../settings';
import { getMatchStore, matchStoreBus } from '../matchStore';
import type { GameId } from '../../games/ids';

/** The app's profile index, settings and per-game match stores, seen as one player's sync store. */
export class LocalSyncStore implements SyncStore {
  constructor(readonly slug: string) {}

  private record() {
    const r = getProfile(this.slug);
    if (!r) throw new Error(`no player "${this.slug}"`);
    return r;
  }

  get profileId(): string {
    return this.record().id;
  }

  get syncKey(): string {
    return this.record().syncKey;
  }

  profile(): SyncProfile {
    const r = this.record();
    return { name: r.name, avatar: r.avatar, updatedAt: r.updatedAt };
  }

  applyProfile(p: SyncProfile): boolean {
    const r = getProfile(this.slug);
    if (!r || p.updatedAt <= r.updatedAt) return false;
    return updateProfile(
      this.slug,
      { name: p.name, ...(p.avatar ? { avatar: p.avatar } : {}) },
      { updatedAt: p.updatedAt },
    );
  }

  settings(): SyncSettings {
    return { settings: getSettings(this.slug), updatedAt: getSettingsUpdatedAt(this.slug) };
  }

  applySettings(s: SyncSettings): boolean {
    if (s.updatedAt <= getSettingsUpdatedAt(this.slug)) return false;
    replaceSettings(this.slug, s.settings, s.updatedAt);
    return true;
  }

  listMatches(game: GameId): Promise<MatchSnapshot[]> {
    return getMatchStore(this.slug, game).list();
  }

  getMatch(game: GameId, id: string): Promise<MatchSnapshot | undefined> {
    return getMatchStore(this.slug, game).get(id);
  }

  putMatch(game: GameId, snapshot: MatchSnapshot): Promise<void> {
    return getMatchStore(this.slug, game).put(snapshot);
  }

  onChange(listener: (change: SyncChange) => void): () => void {
    let lastProfile = getProfile(this.slug);
    const unsubs = [
      matchStoreBus.subscribe((event) => {
        if (event.kind !== 'put') return; // deletions are not synced
        if (event.slug === undefined) listener({ kind: 'unknown' });
        else if (event.slug === this.slug && event.game && event.id) {
          listener({ kind: 'match', game: event.game, id: event.id });
        }
      }),
      subscribeSettings(this.slug, () => listener({ kind: 'settings' })),
      subscribeProfiles(() => {
        const next = getProfile(this.slug);
        if (!next || !lastProfile) {
          lastProfile = next;
          return;
        }
        const changed =
          next.name !== lastProfile.name ||
          next.avatar !== lastProfile.avatar ||
          next.updatedAt !== lastProfile.updatedAt;
        lastProfile = next;
        if (changed) listener({ kind: 'profile' });
      }),
    ];
    return () => {
      for (const u of unsubs) u();
    };
  }
}
