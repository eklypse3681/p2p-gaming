# Architecture

Serverless, peer-to-peer backgammon. There is no backend: the **host's browser runs the game
server** next to its own client, and the guest's browser runs an identical client that talks to
the host over WebRTC. Both clients are the same code; only the transport differs.

```
 Host browser                                   Guest browser
 ┌────────────────────────────────────────┐     ┌──────────────────────┐
 │  React UI  ──▶ GameClient ─┐           │     │ React UI ──▶ GameClient
 │                            │ memory    │     │                 │    │
 │                       (Transport)      │     │            (Transport: PeerJS)
 │                            ▼           │     │                 │    │
 │                       GameServer ◀─────┼─────┼─────────────────┘    │
 │                       (engine, dice,   │ WebRTC data channel        │
 │                        persistence)    │     │                      │
 └────────────────────────────────────────┘     └──────────────────────┘
```

## Packages (pnpm workspace)

| Package                 | Role                                                                                                                       | Deps             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@bgf/engine`           | Pure rules: board, move generation, cube, Crawford/Jacoby, match scoring, action reducer                                   | none             |
| `@bgf/protocol`         | `Transport` / `Listener` / `TransportProvider` interfaces, message types, memory + BroadcastChannel transports, room codes | engine           |
| `@bgf/server`           | `GameServer`: authoritative state, seat assignment, validation, dice, snapshots, resume                                    | engine, protocol |
| `@bgf/client`           | `GameClient`: talks to a `Transport`, exposes a subscribable `ClientState`, drafts turns                                   | engine, protocol |
| `@bgf/transport-peerjs` | `peerJsProvider()`: WebRTC via PeerJS + free PeerJS cloud signalling                                                       | protocol, peerjs |
| `@bgf/web` (`apps/web`) | React 19 + Vite UI: screens, board renderer, themes, persistence (IndexedDB), e2e tests                                    | all of the above |

Packages are consumed from source (`main: src/index.ts`); Vite/Vitest resolve them directly.

## Key design rules

1. **The engine is pure and deterministic.** `applyAction(match, action)` is the only way state
   changes. Dice values live inside actions, so an action log replays to the identical state.
2. **The server is transport-agnostic.** It only sees `Transport` objects. Whether a connection is
   in-memory (host's own client), cross-tab (`BroadcastChannel`) or WebRTC is invisible to it.
3. **Clients are identical.** Host and guest run the same `GameClient` and the same UI. The host
   additionally instantiates a `GameServer` and connects its own client through a memory pair.
4. **Full snapshots, not diffs.** After every action the server sends the whole `MatchSnapshot`
   (a few KB) plus the action that caused it (for animation). Simple, robust to reconnects.
5. **Either side can resume.** Both peers persist every snapshot. On resume, whoever opens the
   match tries to host under its room code; if the code is taken, they join instead. The
   `hello` handshake carries the guest's snapshot and the newer `seq` wins.
6. **Renderer and theme are pluggable.** `apps/web/src/board/contract.ts` defines the view model
   any renderer consumes; `apps/web/src/themes/theme.ts` defines theme/piece/board sets as data.
   2D SVG is the first renderer; 3D is a future implementation of the same contract.
7. **Everything is testable without a network.** Engine/server/client tests run in Node with the
   memory transport. Playwright e2e runs host + guest in two pages of one browser using the
   BroadcastChannel transport (`?transport=broadcast`).

## Table core (`@bgf/table`)

Every game runs on the same generic, game-agnostic core. `TableServer` (in the host's browser)
and `TableClient` (identical on every device) handle seats, keyed identity (challenge/auth),
multi-device seats, presence, chat, previews, persistence and resume. The game supplies a
`GameDefinition`:

```ts
interface GameDefinition<State, Action, Command, View = State, Config = unknown> {
  id: string; // 'backgammon', 'ofc', …
  minSeats: number;
  maxSeats: number;
  hiddenInformation?: boolean; // true → guests receive views, never adopt a guest copy
  normalizeConfig?(raw: unknown): Config;
  init(config: Config, ctx: { rng: Rng; seats: number }): State;
  validateCommand(raw: unknown): Command | null; // shape check; null → `bad-message`
  validatePreview?(raw: unknown): unknown | null;
  command(
    state: State,
    seat: number,
    command: Command,
    ctx: { rng: Rng; now: number; seats: number },
  ): Action | Action[];
  reduce(state: State, action: Action): State; // pure
  view(state: State, seat: number | null): View; // redaction; identity when nothing is hidden
  viewAction?(action: Action, seat: number | null): Action | null;
  isOver?(state: State): boolean;
  summary?(state: State): unknown;
}
interface Rng {
  int(maxExclusive: number): number;
  shuffle<T>(items: readonly T[]): T[];
}
```

Rules of the core:

- **Determinism.** Randomness (dice, shuffles) is drawn from `ctx.rng` inside `command` and
  embedded in the returned actions; `reduce` is pure. A snapshot is verified by replaying
  `actions` from its persisted `initialState`; `init` may use the rng because that state is stored.
- **Seats are indexes** (0..n-1). Games map them to their own labels (backgammon: 0 = white,
  1 = black). The host takes `hostSeat`; other profile ids fill free seats in order; `full`
  otherwise. A known profile id always gets its seat back, from any number of devices.
- **Hidden information.** The host seat's devices receive the full authoritative snapshot; every
  other seat receives `view(state, seat)` and an action log filtered through `viewAction`,
  flagged `view: true`. A view is never adopted on resume (`error host-only-resume`), so a
  hidden-information game can only be resumed from a host-seat copy (or through profile sync
  between the host's own devices). Games without hidden information (`view` = identity) keep
  the old behaviour: any device's newer replayable copy wins.
- **Wire protocol v2** (`packages/protocol/src/table.ts`): `hello`/`challenge`/`auth`, then
  `command { command }`, `preview { payload }`, `chat`, `ping`, `bye`; the server answers with
  `welcome { seat, snapshot }`, `state { snapshot, action?, by? }`, `preview { seat, payload }`,
  `presence { seat, connected }`, `chat`, `error`, `pong`, `rejected`. Command and preview
  payloads are opaque to the core and validated by the definition.
- **Snapshot** (`TableSnapshot`): `{ id, code, seq, createdAt, updatedAt, gameId, config, seats[],
hostSeat, options, initialState, actions, state, chat, view? }`. `options` is a table-level bag
  the game does not interpret (backgammon keeps `homeSide` there).

Backgammon is the reference implementation: `packages/server` exports `backgammonDefinition`
plus `GameServer`, a colour-speaking wrapper over `TableServer`, and `packages/client` exports
`GameClient`, a wrapper over `TableClient` that adds turn drafting. Both convert between the
generic `TableSnapshot` and the colour-keyed `MatchSnapshot` the web app persists
(`packages/server/src/snapshot.ts`), so the web app did not change.

**Adding a game to the core**: implement a `GameDefinition` in its own engine package, wrap
`TableServer`/`TableClient` (or use them directly) in a small package with typed command
helpers, and register the UI under `apps/web/src/games/<id>/` (see "Adding a game").

## Entropy (`@bgf/entropy`, table core `entropy.ts`)

Randomness enters a table in one of three ways:

| Mode                | Option                                                   | When bytes are fetched                           | Record                      |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------ | --------------------------- |
| Plain rng           | `rng: Rng` (default `cryptoRng()`)                       | n/a                                              | none                        |
| Audited local pool  | `rng: createEntropyPool({ provider: cryptoProvider() })` | ahead of time (local generator only)             | bytes, draws, batch id      |
| Just-in-time source | `entropy: { source, bytes?, fallback?, purpose? }`       | at command time, one request per drawing command | bytes, draws, inline proofs |

`EntropySource.draw(bytes, { label, tableId, purpose })` returns bytes plus a proof
(`random.org-signed` = the signed `random` object + signature + serial number + quota left;
`drand` = round, randomness, signature, chain, derivation context; `none` = fallback).

**Command path.** `TableServer.apply` first runs the command against a _probe rng_ that throws
on the first draw. Commands that never draw apply synchronously as before. A drawing command
fetches `def.entropyBytes?(command) ?? 64` bytes, runs `def.command` over a _byte-backed rng_
(`createByteRng`: each `int(n)` reads four bytes big-endian and rejection-samples; `shuffle` is
Fisher–Yates over `int`) and, if the command asks for more than was fetched (`EntropyExhausted`),
doubles the budget, fetches again and re-runs from scratch over the concatenated bytes (commands
are pure, so re-running is safe). At most four rounds. Everything that arrives while a draw is
in flight queues in arrival order behind it. Failure → `error entropy-unavailable` to the
sender and no state change, unless `fallback: true`, in which case this device's generator
supplies the bytes and the record is flagged `fallback`. Games whose `init` draws (an opening
shuffle) are built with `await TableServer.create(opts)`; the constructor refuses them with a
clear message. Pools over external oracles are refused by `createEntropyPool`.

**Snapshot.** `actionMeta[index].entropy` (attributed to the _last_ action a command produced,
where deals and rolls land), `entropyAudit.init` for `init`, `entropyAudit.batches` for the pool
path, and `options.randomness.provider`. Views re-key `actionMeta` to their filtered log.
Reducers and replay never see any of it.

**Verification.** `verifyEntropyRecord(record)` checks the proof with its authority, recomputes
the attested bytes from the proof (random.org `random.data`; drand HKDF expansion), compares
them with the consumed bytes, and re-derives the draw values (`drawsMatch`). Mapping draws onto
the action is game knowledge (backgammon: die = draw + 1). `checkSerials(records)` flags gaps in
random.org serial numbers between consecutive draws of one table.

**Web app wiring (`apps/web`).** Settings → _Randomness_ (`entropySource`, `randomnessMode`,
`randomOrgKey`, `entropyFallback` per player, `session/settings.ts`) feeds `randomnessFromSettings`
(`session/entropy.ts`), which the host screens show as a chip with a per-table override
(`hud/HostTableOptions.tsx`, `hud/RandomnessControls.tsx`). `hostTable` / `hostNewMatch` turn the
choice into `options.randomness = { mode, provider }` plus `entropy: { source, fallback }` and go
through `TableServer.create` / `GameServer.create`; resume re-supplies the source from settings
(the mode is in the saved table). The _Fairness_ panel (`hud/FairnessPanel.tsx`, model in
`session/fairness.ts`) lists `actionMeta` draws and seeded segments with per-row _Verify_ /
_Verify all_ (`verifyEntropyRecord`, `verifySegment`, `verifyBeaconRecord`), shows `checkSerials`
gaps and random.org quota, and downloads the public audit JSON.

## Randomness modes

`options.randomness.mode` chooses how draws are produced; `entropy.source` chooses where the
randomness comes from (this device, random.org, drand). Every mode records enough for any seat
to verify after the fact; they differ in _when_ the host learns a value.

| Mode       | Draws                                                                     | Host knows the future? | Proof unit                 |
| ---------- | ------------------------------------------------------------------------- | ---------------------- | -------------------------- |
| `per-draw` | one source request per drawing command, at the moment it happens          | no                     | one request per action     |
| `seeded`   | one seed per _segment_ (hand / game), committed first, every draw derived | yes, within a segment  | one seed per segment       |
| `beacon`   | each draw bound to the _next_ drand round before that round exists        | no                     | one drand round per action |

**Seeded (commit and reveal).** The definition marks segments: `segmentBoundary(state,
command)` (OFC: `start`; backgammon: `start-game`) and `segmentComplete(state)` (OFC: showdown;
backgammon: game over). When a boundary command arrives — or the first draw happens with no open
segment — the server fetches a 32-byte seed from the source (its proof is kept for the reveal),
publishes `commitment = SHA-256(seed ‖ "|" ‖ tableId ‖ "|" ‖ segmentIndex)` in
`entropyAudit.segments[]` (a `state` broadcast before the command runs), and keeps the seed
private. Draw `k` of the segment reads its bytes from `HKDF-SHA-256(seed, salt =
SHA-256(tableId), info = "bgf-seeded/v1|" tableId "|" segment "|" k)` through the same
`createByteRng` derivation; draws are synchronous once the seed exists. Each action's record
carries `segment` and `drawIndex` (no inline source proof). When `segmentComplete` becomes true,
on the next boundary, or on `close()`, the segment is revealed: `seed`, `source` (the request
that produced it) and `to` are filled in and broadcast. Verification is pure and offline:
`verifySegment(snapshot, i)` recomputes the commitment and re-derives every attributed draw
sequence; `segmentRngFor(snapshot, actionIndex)` hands a game the byte rng to re-derive the
concrete values (dice, dealt cards). Without a configured `entropy.source` the seed comes from
this device (`provider: crypto`, proof `none`): the commitment still proves nothing changed
mid-hand, but not where the seed came from. **Caveat:** a _playing_ host knows the seed, hence
every future card, for the whole segment. Seeded mode is the safe choice for a dealer-hosted
table (below) and a convenience for a trusted host; otherwise use `per-draw` or `beacon`.
Sync/HMAC/HKDF are implemented in `packages/table/src/kdf.ts` (FIPS 180-4 / RFC 4231 / RFC 5869
vectors in its tests).

**Beacon (future drand round).** `entropy.source` must be a `BeaconSource` (`drandProvider`).
For each drawing command the server computes `round = roundAt(now) + 1` from the chain schedule
(`/{chain}/info`, or the built-in quicknet schedule), assigns a per-table draw `counter`, and
publishes the binding in `entropyAudit.beacon.pending` — a `state` broadcast made before the
round exists anywhere. It then polls `/public/{round}` until the round is published (or
`entropy.beaconTimeoutMs`, default 30 s, elapses → `entropy-unavailable`, binding withdrawn),
expands the randomness with `HKDF-SHA-256(randomness, salt = chainHash, info =
"bgf-beacon/v1|" tableId "|draw:" counter)` and runs the command. The record carries the
drand proof and `beacon: { counter, chainHash, round, committedAt }`. `verifyBeaconRecord`
re-fetches the round, re-expands, re-derives, and (given the schedule) reports whether the
binding was made before the round's publication time. Every draw waits for the next round
(≈3 s on quicknet), so the mode suits dealing more than rapid dice.

**Per-draw** is documented above (one request per drawing command). All three modes attach
records to `actionMeta`; `entropyAudit.mode` says which mode the table runs.

## Dealer mode (a non-playing host)

`TableServer` options `hostSeat: null` (or `TableServer.create` with the same) makes the
hosting device the **dealer**: it takes no seat, holds the authoritative state (it receives the
full snapshot, as the host seat does otherwise), and every player is a guest with a redacted
view. `TableSnapshot.hostSeat` is `null` and `snapshot.dealer` carries the dealer's public
profile; `welcome.seat` is `null` for dealer devices and `TableClientState.role` is
`'dealer'`. The dealer's profile id is recognised from any device (multi-device works as for a
seat, cap 4) and is bound to its key on first use like a seat. Seats learn about dealer
presence through the `dealer { profile, connected }` message (first device connects / last
device leaves); the dealer receives seat presence and previews.

What a dealer may send: `chat` (as `DEALER_SEAT`, −1), `ping`, `bye`, and the command types the
definition lists in `dealerCommands` (OFC: `start`, `settle`, `adjust`; backgammon: none).
Those reach `def.command` with `seat === DEALER_SEAT`; anything else is refused with
`not-seated`, previews included. Resume follows the hidden-information rule: only a device
holding the full copy (the dealer's) can re-host; a guest's view is refused (`host-only-resume`
when offered, `verifySnapshot` throws when tried). A dealer-hosted table is the honest home for
`seeded` randomness: the only party that knows the seed plays no hand. Combined with the Node
runtime it becomes a neutral dealer anyone can run.

**Web app wiring.** Host screens: _Host as dealer (I won't play)_ → `hostSeat: null` through
`hostTable` / `hostNewMatch` (`dealer: true`). `TableClientState.role === 'dealer'` (and the
backgammon `ClientState.role`/`dealer` projection) switches the game screens to a dealer bar
(OFC: start hand / settle / adjust; backgammon: none) and a public view of the table; seats see a
dealer chip / “Dealt by …” badge (`SeatStrip`, rails) and dealer chat as _Name (dealer)_.

**Resilient reopening.** `session/retry.ts` gives `resumeTable` / `resumeMatch` and `joinTable` /
`joinMatch` a shared loop: a stale `address-taken` is retried three times 1.5 s apart before
falling back to joining; `timeout` / `network` / `not-found` retry the whole sequence with backoff
(2 s, 4 s, 8 s, then 10 s) for two minutes, view copies reporting `waiting` and finally
`host-offline`; every flow takes an `AbortSignal` and reports progress. The game screens abort an
attempt when the screen unmounts, on _Retry now_ / _Cancel_, and when a session for the key
becomes live; `SessionRegistry.add` never replaces a live session (a late-completing join is
disposed instead), and resuming a code this tab already hosts returns the existing session.

## Unattended play (autopilot)

The table core never needs a human to drive it. A `GameDefinition` may implement
`autopilot(state, ctx)`; the `TableServer` asks it after every applied action, every readiness
change and every presence change, and does what it says. The answer is an
`AutopilotDecision { command, afterMs?, reason }` or null:

- **Immediate** decisions apply at once as a dealer command (`by: -1`, recorded like any other
  action, same entropy path). The game is asked again afterwards, since one command usually enables
  the next. Decisions must be idempotent: once applied, the same state must yield null.
- **Delayed** decisions (`afterMs`) are scheduled on one timer, announced to every client as
  `autopilot { pending }`, and re-checked when the timer fires (the room may have changed). A
  decision that disappears cancels the timer.
- Nothing runs while a just-in-time draw is in flight; `drain()` re-evaluates afterwards.

It is on for every dealer-hosted table and for player-hosted tables that opted in
(`options.autopilot: true`, the web app's default; **Manual dealing** sets it false). `dealerCommands`
still work as overrides. Decisions and refusals surface through `TableServer.onAutopilot` (the Node
runtime logs them; the console shows them).

**Readiness** is table flow, not game state: a seat sends `{ type: 'ready', ready }`, the table
keeps `snapshot.ready[]`, broadcasts it, and clears it when the game says a round began
(`resetsReadiness(action)`). The autopilot context carries `seatsFilled`, `present`, `ready`,
`dealerPresent`, `now` and the config.

| Game       | State                                             | Decision                                    |
| ---------- | ------------------------------------------------- | ------------------------------------------- |
| OFC        | lobby, all seats taken and present                | `start` (first hand)                        |
| OFC        | showdown, everyone asked to reset                 | `settle` (records the hands, resets scores) |
| OFC        | showdown, `nextHand: 'ready'`, all ready          | `start`                                     |
| OFC        | showdown, `nextHand: 'countdown'`                 | `start` after `nextHandDelayMs`             |
| OFC        | a hand is being set / table over / someone absent | nothing                                     |
| Backgammon | no game yet, both seated and present              | `start-game`                                |
| Backgammon | game over, both ready                             | `start-game`                                |
| Backgammon | match over / game in progress                     | nothing                                     |

OFC's flow options live in `TableConfig.flow` (`startWhenFull`, `nextHand`, `nextHandDelayMs`,
`settleOnConsensus`, `pauseWhenAbsent`); a seat's `settle-request` command is engine state
(`settleRequests[]`, cleared by a settlement), since it is a game concept.

## Rules modes

`MatchConfig.rules` is `'enforced'` (default) or `'free'`. Enforced games move through the
opening → to-roll → moving → … phases and the engine validates every play. Free games sit in a
single `free` phase: either seat may `free-roll`, `free-move` any checker of either colour
(coordinates relative to the moved colour; a lone opposing checker is hit, two or more block),
`free-cube`, `free-reset`, and `free-result` (manual scoring). The same server, client,
transports, persistence and history handle both; the UI switches its interaction model.

## Multi-device seats

A seat is a player, not a connection. `GameServer` keeps a list of live connections per seat
(oldest first, capped at `MAX_CONNECTIONS_PER_SEAT` = 4; the oldest is dropped beyond that). A
hello whose profile id matches a seated player joins that seat's list; a new id takes a free seat;
otherwise the table is full. Every message addressed to a seat reaches all of its devices, and
any device may act. `preview` goes only to the opponent's devices. Presence changes only when a
seat's first device arrives or its last device leaves. A device that arrives with a newer
snapshot (it kept playing while the host copy lagged) still wins the resume merge.

The web app's hand-off link is a join link with `?import=<identity code>` inside the hash
(`#/backgammon/join/CODE?import=p2pi1.…`). The picker imports (or merges) that identity without
showing a form and continues to the join, so the second device takes a second connection on the
same seat.

