# P2P Gaming

Serverless, peer-to-peer backgammon for two named players. No backend, no accounts, nothing to
pay for: the **host's browser runs the game server**, the guest connects directly over WebRTC
(signalled through the free PeerJS cloud), and both players' browsers keep the match so it can be
paused and resumed later from either side.

- Full rules: bar, hitting, bearing off (exact / higher-die), must-use-both-dice and higher-die
  rules, doubling cube with ownership, Crawford rule, Jacoby rule (money play), gammons and
  backgammons, resignation at single/gammon/backgammon stakes, match play to any length.
- Two ways to play: **Enforced** (the engine allows only legal moves, dice and turn order) or
  **Free board** (a physical board: drag any checker anywhere, roll whenever you like, set the
  cube by hand, record the result to keep score; blots are hit, made points block the drop).
- Point tracking: match score, cube, pip counts, per-game results, lifetime head-to-head history.
- Pause and resume: every snapshot is persisted in both browsers (IndexedDB). Either player can
  reopen the match later; whoever opens first hosts, the other joins, and the newest state wins.
- One client, many transports: the same UI runs as host and guest; in-memory (hotseat/tests),
  cross-tab (`BroadcastChannel`, used by the end-to-end tests) and PeerJS/WebRTC transports are
  interchangeable.
- Make it yours: combine a UI look (light or dark), a board set (walnut, slate, cherry, oak,
  carbon, teak) and a piece set (ivory, pearl, sky blue, ruby, jade, amber, rose gold) per
  player, or pick a named preset.
- Built to grow: renderer contract (2D SVG today, 3D later), data-driven themes / piece sets /
  board sets, injectable dice source (commit-reveal fairness protocol later), transport provider
  interface (Discord-based signalling later).

Works on desktop and phones (portrait and landscape) with mouse or touch. The host lays out
the table with the home boards on their left (1 bottom-left, 24 top-left; the default) or right;
the opponent sees it from across the table, and Settings can force a side for yourself.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design.

## Quick start

```sh
pnpm install
pnpm dev            # http://localhost:5173
```

1. Pick or create a player. The address bar then shows who you are: `#/steve/…`.
2. Pick a game from the hub (`#/steve/backgammon/`), click **Host a match**, choose the length
   and table layout, and share the room code or link.
3. Your opponent opens the link (or enters the code), picks their player, and joins.
4. Play. Close the tab whenever you like; the match appears under **Continue** for both of you.

Try it alone: host as one player, then open a second tab, pick (or create) another player and join
with the code. Each tab is its own player, with its own settings and saved matches.
`?transport=broadcast` (offline, same browser) and `?transport=memory` exist for tests.

## Who you are

Every player owns a cryptographic key pair, made in the browser the first time the player is
used. Opponents see your name, avatar and **public** key; the private key never leaves your own
devices. When you sit down at a table, the host's server binds your public key to your seat, and
from then on a device can only claim that seat by signing the server's challenge with the private
key — whoever runs the server. Knowing someone's id is not enough to play as them.

