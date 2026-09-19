/**
 * Game-agnostic ledger model: who owes whom, in points and currency, across a session of games.
 * Games map their own history into `LedgerLine`s (OFC hands, backgammon games, manual
 * adjustments, settlements); the UI, CSV export and settlement maths live here.
 */

export type LedgerLineKind = 'hand' | 'game' | 'adjust' | 'settlement';

export interface LedgerLine {
  kind: LedgerLineKind;
  /** Short label, e.g. "Hand 4", "Adjustment", "Settled". */
  label: string;
  at: number | null;
  /** Net points per seat for this line (sums to zero except for adjustments). */
  deltas: number[];
  /** Currency per seat when the line carries money (settlements). */
  amounts?: number[];
  note?: string;
}

export interface Transfer {
  from: number;
  to: number;
  points: number;
  amount: number;
}

export interface LedgerModel {
  seats: number;
  names: string[];
  multiplier: number;
  /** Baseline each seat starts from (0, or the buy-in). */
  baseline: number;
  lines: LedgerLine[];
  /** Points per seat since the last settlement. */
  unsettled: number[];
  /** Displayed balance per seat: baseline + unsettled. */
  balances: number[];
  /** Who pays whom to bring everyone back to the baseline. */
  plan: Transfer[];
}

/** Net points per seat over `lines`, starting after the last settlement. */
export function unsettledFromLines(lines: readonly LedgerLine[], seats: number): number[] {
  const out = new Array<number>(seats).fill(0);
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.kind === 'settlement') {
      start = i + 1;
      break;
    }
  }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    for (let s = 0; s < seats; s++) out[s]! += line.deltas[s] ?? 0;
  }
  return out;
}

/** Minimal set of transfers that zeroes `unsettled` (debtors pay creditors greedily). */
export function planFromBalances(unsettled: readonly number[], multiplier: number): Transfer[] {
  const debtors = unsettled.map((v, i) => ({ seat: i, left: -v })).filter((d) => d.left > 0);
  const creditors = unsettled.map((v, i) => ({ seat: i, left: v })).filter((c) => c.left > 0);
  const out: Transfer[] = [];
  let ci = 0;
  for (const d of debtors) {
    while (d.left > 0 && ci < creditors.length) {
      const c = creditors[ci]!;
      const points = Math.min(d.left, c.left);
      out.push({ from: d.seat, to: c.seat, points, amount: points * multiplier });
      d.left -= points;
      c.left -= points;
      if (c.left === 0) ci++;
    }
  }
  return out;
}

export function buildLedger(input: {
  seats: number;
  names: string[];
  multiplier: number;
  baseline?: number;
  lines: LedgerLine[];
}): LedgerModel {
  const unsettled = unsettledFromLines(input.lines, input.seats);
  const baseline = input.baseline ?? 0;
  return {
    seats: input.seats,
    names: input.names,
    multiplier: input.multiplier,
    baseline,
    lines: input.lines,
    unsettled,
    balances: unsettled.map((v) => baseline + v),
    plan: planFromBalances(unsettled, input.multiplier),
  };
}

/** "$1.25", "−$0.50". Currency symbol is a display convention; the multiplier is unit-less. */
export function formatMoney(amount: number, symbol = '$'): string {
  const sign = amount < 0 ? '−' : '';
  return `${sign}${symbol}${Math.abs(amount).toFixed(2)}`;
}

/** "+3", "−12", "0". */
export function formatPoints(points: number): string {
  if (points > 0) return `+${points}`;
  if (points < 0) return `−${Math.abs(points)}`;
  return '0';
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The ledger as CSV: one row per line, one column per seat (points), plus amounts and notes. */
export function ledgerCsv(model: LedgerModel): string {
  const header = [
    'line',
    'kind',
    'at',
    ...model.names.map((n) => `${n} (points)`),
    ...model.names.map((n) => `${n} (amount)`),
    'note',
  ];
  const rows = model.lines.map((line) => [
    line.label,
    line.kind,
    line.at ? new Date(line.at).toISOString() : '',
    ...model.names.map((_, i) => line.deltas[i] ?? 0),
    ...model.names.map((_, i) =>
      (line.amounts?.[i] ?? (line.deltas[i] ?? 0) * model.multiplier).toFixed(2),
    ),
    line.note ?? '',
  ]);
  const totals = [
    'Balance',
    '',
    '',
    ...model.balances,
    ...model.unsettled.map((v) => (v * model.multiplier).toFixed(2)),
    `multiplier ${model.multiplier}`,
  ];
  return [header, ...rows, totals].map((r) => r.map(csvCell).join(',')).join('\n');
}
