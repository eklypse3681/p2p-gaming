import type { GameSummary, Player, ResultKind, RulesMode } from '@bgf/engine';
import type { MatchSnapshot } from '@bgf/protocol';

export type MatchOutcome = 'won' | 'lost' | 'in-progress';

export interface MatchRow {
  id: string;
  code: string;
  snapshot: MatchSnapshot;
  mySeat: Player;
  theirSeat: Player;
  myName: string;
  opponentName: string;
  opponentId: string | null;
  myScore: number;
  theirScore: number;
  length: number;
  rules: RulesMode;
  outcome: MatchOutcome;
  gamesPlayed: number;
  createdAt: number;
  updatedAt: number;
  games: GameSummary[];
}

function other(p: Player): Player {
  return p === 'white' ? 'black' : 'white';
}

/** Describe a saved match from my point of view; null when this profile is not a player in it. */
export function summarizeMatch(s: MatchSnapshot, myId: string): MatchRow | null {
  const mySeat: Player | null =
    s.players.white?.id === myId ? 'white' : s.players.black?.id === myId ? 'black' : null;
  if (!mySeat) return null;
  const theirSeat = other(mySeat);
  const opponent = s.players[theirSeat];
  const winner = s.match.winner;
  return {
    id: s.id,
    code: s.code,
    snapshot: s,
    mySeat,
    theirSeat,
    myName: s.players[mySeat]?.name ?? 'You',
    opponentName: opponent?.name ?? 'Waiting for opponent',
    opponentId: opponent?.id ?? null,
    myScore: s.match.score[mySeat],
    theirScore: s.match.score[theirSeat],
    length: s.match.config.length,
    rules: s.match.config.rules ?? 'enforced',
    outcome: winner ? (winner === mySeat ? 'won' : 'lost') : 'in-progress',
    gamesPlayed: s.match.games.length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    games: s.match.games,
  };
}

export interface OpponentTally {
  id: string;
  name: string;
  matchesWon: number;
  matchesLost: number;
  gamesWon: number;
  gamesLost: number;
  pointsFor: number;
  pointsAgainst: number;
  lastPlayed: number;
}

export interface Stats {
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  matchesInProgress: number;
  gamesWon: number;
  gamesLost: number;
  gammonsFor: number;
  gammonsAgainst: number;
  backgammonsFor: number;
  backgammonsAgainst: number;
  pointsFor: number;
  pointsAgainst: number;
  opponents: OpponentTally[];
}

function countKind(games: GameSummary[], seat: Player, kind: ResultKind): number {
  return games.filter((g) => g.result.winner === seat && g.result.kind === kind).length;
}

export function computeStats(rows: MatchRow[]): Stats {
  const stats: Stats = {
    matchesPlayed: 0,
    matchesWon: 0,
    matchesLost: 0,
    matchesInProgress: 0,
    gamesWon: 0,
    gamesLost: 0,
    gammonsFor: 0,
    gammonsAgainst: 0,
    backgammonsFor: 0,
    backgammonsAgainst: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    opponents: [],
  };
  const byOpp = new Map<string, OpponentTally>();
  for (const r of rows) {
    if (r.outcome === 'in-progress') stats.matchesInProgress++;
    else {
      stats.matchesPlayed++;
      if (r.outcome === 'won') stats.matchesWon++;
      else stats.matchesLost++;
    }
    const gw = r.games.filter((g) => g.result.winner === r.mySeat).length;
    const gl = r.games.length - gw;
    stats.gamesWon += gw;
    stats.gamesLost += gl;
    stats.gammonsFor += countKind(r.games, r.mySeat, 'gammon');
    stats.gammonsAgainst += countKind(r.games, r.theirSeat, 'gammon');
    stats.backgammonsFor += countKind(r.games, r.mySeat, 'backgammon');
    stats.backgammonsAgainst += countKind(r.games, r.theirSeat, 'backgammon');
    stats.pointsFor += r.myScore;
    stats.pointsAgainst += r.theirScore;
    if (r.opponentId) {
      const t = byOpp.get(r.opponentId) ?? {
        id: r.opponentId,
        name: r.opponentName,
        matchesWon: 0,
        matchesLost: 0,
        gamesWon: 0,
        gamesLost: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        lastPlayed: 0,
      };
      if (r.outcome === 'won') t.matchesWon++;
      if (r.outcome === 'lost') t.matchesLost++;
      t.gamesWon += gw;
      t.gamesLost += gl;
      t.pointsFor += r.myScore;
      t.pointsAgainst += r.theirScore;
      t.lastPlayed = Math.max(t.lastPlayed, r.updatedAt);
      if (r.updatedAt >= t.lastPlayed) t.name = r.opponentName;
      byOpp.set(r.opponentId, t);
    }
  }
  stats.opponents = Array.from(byOpp.values()).sort((a, b) => b.lastPlayed - a.lastPlayed);
  return stats;
}

export function describeResultKind(kind: ResultKind): string {
  return kind === 'single' ? 'single game' : kind;
}

export function describeLength(length: number): string {
  return length > 0 ? `${length}-point match` : 'Unlimited';
}
