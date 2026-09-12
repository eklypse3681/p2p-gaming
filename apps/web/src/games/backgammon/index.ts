import type { GameDefinition } from '../GameProvider';
import { routesFor } from '../GameProvider';
import { HomeScreen } from './HomeScreen';
import { HostScreen } from './HostScreen';
import { JoinScreen } from './JoinScreen';
import { GameScreen } from './GameScreen';
import { HistoryScreen } from './HistoryScreen';
import { DemoScreen } from './DemoScreen';

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
};
