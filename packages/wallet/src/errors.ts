/** Everything in this package fails through one error type, so callers can switch on `code`. */
export class WalletError extends Error {
  constructor(
    public readonly code:
      'no-crypto' | 'bad-seed' | 'bad-path' | 'bad-grant' | 'bad-revocation' | 'bad-scope',
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

export function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new WalletError('no-crypto', 'WebCrypto (crypto.subtle) is not available');
  return s;
}
