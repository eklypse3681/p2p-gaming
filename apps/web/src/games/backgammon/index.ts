import type { MatchSnapshot } from '@bgf/protocol';
import type { GameDefinition, SavedSummary } from '../GameProvider';
import { routesFor } from '../GameProvider';
import { describeLength, summarizeMatch } from '../../session/history';
import { HomeScreen } from './HomeScreen';
import { HostScreen } from './HostScreen';
import { JoinScreen } from './JoinScreen';
import { GameScreen } from './GameScreen';
import { HistoryScreen } from './HistoryScreen';
import { DemoScreen } from './DemoScreen';

/** A saved backgammon match as the hub shows it. */
export function describeSavedMatch(snapshot: unknown, myId: string): SavedSummary | null {
  const s = snapshot as MatchSnapshot;
  if (!s || typeof s !== 'object' || !s.players || !s.match) return null;
  const r = summarizeMatch(s, myId);
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    title: `vs ${r.opponentName}`,
    meta: `${describeLength(r.length)} · ${r.myScore}–${r.theirScore}`,
    badge: r.rules === 'free' ? 'Free' : undefined,
    inProgress: r.outcome === 'in-progress',
    updatedAt: r.updatedAt,
  };
}

export const backgammon: GameDefinition = {
  id: 'backgammon',
  name: 'Backgammon',
  tagline: 'Full rules, doubling cube, match play — or a free board with no rules at all.',
  icon: '🎲',
  peerNamespace: 'backgammon-v1',
  routes: (slug) => routesFor(slug, 'backgammon'),
  screens: {
    Home: HomeScreen,
    Host: HostScreen,
    Join: JoinScreen,
    Game: GameScreen,
    History: HistoryScreen,
  },
  Demo: DemoScreen,
  describeSaved: describeSavedMatch,
};
