/**
 * The verifier's side of delegation.
 *
 * A seat, a club membership or a sync peer is bound to the player's **root** public key and never
 * to a device. When something arrives signed, it carries either a bare signature (the wallet
 * itself signed it) or a signature plus the grant that authorises the device key. Both answer the
 * same question — is this really that player, and are they allowed to do this — so both paths end
 * up in `verifyDelegated`.
 *
 * This is the one function a table or club needs in order to accept delegated devices: keep
 * binding seats to the root key, and call this instead of `verify`.
 */
import type { Signer } from '@bgf/protocol';
import { base64UrlToBytes, bytesToBase64Url, sign, verify } from '@bgf/protocol';
import type { DeviceGrant, GrantProblem, GrantScope, Revocation } from './delegation.js';
import { verifyGrant } from './delegation.js';

export interface SignedByDevice {
  /** The grant token; absent when the wallet's own root key signed. */
  grant?: string;
  /** base64url signature over the challenge bytes. */
  signature: string;
}

export type Authorization =
  | { ok: true; device: string; viaGrant: boolean; grant?: DeviceGrant }
  | { ok: false; reason: GrantProblem };

export interface AuthorizeOptions {
  now: number;
  /** The permission this action needs. The root key always has it. */
  scope?: GrantScope;
  revocation?: Revocation | null;
  revocationMaxAge?: number;
}

export async function verifyDelegated(
  rootPublicKey: string,
  bytes: Uint8Array,
  signed: SignedByDevice,
  opts: AuthorizeOptions,
): Promise<Authorization> {
  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(signed.signature);
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }

  // No grant: the wallet signed for itself, and the wallet may do anything.
  if (!signed.grant) {
    const ok = await verify(rootPublicKey, bytes, signature);
    return ok
      ? { ok: true, device: rootPublicKey, viaGrant: false }
      : { ok: false, reason: 'bad-signature' };
  }

  const checked = await verifyGrant(signed.grant, {
    now: opts.now,
    root: rootPublicKey,
    ...(opts.scope ? { scope: opts.scope } : {}),
    revocation: opts.revocation ?? null,
    ...(opts.revocationMaxAge !== undefined ? { revocationMaxAge: opts.revocationMaxAge } : {}),
  });
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const grant = checked.grant;
  if (!(await verify(grant.device, bytes, signature))) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true, device: grant.device, viaGrant: true, grant };
}

/** What a paired device signs with: its own key, presenting the grant every time. */
export function delegatedSigner(
  devicePrivateKey: string,
  grant: string,
): (bytes: Uint8Array) => Promise<SignedByDevice> {
  return async (bytes) => ({
    grant,
    signature: bytesToBase64Url(await sign(devicePrivateKey, bytes)),
  });
}

/** What the wallet itself signs with. */
export function rootSigner(rootPrivateKey: string): (bytes: Uint8Array) => Promise<SignedByDevice> {
  return async (bytes) => ({ signature: bytesToBase64Url(await sign(rootPrivateKey, bytes)) });
}

/** Adapt either of the above to the plain `Signer` the existing seat handshake takes. */
export function rawSigner(privateKey: string): Signer {
  return (bytes) => sign(privateKey, bytes);
}
