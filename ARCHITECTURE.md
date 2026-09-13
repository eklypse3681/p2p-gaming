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

## Adding a game

`apps/web/src/games/registry.ts` is the only list the router reads. To add a game:

1. Add its id to `GAME_IDS` in `apps/web/src/games/ids.ts` (this also reserves it as a profile
   slug).
2. Create `apps/web/src/games/<id>/` with the screens it needs (`Home`, `Host`, `Join`, `Game`,
   `History`, optionally `Demo`) and export a `GameDefinition` from `index.ts`. Screens read their
   game from `useGame()` (`path('/host')`, `routes.game(id)`) and their player from
   `useProfile()`; they get their saved-match store with `getMatchStore(slug, gameId)` and their
   transport with `getProvider(slug, gameId)`.
3. List the definition in `GAMES`. The hub card, the routes, the invite links, storage keys and
   the PeerJS namespace all follow from the definition.

Game logic belongs in its own workspace packages (as `@bgf/engine` / `@bgf/server` /
`@bgf/client` do for backgammon); the transports and the web shell are shared.
