# Wire protocol

This document describes how messages travel between the broker, providers, and clients. It is intended to be language-neutral so a .NET (or any other) implementation reproduces the same observable behavior as the Node one.

## JSON-RPC

Every payload between any pair of participants is a [JSON-RPC 2.0](https://www.jsonrpc.org/specification) message. The broker never parses tool arguments or resource contents; it only inspects the `id` field to know whether a message is a request, response, or notification.

## Dedicated provider WebSocket

Endpoint: `ws[s]://<host>/provider/<encodedName>`

Framing: one JSON-RPC message per WebSocket text frame. No envelope.

```
  Provider                                                             Broker
     │  ── { id: 1, method: "tools/list", ... }           ◀──   (forwarded from a client)
     │  ── { id: 1, result: { tools: [...] } }            ──▶   (response sent back to that client)
     │  ── { method: "notifications/tools/list_changed" } ──▶   (broadcast to all clients)
```

## Multiplexed provider WebSocket

Endpoint: `ws[s]://<host>/providers`

Framing: each frame is an envelope:

```json
{ "provider": "<name>", "payload": <JSON-RPC message> }
```

The broker registers each `provider` string seen on this socket as a lazy slot owned by the same WebSocket. Closing the socket disconnects every slot it owned.

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

## Raw WebSocket client

Endpoint: `ws[s]://<host>/<encodedName>`

Framing: one JSON-RPC message per WebSocket text frame, no envelope. The broker forwards requests to the matching provider slot and returns responses on the same socket.

## Streamable HTTP client (MCP 2025-03-26)

Endpoints:
- `POST /<name>/mcp` with `Content-Type: application/json` — sends one JSON-RPC request, the response is held until the provider replies, then returned as `application/json`. Notifications (no `id`) get a `202 Accepted` immediately.
- `GET /<name>/mcp` — opens an SSE-style stream that receives all server-initiated notifications until the client disconnects. The session id is echoed in the `Mcp-Session-Id` response header (and read back from the request header if the client supplies one).

## Legacy SSE client

Endpoints:
- `GET /<name>/sse` — opens an SSE stream. Immediately emits one `endpoint` event whose `data:` is the URL the client must POST to:
  ```
  event: endpoint
  data: /<name>/messages?sessionId=<uuid>
  ```
- `POST /<name>/messages?sessionId=<uuid>` — body is a JSON-RPC request. Always returns `202 Accepted`. The response is delivered as a `message` event on the matching SSE stream.

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

## CORS

The broker always returns:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Accept, Mcp-Session-Id
Access-Control-Expose-Headers: Mcp-Session-Id
```

`OPTIONS` preflights return `204 No Content`.
