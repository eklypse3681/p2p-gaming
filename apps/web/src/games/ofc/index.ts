import type { GameDefinition } from '../GameProvider';
import { routesFor } from '../GameProvider';
import { HomeScreen } from './HomeScreen';
import { HostScreen } from './HostScreen';
import { JoinScreen } from './JoinScreen';
import { GameScreen } from './GameScreen';
import { HistoryScreen } from './HistoryScreen';
import { DemoScreen } from './DemoScreen';
import { describeSavedTable } from './history';

export const ofc: GameDefinition = {
  id: 'ofc',
  name: 'Open Face Chinese Poker',
  tagline: 'OFC, Pineapple or Pineapple 2-7 for 2–3 players, your rules, with a settleable ledger.',
  icon: '🃏',
  peerNamespace: 'ofc-v1',
  routes: (slug) => routesFor(slug, 'ofc'),
  screens: {
    Home: HomeScreen,
    Host: HostScreen,
    Join: JoinScreen,
    Game: GameScreen,
    History: HistoryScreen,
  },
  Demo: DemoScreen,
  describeSaved: describeSavedTable,
};
