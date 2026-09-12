# Architecture

`mcp-broker` is a single-process server that brokers JSON-RPC traffic between MCP **providers** (the things that expose tools and resources) and MCP **clients** (the things that consume them).

## Roles

```
   ┌──────────────┐      ┌────────────┐      ┌────────────┐
   │  Provider A  │◀───▶│            │◀───▶│  Client 1  │
   ├──────────────┤      │            │      ├────────────┤
   │  Provider B  │◀───▶│   BROKER   │◀───▶│  Client 2  │
   ├──────────────┤      │            │      ├────────────┤
   │  Provider C  │◀───▶│            │◀───▶│  Client N  │
   └──────────────┘      └────────────┘      └────────────┘
       (WS, stdio)         (this repo)         (HTTP, WS, SSE, stdio)
```

A **provider** registers under a named slot. Each slot is independent: pending requests, notification streams, and connected clients are tracked per slot.

A **client** addresses a provider by name. Multiple clients can target the same provider simultaneously and each receives the responses to its own requests plus broadcast notifications from that provider.

## Provider transports (incoming)

| Transport | How it connects | SDK class | Notes |
|---|---|---|---|
| Dedicated WebSocket | `ws[s]://broker/provider/<name>` | `DirectTransport` | One WS per provider, **plain JSON-RPC frames** |
| Multiplexed WebSocket | `ws[s]://broker/providers` with envelope `{ provider, payload }` | `MultiplexTransport` | One WS carries N providers, **envelope frames** |
| Stdio upstream | Broker spawns a child process at startup, talks newline-delimited JSON-RPC | (none) | Config key `stdioUpstreams[]` |
| Remote upstream | Broker dials out to a URL over Streamable HTTP, SSE or WebSocket | (none) | Config key `mcpServers[]` |
| `.mcpb` bundle | Broker verifies a detached signature, unpacks, and spawns the bundle as a stdio upstream | (none) | Config key `mcpbBundles[]`. A bundle that fails verification is skipped and never spawned |
| Loopback | `tunnel.registerLoopbackProvider(name, transport)` | `LoopbackTransport` | Same process, no socket. Outranks a WebSocket provider of the same name |

> **The pairing rule.** A provider's transport and its URL path are a matched
> pair: `DirectTransport` with `/provider/<name>`, `MultiplexTransport` with
> `/providers`. The broker decides which framing to speak on a socket from the
> URL that socket connected to, never from what arrives on it.
> `ws[s]://broker/providers/<name>` is **neither**: the router matches
> `/providers` exactly and `/provider/` as a prefix, so it falls through to the
> client branch and is accepted as an MCP *client* on a slot named
> `providers/<name>`.

The three configured kinds (`stdioUpstreams`, `mcpServers`, `mcpbBundles`) all
report `transport: "stdio"` in `providers_list`, because the broker tracks them
in one upstream registry. A `transport: "stdio"` entry is therefore not
necessarily a child process; it may be a remote URL.

## Client transports (outgoing)

| Transport | Path | Use case |
|---|---|---|
| Raw WebSocket | `ws[s]://broker/<name>` | Custom MCP clients, low overhead |
| Streamable HTTP (MCP 2025-03-26) | `POST/GET http[s]://broker/<name>/mcp` | MCP Inspector and modern SDKs |
| Legacy SSE | `GET /<name>/sse` + `POST /<name>/messages?sessionId=…` | Older Claude transport |
| Stdio bridge | broker reads stdin, writes stdout | Claude Desktop wrapping the broker as a stdio MCP server |

## Per-provider state

When any of these references a provider name for the first time, the broker creates a lazy state slot:

- `ws`: the active provider WebSocket (or null when disconnected)
- `pending`: map of **broker-allocated** request ids to `{ sink, clientId, expiresAt }`
- `sseSessions`, `mcpGetSessions`: open notification streams
- `wsClients`: raw WS MCP clients on this slot

A request from any client is assigned a broker-side id (`brk-<n>`), which
replaces the client's id on the wire to the provider and is restored before the
response is delivered. That namespacing is what lets two clients on one slot
both use JSON-RPC id `1` without colliding; keying `pending` on the client's raw
id, as earlier versions did, hung one caller and delivered the other caller's
body to it. A provider therefore sees **string** ids it must echo verbatim.
Notifications without an id are not tracked and are broadcast to all sinks of
that slot.

A pending entry is released by a matching response, by the provider
disconnecting, by the caller's own connection closing, or by expiry
(`providerRequestTimeoutMs`, 60 s by default), which fails the request with
`-32000 Provider "<name>" did not respond within <ms>ms` rather than leaving the
caller waiting.

## The reserved `_broker` slot: self-introspection

The broker registers **itself** as a provider under the reserved slot
`_broker`. Any MCP client that connects to `<host>/_broker/mcp` reaches the
broker's own MCP server (in-process, over a loopback transport) and can
discover the broker's state through standard MCP tools:

