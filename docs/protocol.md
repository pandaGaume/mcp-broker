# Wire protocol

This document describes how messages travel between the broker, providers, and clients. It is intended to be language-neutral so a .NET (or any other) implementation reproduces the same observable behavior as the Node one.

## JSON-RPC

Every payload between any pair of participants is a [JSON-RPC 2.0](https://www.jsonrpc.org/specification) message. The broker never parses tool arguments or resource contents; it only inspects the `id` field to know whether a message is a request, response, or notification.

## Dedicated provider WebSocket

Endpoint: `ws[s]://<host>/provider/<encodedName>`

Framing: one JSON-RPC message per WebSocket text frame. No envelope.

The slot is claimed from the **URL** at connect time, before any frame exists,
so a client arriving first is served immediately.

```
  Provider                                                             Broker
     │  ── { id: "brk-7", method: "tools/list", ... }     ◀──   (forwarded from a client)
     │  ── { id: "brk-7", result: { tools: [...] } }      ──▶   (response sent back to that client)
     │  ── { method: "notifications/tools/list_changed" } ──▶   (broadcast to all clients)
```

**Request ids are allocated by the broker.** A client's id is replaced on the
way out with a broker-side `brk-<n>` string and restored before the response
reaches the client. This is what keeps two clients that both pick id `1` from
colliding on one slot. A provider must echo the id **verbatim**, including its
type: a response carrying `1` for a request that carried `"1"` matches nothing
and is warned about, then dropped.

### Registration and the `_all` opt-in

Registration on this path is implicit, but a provider may send one control frame
**first** to ask for membership of the `_all` aggregate slot. Two shapes are
accepted:

```json
{ "jsonrpc": "2.0", "method": "notifications/register", "params": { "aggregate": true } }
```

```json
{ "type": "register", "aggregate": true }
```

The first is what the SDK sends (`new DirectTransport(url, { aggregate: true })`)
and is the shape to implement. The second is the legacy control frame, kept
working. Either must be the **first** frame on the socket: the broker inspects
exactly one frame per socket for this, and a frame carrying `jsonrpc` with any
other method is routed as traffic. The frame is consumed, not forwarded.

Membership is opt-in because `_all` is a content-confidentiality boundary. A
provider that does not ask stays reachable only on its own slot.

The moment the broker accepts an aggregate registration it opens an internal
client and sends `initialize`. **Install the MCP message handler before sending
the registration frame**: a provider not listening yet fails that handshake, is
removed from `_all` and logged, with no retry.

## Multiplexed provider WebSocket

Endpoint: `ws[s]://<host>/providers`

Framing: each frame is an envelope:

```json
{ "provider": "<name>", "payload": <JSON-RPC message> }
```

The broker registers each `provider` string seen on this socket as a lazy slot owned by the same WebSocket. Closing the socket disconnects every slot it owned.

A transport announces each slot with a registration envelope on open, and asks
for `_all` membership in the same frame:

```json
{
  "provider": "<name>",
  "payload": { "jsonrpc": "2.0", "method": "notifications/register", "params": { "aggregate": true } }
}
```

Omit `params` entirely to register without joining `_all`; that frame is
byte-identical to the parameterless form older brokers accept.

A frame that does not decode as an envelope is dropped without a reply. If it is
JSON carrying `jsonrpc`, that is unambiguously a `DirectTransport` on the shared
path: the broker answers with a **bare** JSON-RPC error (the only framing that
peer can decode) naming both corrections, and closes with code `1008`. The
mirror check runs on the slot-scoped path: a first frame that is a JSON object
with no `jsonrpc` which decodes as an envelope is answered with an error
**envelope** and closed the same way.

Conflicts (a name already taken by another WS, or by a stdio upstream) are answered with an error envelope on the same socket:

```json
{
  "provider": "<name>",
  "payload": {
    "jsonrpc": "2.0",
    "id": null,
    "error": { "code": -32000, "message": "Provider \"<name>\" is already connected" }
  }
}
```

## Stdio upstream provider

The broker spawns a child process. Framing on its stdin/stdout is newline-delimited JSON-RPC, identical to the MCP stdio transport.

- One JSON object per line, UTF-8.
- stderr from the child is inherited (visible in broker logs).
- The provider name is fixed at configuration time and cannot be renamed at runtime.

A `.mcpb` bundle is the same thing with a verification step in front: the broker
checks a detached signature against a trusted public key, and a bundle that
fails verification is skipped and never spawned.

## Remote upstream provider

The broker dials **out** to a URL and republishes the remote MCP server as a
slot, over Streamable HTTP, legacy SSE or WebSocket. The slot's clients are
multiplexed onto that one upstream exactly as they are onto a child process.

For Streamable HTTP the broker also opens a standalone `GET` stream to receive
server-initiated messages. A `405` or `501` there means the server offers no GET
stream and the broker stops asking; any other failure is logged with the
upstream's configured name and reopened with exponential backoff (500 ms base,
capped at 30 s). A body that is not JSON is forwarded verbatim rather than
dropped, so the client fails fast with a visible parse error instead of hanging,
and the broker logs the upstream name plus an excerpt.

