import * as current from '../runtime';
import { connLog } from './connLog';

/**
 * The rules a match is played with. Every match records the runtime it was created with
 * (`runtime` on a backgammon snapshot, `options.runtime` on a table), and whoever hosts it later
 * uses that same copy, even after the site has moved on: a deploy never changes a game under way,
 * and players on different app versions still agree.
 *
 * This app's own runtime is used whenever it is the pinned one (and for matches from before
 * pinning). Any other is loaded from the archive, where every published runtime is kept
 * (`functions/runtime-archive`, filled by `/api/archive-runtime` after each deploy).
 */
export type Runtime = typeof current;

/** The id new matches are pinned to: this app's own runtime (`dev` off a production build). */
export let CURRENT_RUNTIME: string = current.RUNTIME_ID;

const loaded = new Map<string, Promise<Runtime>>();

/** Overridable for tests: how an archived runtime's entry is imported. */
let importRuntime = (url: string): Promise<Runtime> => import(/* @vite-ignore */ url);
let fetchPin = (url: string): Promise<Response> => fetch(url);

/** For tests: pretend to be a production build with runtime `id`, loading others with `load`. */
export function setRuntimeLoaderForTests(
  load: ((url: string) => Promise<Runtime>) | null,
  fetcher: ((url: string) => Promise<Response>) | null = null,
  id: string = current.RUNTIME_ID,
): void {
  importRuntime = load ?? ((url) => import(/* @vite-ignore */ url));
  fetchPin = fetcher ?? ((url) => fetch(url));
  CURRENT_RUNTIME = id;
  loaded.clear();
  noticed.clear();
}

const archiveBase = () => `${import.meta.env.BASE_URL ?? '/'}runtime-archive/`;

async function loadArchived(pin: string): Promise<Runtime> {
  const res = await fetchPin(`${archiveBase()}pins/${encodeURIComponent(pin)}`);
  if (!res.ok) throw new Error(`no archived runtime ${pin} (${res.status})`);
  const { entry } = (await res.json()) as { entry?: unknown };
  if (typeof entry !== 'string' || !/^[\w./-]+\.js$/.test(entry) || entry.includes('..')) {
    throw new Error(`archived runtime ${pin} names no entry`);
  }
  const rt = await importRuntime(`${archiveBase()}${entry}`);
  if (rt.RUNTIME_API_VERSION !== current.RUNTIME_API_VERSION) {
    throw new Error(`archived runtime ${pin} speaks API ${rt.RUNTIME_API_VERSION}`);
  }
  if (rt.RUNTIME_ID !== pin)
    throw new Error(`archived runtime ${pin} calls itself ${rt.RUNTIME_ID}`);
  return rt;
}

/**
 * The runtime for a match pinned to `pin`. When an archived copy cannot be had (offline, or never
 * archived), this app's own rules are used and the connection log says so: playing on is better
 * than not playing, and the rules rarely change.
 */
export function runtimeFor(pin: string | undefined): Promise<Runtime> {
  if (!pin || pin === CURRENT_RUNTIME || CURRENT_RUNTIME === 'dev' || pin === 'dev') {
    return Promise.resolve(current);
  }
  let p = loaded.get(pin);
  if (!p) {
    p = loadArchived(pin).then(
      (rt) => {
        connLog('runtime: pinned', { pin });
        return rt;
      },
      (e: unknown) => {
        connLog('runtime: pinned copy unavailable, using this app’s', {
          pin,
          error: e instanceof Error ? e.message : String(e),
        });
        loaded.delete(pin);
        return current;
      },
    );
    loaded.set(pin, p);
  }
  return p;
}

/** Fired on `window` to ask the update notice to check for a newer app right away. */
export const CHECK_VERSION_EVENT = 'bgf:check-version';

const noticed = new Set<string>();

/**
 * A guest learns which rules the table runs from its snapshot. When they are not this app's, the
 * site may have a newer app (a table pinned to newer rules than ours): check now, so the reload
 * offer appears at once rather than within the minute. An older pin needs nothing.
 */
export function watchPin<S>(
  client: { getState(): S; subscribe(l: () => void): () => void },
  pinOf: (state: S) => unknown,
): () => void {
  const check = () => {
    const pin = pinOf(client.getState());
    if (typeof pin !== 'string' || pin === CURRENT_RUNTIME || CURRENT_RUNTIME === 'dev') return;
    if (noticed.has(pin)) return;
    noticed.add(pin);
    connLog('runtime: table runs other rules', { table: pin, app: CURRENT_RUNTIME });
    globalThis.dispatchEvent?.(new Event(CHECK_VERSION_EVENT));
  };
  check();
  return client.subscribe(check);
}