Your hand-off QR, transfer code and export file carry the private key (that is what makes "scan
to become me" work), so treat them like a password. Settings → Player → **Password** adds an
optional lock: the keys are then stored encrypted (PBKDF2 + AES-GCM) and every tab must enter
the password before playing as, exporting or handing off that player. **Lock now** forgets the
password in the current tab; exports of a locked player carry the encrypted keys and ask for
the password on import.

## Moving to another browser

Players live in the browser, so to play as yourself somewhere else, move the player: Settings →
**Export player…** downloads `p2p-gaming-<player>.json` (identity, settings, saved matches), or
**Copy transfer code** gives a short `p2pg1.…` string with just the identity and settings. On the
other browser open the player picker, choose **Import a player**, and pick the file or paste the
code. The player keeps the same id, so matches saved with them can be resumed there. The two
copies then keep separate histories.

## Move to another device

Every match screen has a **Move to another device** panel with a QR code. Scan it with your
phone (or copy the link) and the match opens there _as you_: the link carries your identity, so
there is nothing to pick or type. Both devices share your seat and stay in sync over the same
peer-to-peer connection until you close one of them. A player may have up to four devices
connected at once. If the device you leave was hosting the table, the remaining device offers
to reconnect and takes the hosting over.

## Sync between your devices

Open the same player on two devices and they find each other and stay in sync — settings,
name, avatar and every saved match — directly over WebRTC, with no server in between. It runs
whenever the app is open on that player on both devices; a device that was away catches up the
next time both are open. Matches merge by id with the higher sequence number winning, settings
and profile are last-write-wins.

Devices recognise each other with a per-player **sync key**. It travels only inside your own
export file, transfer code and hand-off QR, and is never sent to opponents. Settings → Devices
shows the current state, lets you switch sync off for a player, and can rotate the key if a code
was exposed (other devices then need a fresh code from you).

## Open Face Chinese Poker

The second game on the same table core. Two or three players; the host's browser deals from a
secret deck and every other seat receives only what it may see.

- **Variants**: classic OFC (one card a turn after the first five), Pineapple (three cards a
  turn, set two, discard one) and Pineapple 2-7 (the middle row scored deuce-to-seven; a ten-low
  or better avoids a foul). Fantasyland with QQ/KK/AA entry, flat or progressive card counts,
  Super Fantasyland, and configurable stay conditions.
- **Your rules**: the host screen has presets to start from and an editor for every number:
  royalty tables per row, Fantasyland thresholds, foul qualifier, buy-in or count-up scoring, the
  money-per-point multiplier. The whole rule set is plain JSON you can copy to a friend, and
  named rule sets are saved per player.
- **Ledger**: every hand records who paid whom in points; the ledger shows balances, the
  cheapest set of payments to settle, adjustments with a note, and a CSV export. "Settle up"
  records the payments and returns everyone to the buy-in (or zero).
- **Resume**: the host re-opens a table from its full copy; other seats hold only their own view
  and rejoin when the host is back.

Try the table without a match at `#/ofc/demo`.

## Who can see what

Any game can be hosted in a player's browser, hidden information or not. Each game declares
what a hosting device is able to see, and the app says so plainly before you create a table,
before you join one, and in the table's rail (the trust badge; tap it for the details):

| Badge                         | Meaning                                                                                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open information**          | Nothing is hidden from anyone (backgammon).                                                                                                                                                                                                    |
| **Host can see hidden cards** | The host's browser runs the table, so its memory holds the other players' un-placed cards, Pineapple discards and face-down Fantasyland hands. The host's screen never shows them; reading them takes deliberate snooping. Fine among friends. |
| **Dealer-hosted**             | The hosting device takes no seat, so no player at the table can see another player's hidden cards.                                                                                                                                             |

The badge also states how randomness is drawn: per-draw and beacon modes never let anyone,
host included, know a card or roll early; seeded mode lets a _playing_ host know the current
hand's seed (safe with a dealer). Nothing restricts who may host; people pick the tables they
are comfortable with.

## Randomness

Dice and shuffles come from one of three sources, chosen by the host when the table is created:

- **This device** (default): `crypto.getRandomValues`. Fast, private, unverifiable.
- **random.org (signed)**: every draw is a `generateSignedIntegers` request made _at the moment
  a roll or deal happens_, never earlier. The response's signed `random` object, its signature,
  the serial number and the remaining quota are recorded with the action. Needs a free
  random.org API key, which lives only in the host's browser and is never sent to other players
  (the free tier is limited to a daily budget of bits and requests; a backgammon roll costs 64
  bytes, an OFC deal a few hundred).
- **drand** (League of Entropy beacon): a public, signed random value every few seconds. The host
  fetches a round when a draw happens and expands it with HKDF-SHA-256 into the bytes it
  needs; the round, randomness, signature and derivation context are recorded. No key needed.
  In _beacon_ mode (below) the table commits to the _next_ round before it exists, so the host
  cannot wait for a round it likes.

What every seat receives with each action that used randomness: the source, the exact bytes
consumed, the sequence of draws made from them (`int(n)` bounds and results), and the proofs.
A verifier can (1) ask random.org `verifySignature` or re-fetch the drand round, (2) recompute
the bytes the proof attests to, (3) re-derive the draws with the documented derivation, and (4)
map the draws onto the action (a backgammon die is a draw of 6 plus one; a shuffle is a
Fisher–Yates over consecutive draws). `@bgf/entropy` exposes `verifyEntropyRecord`,
`deriveDraws` and `checkSerials` (which flags random.org serial-number gaps between a table's
draws, the fingerprint of a host re-requesting until they liked the result).

Independently of the source, the host picks one of three **modes**:

- **Per draw** (default): every roll or deal makes its own request at the moment it happens.
  Nobody, the host included, knows a value before its time. The host is also a player, which is
  why nothing is fetched ahead: any bytes fetched early would be readable by the host before the
  next deal. If the source is down the command is refused with `entropy-unavailable` (unless the
  table was created with the explicit fallback to this device, which is then flagged), and
  other commands queue behind an in-flight draw.
- **Seeded** (commit and reveal): at the start of every hand (OFC) or game (backgammon) the
  table takes one seed from the source, publishes its hash before any card is dealt, derives
  every draw of the hand from it, and reveals the seed at showdown. One proof per hand, and
  anyone can recompute the whole deal offline from the seed. The party holding the seed knows
  the hand in advance, so this mode is meant for a **dealer-hosted** table (a host that plays
  no seat) or a trusted host. It also works with this device as the seed source.
- **Beacon**: every draw is bound to the _next_ drand round, announced to all seats before that
  round is published, then derived from it once it arrives (about three seconds). Nobody can
  know a value in advance, and the binding time is on record.

**Dealer**: a table can be hosted by a device that plays no seat. The dealer holds the deck,
starts hands, settles the ledger, and sees only public information on its own screen; every
player is a guest. It is the natural partner for seeded randomness and for the Node runtime.

## Playing with a dealer

A table does not need one of its players to run it. On either host screen, tick **Host as
dealer (I won't play)**: your device then deals, keeps the ledger and relays, and every seat is
filled by the players who join. The dealer's screen shows the table from the outside (public
view only), with a dealer bar — for OFC: _Deal first hand / Next hand_, _Settle_, _Adjust_; for
backgammon nothing to press, the players start and roll — plus _Fairness_ and _Leave_. Guests
see “🎩 Dealt by …” on their seat strip and in the table rail. Only the dealer's own devices
can reopen a dealer-hosted table (they hold the full copy); guests rejoin when it is back.

A dealer is the honest home for **seeded** randomness: the only party that knows the seed plays
no hand. The same thing runs headless from a terminal — see _Running a dealer from a terminal_.

## Unattended tables

A table runs itself; nobody has to "deal". It reacts to what the players do:

- **First hand / game**: dealt the moment every seat is taken and everyone is connected.
- **Next hand**: Open Face tables deal again when every player has pressed **Ready** (or, if the
  rules say so, after a countdown that pauses while someone is away). Backgammon starts the next
  game when both players are ready. The Ready buttons and everyone's state sit under the showdown /
  game-over panel.
- **Reset scores**: press **Reset scores**; when every seated player has asked, the table records the
  hands played so far and zeroes the scores (or puts everyone back to the buy-in). "Who owes whom",
  an immediate settlement and manual adjustments still exist under **Advanced** on the score sheet
  for tables that keep real accounts.
- **Absent players**: nothing happens while a seated player has no device connected.

A dealer-hosted table (a terminal `dealer`, the console, or "Host as dealer" in the app) is always
unattended. A player-hosted table is unattended too unless you tick **Manual dealing** when you
create it, which brings back the Deal / Next hand / Start game buttons. Dealers keep a small
**Advanced** menu with "Deal now" / "Start now" overrides.

The rules editor's **Table flow** group sets these per table: deal when full, next hand on Ready or
after a countdown (and its length), reset on consensus.

## Checking fairness

Every table shows where its randomness came from. In **Settings → Randomness** you choose the
defaults for the tables you host — the source (_This device_, _random.org_ with a free API key,
or the _drand_ beacon) and the mode (_Per draw_, _Seeded_, _Beacon_) — with a plain-language
note on which combinations are safe when the host also plays (per draw and beacon) and which
need a dealer (seeded). The host screen shows the choice as a chip and lets you change it for
one table; a _fallback_ toggle decides whether a roll is refused or served from this device
(and flagged) when the oracle is unreachable.

During and after a game, the **Fairness** button in the rail (and in History) opens a panel
listing every draw — what it was for, the values, the proof kind, the random.org serial number
or drand round — with _Verify_ per draw and _Verify all_. Verification runs in your browser:
random.org signatures are checked with random.org's `verifySignature`, drand rounds are
re-fetched and re-expanded, seeded segments are re-derived from the revealed seed against the
published commitment. Serial-number gaps between a table's random.org draws are flagged (the host
made requests that are not on this table). _Download audit JSON_ saves the public audit for
anyone to check later. Tables on “This device” randomness say so: nothing to verify there.

