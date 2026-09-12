import { describe, expect, it } from 'vitest';
import type { MatchSnapshot } from '@bgf/protocol';
import type { GameSummary, Player } from '@bgf/engine';
import { newMatch } from '@bgf/engine';
import { computeStats, summarizeMatch } from './history';
import { relativeTime } from './time';
import { parseIceServers } from './settings';
import { extractCode, extractGame } from './links';

function game(
  number: number,
  winner: Player,
  kind: 'single' | 'gammon' | 'backgammon',
  points: number,
  scoreAfter: Record<Player, number>,
): GameSummary {
  return {
    number,
    result: { winner, kind, how: 'bearoff', cube: 1, points },
    scoreAfter,
    crawford: false,
    turns: [],
  };
}

function snap(
  id: string,
  opts: {
    mySeat: Player;
    games: GameSummary[];
    winner: Player | null;
    length?: number;
    oppId?: string;
    oppName?: string;
  },
): MatchSnapshot {
  const match = newMatch({ length: opts.length ?? 3 });
  const last = opts.games[opts.games.length - 1];
  const score = last ? last.scoreAfter : { white: 0, black: 0 };
  const me = { id: 'me', name: 'Me' };
  const them = { id: opts.oppId ?? 'them', name: opts.oppName ?? 'Them' };
  return {
    id,
    code: 'CODE01',
    seq: 1,
    createdAt: 1000,
    updatedAt: 2000,
    config: match.config,
    players: opts.mySeat === 'white' ? { white: me, black: them } : { white: them, black: me },
    hostSeat: 'white',
    actions: [],
    match: {
      ...match,
      score,
      games: opts.games,
      winner: opts.winner,
      gameNumber: opts.games.length + 1,
    },
    chat: [],
  };
}

describe('history', () => {
  it('summarises a match from my point of view', () => {
    const s = snap('m1', {
      mySeat: 'black',
      games: [
        game(1, 'black', 'gammon', 2, { white: 0, black: 2 }),
        game(2, 'white', 'single', 1, { white: 1, black: 2 }),
      ],
      winner: null,
    });
    const row = summarizeMatch(s, 'me')!;
    expect(row.mySeat).toBe('black');
    expect(row.opponentName).toBe('Them');
    expect(row.myScore).toBe(2);
    expect(row.theirScore).toBe(1);
    expect(row.outcome).toBe('in-progress');
    expect(summarizeMatch(s, 'stranger')).toBeNull();
  });

  it('computes totals and head-to-head', () => {
    const rows = [
      summarizeMatch(
        snap('m1', {
          mySeat: 'white',
          games: [game(1, 'white', 'backgammon', 3, { white: 3, black: 0 })],
          winner: 'white',
        }),
        'me',
      )!,
      summarizeMatch(
        snap('m2', {
          mySeat: 'black',
          games: [
            game(1, 'white', 'gammon', 2, { white: 2, black: 0 }),
            game(2, 'white', 'single', 1, { white: 3, black: 0 }),
          ],
          winner: 'white',
          oppId: 'other',
          oppName: 'Other',
        }),
        'me',
      )!,
      summarizeMatch(snap('m3', { mySeat: 'white', games: [], winner: null }), 'me')!,
    ];
    const st = computeStats(rows);
    expect(st.matchesPlayed).toBe(2);
    expect(st.matchesWon).toBe(1);
    expect(st.matchesLost).toBe(1);
    expect(st.matchesInProgress).toBe(1);
    expect(st.gamesWon).toBe(1);
    expect(st.gamesLost).toBe(2);
    expect(st.backgammonsFor).toBe(1);
    expect(st.gammonsAgainst).toBe(1);
    expect(st.pointsFor).toBe(3);
    expect(st.pointsAgainst).toBe(3);
    expect(st.opponents.map((o) => o.id).sort()).toEqual(['other', 'them']);
    const them = st.opponents.find((o) => o.id === 'them')!;
    expect(them.matchesWon).toBe(1);
    expect(them.gamesWon).toBe(1);
  });

  it('formats relative time', () => {
    const now = 10_000_000;
    expect(relativeTime(now - 5_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 hrs ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 days ago');
  });

  it('parses ICE servers and extracts codes from links', () => {
    expect(
      parseIceServers(
        'stun:stun.example.com:3478\n# comment\nturn:t.example.com:3478|user|pass\njunk',
      ),
    ).toEqual([
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'turn:t.example.com:3478', username: 'user', credential: 'pass' },
    ]);
    expect(extractCode('https://x.test/app/?transport=broadcast#/join/ABC234')).toBe('ABC234');
    expect(extractCode('https://x.test/#/backgammon/join/ABC234')).toBe('ABC234');
    expect(extractCode('https://x.test/#/steve/join/ABC234')).toBe('ABC234');
    expect(extractCode('https://x.test/#/steve/backgammon/join/ABC234')).toBe('ABC234');
    expect(extractCode('  abc234 ')).toBe('abc234');
    expect(extractGame('https://x.test/#/join/ABC234')).toBe('backgammon');
    expect(extractGame('https://x.test/#/backgammon/join/ABC234')).toBe('backgammon');
    expect(extractGame('https://x.test/#/steve/backgammon/join/ABC234')).toBe('backgammon');
    expect(extractGame('abc234')).toBe('backgammon');
  });
});