## Identity and seat authentication

Each player owns an ECDSA P-256 key pair (`packages/protocol/src/identity.ts`; WebCrypto, keys
base64url: raw public point, PKCS#8 private key). `PlayerProfile.publicKey` is the only key
material that ever goes on the wire.

```
client ─hello{profile with publicKey, snapshot?}─▶ server
client ◀─challenge{nonce, matchId}────────────── server
client ─auth{signature over challengeBytes({matchId, profileId, nonce})}─▶ server   (ECDSA/SHA-256)
client ◀─welcome{seat, snapshot}──────────────── server   (or rejected{reason:'unauthorized'})
```

Binding is **trust on first use**: the first hello that takes a seat stores its public key in
`snapshot.players[seat]`. A later hello for that id must present the same key and sign for it;
a different or missing key is refused with `unauthorized`. Legacy records without a key accept
an unkeyed hello and are upgraded by the first keyed one. The snapshot-adoption merge
(`maybeAdopt`) keeps the host copy's roster, so a peer's copy can never replace a bound key.
Unanswered challenges are dropped after `CHALLENGE_TIMEOUT_MS`.

In the web app the private key lives in the profile record (`privateKey`) or, for a
password-locked player, inside `secrets`:

```
secrets: { alg: 'pbkdf2-aes-gcm', salt, iterations: 600000, iv, ciphertext }
   ciphertext = AES-256-GCM( JSON({ privateKey, syncKey }) ), key = PBKDF2-SHA-256(password, salt)
```

Unlocking keeps the plain secrets in `sessionStorage['p2p:unlocked:<slug>']` for that tab only.
`publicProfile()` in `session/session.ts` is the boundary that strips everything but id, name,
avatar and public key before a profile reaches a `GameClient`. Exports, transfer codes and
hand-off codes carry the private key (locked exports carry the encrypted block instead); an
import that brings a different key for an id already stored is refused unless the user confirms.

## Profile sync (device to device)

`apps/web/src/session/sync/` keeps one player's devices in sync without any match server.
Each profile record carries a random `syncKey` (never in `hello`, never in snapshots — the
session layer strips profiles to id/name/avatar). All devices holding the same key meet at the
PeerJS address `sync-<first 24 hex of SHA-256(key)>` under namespace `sync-v1`. The first one
there is the **hub**; the others join it and it relays what it receives, so the topology is a
star. A client that loses its hub retries with backoff (1s → 30s) and races to become the hub.

Handshake, then exchange, then live pushes:

```
sync-hello {profileId, deviceId, deviceLabel, nonce}   both sides, on open
sync-auth  {mac = HMAC-SHA-256(syncKey, peer's nonce)}  both sides verify before anything else
manifest   {profile.updatedAt, settings.updatedAt, matches: {game: [{id, seq, updatedAt}]}}
want       {profile?, settings?, matches: {game: [id]}}  what the receiver is missing or has older
data       {profile?, settings?, matches?}               applied with the merge rules
```

Merge rules: matches by id, higher `seq` wins (equal keeps local); profile name/avatar and the
settings blob are last-write-wins by `updatedAt`; deletions are not synced. Local changes are
coalesced for 250 ms and pushed as `data`; the hub forwards to every other device. A device
arriving with a wrong key fails the MAC check and is dropped. `SyncManager` never throws into
React; status (`off | searching | hub | connected | error`, devices, last sync, last error) is
exposed through `useSyncStatus(slug)`.

## Coordinates (read this before touching board code)

- Engine `Board.points[0..23]` are absolute; index 0 = White's 1-point. `+n` white, `-n` black.
- Moves are **player-relative**: 1..24 from the mover's own home board, 25 = bar, 0 = off.
  `to = from - die`. Use `absIndex(player, rel)` / `relPoint(player, idx)`.
- UI `BoardLocation` uses **absolute point numbers 1..24** (White's numbering). Convert with
  `toRel(player, abs)` / `toAbs(player, rel)` from `board/contract.ts`.
- The frame prints the _viewing player's_ relative numbers; their home board (1..6) is on the
  bottom row. A match has **one table layout**, chosen by the host (`MatchSnapshot.homeSide`,
  the side of the home boards as seen from `hostSeat`, default **left**). The seat across the
  table necessarily sees the mirror image, exactly like a physical board: `sideForSeat(snapshot,
seat)` in `@bgf/protocol` (`homeSideFor(state, seat)` in `@bgf/client`) resolves it.
  - `left`: bottom row reads 1..12 left→right, top row 24..13 left→right (13 top-right,
    24 top-left); tray on the left; checkers travel 24 → 13 → 12 → 1, i.e. clockwise.
  - `right`: the mirror image (1 bottom-right, 24 top-right, tray on the right).
    Settings → "Home board side" is a per-viewer override (`homeSidePreference`: follow the
    table / always left / always right). "Flip board" views from the opponent's chair, so with
    "follow the table" it is a true 180° rotation. The geometry is computed once for home-right
    and mirrored on coordinates (never with an SVG transform, so numbers and dice pips are never
    flipped); see `board/geometry.ts`.

## Message flow

```
client ─hello{profile,snapshot?}─▶ server ─welcome{seat,snapshot}─▶ client
client ─roll / play{play} / double / take / drop / offer-resign …─▶ server
server ─state{snapshot, action, by}─▶ every client (after each accepted action)
client ─preview{play}─▶ server ─preview{seat,play}─▶ other client   (non-authoritative)
server ─presence{seat,connected}─▶ clients   (on connect / disconnect)
client ─chat─▶ server ─chat─▶ clients
server ─error{code,message}─▶ offending client   (rule violations never change state)
```

## Test-id conventions (shared by renderer, screens and e2e)

Board: `board`, `point-<abs>` (1..24), `bar-white` / `bar-black`, `off-white` / `off-black`,
`checker-<id>`, `dice`, `die-<index>`, `cube`, `point-label-<abs>`.
Screens/HUD: `player-name-input`, `host-button`, `join-code-input`, `join-button`, `room-code`,
`start-game-button`, `opening-roll-button`, `roll-button`, `double-button`, `take-button`,
`drop-button`, `done-button`, `undo-button`, `resign-button`, `status-text`,
`score-white`, `score-black`, `pips-white`, `pips-black`, `saved-game-<id>`, `history-list`.

## URL scheme (hash router, static-host friendly)

The player _and_ the game are part of the address. Nothing is ever assumed from a shared
"current profile", and every game hangs off the same player in the same way:

```
#/                                   player picker (who is playing in this tab?)
#/<game>/join/:code                  invite link → picker in "joining" mode (#/join/:code = backgammon)
#/<game>/demo                        that game's playground (no player needed)
#/:profile/                          games hub for that player + matches in progress across games
#/:profile/settings                  player-wide settings (appearance, player, network)
#/:profile/<game>/                   game home (host / join / continue / results)
#/:profile/<game>/host
#/:profile/<game>/join/:code?
#/:profile/<game>/game/:matchId
#/:profile/<game>/history
```

Old addresses without the game segment (`#/steve/host`, `#/steve/game/<id>`, …) redirect to
backgammon. Query `?transport=memory|broadcast|peerjs` overrides the transport (default `peerjs`).

Per-player storage: `bgf:profiles` (slug → id/name/avatar), `bgf:settings:<slug>`. A player can
be moved between browsers (`apps/web/src/session/transfer.ts`): a JSON export
`{ format: 'p2p-gaming-profile', version: 1, profile, settings, matches: { <game>: [snapshots] } }`
or a `p2pg1.<base64url>` transfer code (identity + settings only). Importing keeps the profile
id; matches merge by id, the higher `seq` wins.
Per-player-per-game storage: IndexedDB `p2p-<slug>-<game>` (saved matches); live sessions are
keyed `<slug>:<game>:<matchId>`; PeerJS ids use the namespace `<game>-v1`, so room codes of
different games never collide.

## Node runtime (`@bgf/dealer`)

The table core and the transports are plain TypeScript, so a table can be hosted outside a
browser. `packages/dealer` is a library plus a thin CLI:

- `createDealer({ game, config, seats, code?, dataDir, profile, entropy?, transport?, resume? })`
  loads or creates a keyed profile (`<dataDir>/profile.json`, ECDSA keys from `@bgf/protocol`),
  picks the game definition (`backgammonDefinition`, `ofcDefinition`), builds a `TableServer`
  (`TableServer.create` when a just-in-time entropy source is configured), hosts under the room
  code on a `TransportProvider` (PeerJS by default, namespace `<game>-v1`), persists every
  snapshot atomically to `<dataDir>/tables/<id>.json`, and emits `hosted | seat | action | saved |
stopped | error` events. `resume` reloads a saved host copy (views are refused).
- `bin/dealer.mjs` bundles `src/run.ts` with esbuild on first use (workspace sources are consumed
  directly; `peerjs` and `node-datachannel` stay external) and runs the CLI: `host`, `resume`,
  `list`, `status`, `stop` (a marker file the running process polls).
- PeerJS under Node: `@bgf/transport-peerjs` installs `RTCPeerConnection`, `RTCSessionDescription`,
  `RTCIceCandidate` and `RTCDataChannel` from the optional `node-datachannel/polyfill` when there
  is no `window` (`peerJsProvider({ node })`, `installNodeWebRtcSync()`). The polyfill is loaded
  synchronously through `createRequire` obtained from `process.getBuiltinModule`, so there is no
  Node import for a browser bundler to see and no async gap before the `Peer` is constructed.
  Node 22+ supplies `WebSocket` and `navigator`.
- Seats: the runtime hosts in dealer mode by default (`hostSeat: null`): its profile is recorded
  as the snapshot's `dealer`, it plays no seat, and every seat is filled by guests.
  `--dealer=false` makes it occupy seat 0 instead (a headless player host).
- The same runtime is where the MCP player will live: a `TableClient` with its own identity that
  joins by code and exposes state/legal-moves/play tools to a model.

## Console (`apps/console` + `packages/dealer/src/{manager,console-server}.ts`)

`dealer serve` runs a `DealerManager` (many tables in one process: persisted registry
`tables.json`, `settings.json`, named rule sets in `rulesets/`, an event ring buffer, and a
dealer-side `TableClient` per running table for dealer-only commands) behind a small Node `http`
server. The React console in `apps/console` is built into `packages/dealer/console/` and served
from `/`; live updates arrive over server-sent events.

API (JSON, under `/api`):

| Method             | Path                                       | Purpose                                                                                                              |
| ------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| GET                | `/status`                                  | Process status, dealer profile, masked settings, whether the console is built                                        |
| GET / PUT          | `/settings`                                | Dealer settings (the random.org key is masked on the way out; a masked value on the way in keeps the stored key)     |
| GET                | `/presets?game=`                           | Named starting configurations per game (OFC presets come from `@bgf/ofc-engine`)                                     |
| GET / PUT / DELETE | `/rulesets[/:name]`                        | Named OFC rule sets, validated with `validateTableConfig`                                                            |
| GET                | `/events`                                  | SSE stream of manager events (`created`, `resumed`, `stopped`, `removed`, `seat`, `action`, `error`, `settings`)     |
| GET / POST         | `/tables`                                  | List tables / create one (`game`, `config`, `seats`, `name`, `code`, `entropy`, `randomness`, `fallback`, `options`) |
| GET                | `/tables/:id`                              | Table info with seats, presence, summary, randomness and recent events                                               |
| GET                | `/tables/:id/snapshot`                     | `viewSnapshot(def, snapshot, null)` — the spectator view, never hidden state                                         |
| GET                | `/tables/:id/audit`                        | Public randomness audit (`options.randomness`, `actionMeta`, `entropyAudit`)                                         |
| GET                | `/tables/:id/ledger`                       | OFC balances, unsettled amounts, settlement plan, ledger entries                                                     |
| POST               | `/tables/:id/{resume,stop,remove,command}` | Lifecycle and dealer-only commands (`start`, `settle`, `adjust`)                                                     |

Security boundary: the server binds to loopback unless told otherwise, and any non-loopback bind
requires a bearer token (also accepted as `?token=` for the SSE stream and the audit download).
Only public views leave the process; the dealer's private key and the random.org key never do.
The OFC rules helpers (`RULES_PRESETS`, `validateTableConfig`, `describeRules`) live in
`packages/ofc-engine/src/rules-presets.ts` so the web host screen and the console share them.

Tests: `packages/dealer/test/{manager,console-server}.test.ts` drive the manager and the HTTP API
over the memory transport (including SSE); `apps/console` has component tests with a fake API and
a Playwright smoke that starts a real `dealer serve` with `P2P_DEALER_TRANSPORT=memory`.

## Adding a game

`apps/web/src/games/registry.ts` is the only list the router reads. Open Face Chinese Poker is
the worked example (`apps/web/src/games/ofc/`); it took no changes to the router, the picker,
storage, hand-off, sync or identity.

1. **Rules**: a workspace package with a pure engine and a `GameDefinition` for the table core
   (`packages/ofc-engine` exports `ofcDefinition`: `init`, `validateCommand`, `command`,
   `reduce`, `view`, `viewAction`, `hiddenInformation: true`).
2. **Id**: add it to `GAME_IDS` in `apps/web/src/games/ids.ts` (this also reserves it as a
   profile slug).
3. **Sessions**: `apps/web/src/session/tableSession.ts` hosts, joins and resumes any
   `GameDefinition` on `TableServer`/`TableClient` — `hostTable(def, …)`, `joinTable`,
   `resumeTable`. A game wraps them with its own types (`games/ofc/session.ts`) and gets its
   provider and store with `getProvider(slug, gameId)` / `getSnapshotStore(slug, gameId)`.
   Sessions live in the `SessionRegistry` keyed `<slug>:<game>:<matchId>`; `useSession<T>()`
   returns them typed for the game.
4. **Screens**: `apps/web/src/games/<id>/` with `Home`, `Host`, `Join`, `Game`, `History`,
   optionally `Demo`, exported as a `GameDefinition` from `index.ts`. Screens read their game from
   `useGame()` and their player from `useProfile()`. Provide `describeSaved(snapshot, myId)` so the
   games hub can list the game's saved snapshots without knowing their shape.
5. **Register** it in `GAMES`. The hub card, routes, invite links, storage keys and the PeerJS
   namespace all follow from the definition.

Hidden-information games: the host's devices persist the full snapshot and are the only ones
that can re-host; other seats persist a `view` and `resumeTable` reports `host-offline` while the
host is away. The generic ledger model (`apps/web/src/session/ledger.ts`) is shared: a game maps
its history onto `LedgerLine`s and the `LedgerSheet` shows balances, the settlement plan and a
CSV export.

## Trust disclosure

Server-in-browser is valid for every game. A `GameDefinition` carries
`trust: { hiddenInformation, hostCanSee: string[], notes? }` describing what a hosting device
could read out of its own memory; `describeTrust(def, { hostSeat, randomness })` (`@bgf/table`,
pure) turns that plus the hosting arrangement (`hostSeat: null` = dealer) and the declared
randomness mode/provider into `{ level: 'open' | 'host-sees-hidden' | 'dealer', title, details }`.
`TableServer` writes the description into `TableSnapshot.options.trust` at creation (and fills
it in when an older snapshot is resumed) so every seat reads the same text. The web app shows
a `trust-panel` on both host screens (live with the dealer/randomness choices), a `trust-badge`
on the join screens (definition-level: what a player-hosted table implies) and in the game
rails (from the snapshot), and the dealer console shows the panel for the dealer case. Nothing
in the session layer or the core refuses a player host for a hidden-information game.

## The platform runtime (separate repository)

A club has to run somewhere. That runtime — the roster and signed chip ledger, dealer-mode
tables, the member channel, chip purchases, the operator console API — is **not in this
repository**. It is where chips are minted and rake is enforced, and those rules are kept by
distribution rather than by trusting operators, so it ships separately.

What that leaves here is the whole client side of the design, and the specification itself:

| Here                                                             | Not here                                     |
| ---------------------------------------------------------------- | -------------------------------------------- |
| `@bgf/club-spec`: what a club is, plus the conformance suite     | The platform's hosting, purchases, operators |
| `@bgf/club`: the reference implementation and the channel client | The house club and its matchmaking policy    |
| Engines, table core, transports, web app, Node dealer, soak      | The platform's store and HTTP API            |

The seam is clean by construction, and worth keeping that way: **nothing in this repository
imports the platform.** The console's platform pages mirror its types rather than importing
them, so the browser bundle never pulls it in, and `pnpm soak --club` / `--lobby` shell out to
its binary when a workspace has both checked out and print an explanation when it does not.

Anyone may write their own runtime instead. Implement `ClubApi`, declare capabilities and
custody honestly, run `runClubConformance` against it, and the browser app talks to it
unmodified — it reads what a club declares and adapts, down to telling players who holds their
chips before they join.

## Clubs (web)

The browser side of clubs lives in `apps/web/src/clubs/` and talks the club channel contract in
`packages/protocol/src/club.ts` over any `Transport` (PeerJS namespace `club-v1`; the club's
address is its id). `ClubClient` runs the keyed hello → challenge → auth handshake, then the lobby
protocol (`lobby`, `sit`, `leave`, `statement`, `transfer`, `request-chips`, `chat`). Routes:
`#/:profile/clubs` (joined clubs, join by invite), `#/:profile/club/join/:token` (decode the invite,
connect, remember the club), `#/:profile/club/:clubId` (lobby); the profile-less `#/club/join/:token`
goes through the player picker. Joined clubs are stored per player in `bgf:clubs:<slug>`.

`ClubRegistryProvider` keeps club connections alive across routes (a live session is never replaced
by a late reconnect, mirroring the table registry). Sitting stores the seat the club hands out and
navigates to the game's join route with `?club=<id>&table=<id>`; `ClubChip` reads that context on
join and game screens to show balance, stack and the way back. `FakeClubClient` implements the same
`ClubClientApi` for component tests and, in development builds only, the `?fakeclub=1` flag so the
screens can be walked without a club runtime.
