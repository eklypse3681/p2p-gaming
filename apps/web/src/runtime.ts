/**
 * The table runtime: everything that must agree between the players' browsers and anything else
 * that hosts a table (a club's unattended dealer). It is built from the same sources, in the same
 * build, as the app, which hosts its own tables through these exports too, so there is one copy of
 * the game rules, the table server and the wire format, published at one address per version.
 *
 * Published by the build as `runtime/manifest.json` (see `vite.config.ts`): the entry file and
 * every file it needs, with content hashes. A club loads that set, checks the hashes, and imports
 * the entry. Nothing here may touch the DOM or browser storage, so it also runs under Node; a
 * build check (`scripts/check-runtime.mjs`) verifies the runtime pulls in nothing the app does
 * not load itself, and imports it under Node.
 *
 * The exports are a contract: change their meaning only with a new `RUNTIME_API_VERSION`.
 */

/**
 * Bumped whenever an export below changes in a way a host would notice. A host refuses a runtime
 * whose API version it does not know rather than half-working with it.
 */
export const RUNTIME_API_VERSION: number = 1;

/**
 * Which rules these are: the name of the built file that holds this code, whose hash changes
 * exactly when the code does (`runtime-D5quDDb6.js`), or `dev` outside a production build. A
 * match records the id it was created with and is always played with that copy of the rules
 * (`runtime/manifest.json` names it as `id`; every published copy is kept for that).
 */
export const RUNTIME_ID: string =
  /\/(runtime-[\w-]+\.js)(?:[?#].*)?$/.exec(import.meta.url)?.[1] ?? 'dev';

/** The game definitions a table can be hosted with, by `gameId`. */
export const definitions = { backgammon: backgammonDefinition, ofc: ofcDefinition } as const;

// ---- table core: the authoritative server for any game, and its snapshot helpers
export { TableServer, viewSnapshot } from '@bgf/table';
export type { GameDefinition, TableServerOptions } from '@bgf/table';

// ---- games
import { backgammonDefinition } from '@bgf/server';
import { ofcDefinition } from '@bgf/ofc-engine';
export { backgammonDefinition, seatPlayer, GameServer } from '@bgf/server';
export {
  ofcDefinition,
  defaultConfig as ofcDefaultConfig,
  validateTableConfig as ofcValidateTableConfig,
  RULES_PRESETS as OFC_RULES_PRESETS,
} from '@bgf/ofc-engine';

// ---- wire: transports (the PeerJS one carries the fragmenting players' browsers expect)
export { peerJsProvider } from '@bgf/transport-peerjs';
export { memoryProvider, PROTOCOL_VERSION } from '@bgf/protocol';

// ---- randomness sources a table may draw from (their records are audited by players)
export { cryptoProvider, drandProvider, randomOrgProvider } from '@bgf/entropy';
