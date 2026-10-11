import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action, Command, TableConfig, TableState, TableView } from '@bgf/ofc-engine';
import { defaultConfig } from '@bgf/ofc-engine';
import type { MatchSnapshot, PlayerProfile } from '@bgf/protocol';
import { memoryProvider } from '@bgf/protocol';
import * as current from '../runtime';
import type { Runtime } from './runtimes';
import { CHECK_VERSION_EVENT, runtimeFor, setRuntimeLoaderForTests, watchPin } from './runtimes';
import type { TableSessionDeps } from './tableSession';
import { hostTable, joinTable, resumeTable } from './tableSession';
import { hostNewMatch, joinMatch, resumeMatch } from './session';

const ALICE: PlayerProfile = { id: 'a', name: 'Alice' };
const BOB: PlayerProfile = { id: 'b', name: 'Bob' };

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

function memStore() {
  const map = new Map<string, unknown>();
  return {
    async put(s: { id: string }) {
      map.set(s.id, s);
    },
    async get(id: string) {
      return map.get(id) as never;
    },
    async findByCode(code: string) {
      return Array.from(map.values()).find((s) => (s as { code: string }).code === code) as never;
    },
  };
}

/**
 * An archived copy of the rules, as a page would import it: the same code under another id, with
 * its own table servers (spied on, to see who hosts) and its own copy of each game definition.
 */
function archived(id: string) {
  const def = { ...current.definitions.ofc };
  const tableCreate = vi.fn((o: Parameters<typeof current.TableServer.create>[0]) =>
    current.TableServer.create(o),
  );
  const gameCreate = vi.fn((o: Parameters<typeof current.GameServer.create>[0]) =>
    current.GameServer.create(o),
  );
  const rt = {
    ...current,
    RUNTIME_ID: id,
    definitions: { ...current.definitions, ofc: def },
    TableServer: { create: tableCreate },
    GameServer: { create: gameCreate },
  } as unknown as Runtime;
  return { rt, def, tableCreate, gameCreate };
}

/** The archive: answers `pins/<id>` with an entry, and imports by URL. */
function archive(copies: Record<string, Runtime>) {
  const fetched: string[] = [];
  const imported: string[] = [];
  const fetcher = async (url: string) => {
    fetched.push(url);
    const id = decodeURIComponent(url.split('/pins/')[1] ?? '');
    return copies[id]
      ? new Response(JSON.stringify({ entry: `runtime/entry-for-${id}` }))
      : new Response('not archived', { status: 404 });
  };
  const load = async (url: string) => {
    imported.push(url);
    const id = /entry-for-(.+)$/.exec(url)![1]!;
    return copies[id]!;
  };
  return { fetcher, load, fetched, imported };
}

afterEach(() => setRuntimeLoaderForTests(null, null));

describe('runtimeFor', () => {
  it("uses this app's own rules for an unpinned match, its own pin, and off a production build", async () => {
    const a = archive({});
    setRuntimeLoaderForTests(a.load, a.fetcher, 'runtime-OWN.js');
    expect(await runtimeFor(undefined)).toBe(current);
    expect(await runtimeFor('runtime-OWN.js')).toBe(current);
    setRuntimeLoaderForTests(a.load, a.fetcher, 'dev');
    expect(await runtimeFor('runtime-OLD.js')).toBe(current);
    expect(a.fetched).toEqual([]);
  });

  it('loads another pin from the archive once, by the entry its pin names', async () => {
    const old = archived('runtime-OLD.js');
    const a = archive({ 'runtime-OLD.js': old.rt });
    setRuntimeLoaderForTests(a.load, a.fetcher, 'runtime-NEW.js');
    expect(await runtimeFor('runtime-OLD.js')).toBe(old.rt);
    expect(await runtimeFor('runtime-OLD.js')).toBe(old.rt);
    expect(a.fetched).toEqual(['/runtime-archive/pins/runtime-OLD.js']);
    expect(a.imported).toEqual(['/runtime-archive/runtime/entry-for-runtime-OLD.js']);
  });

  it("falls back to this app's rules when the copy is missing, misnamed or speaks another API", async () => {
    const wrongName = archived('runtime-OTHER.js');
    const wrongApi = { ...archived('runtime-API.js').rt, RUNTIME_API_VERSION: 99 } as Runtime;
    const a = archive({ 'runtime-MISNAMED.js': wrongName.rt, 'runtime-API.js': wrongApi });
    setRuntimeLoaderForTests(a.load, a.fetcher, 'runtime-NEW.js');
    expect(await runtimeFor('runtime-GONE.js')).toBe(current);
    expect(await runtimeFor('runtime-MISNAMED.js')).toBe(current);
    expect(await runtimeFor('runtime-API.js')).toBe(current);
    // A failure is not remembered: the next resume tries again.
    await runtimeFor('runtime-GONE.js');
    expect(a.fetched.filter((u) => u.endsWith('runtime-GONE.js'))).toHaveLength(2);
  });
});

