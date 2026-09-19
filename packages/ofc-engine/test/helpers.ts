import type {
  Action,
  Card,
  Command,
  Placement,
  Row,
  Rows,
  TableConfig,
  TableState,
} from '../src/index.js';
import {
  ROW_CAPACITY,
  ROWS,
  applyAll,
  canPlace,
  cards,
  command,
  init,
  seededRng,
  turnRequirement,
} from '../src/index.js';
import type { Rng } from '../src/index.js';

export function rows(top: string, middle: string, bottom: string): Rows {
  return { top: cards(top), middle: cards(middle), bottom: cards(bottom) };
}

/** Fill rows in a fixed order: bottom, then middle, then top. */
export type PlaceCommand = Extract<Command, { type: 'place' }>;

export function firstFit(state: TableState, seat: number): PlaceCommand {
  const s = state.hand!.seats[seat]!;
  const req = turnRequirement(state, seat);
  const counts: Record<Row, number> = {
    top: s.rows.top.length,
    middle: s.rows.middle.length,
    bottom: s.rows.bottom.length,
  };
  const placements: Placement[] = [];
  const pending = s.pending.slice();
  const order: Row[] = ['bottom', 'middle', 'top'];
  for (let i = 0; i < req.place; i++) {
    const card = pending.shift()!;
    const row = order.find((r) => counts[r] < ROW_CAPACITY[r])!;
    counts[row]++;
    placements.push({ card, row });
  }
  return { type: 'place', placements, discards: pending };
}

/** Random legal placement. */
export function randomFit(state: TableState, seat: number, rng: Rng): PlaceCommand {
  const s = state.hand!.seats[seat]!;
  const req = turnRequirement(state, seat);
  const counts: Record<Row, number> = {
    top: s.rows.top.length,
    middle: s.rows.middle.length,
    bottom: s.rows.bottom.length,
  };
  const pending = rng.shuffle(s.pending);
  const placements: Placement[] = [];
  for (let i = 0; i < req.place; i++) {
    const card = pending.shift()!;
    const open = ROWS.filter((r) => counts[r] < ROW_CAPACITY[r]);
    const row = open[rng.int(open.length)]!;
    counts[row]++;
    placements.push({ card, row });
  }
  return { type: 'place', placements, discards: pending };
}

export interface PlayLog {
  state: TableState;
  actions: Action[];
}

/** Start a hand and play it to the showdown with the given placement policy. */
export function playHand(
  state: TableState,
  rng: Rng,
  policy: (s: TableState, seat: number) => Command = firstFit,
  log: Action[] = [],
): PlayLog {
  let s = state;
  const start = command(s, 0, { type: 'start' }, rng);
  log.push(...start);
  s = applyAll(s, start);
  let guard = 0;
  while (s.hand!.phase === 'setting') {
    if (++guard > 200) throw new Error('hand did not finish');
    const n = s.config.seats;
    let acted = false;
    for (let seat = 0; seat < n; seat++) {
      if (!canPlace(s, seat)) continue;
      const acts = command(s, seat, policy(s, seat), rng);
      log.push(...acts);
      s = applyAll(s, acts);
      acted = true;
      break;
    }
    if (!acted) throw new Error(`nobody can act: toAct=${s.hand!.toAct}`);
  }
  return { state: s, actions: log };
}

export function table(cfg: Partial<TableConfig> = {}): TableState {
  return init({ variant: 'pineapple', seats: 2, ...cfg });
}

export function rng(seed = 1): Rng {
  return seededRng(seed);
}

export function c(s: string): Card {
  return cards(s)[0]!;
}
