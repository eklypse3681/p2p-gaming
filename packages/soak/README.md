# @bgf/soak

Bots that play whole sessions through the **real** table server, over any transport, and check
the invariants that matter: every hand zero-sum, the host log replays, guest views never leak
hidden cards, and no bot command is ever refused by the rules.

```sh
pnpm soak --game ofc --variant pineapple27 --seats 3 --hands 200
pnpm soak --game backgammon --games 50
pnpm soak --game ofc --provider peerjs --dealer runtime --code ABC123   # join a table that is already running
pnpm soak --game ofc --entropy drand --randomness beacon --hands 20     # real beacon randomness
```

The CLI exits non-zero when an invariant fails, so it doubles as a CI check. `--json` prints the
full report. `--seed N` makes the bots and (with crypto entropy) the table deterministic.

## What runs

- `runSoak(options)` hosts a **dealer-mode** `TableServer` in-process over the memory transport
  (`--dealer inline`), or joins an existing table by room code over memory or PeerJS
  (`--dealer runtime`). Seats are filled with participants; the table's own autopilot deals and
  moves between hands, exactly as an unattended club table would.
- `createParticipant({ provider, code, game, bot })` is a bot at a seat: it joins by code with a
  fresh keypair, answers the seat challenge, acts whenever its bot returns a command, presses
  Ready after a hand or game, and records everything it saw. It knows nothing about the UI or
  the transport, so the same participant can sit at a browser-hosted table, a Node dealer, or a
  club room.
- Bots are pure functions from game state to command:
  - `ofcBot(state, seat)` enumerates placements (subsets × rows), scores them with the engine's
    evaluators, royalties and foul rules, keeps the 2-7 middle low, chases Fantasyland when the
    other rows can carry it, and searches Fantasyland sets for the best non-fouling hand.
  - `backgammonBot(match, player)` picks among the engine's legal plays (hits, points, bear-offs,
    exposure), doubles when well ahead, takes when not too far behind.

## Report

Per seat: score, fouls, royalties, Fantasyland entries (and 15-card double entries), stays,
commands, errors. Table: hands or games, wall time, actions, average hand time, provider and
randomness mode. Invariants: zero-sum hands, point conservation, host replay, view redaction,
no rule errors, target reached. Backgammon adds singles/gammons/backgammons and cube usage.

## In tests

`runSoak` is plain TypeScript, so a test can assert a 30-hand session in a few seconds:

```ts
const report = await runSoak({
  game: 'ofc',
  variant: 'pineapple27',
  seats: 3,
  hands: 30,
  seed: 42,
});
expect(report.ok).toBe(true);
```

## Club mode

`pnpm soak --club --members 3 --hands 50 [--variant pineapple27] [--json]` hands over to
The platform runtime's club soak (not in this repository): a hosted club in this process (dev purchase, invited bot members,
grants, buy-ins, a real dealer-mode table, rake, cash-outs, restart from the store) with every
chip invariant asserted. The bots are the same participants as here, paced through a timer
(`actDelayMs`) so ledger signing gets its turn on the in-memory transport. See
the platform runtime.
