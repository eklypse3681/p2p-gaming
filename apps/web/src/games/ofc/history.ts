import type { Action, HandResult, TableConfig, TableState, TableView } from '@bgf/ofc-engine';
import { balances as engineBalances } from '@bgf/ofc-engine';
import type { PlayerProfile, TableSnapshot } from '@bgf/protocol';
import type { SavedSummary } from '../GameProvider';
import { describeRules, variantName } from './rules/describe';

/** The snapshot shape OFC persists: full state on the host, a seat's view elsewhere. */
export type OfcSnapshot = TableSnapshot<TableState | TableView, Action, TableConfig>;

export interface TableRow {
  id: string;
  code: string;
  snapshot: OfcSnapshot;
  mySeat: number;
  names: string[];
  opponents: Array<{ id: string; name: string; seat: number }>;
  /** My net points over the whole table. */
  myNet: number;
  /** My displayed balance (buy-in + unsettled in buy-in mode; unsettled otherwise). */
  myBalance: number;
  hands: number;
  status: TableState['status'];
  config: TableConfig;
  createdAt: number;
  updatedAt: number;
  results: HandResult[];
  fouls: number;
  royalties: number;
  fantasylands: number;
}

function stateOf(s: OfcSnapshot): TableState | TableView {
  return s.state;
}

/** Describe a saved table from my point of view; null when this profile has no seat in it. */
export function summarizeTable(s: OfcSnapshot, myId: string): TableRow | null {
  const mySeat = s.seats.findIndex((p) => p?.id === myId);
  if (mySeat < 0) return null;
  const state = stateOf(s);
  const names = s.seats.map((p, i) => p?.name ?? `Seat ${i + 1}`);
  const opponents = s.seats
    .map((p, seat) => ({ p, seat }))
    .filter(({ p, seat }) => seat !== mySeat && p !== null)
    .map(({ p, seat }) => ({ id: (p as PlayerProfile).id, name: (p as PlayerProfile).name, seat }));
  const results = state.history;
  const mine = results.map((r) => r.seats[mySeat]).filter((x) => x !== undefined);
  const bal = engineBalances(state as TableState);
  return {
    id: s.id,
    code: s.code,
    snapshot: s,
    mySeat,
    names,
    opponents,
    myNet: state.scores[mySeat] ?? 0,
    myBalance: bal[mySeat] ?? 0,
    hands: state.handNumber,
    status: state.status,
    config: state.config,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    results,
    fouls: mine.filter((x) => x.fouled).length,
    royalties: mine.reduce((a, x) => a + x.royalties, 0),
    fantasylands: mine.filter((x) => x.fantasylandNext > 0).length,
  };
}

/** A saved table as the hub and home lists show it. */
export function describeSavedTable(snapshot: unknown, myId: string): SavedSummary | null {
  const s = snapshot as OfcSnapshot;
  if (!s || typeof s !== 'object' || !Array.isArray(s.seats) || !s.state) return null;
  const r = summarizeTable(s, myId);
  if (!r) return null;
  const others = r.opponents.map((o) => o.name);
  const net = r.myNet > 0 ? `+${r.myNet}` : String(r.myNet);
  return {
    id: r.id,
    code: r.code,
    title: others.length ? `with ${others.join(', ')}` : 'Waiting for players',
    meta: `${variantName(r.config.variant)} · ${r.hands} hand${r.hands === 1 ? '' : 's'} · ${net}`,
    badge: r.config.variant === 'pineapple27' ? '2-7' : undefined,
    inProgress: r.status !== 'over',
    updatedAt: r.updatedAt,
  };
}

export interface OpponentTally {
  id: string;
  name: string;
  tables: number;
  hands: number;
  /** My net points against this opponent (pairwise). */
  pointsNet: number;
  lastPlayed: number;
}

export interface OfcStats {
  tables: number;
  tablesInProgress: number;
  handsPlayed: number;
  pointsNet: number;
  fouls: number;
  royalties: number;
  fantasylands: number;
  opponents: OpponentTally[];
}

export function computeOfcStats(rows: TableRow[]): OfcStats {
  const stats: OfcStats = {
    tables: rows.length,
    tablesInProgress: 0,
    handsPlayed: 0,
    pointsNet: 0,
    fouls: 0,
    royalties: 0,
    fantasylands: 0,
    opponents: [],
  };
  const byOpp = new Map<string, OpponentTally>();
  for (const r of rows) {
    if (r.status !== 'over') stats.tablesInProgress++;
    stats.handsPlayed += r.results.length;
    stats.pointsNet += r.myNet;
    stats.fouls += r.fouls;
    stats.royalties += r.royalties;
    stats.fantasylands += r.fantasylands;
    for (const o of r.opponents) {
      const t = byOpp.get(o.id) ?? {
        id: o.id,
        name: o.name,
        tables: 0,
        hands: 0,
        pointsNet: 0,
        lastPlayed: 0,
      };
      t.tables++;
      t.hands += r.results.length;
      for (const h of r.results) {
        for (const pair of h.pairs) {
          if (pair.a === r.mySeat && pair.b === o.seat) t.pointsNet += pair.net;
          else if (pair.b === r.mySeat && pair.a === o.seat) t.pointsNet -= pair.net;
        }
      }
      if (r.updatedAt >= t.lastPlayed) {
        t.lastPlayed = r.updatedAt;
        t.name = o.name;
      }
      byOpp.set(o.id, t);
    }
  }
  stats.opponents = Array.from(byOpp.values()).sort((a, b) => b.lastPlayed - a.lastPlayed);
  return stats;
}

export { describeRules };
