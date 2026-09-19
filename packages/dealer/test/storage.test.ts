import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TableSnapshot } from '@bgf/protocol';
import {
  clearStop,
  listTables,
  loadTable,
  requestStop,
  saveTable,
  stopRequested,
} from '../src/index.js';
import { tempDir } from './helpers.js';

function snap(id: string, code: string, seq: number, updatedAt: number): TableSnapshot {
  return {
    id,
    code,
    seq,
    createdAt: 1,
    updatedAt,
    gameId: 'backgammon',
    config: {},
    seats: [null, null],
    hostSeat: 0,
    options: {},
    initialState: {},
    actions: [],
    state: {},
    chat: [],
  };
}

describe('table storage', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir()));
  afterEach(() => cleanup());

  it('saves atomically, lists newest first, and loads by id or code', async () => {
    await saveTable(dir, 'backgammon', snap('t1', 'AAAAAA', 3, 100));
    await saveTable(dir, 'ofc', snap('t2', 'BBBBBB', 1, 200));
    await saveTable(dir, 'backgammon', snap('t1', 'AAAAAA', 4, 300)); // overwrite in place
    const all = await listTables(dir);
    expect(all.map((r) => [r.snapshot.id, r.snapshot.seq])).toEqual([
      ['t1', 4],
      ['t2', 1],
    ]);
    expect((await loadTable(dir, 't2'))?.game).toBe('ofc');
    expect((await loadTable(dir, 'aaaaaa'))?.snapshot.seq).toBe(4);
    expect(await loadTable(dir, 'nope')).toBeNull();
    expect(await listTables(`${dir}/missing`)).toEqual([]);
  });

  it('stop requests are marker files', async () => {
    expect(await stopRequested(dir, 't1')).toBe(false);
    await requestStop(dir, 't1');
    expect(await stopRequested(dir, 't1')).toBe(true);
    await clearStop(dir, 't1');
    expect(await stopRequested(dir, 't1')).toBe(false);
  });
});
