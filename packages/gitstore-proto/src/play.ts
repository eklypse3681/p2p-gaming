import {
  applyAction as bgApply,
  newMatch,
  type Action as BgAction,
  type MatchState,
  type Player,
} from '@bgf/engine';
import { backgammonDefinition } from '@bgf/server';
import { seededRng } from '@bgf/table';
import {
  applyAll,
  canPlace,
  defaultConfig,
  command as ofcCommand,
  init as ofcInit,
  turnRequirement,
  type Action as OfcAction,
  type Card,
  type Command as OfcCommand,
  type TableState,
} from '@bgf/ofc-engine';
import { backgammonBot, ofcBot } from '@bgf/soak';
import { canonical, sha256 } from './gitstore.ts';

/**
 * The "current state" a table ref points at must be small and denormalised: balances, the live
 * snapshot, chain heads. The engines' states also carry accumulated history/ledger arrays
 * (the chain itself), which are excluded from the state hash — hashing them would make every
 * hand's cost grow with the table's age (this prototype's first run did exactly that).
 */
function ofcStateHash(state: TableState): string {
  return sha256(canonical({ ...state, history: [], ledger: [] }));
}
function bgStateHash(match: MatchState): string {
  return sha256(
    canonical({ ...match, games: [], game: match.game ? { ...match.game, history: [] } : null }),
  );
}
import { cardIndex, type BgGameRecord, type OfcHandRecord } from './record.ts';

const ROW_CAP = { top: 3, middle: 5, bottom: 5 } as const;

/** Fast legal placement (no evaluation) for volume generation. */
function quickPlace(state: TableState, seat: number): OfcCommand {
  const me = state.hand!.seats[seat]!;
  const req = turnRequirement(state, seat);
  const counts = {
    top: me.rows.top.length,
    middle: me.rows.middle.length,
    bottom: me.rows.bottom.length,
  };
  const pending = me.pending.slice();
  const placements: Array<{ card: Card; row: 'top' | 'middle' | 'bottom' }> = [];
  for (let i = 0; i < req.place; i++) {
    const card = pending.shift()!;
    const row = (['bottom', 'middle', 'top'] as const).find((r) => counts[r] < ROW_CAP[r])!;
    counts[row]++;
    placements.push({ card, row });
  }
  return { type: 'place', placements, discards: pending };
}

export interface OfcHandsOptions {
  variant: 'ofc' | 'pineapple' | 'pineapple27';
  seats: 2 | 3;
  hands: number;
  seed: number;
  /** 'smart' uses the soak bot (slow, realistic play); 'quick' places legally without thinking. */
  play: 'smart' | 'quick';
  clubId?: string;
  tableId?: string;
}

/** Drive real hands through the OFC engine and emit denormalised records. */
export function ofcHands(opts: OfcHandsOptions): OfcHandRecord[] {
  const rng = seededRng(opts.seed);
  let state = ofcInit(defaultConfig({ variant: opts.variant, seats: opts.seats }));
  const records: OfcHandRecord[] = [];
  let prevHash = 'genesis';
  const clubId = opts.clubId ?? 'club-a';
  const tableId = opts.tableId ?? 't1';
  let now = 1_789_257_600_000;
  const clock = () => now;
  for (let n = 1; n <= opts.hands; n++) {
    const s0 = ofcStateHash(state);
    const startAt = now;
    const actions: OfcAction[] = [];
    const apply = (acts: OfcAction[]) => {
      actions.push(...acts);
      state = applyAll(state, acts);
    };
    apply(ofcCommand(state, -1, { type: 'start' }, rng, clock));
    let guard = 0;
    while (state.hand && state.hand.phase === 'setting') {
      if (++guard > 200) throw new Error('hand did not finish');
      let acted = false;
      for (let seat = 0; seat < opts.seats; seat++) {
        if (!canPlace(state, seat)) continue;
        const cmd = opts.play === 'smart' ? ofcBot(state, seat, { rng }) : quickPlace(state, seat);
        if (!cmd) continue;
        now += 12_000;
        apply(ofcCommand(state, seat, cmd, rng, clock));
        acted = true;
        break;
      }
      if (!acted) throw new Error('no seat could act');
    }
    const s1 = ofcStateHash(state);
    const result = state.history[state.history.length - 1]!;
    const deals: number[][] = Array.from({ length: opts.seats }, () => []);
    const acts: OfcHandRecord['acts'] = [];
    for (const a of actions) {
      if (a.type === 'start-hand')
        for (const d of a.deals) deals[d.seat]!.push(...d.cards.map(cardIndex));
      else if (a.type === 'deal-next') deals[a.seat]!.push(...a.cards.map(cardIndex));
      else if (a.type === 'place') {
        acts.push({
          s: a.seat,
          p: a.placements.map(
            (p) =>
              [cardIndex(p.card), ['top', 'middle', 'bottom'].indexOf(p.row)] as [number, number],
          ),
          d: a.discards.map(cardIndex),
        });
      }
    }
    const moved = result.transfers.reduce((acc, t) => acc + t.points, 0);
    const body: Omit<OfcHandRecord, never> = {
      v: 1,
      g: 'ofc',
      c: clubId,
      t: tableId,
      n,
      s0,
      s1,
      ph: prevHash,
      at: [startAt, now],
      btn: state.button,
      deals,
      acts,
      res: {
        pts: result.seats.map((s) => s.points),
        roy: result.seats.map((s) => s.royalties),
        foul: result.seats.reduce((m, s, i) => m | (s.fouled ? 1 << i : 0), 0),
        fl: result.seats.map((s) => s.fantasylandNext),
        rake: Math.ceil(moved * 0.02),
        tr: result.transfers.map((t) => [t.from, t.to, t.points] as [number, number, number]),
      },
    };
    records.push(body);
    prevHash = sha256(canonical(body));
    now += 5_000;
  }
  return records;
}

