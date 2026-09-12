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

## Moving to another browser

Players live in the browser, so to play as yourself somewhere else, move the player: Settings →
**Export player…** downloads `p2p-gaming-<player>.json` (identity, settings, saved matches), or
**Copy transfer code** gives a short `p2pg1.…` string with just the identity and settings. On the
other browser open the player picker, choose **Import a player**, and pick the file or paste the
code. The player keeps the same id, so matches saved with them can be resumed there. The two
copies then keep separate histories.

## Move to another device

Every match screen has a **Move to another device** panel with a QR code. Scan it with your
phone (or copy the link) and the match opens there *as you*: the link carries your identity, so
there is nothing to pick or type. Both devices share your seat and stay in sync over the same
peer-to-peer connection until you close one of them. A player may have up to four devices
connected at once. If the device you leave was hosting the table, the remaining device offers
to reconnect and takes the hosting over.

## Toolchain

TypeScript 7 (native compiler) for `tsc`, with the TypeScript 6 API package aliased as
`typescript` so typescript-eslint keeps working (the setup recommended in the TS 7 release
notes). Vite 8, Vitest 5, Playwright, React 19, react-router 8, motion 13, ESLint 10, pnpm.

## Scripts

| Command          | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm dev`       | Vite dev server for the web app                                     |
| `pnpm build`     | Production build (static files; deploy anywhere, e.g. GitHub Pages) |
| `pnpm test`      | Unit + component tests for every package (Vitest)                   |
| `pnpm test:e2e`  | Playwright end-to-end tests (host + guest in one browser)           |
| `pnpm typecheck` | TypeScript project references build                                 |
| `pnpm lint`      | ESLint                                                              |
| `pnpm check`     | typecheck + lint + unit tests                                       |

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

## Roadmap

- **Discord signalling and voice**: a `TransportProvider` that exchanges WebRTC offers/answers
  through a Discord channel (bot token kept client-side by the host) instead of PeerJS, and an
  in-browser voice channel using the same peer connection.
- **Fair dice**: commit-reveal dice where both peers contribute entropy (the `DiceSource`
  interface already isolates dice generation from the server).
- **3D renderer**: a second implementation of `BoardRendererProps` (react-three-fiber) selectable
  in Settings; themes already separate board sets and piece sets.
- **Spectators**, match replay from the action log, analysis (pip-count deltas, blunder marks).