- `broker_info`, name, version, uptime, host, port, TLS, effective paths.
- `providers_list`: every provider slot known to the broker (connected and
  disconnected), with transport kind, client count, session count, and pending
  request count. This is cross-slot discovery: a single client gets the full
  inventory from one call.
- `provider_status({ name })`, detail of one slot by name.
- `broker_guide({ topic? })`, the broker's own integration guide as Markdown,
  with this deployment's effective configuration appended to every page.
- `broker_diagnose({ slot? })`, live state plus the problems the broker can
  prove, each carrying `symptom`, `evidence` and an actionable `fix`. Checks
  whose input is unreachable are listed in `checksSkipped` rather than guessed.

Matching resources at `broker://info`, `broker://providers`, the URI template
`broker://providers/{name}`, the six `broker://guide/<topic>` pages and the
template `broker://guide/{topic}` mirror the same data for clients that prefer
`resources/read` to `tools/call`. `broker_diagnose` deliberately has **no**
backing resource: resource content is cached, and a cached diagnosis is stale at
exactly the moment it matters.

`_broker` proxies nothing. It is an introspection server, not a route to other
slots.

## The reserved `_all` slot: aggregation

`_all` presents the union of the tools and prompts of every **opted-in**
provider as a single MCP server, over the same client-side endpoints
(`/_all/mcp`, `/_all/sse`, `ws://…/_all`). It is registered at startup, before
the stdio bridge resumes stdin, which is what makes it the only safe stdio-host
target.

- **Membership is opt-in, and the default is not uniform.** A WebSocket provider
  joins by sending the aggregate registration (the `aggregate` option on both
  SDK transports). A `stdioUpstreams[]` entry joins only with
  `"aggregate": true`. `mcpServers[]` and `mcpbBundles[]` entries join **by
  default** and opt out with `"aggregate": false`. `_broker` is always in.
- **Names are prefixed** `<slot>-<original>`, descriptions tagged
  `[<slot>] ...`. The prefixed name is capped at 64 characters, an overlong one
  is truncated and hash-suffixed, and a collision is broken with a `-2`, `-3`
  suffix, so the mapping back to `(provider, original)` is a lookup table and
  not a parse. A client must echo the name `tools/list` returned.
- **Tools and prompts only.** `initialize`, `ping`, `tools/list`, `tools/call`,
  `prompts/list`, `prompts/get`. Everything else, `resources/list` and
  `resources/read` included, returns `-32601 Method not found`.
- It emits `notifications/tools/list_changed` and
  `notifications/prompts/list_changed` when a provider joins, leaves or changes
  its catalog, so a provider that arrives mid-session becomes visible without a
  reconnect.
- Under authorization it **filters the catalog** per caller rather than
  rejecting the call; an invisible tool answers `-32602 Unknown aggregated
  tool`, deliberately indistinguishable from a name that does not exist. `_all`
  is therefore a content-confidentiality boundary, which is why membership is
  opt-in rather than automatic.
- A provider whose aggregate handshake fails is removed and logged rather than
  registered with an empty catalog, so the aggregate's provider count can be
  lower than the number of providers that asked to join.

## Why this design

- **Provider isolation at the tool level.** Two providers with unrelated
  tool catalogs do not see each other's traffic. A client connected to
  `<name1>/mcp` cannot call `<name2>`'s tools, only the broker's
  introspection tools expose information about other slots.
- **Multiple clients per provider.** A scene running once can be inspected
  by Inspector and driven by Claude at the same time. This holds because
  `pending` is keyed by a broker-allocated id rather than by the client's own,
  so two clients that both pick JSON-RPC id `1` each get their own answer.
- **Asymmetric transports.** A provider can speak WS while a client speaks
  SSE on the same slot; the broker translates the framing.
- **Lazy state.** Clients can connect to a provider name before the
  provider itself is up; the broker buffers the slot and answers with a
  JSON-RPC error until the provider attaches.
- **The broker is itself an MCP server.** Discoverability comes for free , 
  no separate admin API to learn.

## What the broker does not do

Stated explicitly, because each of these has cost an integrator time:

- **`_all` is not a proxy, and not automatic.** It aggregates tools and prompts
  of providers that asked to join, and returns `-32601` for everything else.
- **`_broker` is not a route to other slots.** It is introspection only.
- **A static mount does not exempt the origin it serves.** The origin check on
  the HTTP client endpoints applies to a page the broker itself serves. The
  check does not extend to WebSocket upgrades at all, in either direction.
- **`start()` is not a connection guarantee**, on either side. On the provider
  side it resolves when the transport reports itself open; a broker refusal
  arrives afterwards as a WebSocket close with code 1008. On the broker side it
  resolves when the port is bound, and no provider can exist yet.
- **Streamable HTTP and SSE sessions never expire.** A client that closes its
  tab without `DELETE /<slot>/mcp` leaves its session alive, and every
  broadcast notification is queued into it. `sessionCount` growing
  monotonically across a run is the only signal.
- **Slots are not declared.** A name nobody serves is not an error; it is an
  empty slot that answers `-32000 Provider "<name>" not connected`.
