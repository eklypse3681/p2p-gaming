import type { ClubCurrency } from '@bgf/protocol';

/** Minor units → "12.50 chips" (or "1,250 🪙" with no decimals). */
export function fmtChips(minor: number, currency?: ClubCurrency | null): string {
  const decimals = currency?.decimals ?? 0;
  const value = minor / 10 ** decimals;
  const text = value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return currency?.code ? `${text} ${currency.code}` : text;
}

/** Signed variant for ledger lines: "+12.50" / "−3.00". */
export function fmtSigned(minor: number, currency?: ClubCurrency | null): string {
  const sign = minor > 0 ? '+' : minor < 0 ? '−' : '';
  return sign + fmtChips(Math.abs(minor), currency);
}

export function fmtTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDate(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function shortId(id: string, n = 8): string {
  return id.length > n + 1 ? `${id.slice(0, n)}…` : id;
}

export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}
