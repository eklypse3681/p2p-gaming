import type { ClubCurrency, ClubIdentity, KeyPair } from '@bgf/protocol';
import { base64UrlToBytes } from '@bgf/protocol';
import { sha256Base64Url } from './canonical.js';

/** A club's id is the base64url SHA-256 of its raw public key. */
export function clubIdFor(publicKey: string): string {
  return sha256Base64Url(base64UrlToBytes(publicKey));
}

export interface CreateClubOptions {
  name: string;
  currency?: Partial<ClubCurrency>;
  keys: KeyPair;
  tagline?: string;
  now?: number;
}

export const DEFAULT_CURRENCY: ClubCurrency = { code: 'chips', name: 'Chips', decimals: 0 };

export function createClub(opts: CreateClubOptions): ClubIdentity {
  const name = opts.name.trim();
  if (!name) throw new ClubError('bad-name', 'a club needs a name');
  const currency: ClubCurrency = { ...DEFAULT_CURRENCY, ...(opts.currency ?? {}) };
  if (!currency.code.trim()) throw new ClubError('bad-currency', 'currency code is required');
  if (!Number.isInteger(currency.decimals) || currency.decimals < 0 || currency.decimals > 8) {
    throw new ClubError('bad-currency', 'currency decimals must be 0..8');
  }
  return {
    id: clubIdFor(opts.keys.publicKey),
    name,
    publicKey: opts.keys.publicKey,
    currency,
    createdAt: opts.now ?? Date.now(),
    ...(opts.tagline ? { tagline: opts.tagline } : {}),
  };
}

/** Errors raised by the club domain carry a stable code the runtime relays to clients. */
export class ClubError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClubError';
  }
}

/** Format minor units for display, e.g. 1250 with 2 decimals → "12.50". */
export function formatAmount(amount: number, currency: ClubCurrency): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (currency.decimals === 0) return `${sign}${abs}`;
  const factor = 10 ** currency.decimals;
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(currency.decimals, '0');
  return `${sign}${whole}.${frac}`;
}
