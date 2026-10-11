import type { TableClientMessage } from '@bgf/protocol';
import type { EntropySource } from '@bgf/table';
import { GAME_IDS } from '../games/ids';
import { cryptoProvider, drandProvider } from '../runtime';
import { buildEntropy, randomnessFromSettings } from '../session/entropy';
import { getMatchStore } from '../session/matchStore';
import { runtimeFor } from '../session/runtimes';
import type { BaseSession } from '../session/SessionRegistry';
import { getSettings } from '../session/settings';
import type { MailboxDevice } from './client';
import type { InboxEnv, KnownMatch } from './inbox';
import { relays } from './offline';

/** Where a page finds what `processInbox` needs. */
export function pageInboxEnv(
  slug: string,
  device: MailboxDevice,
  live: (game: string, matchId: string) => BaseSession | undefined,
): InboxEnv {
  return {
    device,
    async findMatch(matchId) {
      for (const game of GAME_IDS) {
        const store = getMatchStore(slug, game);
        const snapshot = await store.get(matchId);
        if (snapshot) {
          return {
            game,
            snapshot,
            put: (s) => store.put(s as never),
          } as KnownMatch;
        }
      }
      return undefined;
    },
    liveHost(game, matchId) {
      const s = live(game, matchId) as
        | (BaseSession & {
            server?: {
              deliver?(
                seat: number,
                msg: TableClientMessage,
              ): Promise<{ errors: { code: string; message: string }[] }>;
            };
          })
        | undefined;
      const server = s?.role === 'host' ? s.server : undefined;
      if (!server?.deliver || game === 'backgammon') return undefined;
      return { deliver: (seat, msg) => server.deliver!(seat, msg) };
    },
    liveGuest(_game, matchId) {
      return relays.get(matchId);
    },
    runtimeFor,
    entropyFor(provider): EntropySource | undefined {
      if (provider === 'drand') return drandProvider();
      if (provider === 'random.org') {
        const choice = randomnessFromSettings(getSettings(slug));
        return choice.randomOrgKey
          ? buildEntropy({ ...choice, source: 'random.org' }).source
          : undefined;
      }
      return cryptoProvider();
    },
  };
}