describe('a match keeps its rules across a deploy', () => {
  type Deps = TableSessionDeps<TableState, Action, Command, TableView, TableConfig>;
  const ofc = current.definitions.ofc;

  it('OFC: a new table is pinned; after a deploy the host re-hosts with the pinned copy and a newer guest plays on', async () => {
    const provider = memoryProvider();
    const hostStore = memStore();
    const guestStore = memStore();
    const deps = (store: ReturnType<typeof memStore>): Deps => ({
      provider,
      store: store as never,
    });

    // Before the deploy: this app is runtime-V1.
    setRuntimeLoaderForTests(null, null, 'runtime-V1.js');
    const config = defaultConfig({ variant: 'ofc', seats: 2 });
    const host = await hostTable(ofc, { profile: ALICE, config, seats: 2 }, deps(hostStore));
    const bob = await joinTable(ofc, { code: host.code, profile: BOB }, deps(guestStore));
    await flush();
    expect(host.client.getState().snapshot!.options.runtime).toBe('runtime-V1.js');
    // The guest's copy carries the pin too.
    expect(bob.client.getState().snapshot!.options.runtime).toBe('runtime-V1.js');
    const id = host.matchId;
    host.dispose();
    bob.dispose();
    await flush();

    // The site deploys runtime-V2; both reload. V1 now comes from the archive.
    const v1 = archived('runtime-V1.js');
    const a = archive({ 'runtime-V1.js': v1.rt });
    setRuntimeLoaderForTests(a.load, a.fetcher, 'runtime-V2.js');
    const asked = vi.fn();
    globalThis.addEventListener(CHECK_VERSION_EVENT, asked);

    const again = await resumeTable(
      ofc,
      { snapshot: (await hostStore.get(id)) as never, profile: ALICE },
      deps(hostStore),
    );
    expect(again.role).toBe('host');
    expect(v1.tableCreate).toHaveBeenCalledTimes(1);
    expect(v1.tableCreate.mock.calls[0]![0].def).toBe(v1.def);
    expect(again.client.getState().snapshot!.options.runtime).toBe('runtime-V1.js');

    const bobAgain = await resumeTable(
      ofc,
      { snapshot: (await guestStore.get(id)) as never, profile: BOB },
      deps(guestStore),
    );
    await flush();
    expect(bobAgain.role).toBe('guest');
    expect(bobAgain.client.getState().seat).toBe(1);
    // The hand dealt before the deploy is still the one in play.
    const view = bobAgain.client.getState().snapshot!.state as unknown as TableView;
    expect(view.hand?.number).toBe(1);
    // The guest noticed the table runs other rules and asked for an update check.
    expect(asked).toHaveBeenCalledTimes(1);
    globalThis.removeEventListener(CHECK_VERSION_EVENT, asked);
    bobAgain.dispose();
    again.dispose();
  });

  it('backgammon: a new match is pinned and resumes on the pinned copy', async () => {
    const provider = memoryProvider();
    const hostStore = memStore();
    setRuntimeLoaderForTests(null, null, 'runtime-V1.js');
    const host = await hostNewMatch(
      { profile: ALICE, config: { length: 3 } },
      { provider, store: hostStore as never },
    );
    const bob = await joinMatch({ code: host.code, profile: BOB }, { provider });
    await flush();
    const snap = host.client.getState().snapshot as MatchSnapshot;
    expect(snap.runtime).toBe('runtime-V1.js');
    expect(bob.client.getState().snapshot?.runtime).toBe('runtime-V1.js');
    host.dispose();
    bob.dispose();
    await flush();

    const v1 = archived('runtime-V1.js');
    const a = archive({ 'runtime-V1.js': v1.rt });
    setRuntimeLoaderForTests(a.load, a.fetcher, 'runtime-V2.js');
    const again = await resumeMatch(
      { snapshot: (await hostStore.get(snap.id)) as never, profile: ALICE },
      { provider, store: hostStore as never },
    );
    expect(again.role).toBe('host');
    expect(v1.gameCreate).toHaveBeenCalledTimes(1);
    expect((again.client.getState().snapshot as MatchSnapshot).runtime).toBe('runtime-V1.js');
    again.dispose();
  });
});

describe('watchPin', () => {
  it('asks for an update check once per foreign pin, never for its own', () => {
    setRuntimeLoaderForTests(null, null, 'runtime-OWN.js');
    let state = { pin: 'runtime-OWN.js' };
    const listeners = new Set<() => void>();
    const client = {
      getState: () => state,
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const asked = vi.fn();
    globalThis.addEventListener(CHECK_VERSION_EVENT, asked);
    const stop = watchPin(client, (s) => s.pin);
    expect(asked).not.toHaveBeenCalled();
    state = { pin: 'runtime-NEWER.js' };
    listeners.forEach((l) => l());
    listeners.forEach((l) => l());
    expect(asked).toHaveBeenCalledTimes(1);
    stop();
    globalThis.removeEventListener(CHECK_VERSION_EVENT, asked);
  });
});
