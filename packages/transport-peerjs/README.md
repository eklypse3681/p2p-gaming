# `@bgf/transport-peerjs`

WebRTC implementation of the `@bgf/protocol` `TransportProvider`, built on
[PeerJS](https://peerjs.com) 1.5.x. The host registers a peer id derived from the room code on a
signalling server (the free PeerJS cloud by default); the guest connects straight to that id and
everything afterwards travels over a reliable data channel — no backend of ours anywhere.

```ts
import { peerJsProvider } from '@bgf/transport-peerjs';

const provider = peerJsProvider();

// Host
const listener = await provider.host('ABCD');
listener.onConnection((transport) => server.attach(transport));

// Guest
const transport = await provider.join('ABCD', { timeoutMs: 15_000 });
```

## Exports

| Export                        | Notes                                                     |
| ----------------------------- | --------------------------------------------------------- |
| `peerJsProvider(options?)`    | Returns a `TransportProvider` named `'peerjs'`            |
| `peerIdFor(code, namespace?)` | The signalling id a room code maps to                     |
| `isWebRtcSupported()`         | Synchronous capability probe; `false` in Node             |
| `PeerJsProviderOptions`       | Option type (below)                                       |
| `DEFAULT_NAMESPACE` `'v1'`    | Default id namespace                                      |
| `DEFAULT_TIMEOUT_MS` `15000`  | Default `join` timeout                                    |
| `DEFAULT_KEEPALIVE_MS` `5000` | Default keepalive period                                  |
| `KEEPALIVE_MAX_MISSED` `3`    | Unanswered pings before the transport closes              |
| `EXTRA_ICE_SERVERS`           | The public STUN servers added on top of PeerJS's defaults |

PeerJS itself is imported lazily (`await import('peerjs')` inside `host`/`join`), so importing this
package in Node — unit tests, SSR, tooling — never touches `window` or `navigator`.

## Id scheme

```
peerIdFor(code, namespace) === `bgf-${code.toLowerCase()}-${namespace}`   // default namespace: 'v1'
```

The room code alone is not enough on the **shared** public cloud: every deployment in the world
registers into the same id space, so two unrelated apps using the code `ABCD` would fight over one
id (the loser gets `unavailable-id`). The `bgf-` prefix plus the namespace keeps collisions to
codes issued by this app. Bump `namespace` (e.g. `'v2'`, `'staging'`) whenever a deployment must not
share ids with existing clients — peers on different namespaces simply cannot see each other.

## Options

All optional.

| Option        | Default                          | Meaning                                                      |
| ------------- | -------------------------------- | ------------------------------------------------------------ |
| `host`        | PeerJS cloud (`0.peerjs.com`)    | Signalling host                                              |
| `port`        | `443`                            | Signalling port                                              |
| `path`        | `/`                              | Path of a self-hosted PeerServer                             |
| `secure`      | PeerJS default (`true` on cloud) | Use TLS                                                      |
| `key`         | PeerJS default (`peerjs`)        | PeerServer API key (cloud only)                              |
| `debug`       | `0`                              | PeerJS log level, `0`–`3`                                    |
| `iceServers`  | see below                        | **Replaces** the ICE server list entirely                    |
| `namespace`   | `'v1'`                           | Id namespace, see above                                      |
| `keepaliveMs` | `5000`                           | Application-level keepalive period; `0` disables it          |
| `timeoutMs`   | `15000`                          | Default `join` timeout (the per-call `opts.timeoutMs` wins)  |
| `peerOptions` | `{}`                             | Raw PeerJS `PeerOptions`, merged **last** — the escape hatch |

### Errors

Failures surface as `TransportError` from `@bgf/protocol`:

| Situation                                     | Code            |
| --------------------------------------------- | --------------- |
| Host id already registered (`unavailable-id`) | `address-taken` |
| No peer under that id (`peer-unavailable`)    | `not-found`     |
| Data channel did not open inside `timeoutMs`  | `timeout`       |
| Signalling/server/socket failures             | `network`       |
| Channel closed while `join` was still waiting | `closed`        |
| `browser-incompatible`, PeerJS unloadable     | `unsupported`   |

## Connection liveness

WebRTC can take a long time to admit that the far side disappeared (laptop lid closed, tab killed,
network gone), and the `close` event may never arrive at all. On top of PeerJS's own
`close`/`error` events, each transport therefore runs an application-level heartbeat:

- every `keepaliveMs` it sends `{ __ka: 1 }` (a ping);
- a peer that receives a ping answers `{ __ka: 2 }` — **even if its own keepalive is disabled**;
- after `KEEPALIVE_MAX_MISSED` (3) unanswered pings the transport closes with status `closed` and
  reason `'timeout'`, so the UI can show "opponent disconnected" ~20 s after the last reply;
- envelopes carrying a `__ka` property are filtered out and never reach `onMessage`.

Set `keepaliveMs: 0` to turn the heartbeat off (e.g. when a higher layer already pings).

## Free PeerJS cloud: the caveats

The default configuration uses the free cloud broker at `0.peerjs.com` for signalling and public
STUN servers for NAT traversal:

- **STUN only, no TURN.** STUN lets two peers discover their public address and punch a hole
  through most home routers. Behind a _symmetric_ NAT, a strict corporate firewall, or some mobile
  carrier-grade NATs, hole punching fails and the connection never opens — `join` then rejects with
  `timeout`. A TURN relay is the only fix (it is also the only part of this stack that costs money
  and sees traffic volume).
- **Best effort availability.** The cloud broker is a free community service with rate limits and
  no uptime guarantee. It only carries signalling (a few KB while connecting); game traffic is
  peer-to-peer.
- **Shared id space.** See the id scheme above.
- **Ids are guessable.** Anyone who knows the room code can connect, so the application layer must
  still validate who is on the other end.

Default ICE servers = whatever PeerJS ships (`util.defaultConfig.iceServers`) plus, de-duplicated:

```
stun:stun.l.google.com:19302
stun:stun1.l.google.com:19302
```

### Adding TURN

Passing `iceServers` replaces the list entirely, so include your STUN servers too:

```ts
peerJsProvider({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'secret' },
    { urls: 'turns:turn.example.com:5349', username: 'user', credential: 'secret' },
  ],
});
```

Use short-lived credentials minted per session (coturn's `use-auth-secret` / REST API) rather than a
static password baked into the client bundle.

### Self-hosting the signalling server

[`peer`](https://www.npmjs.com/package/peer) (PeerServer) is a small Node process:

```bash
npx peerjs --port 9000 --key peerjs --path /bgf
```

```ts
peerJsProvider({
  host: 'peer.example.com',
  port: 443,
  path: '/bgf',
  secure: true,
  namespace: 'prod', // your own id space anyway; keep it explicit
});
```

Anything not covered by the named options goes through `peerOptions`, which is merged last and can
override everything above (`token`, `pingInterval`, `referrerPolicy`, a hand-built `config`, …):

```ts
peerJsProvider({ peerOptions: { pingInterval: 3000, referrerPolicy: 'no-referrer' } });
```

## Tests

`pnpm vitest run --project transport-peerjs` — the suite mocks the `peerjs` module with a fake
`Peer`/`DataConnection` network (`test/fake-peerjs.ts`), so it runs in Node with no browser, no
signalling server and no WebRTC. Two provider instances are wired through the fake network to prove
a message round-trips host → guest → host.
