# @bgf/wallet

One seed behind a player, and a way to let a second device act for them without ever copying it.

Replaces the old hand-off QR code, which carried the private key itself: anyone who photographed
that screen became the player permanently, and the only remedy was to abandon the identity along
with every seat and club membership bound to it.

## The seed

A wallet is 32 random bytes. Every key is derived from them, so one backup restores all of them:

```
seed ──HKDF-SHA-256──┬─ identity        → the ECDSA P-256 key seats are bound to
                     ├─ sync            → the device-sync secret
                     ├─ club/<clubId>   → a separate key per club
                     └─ device/<serial> → a device key, when the wallet holds both ends
```

`deriveKeyPair` returns an ordinary `KeyPair` from `@bgf/protocol` — raw uncompressed public key,
PKCS#8 private key, both base64url — so a derived key is accepted everywhere a generated one
already is, and nothing downstream had to change. WebCrypto cannot turn a private scalar into a
public point, so `@noble/curves` does that one step and WebCrypto does the rest.

Two details that are easy to get wrong and are tested:

- **Purpose and length are bound into the HKDF `info`.** Expand is a prefix function of its
  length, so deriving 32 bytes and 48 bytes under one `info` would hand out the short answer as
  the head of the long one.
- **The scalar is reduced from 384 bits**, not 256, so the modulo bias into `[1, n-1]` is about
  2⁻¹²⁸ rather than something a statistician could find.

A club key is separate per club: the same person at two clubs presents two unrelated public keys,
so clubs cannot correlate their rosters, while the player still restores both from one backup.

## Device grants

The new device generates its own key pair and shows only the public half. The wallet signs a
**grant** — this device key, these scopes, until this date, as serial N — and the device presents
it alongside every signature from then on.

```ts
const wallet = await openWallet(seed);
const grant = await wallet.pairDevice({ device: phonePublicKey, serial: 1, label: 'phone' });

// on the phone
const signed = await delegatedSigner(phonePrivateKey, grant)(challengeBytes(challenge));

// on whatever is checking — a table, a club
const auth = await verifyDelegated(rootPublicKey, bytes, signed, { now, scope: 'seat' });
```

Nothing secret crosses the pairing channel, so a photographed QR code is worth nothing.

Scopes are a closed vocabulary: `seat`, `sync`, `club`, `admin`. The root key always has all of
them; a device has only what it was given.

Tokens are `p2pd1.<payload>.<signature>`, matching the club's invite and mint certificates.

## Losing a device

Revoke serial N. Every other device keeps working, and the identity itself never moves — which is
the entire reason for not copying the key:

```ts
const token = await wallet.revoke({ serials: [1] });          // one device
const token = await wallet.revoke({ minSerial: next });        // sign out everything
```

`minSerial` revokes every serial below it, so "sign out all devices" is one number rather than a
growing list.

A verifier that is handed a revocation list should also decide how old a list it will believe:
pass `revocationMaxAge`, or an attacker who keeps replaying yesterday's list hides today's
revocations. Without a list nothing is revoked, so the freshness policy belongs to whoever is
checking — see `verifyGrant` and `verifyDelegated`.

## Integrating

Seats and memberships stay bound to the **root** public key. The change on the verifying side is
to call `verifyDelegated` instead of `verify`, which accepts both a bare root signature and a
delegated one. Trust-on-first-use still binds the root key, and devices come and go underneath it.

## What is pinned

`test/derive.test.ts` holds a known-answer vector. Derivation decides what public key a player
*is*, so changing it silently rebuilds every identity, orphans every seat binding and every club
membership, and no backup would restore them. If a change breaks that test, the change is wrong
unless it comes with a migration and a new `WALLET_KDF` version string.

## Not here yet

The passkey path (WebAuthn PRF unlocking the seed), the recovery phrase, and the
password-encrypted fallback where PRF is missing. Passkeys bind to a domain, so that work waits
until the site is served from its own.
