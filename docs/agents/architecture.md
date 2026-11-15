# mcp-broker architecture, for agents

This page is the map. It names every layer of the broker, states the one rule per layer that is most often got wrong, and links each concept to the document that specifies it and to the source file that implements it. Read it before any other page; then read only the pages the task needs.

If you can reach a **running** broker, ask it instead: the reserved `_broker` slot serves `broker_guide({ topic? })` and `broker_diagnose({ slot? })`, generated from the broker's own source and completed with the deployment's effective configuration. When they disagree with this page, they win. The same guide pages are published statically under [guide/](../guide/index.md).

## In one sentence

mcp-broker puts many MCP servers behind one host and one port: each server occupies a named **slot**, servers reach their slot from the inside as **providers**, and any standard MCP client reaches a slot from the outside, alone at `/<slot>/mcp` or aggregated with every other opted-in provider at `/_all/mcp`.

## The layers

```text
                MCP clients: Claude, MCP Inspector, SDKs, agents, a browser page
                        |  Streamable HTTP /<slot>/mcp   SSE /<slot>/sse
                        |  raw WebSocket /<slot>        stdio bridge
                        v
 +---------------------------------------------------------------------------+
 | 3  CLIENT EGRESS     sessions, origin check, MCP-Protocol-Version          |
 | 5  EDGE SECURITY     OAuth 2.1 resource server, provider identities        |
 | 6  AUTHORITY         hierarchical policy, declarations, authorize, limits, |
 |                      budgets, audited decisions and results                |
 | 4  RESERVED SLOTS    _broker (introspection)   _all (aggregate)            |
 | 2  SLOTS / ROUTING   lazy slots, broker-owned request ids, subscriptions   |
 | 7  TELEMETRY         traceparent on every request, broker/telemetry, OTLP  |
 | 8  DISCOVERY         mDNS/DNS-SD (opt-in), RFC 9728 metadata, self-docs    |
 | 1  PROVIDER INGRESS  /provider/<slot>  /providers  stdio  remote  .mcpb    |
 +---------------------------------------------------------------------------+
                        ^
                        |  DirectTransport, MultiplexTransport, LoopbackTransport
                        |  libmcpb (C99), McpBroker (Unreal), Python Provider
                MCP servers: browser pages, Node apps, ESP32 boards,
                Unreal Engine simulations, stdio tools, remote servers
```

The broker is one Node process. The whole tunnel is JSON-RPC 2.0; the broker translates framing between transports and rewrites request ids, and otherwise relays MCP as published.

## Vocabulary

| Term | Meaning |
|---|---|
| **slot** | A name under which one MCP server is reachable. Created lazily on first reference; never declared. An empty slot answers `-32000 Provider "<slot>" not connected` |
| **provider** | An MCP **server** that publishes into a slot. On the tunnel it is a WebSocket *client* of the broker, which is why the word "client" is avoided for it |
| **client** (or consumer) | An MCP **client** that calls a slot over a standard MCP transport. It never speaks the tunnel protocol |
| **dedicated** endpoint | `ws[s]://<host>/provider/<slot>`, one slot per socket, plain JSON-RPC frames, `DirectTransport` |
| **multiplexed** endpoint | `ws[s]://<host>/providers`, N slots per socket, `{ provider, payload }` envelopes, `MultiplexTransport` |
| **upstream** | A provider the broker starts or dials itself: `stdioUpstreams[]`, `mcpServers[]`, `mcpbBundles[]` |
| **loopback** provider | An MCP server in the broker's own process, `tunnel.registerLoopbackProvider()`, no socket |
| `_broker` | Reserved slot: the broker's own introspection MCP server. Routes to nothing |
| `_all` | Reserved slot: union of the tools and prompts of opted-in providers, names prefixed `<slot>-` |
| **declaration** | What a provider tells the broker about the resources it governs (`broker/authorization/declare`). Describes; grants nothing |
| **caller reference** | `params._meta["io.cyanmycelium/caller"]`, attached by the broker to each request for a declaring provider, so the provider can ask `broker/authorize` about the real caller |

## Layer by layer

### 1. Provider ingress

How an MCP server gets into a slot.

