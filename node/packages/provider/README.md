# @cyanmycelium/mcp-broker-provider

Provider side of the [CyanMycelium MCP broker](https://github.com/pandaGaume/mcp-broker) tunnel: what an application uses to **publish** its MCP server to a broker slot.

MCP defines two standard transports, stdio and Streamable HTTP, and both live in [`@cyanmycelium/mcp-core`](https://www.npmjs.com/package/@cyanmycelium/mcp-core). The WebSocket tunnel is not one of them: it is CyanMycelium topology, where an MCP server runs next to a browser application and reaches the outside world through a broker. That is what this package covers, so `mcp-core` stays a faithful implementation of the specification and nothing else.

See [docs/packages.md](https://github.com/pandaGaume/mcp-broker/blob/main/docs/packages.md) for how this package relates to the broker, and why *provider* rather than *client*.

## Install

```sh
npm install @cyanmycelium/mcp-broker-provider
```

## Entry points

```ts
import { MultiplexTransport } from "@cyanmycelium/mcp-broker-provider";
import { decodeEnvelope } from "@cyanmycelium/mcp-broker-provider/protocol";
```

| Entry point | Contents |
|---|---|
| `.` | The tunnel transports, plus everything below |
| `./protocol` | The envelope wire format: types, codec, registration notification, error codes. No dependencies, isomorphic |

## The envelope protocol

A multiplexed tunnel socket carries traffic for several providers at once, so every JSON-RPC message is wrapped with the name of the provider slot it belongs to:

```json
{ "provider": "scene-1", "payload": { "jsonrpc": "2.0", "id": 1, "method": "tools/list" } }
```

`./protocol` is the single definition of that format, and the broker imports it from here rather than re-declaring the shape inline, so the two ends cannot drift. The broker depends on this package because it is itself a provider: it publishes its own `_broker` introspection slot and its `_all` aggregate slot.

Beyond the envelope it also covers:

- `notifications/register`, sent as soon as the tunnel opens to claim a provider slot. Without it the broker only learns a provider name on its first real message, and an MCP client connecting in between is told the provider is not connected. It optionally carries `params: { aggregate: true }`, which also joins the broker's `_all` slot, see [Joining the `_all` aggregate slot](#joining-the-_all-aggregate-slot).
- The tunnel error codes: `-32001` when the provider's credentials do not allow publishing on the requested slot, `-32000` when the slot is unavailable.

When the broker refuses a slot, the transport surfaces it through `onError` rather than forwarding it. An id-less error frame handed to an MCP server would be classified as an unknown notification and dropped without a word, so the publisher would never learn it was refused.

Malformed frames decode to `undefined` rather than throwing: a tunnel socket is a public surface, and a peer sending garbage must not take the receiver down.

## Transports

| Transport | Endpoint it speaks to | Framing | Reconnects | Use case |
|---|---|---|---|---|
| `MultiplexTransport` | the shared multiplex base, `ws://<broker>/providers` | envelopes `{ provider, payload }` | yes, on the shared socket | Several servers published by one application. A single socket carries them all, keyed by slot name |
| `DirectTransport` | a slot-scoped path, `ws://<broker>/provider/<name>` | plain JSON-RPC frames | **no** | One server, one socket |

**The transport and the path are a pair, not a preference.** The broker decides framing from the endpoint the socket landed on, so a mismatch does not fail the handshake: the socket opens, looks healthy, and every frame is dropped on one side or the other with nothing logged by the broker. Both transports warn on the console when they spot the mismatch at connect time. And `ws://<broker>/providers/<name>`, the natural-looking blend of the two, is neither: the broker accepts it as a *client* connection on a slot of that name.

```ts
import { McpServerBuilder } from "@cyanmycelium/mcp-core/server";
import { MultiplexTransport } from "@cyanmycelium/mcp-broker-provider";

const server = new McpServerBuilder()
    .withName("scene-1")
    .withTransport(MultiplexTransport.create("scene-1", "ws://localhost:3000/providers"))
    .register(behavior)
    .build();

await server.start();
```

Transports created for the same tunnel URL share one WebSocket, whichever order they are opened in. Reconnection is handled by that shared socket, with exponential back-off and jitter, and individual transports never reconnect on their own. `DirectTransport` does not reconnect at all: when its socket closes it stays closed, and the application decides whether to call `connect()` again.

`server.start()` resolving means the transport reported itself open, not that the broker accepted the slot. A refusal arrives afterwards, and reaches you as an `onError` on the transport and a line on the console.

`@cyanmycelium/mcp-core` is a peer dependency: the transports import its `IMessageTransport` type and nothing else at runtime, so your application keeps a single copy of it.

## Joining the `_all` aggregate slot

The broker publishes an aggregate slot, `_all`, which exposes every opted-in provider's tools and prompts through one MCP connection. Membership is opt-in, because `_all` is a confidentiality boundary: a provider that does not ask for it stays reachable only on its own slot.

```ts
import { DirectTransport, MultiplexTransport } from "@cyanmycelium/mcp-broker-provider";

// One socket per server
const direct = new DirectTransport("ws://localhost:3000/provider/scene-1", { aggregate: true });

// Or on the shared tunnel
const shared = MultiplexTransport.create("scene-1", "ws://localhost:3000/providers", { aggregate: true });
```

Either form sends the registration notification with `params: { aggregate: true }` as its first frame:

```json
{ "jsonrpc": "2.0", "method": "notifications/register", "params": { "aggregate": true } }
```

`DirectTransport` sends it verbatim, since the slot-scoped path carries plain JSON-RPC and the broker already knows the slot name from the URL. `MultiplexTransport` sends it inside the usual envelope, as `{ "provider": "scene-1", "payload": { ... } }`.

**Wire the message handler before you connect.** The broker runs `initialize` against a newly aggregated provider immediately, and a provider that does not answer is dropped from `_all` silently. Handing the transport to an MCP server does this for you, since the server assigns `onMessage` before calling `connect()`. Assigning it yourself, after connecting, loses the handshake and the provider never appears in the aggregate.

## Diagnostics

This stack used to fail quietly. The transports now name what went wrong, on the console, because a browser-hosted provider has nowhere else to report:

- A frame written before the socket is open is queued (64 frames, oldest dropped first with a warning) and flushed on open, rather than discarded. That window covers the whole reconnect back-off, up to 30 seconds.
- A close with a code other than `1000` is reported through `onError` with the code and the broker's own reason, before `onClose`. A `1008` is a policy refusal: the slot is already connected, is reserved, or provider authentication rejected it.
- An incoming frame that is not an envelope, or one for a slot this socket does not publish, is logged with the likely cause and the fix. Repeats are sampled (the first in full, then one in fifty) so a mismatched tunnel cannot flood the console.

## In a browser

The transports are written for the browser, but the npm path needs a bundler: neither this package nor `@cyanmycelium/mcp-core` ships a UMD build or declares a `browser` field, so a bare `<script>` tag will not load them. Any bundler works; there is nothing to configure beyond resolving the two packages.

Import only the isomorphic entry points. `@cyanmycelium/mcp-core/server` and `@cyanmycelium/mcp-core/client` run in a browser; `@cyanmycelium/mcp-core/node` does not, and pulling it in is the usual cause of a build that fails on Node built-ins.

If you would rather not add a build step, the broker ships a dependency-free ES module that speaks the same tunnel, `web/js/lib/broker-tunnel.js` (inside the `@cyanmycelium/mcp-broker` package, at `node/packages/broker/web` in the repository). It is the zero-build alternative, not a replacement: it carries no MCP server implementation.

One limitation worth knowing before you deploy: if the broker is configured with provider authentication, a browser-hosted provider cannot connect. The broker reads its credential from the `X-Provider-Token` or `Authorization` header of the upgrade request, and the browser `WebSocket` constructor cannot set headers, so the handshake is refused with a 401 the page sees only as a generic error. A browser provider needs provider auth off, or an authenticating reverse proxy in front of the broker.

## Status

This package is the only home of the tunnel transports. They also shipped in `@cyanmycelium/mcp-core@0.4.x`, were removed there in `0.5.0`, and are gone from the current `0.7.x`, so migrate those imports here before upgrading `mcp-core`.

The protocol is shared with the broker, and later with the consumer side. Import it through the `./protocol` subpath rather than the package root, so it can move to a package of its own one day without touching your call sites.

## License

Apache-2.0