## Toolchain

TypeScript 7 (native compiler) for `tsc`, with the TypeScript 6 API package aliased as
`typescript` so typescript-eslint keeps working (the setup recommended in the TS 7 release
notes). Vite 8, Vitest 5, Playwright, React 19, react-router 8, motion 13, ESLint 10, pnpm.

## Scripts

| Command          | What it does                                                                        |
| ---------------- | ----------------------------------------------------------------------------------- |
| `pnpm dev`       | Vite dev server for the web app                                                     |
| `pnpm build`     | Production build (static files; deploy anywhere, e.g. GitHub Pages)                 |
| `pnpm test`      | Unit + component tests for every package (Vitest)                                   |
| `pnpm test:e2e`  | Playwright end-to-end tests (host + guest in one browser)                           |
| `pnpm typecheck` | TypeScript project references build                                                 |
| `pnpm lint`      | ESLint                                                                              |
| `pnpm check`     | typecheck + lint + unit tests                                                       |
| `pnpm soak`      | Bots play whole sessions through the real table server (`--club` for a hosted club) |

## Repository layout

```
packages/engine            pure rules engine (no dependencies)
packages/protocol          transport interface, messages, memory + BroadcastChannel transports
packages/server            GameServer (runs in the host's browser)
packages/client            GameClient + turn drafting + selectors + MatchStore interface
packages/transport-peerjs  PeerJS / WebRTC transport provider
apps/web                   React 19 + Vite app: player picker, games hub, settings, e2e tests
apps/web/src/games/        one folder per game (backgammon today); see ARCHITECTURE "Adding a game"
```

