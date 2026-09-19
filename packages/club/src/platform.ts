import type { PlatformCertificate, Signer } from '@bgf/protocol';
import { base64UrlToBytes, bytesToBase64Url, randomNonce, sign, verify } from '@bgf/protocol';
import { utf8Bytes } from '@bgf/table';
import { canonicalJson } from './domain/canonical.js';
import { ClubError } from './domain/identity.js';

/**
 * The platform sells chips to clubs. A club can only mint chips into its reserve by presenting a
 * certificate signed with the platform key; rake and entry fees are burned, so reserves dissipate
 * and clubs come back for more. This is the DEV placeholder public key: the matching private key
 * lives only in `packages/club/dev/platform-dev-key.json` (git-ignored) so tests and local
 * consoles can issue certificates. The production key replaces this constant at release time.
 */
export const PLATFORM_PUBLIC_KEY =
  'BJfbeNNrnlAyOUvKN-jt3DUHCrhN6LK_OQkfBQVKVf3O7wOsR4eB2_hOEdShtsw4iUV01j9tZwNGSLBSWIntRJc';

/** Minimum rake the platform enforces on every raked hand (basis points of chips moved). */
export const PLATFORM_MIN_RAKE_BPS = 200;

export const CERTIFICATE_PREFIX = 'p2pm1';
export const DEFAULT_CERTIFICATE_TTL_MS = 1000 * 60 * 60 * 24 * 365;

export function certificateBytes(cert: PlatformCertificate): Uint8Array {
  return utf8Bytes(`p2p-gaming platform certificate v1\n${canonicalJson(cert)}`);
}

export interface IssueCertificateOptions {
  clubId: string;
  currency: string;
  amount: number;
  /** The platform private key (PKCS#8 base64url) or a signer over it. */
  privateKey?: string;
  signer?: Signer;
  now?: number;
  expiresAt?: number;
}

export async function issueCertificate(
  opts: IssueCertificateOptions,
): Promise<{ certificate: PlatformCertificate; token: string }> {
  if (!Number.isInteger(opts.amount) || opts.amount <= 0) {
    throw new ClubError('bad-certificate', 'certificate amounts are positive integers');
  }
  const signer =
    opts.signer ?? (opts.privateKey ? (b: Uint8Array) => sign(opts.privateKey!, b) : null);
  if (!signer)
    throw new ClubError('bad-certificate', 'a platform key is needed to issue certificates');
  const now = opts.now ?? Date.now();
  const certificate: PlatformCertificate = {
    clubId: opts.clubId,
    currency: opts.currency,
    amount: opts.amount,
    nonce: randomNonce(12),
    issuedAt: now,
    expiresAt: opts.expiresAt ?? now + DEFAULT_CERTIFICATE_TTL_MS,
  };
  const signature = bytesToBase64Url(await signer(certificateBytes(certificate)));
  return { certificate, token: encodeCertificate(certificate, signature) };
}

export function encodeCertificate(certificate: PlatformCertificate, signature: string): string {
  const payload = bytesToBase64Url(utf8Bytes(canonicalJson(certificate)));
  return `${CERTIFICATE_PREFIX}.${payload}.${signature}`;
}

export function decodeCertificate(token: string): {
  certificate: PlatformCertificate;
  signature: string;
} {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== CERTIFICATE_PREFIX) {
    throw new ClubError('bad-certificate', 'that is not a platform certificate');
  }
  let certificate: PlatformCertificate;
  try {
    certificate = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(parts[1]!)),
    ) as PlatformCertificate;
  } catch {
    throw new ClubError('bad-certificate', 'the certificate is damaged');
  }
  if (
    !certificate ||
    typeof certificate.clubId !== 'string' ||
    typeof certificate.currency !== 'string' ||
    !Number.isInteger(certificate.amount) ||
    certificate.amount <= 0 ||
    typeof certificate.nonce !== 'string' ||
    typeof certificate.issuedAt !== 'number'
  ) {
    throw new ClubError('bad-certificate', 'the certificate is malformed');
  }
  return { certificate, signature: parts[2]! };
}

/** Verify a certificate token against the platform key; throws `ClubError` with a specific code. */
export async function verifyCertificate(
  token: string,
  publicKey: string = PLATFORM_PUBLIC_KEY,
  now: number = Date.now(),
): Promise<PlatformCertificate> {
  const { certificate, signature } = decodeCertificate(token);
  let ok = false;
  try {
    ok = await verify(publicKey, certificateBytes(certificate), base64UrlToBytes(signature));
  } catch {
    ok = false;
  }
  if (!ok) throw new ClubError('bad-certificate', 'the certificate was not signed by the platform');
  if (certificate.expiresAt !== undefined && now > certificate.expiresAt) {
    throw new ClubError('certificate-expired', 'the certificate has expired');
  }
  return certificate;
}
