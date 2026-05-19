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

| Transport | How it connects | Notes |
|---|---|---|
| Dedicated WebSocket | `ws[s]://broker/provider/<name>` | One WS per provider |
| Multiplexed WebSocket | `ws[s]://broker/providers` with envelope `{ provider, payload }` | One WS carries N providers |
| Stdio upstream | Broker spawns a child process at startup, talks newline-delimited JSON-RPC | Configured statically |

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
- `pending`: map of pending JSON-RPC request ids to their response sinks
- `sseSessions`, `mcpGetSessions`: open notification streams
- `wsClients`: raw WS MCP clients on this slot

A request from any client lands in `pending` keyed by its JSON-RPC id; the matching response from the provider is routed back to the same sink. Notifications without an id are broadcast to all sinks of that slot.

## Why this design

- **Provider isolation.** Two providers with unrelated tool catalogs do not see each other's traffic.
- **Multiple clients per provider.** A scene running once can be inspected by Inspector and driven by Claude at the same time.
- **Asymmetric transports.** A provider can speak WS while a client speaks SSE on the same slot; the broker translates the framing.
- **Lazy state.** Clients can connect to a provider name before the provider itself is up; the broker buffers the slot and answers with a JSON-RPC error until the provider attaches.

## What v0.1 is not yet

- No cross-slot aggregation (a single client sees one provider's tools, not the union of all)
- No authentication or authorization
- No tenant or environment separation
- No health checks or active failover

See [roadmap.md](roadmap.md) for the path forward.