## Networking notes

The free PeerJS cloud only does signalling; media flows peer-to-peer. There is no TURN relay,
so two players behind strict symmetric NATs may fail to connect. Settings lets you point at a
self-hosted [PeerServer](https://github.com/peers/peerjs-server) and add your own STUN/TURN
servers. Room codes map to PeerJS ids as `bgf-<code>-v1`.

## Running a dealer from a terminal

A table does not have to be hosted by a browser. `@bgf/dealer` is a small Node runtime that hosts
a backgammon or Open Face Chinese Poker table from a terminal over the same PeerJS transport the
web app uses (WebRTC from Node via the optional `node-datachannel` package, Node 22+):

```sh
pnpm install
pnpm exec dealer host --game ofc --rules my-rules.json --seats 3
#   Room code:    Q7XK2M
#   Invite link:  https://eklypse3681.github.io/p2p-gaming/#/ofc/join/Q7XK2M
```

Players open the invite link (or enter the code) in the web app as usual. Other commands:
`dealer resume <code>` re-hosts a saved table, `dealer list`, `dealer status <code>`, and
`dealer stop <code>` asks a running dealer to save and exit. Data lives in `~/.p2p-dealer`
(`--data DIR` or `P2P_DEALER_DATA`): `profile.json` holds the dealer's keyed identity,
`tables/<id>.json` the full table snapshot after every action (atomic writes, so a crash never
leaves a half-written table).

Randomness: `--entropy crypto` (default), `--entropy random.org --api-key KEY` (or
`RANDOM_ORG_API_KEY`; one signed request per deal or roll), or `--entropy drand`. Add
`--fallback` to keep playing on this machine's generator if the oracle is unreachable (the audit
flags those draws). `--app-url` changes the base of the invite link for a self-hosted copy.

Two things to know. The terminal holds the full state of a hidden-information game (the deck,
face-down hands), so it must stay up during a hand — `dealer resume` picks up where it left off
if it does not. And the dealer plays no seat: every seat is filled by players who join, which is
what makes a neutral host possible for card games (`--dealer=false` makes it occupy seat 0
instead). The same runtime is the basis for the MCP player, which will join a table with an
identity of its own and play a seat.

## Dealer console

The dealer runtime has its own web console, served by the runtime itself, for setting up hosts,
games and rule sets from a browser instead of the command line:

```sh
pnpm build:console          # once, builds the console into packages/dealer/console
pnpm dealer serve --open    # http://127.0.0.1:7777
```

What it does:

- **Tables** — every table this dealer hosts, with status, seats, scores; open, stop, resume or
  remove them. Stopped tables keep their saved state and resume under the same room code.
- **New table** — pick the game, then either a preset or the full rule set: for backgammon the
  match length, Crawford/Jacoby, enforced or free board and the home side; for Open Face Chinese
  Poker the same editor as the web app (variant, seats, scoring mode, buy-in, multiplier, every
  royalty, Fantasyland entry/cards/stay rules, the 2-7 qualifier) plus a JSON view to paste or
  copy and named rule sets stored in the dealer's data folder. Then the hosting options: table
  name, room code, randomness source (this machine, random.org, drand) and mode (per draw,
  seeded, beacon).
