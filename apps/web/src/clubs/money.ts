import type { ClubCurrency } from '@bgf/protocol';

/** Format minor units with the club's decimals, e.g. 12550 with 2 decimals → "125.50 chips". */
export function formatChips(
  amount: number,
  currency: ClubCurrency,
  opts: { sign?: boolean } = {},
): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const factor = 10 ** currency.decimals;
  const whole = Math.floor(abs / factor);
  const frac = abs - whole * factor;
  const body =
    currency.decimals > 0
      ? `${whole.toLocaleString()}.${String(frac).padStart(currency.decimals, '0')}`
      : whole.toLocaleString();
  const prefix = negative ? '−' : opts.sign && amount > 0 ? '+' : '';
  return `${prefix}${body} ${currency.code}`;
}

/** Parse a user-typed amount ("12.5") into minor units; null when not a valid non-negative number. */
export function parseChips(text: string, currency: ClubCurrency): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^\d+(\.\d*)?$/.test(trimmed)) return null;
  const [w, f = ''] = trimmed.split('.');
  const frac = (f + '0'.repeat(currency.decimals)).slice(0, currency.decimals);
  const value = Number(w) * 10 ** currency.decimals + (currency.decimals ? Number(frac) : 0);
  return Number.isFinite(value) ? value : null;
}
