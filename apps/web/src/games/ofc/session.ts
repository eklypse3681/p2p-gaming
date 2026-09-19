import type { Action, Command, TableConfig, TableState, TableView } from '@bgf/ofc-engine';
import { ofcDefinition } from '@bgf/ofc-engine';
import type { PlayerProfile, Signer } from '@bgf/protocol';
import { getProvider } from '../../session/providers';
import { getSnapshotStore } from '../../session/matchStore';
import type { TableSession, TableSessionDeps } from '../../session/tableSession';
import type { RandomnessChoice } from '../../session/entropy';
import type { FlowOptions } from '../../session/retry';
import { hostTable, joinTable, resumeTable } from '../../session/tableSession';
import type { OfcSnapshot } from './history';

export type OfcSession = TableSession<TableState, Action, Command, TableView, TableConfig>;
export type OfcDeps = TableSessionDeps<TableState, Action, Command, TableView, TableConfig>;

/** The transport and saved-table store of one player for OFC. */
export function ofcDeps(slug: string): OfcDeps {
  return {
    provider: getProvider(slug, 'ofc'),
    // Stores hold the host's full copy or a seat's view; both are `TableSnapshot`s.
    store: getSnapshotStore<OfcSnapshot>(slug, 'ofc') as unknown as OfcDeps['store'],
  };
}

export interface HostOfcOptions {
  profile: PlayerProfile;
  signer?: Signer;
  config: TableConfig;
  /** Host as the non-playing dealer: all `config.seats` seats are filled by guests. */
  dealer?: boolean;
  randomness?: RandomnessChoice;
  /** Unattended table (default true): deals, moves on and resets scores by itself. */
  autopilot?: boolean;
}

/** Host a new table: the host sits in seat 0 (or deals); the config decides how many seats there are. */
export function hostOfcTable(opts: HostOfcOptions, deps: OfcDeps): Promise<OfcSession> {
  return hostTable(
    ofcDefinition,
    {
      profile: opts.profile,
      signer: opts.signer,
      config: opts.config,
      seats: opts.config.seats,
      hostSeat: 0,
      dealer: opts.dealer,
      randomness: opts.randomness,
      autopilot: opts.autopilot,
    },
    deps,
  );
}

export interface JoinOfcOptions {
  code: string;
  profile: PlayerProfile;
  signer?: Signer;
  /** Tries before giving up when the host does not answer (default 1). */
  attempts?: number;
}

export function joinOfcTable(
  opts: JoinOfcOptions,
  deps: OfcDeps,
  flow: FlowOptions = {},
): Promise<OfcSession> {
  return joinTable(ofcDefinition, opts, deps, flow);
}

export interface ResumeOfcOptions {
  snapshot: OfcSnapshot;
  profile: PlayerProfile;
  signer?: Signer;
  randomness?: RandomnessChoice;
}

export function resumeOfcTable(
  opts: ResumeOfcOptions,
  deps: OfcDeps,
  flow: FlowOptions = {},
): Promise<OfcSession> {
  return resumeTable(
    ofcDefinition,
    { ...opts, snapshot: opts.snapshot as ResumeOfcSnapshot },
    deps,
    flow,
  );
}
type ResumeOfcSnapshot = Parameters<
  typeof resumeTable<TableState, Action, Command, TableView, TableConfig>
>[1]['snapshot'];