export interface BgGamesOptions {
  games: number;
  seed: number;
  clubId?: string;
  tableId?: string;
}

function playerIndex(p: Player): number {
  return p === 'black' ? 1 : 0;
}

/** Drive real backgammon games (one game = one record) through the engine via the server definition. */
export function bgGames(opts: BgGamesOptions): BgGameRecord[] {
  const rng = seededRng(opts.seed);
  let match: MatchState = newMatch({ length: 0, crawford: false, jacoby: true });
  const records: BgGameRecord[] = [];
  let prevHash = 'genesis';
  let now = 1_789_257_600_000;
  const ctx = { rng, now, seats: 2 };
  for (let n = 1; n <= opts.games; n++) {
    const s0 = bgStateHash(match);
    const startAt = now;
    const acts: number[][] = [];
    let guard = 0;
    for (;;) {
      if (++guard > 5000) throw new Error('game did not finish');
      const game = match.game;
      if (game && game.phase.kind === 'over') break;
      let moved = false;
      for (const player of ['white', 'black'] as const) {
        const cmd = backgammonBot(match, player, { rng });
        if (!cmd) continue;
        const out = backgammonDefinition.command(match, playerIndex(player), cmd, { ...ctx, now });
        const list = (Array.isArray(out) ? out : [out]) as BgAction[];
        for (const a of list) {
          match = bgApply(match, a);
          acts.push(encodeBg(a));
        }
        now += 8_000;
        moved = true;
        break;
      }
      if (!moved) throw new Error('no player could act');
    }
    const s1 = bgStateHash(match);
    const g = match.game!;
    const result = g.phase.kind === 'over' ? g.phase.result : null;
    if (!result) throw new Error('no result');
    const body: BgGameRecord = {
      v: 1,
      g: 'bg',
      c: opts.clubId ?? 'club-a',
      t: opts.tableId ?? 'b1',
      n,
      s0,
      s1,
      ph: prevHash,
      at: [startAt, now],
      acts,
      res: {
        winner: playerIndex(result.winner),
        kind: ['single', 'gammon', 'backgammon'].indexOf(result.kind),
        points: result.points,
        cube: result.cube,
        tr: [[playerIndex(result.winner) ? 0 : 1, playerIndex(result.winner), result.points]],
      },
    };
    records.push(body);
    prevHash = sha256(canonical(body));
    // next game
    match = bgApply(match, { type: 'start-game' });
  }
  return records;
}

function encodeBg(a: BgAction): number[] {
  switch (a.type) {
    case 'start-game':
      return [9];
    case 'opening-roll':
      return [0, playerIndex(a.player), a.die];
    case 'roll':
      return [1, playerIndex(a.player), a.dice[0], a.dice[1]];
    case 'play':
      return [2, playerIndex(a.player), ...a.play.flatMap((m) => [m.from, m.to, m.die])];
    case 'double':
      return [3, playerIndex(a.player)];
    case 'take':
      return [4, playerIndex(a.player)];
    case 'drop':
      return [5, playerIndex(a.player)];
    default:
      return [8];
  }
}