## Raw WebSocket client

Endpoint: `ws[s]://<host>/<encodedName>`

Framing: one JSON-RPC message per WebSocket text frame, no envelope. The broker forwards requests to the matching provider slot and returns responses on the same socket.

## Streamable HTTP client (MCP 2025-03-26)

Endpoints:
- `POST /<name>/mcp` with `Content-Type: application/json`, sends one JSON-RPC request, the response is held until the provider replies, then returned as `application/json`. Notifications (no `id`) get a `202 Accepted` immediately.
- `GET /<name>/mcp`, opens an SSE-style stream that receives all server-initiated notifications until the client disconnects. The session id is echoed in the `Mcp-Session-Id` response header (and read back from the request header if the client supplies one).

## Legacy SSE client

Endpoints:
- `GET /<name>/sse`, opens an SSE stream. Immediately emits one `endpoint` event whose `data:` is the URL the client must POST to:
  ```
  event: endpoint
  data: /<name>/messages?sessionId=<uuid>
  ```
- `POST /<name>/messages?sessionId=<uuid>`, body is a JSON-RPC request. Always returns `202 Accepted`. The response is delivered as a `message` event on the matching SSE stream.

## Error envelopes

When a client targets a provider that is not connected, the broker fabricates:

```json
{
  "jsonrpc": "2.0",
  "id": <the client request id or null>,
  "error": { "code": -32000, "message": "Provider \"<name>\" not connected" }
}
```

If the provider disconnects while requests are in flight, the broker sends the same shape to every pending sink, then drops the pending map.

Three messages, one code (`-32000`), distinguished by their text:

| message | when |
|---|---|
| `Provider "<name>" not connected` | the slot exists but nothing is serving it right now |
| `Provider "<name>" disconnected` | the provider dropped while the request was in flight |
| `Provider "<name>" did not respond within <ms>ms` | the pending deadline expired (`providerRequestTimeoutMs`, 60000 by default; `0` disables) |

All three echo the caller's own request id, never `null`. A client that
correlates by id will match them.

## CORS

The broker sets these on every HTTP response:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: <echoed>
Access-Control-Expose-Headers: Mcp-Session-Id
```

`Access-Control-Allow-Headers` **echoes the request's
`Access-Control-Request-Headers` header verbatim** when one is present, and only
falls back to the literal `Content-Type, Accept, Mcp-Session-Id` when it is
absent. An implementation that hardcoded the fallback would reject any preflight
carrying `Authorization`, which every authenticated client sends.

`OPTIONS` preflights return `204 No Content` unconditionally, before any routing
or authorization.

CORS is **not** the access control here. `Access-Control-Allow-Origin: *` is
permissive by design; the actual gate is the `Origin` check performed on
`/<name>/mcp`, `/<name>/sse` and `/<name>/messages`, which refuses an
unallowed origin with `403` and a body of the shape:

```json
{ "error": "invalid_origin", "error_description": "…" }
```

A request carrying **no** `Origin` header always passes. WebSocket upgrades are
not origin-checked at all.
