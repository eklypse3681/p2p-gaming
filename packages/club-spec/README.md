# `@bgf/club-spec`

A club is an interface, not a product.

The hosted platform, somebody running their own server, and a contract-backed adapter are all
legal clubs. This package is the contract they share and the suite that proves an implementation
honours it. It depends on nothing but `@bgf/protocol`, so anyone can build against it.

The public play-money world is not a separate system beside the clubs. It is a club: open
membership, a grant on joining, matchmaking across everyone online. Building it that way is what
keeps this interface honest, because the flagship is its own first consumer.

## The shape of it

- **`api.ts`** — `ClubApi`: everything a client needs, and nothing about how a club is built.
- **`capabilities.ts`** — what an implementation declares about itself before it serves anything,
  including who holds the chips.
- **`settlement.ts`** — staking chips on a table and settling what comes back.
- **`matching.ts`** — the matchmaking lifecycle, and a reference policy.
- **`errors.ts`** — the shared error vocabulary a client reacts to.

## Three rules

1. **Declare before you serve.** `info()` is answerable without authenticating, and an operation
   the capabilities do not claim fails with `unsupported` rather than half-working.
2. **Every mutation is idempotent.** Each carries an `opId`. Repeating it returns the original
   result and moves no chips twice; reusing the id with different arguments is a `conflict`.
3. **Chips are conserved.** What members hold, plus what is staked, plus what was raked, equals
   what the club issued. An implementation that cannot guarantee that refuses rather than guesses.

## Settling without blocking a hand

A ledger can be slow or costly to write — a contract with block times, a rate-limited service —
while a hand must never wait on it. So authorisation and settlement are separate:

| Mode        | When chips move                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `immediate` | Every hand, as it finishes. What an in-process ledger does.                                                       |
| `deferred`  | The stake is authorised when a member sits; the net reaches the books once, when they leave or the window closes. |

Two properties make `deferred` safe. A member can never lose more than the stake they committed,
because the commitment is a ceiling. And a tally must conserve: every net plus the rake sums to
zero. `checkTally` is the shared arbiter, so an implementation and the suite always agree.

## Proving an implementation

```ts
import { describe } from 'vitest';
import { runClubConformance } from '@bgf/club-spec/conformance';

describe('MyClub', () =>
  runClubConformance({
    name: 'MyClub',
    create: async () => ({
      club: await MyClub.open(),
      members, // keyed, already permitted to authenticate
      strangers, // profiles the club should refuse
      templateId, // something to sit at
      fund,
      ban,
      advance,
      close,
    }),
  }));
```

Checks are grouped by what they hold you to: **declaration**, **capabilities** (an operation you
claim must work, one you do not claim must say `unsupported`), **auth**, **idempotency**,
**conservation**, **commitments**, **settlement**, **matchmaking**, **statements** and
**isolation**. Each gets a freshly created club, so one check's chips can never explain another's
result. Anything the target cannot support is skipped with a reason rather than failed.

`runClubConformanceChecks` is the same suite without a test framework, returning a report — so a
club written in another language can be driven through a thin adapter and held to the same
standard. `formatConformanceReport` prints it.

## What passes today

| Implementation | Where        | Notes                                                                                                                                               |
| -------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryClub`   | this package | The smallest club that is still a club: open membership, immediate settlement, no transfers. Exists to prove the suite runs and to develop against. |
| `ClubServer`   | `@bgf/club`  | The reference implementation, in both settlement modes.                                                                                             |
| `RemoteClub`   | `@bgf/club`  | The same club over a transport, which holds the wire protocol to the spec too.                                                                      |
