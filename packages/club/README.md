# @bgf/club

The club domain and the club channel. A club is a runtime with its own keypair that keeps a
member roster, a signed chip ledger, and rooms of table templates. Members reach it over any
`Transport` (PeerJS id derived from the club id, namespace `club-v1`), prove their identity with
the same keyed challenge tables use, and talk the protocol in `@bgf/protocol` (`club.ts`).

## Model

- **Identity**: `createClub({ name, currency, keys })`. The club id is the base64url SHA-256 of
  its public key. Currencies are integers in minor units with a display `decimals`.
- **Members**: the creator is the `owner`; others join with a signed invite token
  (`p2pc1.<payload>.<sig>`), either as `active` (auto-approve) or `pending` until an admin
  approves. Roles: owner, admin, member. A member id is bound to its key: the same id with a
  different key is refused.
- **Rooms and templates**: a room lists table templates (game, rule config, seats, stakes,
  randomness, `alwaysOpen`). Stakes carry `chipsPerPoint`, buy-in bounds and the rake.
- **Lobby**: what a member sees: rooms, open tables (from the runtime's `TableRegistry`), their
  own balance and role, who is online. Admins also see the reserve.

## Ledger

Append-only hash chain, every entry signed by the club key:

```
hash      = SHA-256(prevHash ‖ canonicalJSON({ seq, at, kind, lines, ref }))
signature = ECDSA-P256(club private key, hash)
```

`lines` are `{ account, amount }` in minor units. Accounts are member ids, `house` (the club's
reserve), `table:<id>:<memberId>` (a stack at a table) and `tournament:<id>` pools. Kinds:

| kind                  | meaning                                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| `mint`                | a platform certificate credits the house; the only way chips enter         |
| `burn`                | rake or entry fees destroyed; the only way chips leave; all lines negative |
| `grant` / `redeem`    | house → member / member → house                                            |
| `buy-in` / `cash-out` | member ↔ their stack at a table                                            |
| `result`              | one hand's chips moving between stacks                                     |
| `transfer`            | member → member                                                            |
| `fee`                 | account → house                                                            |
| `adjust`              | admin correction (house may only be debited)                               |

`verifyLedger(entries, clubPublicKey, { platformPublicKey })` re-hashes the chain, checks every
signature, and enforces the chip economy: every `mint` carries a valid, single-use platform
certificate for that amount; only mint, redeem and fee ever credit the house; the reserve never
goes negative; `minted − burned ≥ circulation + reserve` after every entry; and every raked
`result` is followed by a `burn` of at least the platform minimum.

Members get `statementFor(memberId)`: their own entries plus the signed head of the ledger.
`verifyStatement` checks the entries, the head signature and that they add up to the balance.

## Chips and the platform

Clubs do not print chips. The platform sells them: a **certificate** (`p2pm1.<payload>.<sig>`,
signed with the platform key, single-use, per club and currency) is minted into the club's
reserve, and the club grants chips to members from that reserve. Every raked hand burns chips
(`PLATFORM_MIN_RAKE_BPS` is the enforced floor; templates below it are refused), and tournament
entry fees are burned the same way, so a club's economy dissipates and it comes back to the
platform for more. Anyone holding the ledger can verify all of this offline with the club's and
the platform's public keys.

`PLATFORM_PUBLIC_KEY` in `src/platform.ts` is a **development placeholder**. Its private key lives
only in `dev/platform-dev-key.json` (git-ignored) so tests and local consoles can issue
certificates with `issueCertificate`. The production key replaces the constant at release.

Enforcement model: the club runtime ships as the platform's build (closed source; only the
client side of the protocol is open), so rake and minting rules are enforced by distribution.
The hash chain, the club's signatures and the platform's certificates are the bookkeeping
guarantee behind that: `verifyLedger` is an admin/platform tool for auditing a club's books,
not something members are expected to run. What a member gets is a clear statement: every
entry that touched their balance, with a description, the change and the running balance.

## Trust

The club is the bookkeeper and the platform's build is the referee. Members hold signed
statements; the platform's certificates bound how many chips a club can ever have. Tables are
joined by room code as always; the club only hands out the code after moving the buy-in onto the
member's stack.

This package is self-contained (dependencies: `@bgf/protocol`, `@bgf/table`, `@bgf/club-spec`)
so a runtime can consume it as a plain dependency. The runtime that hosts clubs, mints chips and
serves the operator console is a separate, private repository; this package is the reference
implementation of the specification it serves, and it passes the same conformance suite any
other implementation must.
