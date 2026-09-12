import type { MatchSnapshot } from '@bgf/protocol';

/**
 * Persistence for match snapshots. Every client (host or guest) saves each snapshot it receives,
 * so either side can resume the match later. The web app implements this over IndexedDB.
 */
export interface MatchStore {
  list(): Promise<MatchSnapshot[]>;
  get(id: string): Promise<MatchSnapshot | undefined>;
  put(snapshot: MatchSnapshot): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemoryMatchStore implements MatchStore {
  private readonly items = new Map<string, MatchSnapshot>();

  async list(): Promise<MatchSnapshot[]> {
    return Array.from(this.items.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<MatchSnapshot | undefined> {
    return this.items.get(id);
  }

  async put(snapshot: MatchSnapshot): Promise<void> {
    this.items.set(snapshot.id, snapshot);
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }

  /** Synchronous peek for tests. */
  peek(id: string): MatchSnapshot | undefined {
    return this.items.get(id);
  }

  get size(): number {
    return this.items.size;
  }
}