- **Table** — invite link and QR code, seats with presence and device counts, a live event log
  (server-sent events), the game summary, and dealer actions for OFC: deal the next hand, settle
  the ledger (with the who-pays-whom plan), adjust a balance. The randomness panel names the
  source and mode and offers the public audit JSON for download.
- **Settings** — dealer name, web app URL for invite links, default randomness source and mode,
  the random.org API key (kept in the data folder, masked in the UI), console token.

The console binds to `127.0.0.1` by default. To reach it from another machine start it with
`dealer serve --host 0.0.0.0 --token <secret>` (or set the token in Settings first); the console
asks for the token and sends it with every request. The API only ever serves public views of a
table — the deck and face-down hands never leave the process — and the API key is never returned.

Tables created here run in the `dealer serve` process; `dealer serve --resume-all` brings back
every table that was running when the process last stopped.

## Soak testing

`pnpm soak` plays whole sessions with bots through the real table server and checks the
invariants: every hand zero-sum, the host's action log replays to the same state, guest views
never leak hidden cards, and the rules never refuse a bot. It runs unattended, like a club table.

```sh
pnpm soak --game ofc --variant pineapple27 --seats 3 --hands 200
pnpm soak --game backgammon --games 50
pnpm soak --game ofc --provider peerjs --dealer runtime --code ABC123   # bots join a running table
```

A non-zero exit means an invariant failed. `runSoak()` and `createParticipant()` from
`@bgf/soak` do the same from tests, and the participants are transport-agnostic, so the same
bots can sit at browser-hosted tables, the Node dealer, or club rooms. See
[packages/soak/README.md](./packages/soak/README.md).

## The platform runtime

A club needs somewhere to run: something that holds the roster and the signed chip ledger, deals
tables unattended, serves the lobby members connect to, and gives owners a console. That runtime
is **not in this repository**. It lives separately because it is where chips are issued and rake
is enforced, and those rules are kept by distribution rather than by asking operators to be
honest.

What is here is everything needed to play, to implement a club, or to run your own:

- `@bgf/club-spec` — what a club **is**: the operations, the capabilities an implementation
  declares, who holds the chips, how chips are staked and settled, and a conformance suite of
  checks any implementation runs to prove it is legal.
- `@bgf/club` — the reference implementation, which passes that suite, plus the client side of
  the club channel that the web app speaks.
- Everything else: the games, the table core, the transports, the browser app, the personal Node
  dealer and the soak.

So a club is an interface, not a product. Write your own runtime against the specification, run
the conformance suite against it, and the browser app will talk to it unmodified — it reads what
a club declares and adapts, and it tells players who holds their chips before they join.

`pnpm soak --club --members 3 --hands 50` (which needs a platform runtime alongside) runs a
whole club in one process (dev purchase, bot
members, a real dealer-mode table, rake, cash-outs, restart from the store) and asserts every
chip invariant.

## Roadmap

- **Discord signalling and voice**: a `TransportProvider` that exchanges WebRTC offers/answers
  through a Discord channel (bot token kept client-side by the host) instead of PeerJS, and an
  in-browser voice channel using the same peer connection.
- **Fair dice**: commit-reveal dice where both peers contribute entropy (the `DiceSource`
  interface already isolates dice generation from the server).
- **3D renderer**: a second implementation of `BoardRendererProps` (react-three-fiber) selectable
  in Settings; themes already separate board sets and piece sets.
- **Spectators**, match replay from the action log, analysis (pip-count deltas, blunder marks).

## Clubs

A club has a name, a member list, house chips and rooms of tables, and it runs on a runtime
that implements the club specification (see _The platform runtime_ above). Joining one from the
browser:

1. Open **Clubs** (`#/<player>/clubs`) and paste the invite link or token the club sent you
   (scanning its QR opens the same `#/club/join/<token>` link). Your player's key is what the club
   remembers; a pending membership shows as such until an admin approves it.
2. The **lobby** (`#/<player>/club/<id>`) shows your chip balance, each room's table templates
   (game, rules, seats, chips per point, buy-in), the tables currently open, chat, and your
   **statement** (every ledger entry that touched your account, with the club-signed ledger head).
3. **Sit** at an open table or open one from a template. The club moves your buy-in onto the table
   and hands you the room code; you join it exactly like any other table, with a club chip on the
   game screen showing your balance and stack and a way back to the lobby. Chips move back at
   cash-out and results settle into your balance.
4. Transfer chips to another member or request chips from the house from the lobby.

Clubs you joined are remembered per player; the club connection stays open while you play.