| Way in | Endpoint or key | Implemented by |
|---|---|---|
| Dedicated WebSocket | `ws[s]://<host>/provider/<slot>` | `DirectTransport` ([provider package](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/provider/src/direct.transport.ts)), `mcpb_provider_t` (C) |
| Multiplexed WebSocket | `ws[s]://<host>/providers` | `MultiplexTransport` ([source](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/provider/src/multiplex.transport.ts)), `mcpb_mux_t` (C), the Unreal plugin |
| Child process over stdio | `stdioUpstreams[]` | [stdio.upstream.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/stdio.upstream.ts) |
| Remote server the broker dials | `mcpServers[]` | [remote.upstream.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/remote.upstream.ts) |
| Signed `.mcpb` bundle | `mcpbBundles[]` | [mcpb.loader.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/mcpb/mcpb.loader.ts) |
| Same process | `tunnel.registerLoopbackProvider(name, transport)` | `LoopbackTransport` from `@cyanmycelium/mcp-core` |

**The rule:** a provider's transport and its URL path are one decision. `DirectTransport` pairs with `/provider/<slot>`, `MultiplexTransport` with `/providers`. `/providers/<slot>` is neither: it is accepted as an MCP *client* of a slot literally named `providers/<slot>`. Since 1.3.0 the broker detects both mismatches on the first frame and closes with `1008`; older brokers stay silent.

**Joining `_all` is opt-in:** a WebSocket provider sends `{"jsonrpc":"2.0","method":"notifications/register","params":{"aggregate":true}}` first (the `aggregate` transport option does it); a `stdioUpstreams[]` entry needs `"aggregate": true`; `mcpServers[]` and `mcpbBundles[]` join by default.

