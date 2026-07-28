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

- `notifications/register`, sent as soon as the tunnel opens to claim a provider slot. Without it the broker only learns a provider name on its first real message, and an MCP client connecting in between is told the provider is not connected.
- The tunnel error codes: `-32001` when the provider's credentials do not allow publishing on the requested slot, `-32000` when the slot is unavailable.

When the broker refuses a slot, the transport surfaces it through `onError` rather than forwarding it. An id-less error frame handed to an MCP server would be classified as an unknown notification and dropped without a word, so the publisher would never learn it was refused.

Malformed frames decode to `undefined` rather than throwing: a tunnel socket is a public surface, and a peer sending garbage must not take the receiver down.

## Transports

| Transport | Use case |
|---|---|
| `MultiplexTransport` | Several servers published by one application. A single socket carries them all, keyed by slot name |
| `DirectTransport` | One server, one socket, on `ws://<broker>/provider/<name>` |

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

Transports created for the same tunnel URL share one WebSocket, whichever order they are opened in. Reconnection is handled by that shared socket, with exponential back-off and jitter; individual transports never reconnect on their own.

`@cyanmycelium/mcp-core` is a peer dependency: the transports import its `IMessageTransport` type and nothing else at runtime, so your application keeps a single copy of it.

## Status

`0.1.0` ships the protocol module and both transports. They still exist in `@cyanmycelium/mcp-core@0.4.x` as well, and are removed there in `0.5.0`, migrate your imports before upgrading.

The protocol is shared with the broker, and later with the consumer side. Import it through the `./protocol` subpath rather than the package root, so it can move to a package of its own one day without touching your call sites.

## License

Apache-2.0
