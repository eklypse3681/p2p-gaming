import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TableSnapshot } from '@bgf/protocol';
import type { DealerGame } from './games.js';
import { isDealerGame } from './games.js';

/** A persisted table: the host's full snapshot (hidden information included) plus bookkeeping. */
export interface TableRecord {
  savedAt: number;
  game: DealerGame;
  snapshot: TableSnapshot;
}

export const TABLES_DIR = 'tables';

function tablesDir(dataDir: string): string {
  return join(dataDir, TABLES_DIR);
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function tablePath(dataDir: string, id: string): string {
  return join(tablesDir(dataDir), `${safeId(id)}.json`);
}

/** Atomic write: the file is either the previous snapshot or the new one, never half of it. */
export async function saveTable(
  dataDir: string,
  game: DealerGame,
  snapshot: TableSnapshot,
): Promise<string> {
  await mkdir(tablesDir(dataDir), { recursive: true });
  const path = tablePath(dataDir, snapshot.id);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const record: TableRecord = { savedAt: Date.now(), game, snapshot };
  await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

async function readRecord(path: string): Promise<TableRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<TableRecord>;
    if (!parsed.snapshot || typeof parsed.snapshot !== 'object' || !isDealerGame(parsed.game)) {
      return null;
    }
    return {
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      game: parsed.game,
      snapshot: parsed.snapshot as TableSnapshot,
    };
  } catch {
    return null;
  }
}

export async function listTables(dataDir: string): Promise<TableRecord[]> {
  let names: string[];
  try {
    names = await readdir(tablesDir(dataDir));
  } catch {
    return [];
  }
  const records: TableRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = await readRecord(join(tablesDir(dataDir), name));
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.snapshot.updatedAt - a.snapshot.updatedAt);
}

/** Find a table by id or by room code (the most recently updated one wins). */
export async function loadTable(dataDir: string, idOrCode: string): Promise<TableRecord | null> {
  const direct = await readRecord(tablePath(dataDir, idOrCode));
  if (direct) return direct;
  const code = idOrCode.trim().toUpperCase();
  const all = await listTables(dataDir);
  return all.find((r) => r.snapshot.code.toUpperCase() === code) ?? null;
}

export async function deleteTable(dataDir: string, id: string): Promise<void> {
  await rm(tablePath(dataDir, id), { force: true });
}

// A stop request is a marker file next to the table; the running dealer polls for it.
export function stopFlagPath(dataDir: string, id: string): string {
  return join(tablesDir(dataDir), `${safeId(id)}.stop`);
}

export async function requestStop(dataDir: string, id: string): Promise<void> {
  await mkdir(tablesDir(dataDir), { recursive: true });
  await writeFile(stopFlagPath(dataDir, id), String(Date.now()));
}

export async function stopRequested(dataDir: string, id: string): Promise<boolean> {
  try {
    await stat(stopFlagPath(dataDir, id));
    return true;
  } catch {
    return false;
  }
}

export async function clearStop(dataDir: string, id: string): Promise<void> {
  await rm(stopFlagPath(dataDir, id), { force: true });
}