Specified in: [protocol.md](../protocol.md), [endpoints.md](../endpoints.md#provider-side-incoming). Router: [ws.tunnel.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/ws/ws.tunnel.ts). Wire envelope: [envelope.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/provider/src/protocol/envelope.ts).

### 2. Slots and routing

- A slot is created on first reference, by a provider or by a client. Clients may connect before the provider exists.
- Each client request gets a broker-allocated id (`brk-<n>`) on the provider side; the client's own id is restored on the answer. Two clients may both use id `1`.
- A pending request ends on answer, provider disconnect, caller disconnect, or after `providerRequestTimeoutMs` (60 s).
- Notifications are broadcast to the slot's clients, except `notifications/resources/updated`, which goes only to sessions subscribed to that exact URI. The broker reference-counts subscriptions: N clients cost the provider one `resources/subscribe`.
- A provider reconnecting gets the last client `initialize` replayed, then one subscribe per URI.
- Server-to-client requests opened by a provider (`sampling/createMessage`, `roots/list`, `elicitation/create`) are answered `-32601` by the broker, never relayed.

Specified in: [architecture.md](../architecture.md#per-provider-state), [protocol.md](../protocol.md#resource-subscriptions). Source: [broker.slots.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/broker/broker.slots.ts), [resource.subscription.registry.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/subscriptions/resource.subscription.registry.ts).

### 3. Client egress

| Transport | Path |
|---|---|
| Streamable HTTP | `POST`, `GET`, `DELETE` `/<slot>/mcp` |
| Legacy SSE | `GET /<slot>/sse`, `POST /<slot>/messages?sessionId=` |
| Raw WebSocket | `ws[s]://<host>/<slot>` |
| stdio bridge | `MCP_BROKER_STDIO_PROVIDER=<slot>`; always `_all` for an MCP host |

- A request carrying an `Origin` header is refused (`403 invalid_origin`) unless that exact origin is in `allowedOrigins`. A page served by the broker's own static mount is **not** exempt. A request with no `Origin` (Node, Inspector, SDKs) always passes. WebSocket upgrades are not origin-checked.
- Streamable HTTP and SSE sessions never expire: a client that leaves without `DELETE /<slot>/mcp` keeps its session and subscriptions.
- TLS is the broker's own (`tls` in the config, `MCP_BROKER_TLS_CERT`) or a reverse proxy's; `ws://` becomes `wss://` and `http://` becomes `https://` with nothing else changing.

Specified in: [endpoints.md](../endpoints.md#client-side-outgoing), guide [connect-client](../guide/connect-client.md), [config.md](../../node/packages/broker/docs/config.md).

### 4. Reserved slots

- **`_broker`** serves `broker_info`, `providers_list`, `provider_status`, `broker_guide`, `broker_diagnose` and the matching `broker://` resources. `broker://providers` accepts `resources/subscribe`. It proxies **nothing**.
- **`_all`** exists from startup and answers `initialize` itself, which makes it the only safe target for a stdio MCP host. Tools and prompts only: every other method, `resources/*` included, is `-32601`. Tool names are `<slot>-<tool>`, capped at 64 characters, hash-suffixed when too long, `-2` on collision: **never rebuild a name, echo the one `tools/list` returned**. Under authorization the catalog is filtered per caller.

Specified in: [architecture.md](../architecture.md#the-reserved-_broker-slot-self-introspection). Source: [broker.server.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/broker/broker.server.ts), [aggregate.server.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/broker/aggregate/aggregate.server.ts), [broker.guides.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/broker/broker.guides.ts), [broker.diagnostics.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/broker/broker.diagnostics.ts).

### 5. Edge security

All of it is **opt-in**: with no `auth` configuration the broker authenticates nobody, which is only appropriate behind a trusted network boundary.

- **Clients:** the broker is an OAuth 2.1 resource server (MCP authorization spec). A missing or invalid token gets `401` with `WWW-Authenticate: Bearer resource_metadata=...`; the metadata is served at `/.well-known/oauth-protected-resource/<slot>/mcp` (RFC 9728). `auth.dev` gives static per-caller tokens for local tests, loopback only by default.
- **Providers:** a shared secret, or a per-provider identity from the security file's `providers` table, sent as `X-Provider-Token` or `Authorization: Bearer`. A browser cannot set those headers, so a browser provider cannot authenticate to the broker directly.
- **Slot takeover:** a second provider on a held slot is refused `1008` while the incumbent answers heartbeats (`providerTakeover`, default `"liveness"`).
- The stdio bridge is anonymous.

Specified in: [authorization.md](../authorization.md), [HOWTO.md](../../HOWTO.md) (in French). Source: [auth/](https://github.com/pandaGaume/mcp-broker/tree/main/node/packages/broker/src/auth).

### 6. Authority

The broker can be the authorization decision point for providers that govern their own kind of resource (SCADA first).

1. **Policy** (operator, security file): subjects, roles of capabilities, assignments on hierarchical resource paths (ISA-95 aligned), explicit denies. `authorize(subject, capability, resourcePath) -> allow | deny`.
2. **Declaration** (provider, `broker/authorization/declare`): its domain, namespace, capabilities and resources, with optional engineering `limits` and resource patterns. One owner identity per domain, one declaration per `(identity, slot)`. It grants nothing.
3. **Decision** (provider asks, `broker/authorize`, about a caller reference or about itself): one audited decision per check. A resource with limits returns `allow-with-constraints`, with `allowed: false` so a provider that ignores obligations refuses rather than oversteps.
4. **Execution limits and budgets:** concurrency and budget reservations, released on answer or by an operator.
5. **Result** (provider, `broker/audit/result`): audited next to the decision; unreported results of required capabilities show up in `broker_diagnose`.

Specified in: [hierarchical-authorization.md](../hierarchical-authorization.md), [authorization.md](../authorization.md#hierarchical-policies), [execution-limits.md](../../node/packages/broker/docs/execution-limits.md), the "Declared authorization" section of [AGENTS.md](../../AGENTS.md#declared-authorization-150). Source: [authorization/](https://github.com/pandaGaume/mcp-broker/tree/main/node/packages/broker/src/authorization), [authority/](https://github.com/pandaGaume/mcp-broker/tree/main/node/packages/broker/src/authority), [limits/controller.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/limits/controller.ts).

### 7. Telemetry and traces

- Every MCP request routed to a provider carries a valid W3C `traceparent` in `params._meta`; a valid caller value is kept, a missing or malformed one replaced.
- Providers send spans as the private notification `broker/telemetry`, which the broker validates, bounds, queues and exports over OTLP/HTTP. It is never broadcast to clients.
- The audit `correlationId` and the W3C `traceId` are distinct and linked.

Specified in: [telemetry.md](../telemetry.md). Source: [telemetry/](https://github.com/pandaGaume/mcp-broker/tree/main/node/packages/broker/src/telemetry).

### 8. Discovery

- **Self-documentation:** `_broker` (`broker_guide`, `broker_diagnose`), and through `_all`.
- **LAN:** opt-in mDNS/DNS-SD announcement of `_mcp-broker._tcp.local` on named interfaces (`mdns` in the config). It advertises no credentials, no provider inventory and no version, and grants no trust.
- **Authorization metadata:** RFC 9728 documents per slot when the resource server is on.
- **Web:** this site, its [llms.txt](../llms.txt), and the npm package `@cyanmycelium/mcp-broker`.

Specified in: `mdns` in [config.md](../../node/packages/broker/docs/config.md). Source: [discovery/mdns.ts](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/src/discovery/mdns.ts).

### The device side

Providers do not have to be Node. `c/libmcpb` is a C99 tunnel client (no allocation, a six-function platform port) that speaks exactly the two WebSocket framings; it carries JSON-RPC bytes and never interprets them. It runs on an ESP32 (`mcpb_esp`), inside Unreal Engine 5 (plugin `McpBroker`, one multiplexed socket for every simulated device), and under Python through `ctypes` (`mcp_provider.Provider`). A simulated `pump-1` and a real `pump-1` publish the same slot and tool schemas.

Specified in: [c/README.md](../../c/README.md), [c/libmcpb/README.md](../../c/libmcpb/README.md), [c/espressif/README.md](../../c/espressif/README.md), [c/unreal/README.md](../../c/unreal/README.md), [python/README.md](../../python/README.md).

## Three paths through the broker

**A browser page publishes a tool.**
The page builds an `McpServer` with `DirectTransport("ws://<host>/provider/my-slot", { aggregate: true })`, starts it, and closes the transport on `pagehide`. `start()` resolving means the socket opened, not that the slot was accepted: a refusal arrives later as a `1008` close. The page needs a bundler, and cannot authenticate as a provider. Runnable: [samples/browser-provider](https://github.com/pandaGaume/mcp-broker/tree/main/samples/browser-provider).

**An agent calls it.**
The agent's MCP client points at `http://<host>/my-slot/mcp`, or at `http://<host>/_all/mcp` and calls `my-slot-<tool>` exactly as `tools/list` spelled it. A stdio host uses the broker with `MCP_BROKER_STDIO_PROVIDER=_all`. Runnable: [samples/host-config](https://github.com/pandaGaume/mcp-broker/tree/main/samples/host-config).

**A governed write.**
A declaring provider receives `tools/call` with a caller reference, asks `broker/authorize` with that reference, applies `obligations.constraints` when the effect is `allow-with-constraints`, acts, then reports the outcome with `broker/audit/result`. Tests: `startTestBroker()` from `@cyanmycelium/mcp-broker/testing` ([testing.md](../../node/packages/broker/docs/testing.md)).

## What the broker is not

- `_all` is not a proxy, not automatic, and carries no resources.
- `_broker` routes to nothing.
- A slot is not declared; an unknown name is an empty slot.
- `start()` resolving is not a connection guarantee, on either side.
- A static mount does not exempt its own origin from the origin check; the origin check does not cover WebSocket upgrades.
- Sessions do not expire.
- The broker is not an identity provider: it validates tokens, it does not issue them.
- Grammar files reword the `_broker` tools only; provider tools are relayed as published.

## Reading order

1. This page.
2. [AGENTS.md](../../AGENTS.md): topology table, copy-pasteable configurations, symptom-to-fix table.
3. The guide page for the task: [publish-provider](../guide/publish-provider.md), [connect-client](../guide/connect-client.md), [host-config](../guide/host-config.md), [deploy](../guide/deploy.md), [troubleshooting](../guide/troubleshooting.md).
4. The specification for the layer: [protocol.md](../protocol.md), [endpoints.md](../endpoints.md), [authorization.md](../authorization.md), [telemetry.md](../telemetry.md), [config.md](../../node/packages/broker/docs/config.md).
5. Runnable proof: [samples/index.json](../../samples/index.json).
