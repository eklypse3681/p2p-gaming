import type { MatchSnapshot, PlayerProfile, TableSnapshot } from '@bgf/protocol';
import type { MatchState, Player } from '@bgf/engine';
import { definitions, viewSnapshot } from '../runtime';
import type { HostedTable } from './absent';
import { mailAbsentSeats } from './absent';
import { backgammonTurn, ofcTurn } from './turns';
import { playedByMail } from './mutual';

const COLORS: Player[] = ['white', 'black'];

interface BackgammonServer {
  getSnapshot(): MatchSnapshot;
  connectedSeats(): Player[];
  onChange(l: () => void): () => void;
}
interface AnyTableServer {
  getSnapshot(): TableSnapshot;
  connectedSeats(): number[];
  onChange(l: () => void): () => void;
}

/** The mailer's view of a hosted backgammon match: the whole match goes to the other player. */
function backgammonTable(server: BackgammonServer): HostedTable {
  const snap = () => server.getSnapshot();
  return {
    game: 'backgammon',
    matchId: () => snap().id,
    key: () => snap().mailboxKey,
    version: () => `${snap().seq}:${snap().chat?.length ?? 0}`,
    seats: () => COLORS.map((c) => snap().players[c] ?? null),
    connected: () => server.connectedSeats().map((c) => COLORS.indexOf(c)),
    viewFor: () => snap() as unknown as ReturnType<HostedTable['viewFor']>,
    playedByMail: () => playedByMail(snap()),
    yourTurn: (seat) => backgammonTurn(snap().match as MatchState, seat),
    onChange: (l) => server.onChange(l),
  };
}

/** A hosted table game: each player gets their own view (hidden cards stay hidden). */
function genericTable(game: string, server: AnyTableServer): HostedTable | null {
  const def = (definitions as Record<string, Parameters<typeof viewSnapshot>[0]>)[game];
  if (!def) return null;
  const snap = () => server.getSnapshot();
  return {
    game,
    matchId: () => snap().id,
    key: () => {
      const k = snap().options?.mailboxKey;
      return typeof k === 'string' ? k : undefined;
    },
    version: () => `${snap().seq}:${snap().chat?.length ?? 0}`,
    seats: () => snap().seats as (PlayerProfile | null)[],
    connected: () => server.connectedSeats(),
    viewFor: (seat) =>
      viewSnapshot(def, snap(), seat) as unknown as ReturnType<HostedTable['viewFor']>,
    playedByMail: () => playedByMail(snap()),
    yourTurn: (seat) => (game === 'ofc' ? ofcTurn(snap().state, seat) : false),
    onChange: (l) => server.onChange(l),
  };
}

/**
 * While a session hosts a match on this device, mail its position to whoever is away. Returns
 * the stop function (also mails anything still unsent).
 */
export function startHostMail(
  slug: string,
  game: string,
  session: { role: 'host' | 'guest'; server?: unknown },
): () => void {
  if (session.role !== 'host' || !session.server) return () => {};
  if (game === 'backgammon') {
    const server = session.server as BackgammonServer;
    const s = server.getSnapshot();
    const me = s.dealer ? null : COLORS.indexOf(s.hostSeat);
    return mailAbsentSeats(slug, backgammonTable(server), me);
  }
  const server = session.server as AnyTableServer;
  const table = genericTable(game, server);
  if (!table) return () => {};
  return mailAbsentSeats(slug, table, server.getSnapshot().hostSeat);
}
