import type { LedgerEntry, TableState, TableView } from '@bgf/ofc-engine';
import type { LedgerLine, LedgerModel } from '../../../session/ledger';
import { buildLedger } from '../../../session/ledger';

/** Map the engine's ledger entries onto the generic ledger lines. */
export function ofcLedgerLines(entries: readonly LedgerEntry[], seats: number): LedgerLine[] {
  const zeros = () => new Array<number>(seats).fill(0);
  return entries.map((e): LedgerLine => {
    switch (e.type) {
      case 'hand': {
        const deltas = zeros();
        for (const t of e.transfers) {
          deltas[t.from]! -= t.points;
          deltas[t.to]! += t.points;
        }
        return { kind: 'hand', label: `Hand ${e.hand}`, at: null, deltas };
      }
      case 'adjust': {
        const deltas = zeros();
        deltas[e.seat]! += e.points;
        return { kind: 'adjust', label: 'Adjustment', at: e.at, deltas, note: e.note };
      }
      case 'settlement': {
        const deltas = zeros();
        const amounts = zeros();
        for (const t of e.transfers) {
          deltas[t.from]! -= t.points;
          deltas[t.to]! += t.points;
          amounts[t.from]! -= t.amount;
          amounts[t.to]! += t.amount;
        }
        return { kind: 'settlement', label: 'Settled', at: e.at, deltas, amounts };
      }
    }
  });
}

/** The ledger of a table as the sheet shows it. */
export function ofcLedgerModel(state: TableState | TableView, names: string[]): LedgerModel {
  const seats = state.config.seats;
  const sc = state.config.scoring;
  return buildLedger({
    seats,
    names,
    multiplier: sc.multiplier,
    baseline: sc.mode === 'buyin' ? (sc.buyIn ?? 0) : 0,
    lines: ofcLedgerLines(state.ledger, seats),
  });
}
