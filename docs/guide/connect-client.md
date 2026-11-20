<!-- Generated from node/packages/broker/src/broker/broker.guides.ts by node/scripts/build-site.mjs --guides. Do not edit. -->

> **Connect a client.** Reach a slot: the four client transports, the reserved `_broker` and `_all` slots, origins, authorization, error codes. This is the page a running broker serves as `broker://guide/connect-client` and through `broker_guide({ topic: "connect-client" })`; the live copy also carries that deployment's effective configuration (host, port, scheme, paths), so prefer it when you can reach a broker.

# Reach a slot as an MCP client

## 1. Endpoints, per slot

| transport | endpoint | notes |
|---|---|---|
| Streamable HTTP | `POST`, `GET`, `DELETE` `http(s)://<host>/<slot>/mcp` | current MCP transport, use this; sessions (`initialize`) and stateless requests (2026-07-28) |
| Legacy SSE | `GET http(s)://<host>/<slot>/sse` then `POST .../<slot>/messages` | 2024-11-05 HTTP+SSE, kept for old hosts |
| Raw WebSocket | `ws(s)://<host>/<slot>` | bare JSON-RPC frames, no session layer |
| stdio bridge | the broker process itself | one slot per broker process, see `broker://guide/host-config` |

`<slot>` is the slot name. The HTTP router splits the path on `/` and requires
exactly two segments, so a slot name containing `/` must be percent-encoded:
slot `a/b` is reachable at `/a%2Fb/mcp`.

Default path suffixes are `/mcp`, `/sse` and `/messages`; call `broker_info` to
read the effective values if the deployment customized them.

## 2. Connecting to a slot that has no provider

Slots are lazy. Connecting to a name nobody serves is not an error: the
connection succeeds and every request is answered with
`-32000 Provider "<slot>" not connected`. Call `providers_list` on `_broker` to
see which names actually exist, or `broker_diagnose` to be told why one is empty.

## 3. Reserved slots

### `_broker`

The broker's own introspection server, and nothing else. It exposes
`broker_info`, `providers_list`, `provider_status`, `broker_guide` and
`broker_diagnose`, plus the resources `broker://info`, `broker://providers`,
`broker://providers/{name}` and `broker://guide/{topic}`. It does not proxy any
other provider. It is available from the moment the broker finishes starting.

`broker://providers` and `broker://providers/<name>` can be subscribed to: a
slot appearing, a provider attaching or detaching, a slot joining or leaving
`_all` each send `notifications/resources/updated`. Counters (`pendingCount`,
`clientCount`, `sessionCount`) never do, since reading moves them; read them
when you need them. A slot name is percent-encoded in its URI, so slot `a/b`
is `broker://providers/a%2Fb`.

### `_all`

An aggregate, not a proxy. It presents the union of the tools and prompts of
every **opted-in** provider as one MCP server. Membership covers configured
upstreams (`stdioUpstreams`, `mcpServers`, `mcpbBundles`), `_broker` itself, and
WebSocket provider slots that sent the aggregate opt-in frame. See
`broker://guide/publish-provider` for how a provider opts in.

Names are prefixed with the origin slot:

```
  <slot>-<original>        e.g. weather-forecast, _broker-broker_info
```

**Never reconstruct a prefixed name.** The prefixed name is capped at 64
characters, and an overlong one is truncated and given a hash suffix; a
collision between two providers is broken with a `-2`, `-3` suffix. The mapping
back to `(provider, original)` is a lookup table, not a parse. Call `tools/list`
on `_all` and pass the returned string back verbatim in `tools/call`.

Descriptions are tagged with their origin, `[<slot>] <original description>`, so
you can tell where a tool came from without parsing its name.

`_all` implements `initialize`, `ping`, `tools/list`, `tools/call`,
`prompts/list` and `prompts/get`. **Everything else returns
`-32601 Method not found`**, including `resources/list` and `resources/read`. If
you need a provider's resources, connect to that provider's own slot.

`_all` emits `notifications/tools/list_changed` and
`notifications/prompts/list_changed` whenever a provider joins, leaves, or
changes its catalog. A client that subscribes sees a provider that arrives
mid-session without reconnecting.

### Subscribing to resources

On any slot but `_all`, `resources/subscribe` and `resources/unsubscribe` work on
every transport (WebSocket, SSE, Streamable HTTP, stdio). The broker keeps the
subscriptions per session and sends the provider one subscribe per URI, so N
clients cost the provider one. `notifications/resources/updated` reaches only
the sessions subscribed to that exact URI (no normalization); every other
notification is still broadcast to the whole slot.

- Subscribing twice is one subscription; unsubscribing from something you do
  not hold succeeds.
- Closing the socket, the SSE stream, or sending `DELETE /<slot>/mcp` releases
  everything the session held. A Streamable HTTP session that is never deleted
  never expires, and neither do its subscriptions.
- Limits: 64 URIs per client, 1024 client subscriptions per slot, URIs of at
  most 2048 characters (`resourceSubscriptions` in the config). Past a limit the
  answer is `-32000`, an overlong URI `-32602`.
- If the provider disconnects, subscriptions are kept and restored when a
  provider comes back, followed by one `updated` per URI so you re-read.

### Protocol 2026-07-28 (stateless)

A `POST /<slot>/mcp` without `Mcp-Session-Id`, whose request carries
`params._meta["io.modelcontextprotocol/protocolVersion"]`, is one stateless
request: no handshake, no session, the answer on that POST's response. Send
the headers the revision requires (`MCP-Protocol-Version`, `Mcp-Method`, and
`Mcp-Name` for `tools/call`, `prompts/get`, `resources/read` and the Events
methods); a mismatch is `-32020`. Sessions opened by `initialize` keep working
at the same URL. WebSocket, SSE and the stdio bridge stay on the handshake
revisions.

- **The broker probes each provider once** (a `server/discover` of its own, on
  the first stateless request after the provider attached). A provider that
  speaks 2026-07-28 (mcp-core 1.6 or later) gets each request as it is: MRTR
  (`input_required`), `subscriptions/listen` and the Events extension
  (`events/list`, `events/poll`, `events/stream`) work end to end.
- **A provider that speaks only the handshake revisions** (C, Python, stdio and
  remote upstreams, older mcp-core) is relayed in a session the broker opens
  with it: the stateless `_meta` is removed, the answer gets `resultType`,
  `ttlMs: 0` and `cacheScope: "private"`, and the broker answers
  `server/discover` from the provider's `initialize`. Its `subscriptions/listen`
  is served by the broker: list changes from the provider's session, resource
  updates through the same shared subscription (N listens on one URI cost the
  provider one `resources/subscribe`).
- **Logs and progress**, whatever the provider speaks: a request carrying
  `_meta.io.modelcontextprotocol/logLevel` gets the provider's
  `notifications/message` at that level or above on its response. A log names
  no request, so every such request pending on the slot gets it, and a
  handshake-only provider's own session level (default `info` in mcp-core) is
  a floor. `notifications/progress` reaches only the request whose
  `progressToken` it carries: the provider sees a token of the broker's, the
  client gets its own back.
- **A slot with no provider** answers `server/discover`, the lists (empty) and
  `subscriptions/listen` (list changes only) itself, and announces
  `list_changed` on the listen when the provider attaches.
- Methods 2026-07-28 removed (`ping`, `logging/setLevel`, `resources/subscribe`,
  `resources/unsubscribe`) answer `-32601` with HTTP 404.
- A listen or an event stream has no request deadline; closing its response
  cancels it, and the broker withdraws it at the provider. When the broker
  stops, it answers each one as a stopping server does.
- Authorization: `server/discover` and `subscriptions/listen` are free (each
  notification is checked on its way, each listened URI like a
  `resources/subscribe`); the Events methods need `mcp.events.read`.

## 4. Browser clients and the origin check

All three HTTP client endpoints, `/<slot>/mcp`, `/<slot>/sse` and
`/<slot>/messages`, refuse any request carrying an `Origin` header that is not
on the allow list, with HTTP 403. **The list is empty by default**, so out of
the box no browser origin passes while every non-browser client (which sends no
`Origin`) passes. This is deliberate: without the check any page in the user's
browser could drive the broker.

Serving the page from the broker's own static mount does NOT exempt it. Set the
origins explicitly:

```json
{ "allowedOrigins": ["http://localhost:3000", "https://app.example.com"] }
```

or `MCP_BROKER_ALLOWED_ORIGINS=http://localhost:3000,https://app.example.com`.
Match the scheme, host and port exactly, as the browser sends them; if the
broker runs with TLS the origin is `https://`, not `http://`.

The 403 body names the refused origin, says whether the list was unset or set
but non-matching, and states the comparison rule, so the usual causes (a
trailing slash, `http` against a TLS broker, a missing port) are readable off
the response.

The **WebSocket** endpoints carry no origin check at all: `ws://<host>/<slot>`
and the two provider paths are gated by authorization and by provider auth,
never by `Origin`. Do not treat a working WebSocket as evidence that the same
page's HTTP requests will pass.

## 5. Authorization

When OAuth 2.1 is enabled, every HTTP request to a slot must carry
`Authorization: Bearer <token>` issued for that slot's canonical resource URI. A
missing or invalid token gets 401 with an RFC 9728 `WWW-Authenticate` challenge;
a valid token lacking the required scope gets 403 with the missing scope named
in the challenge. Protected Resource Metadata is served unauthenticated so a
client can discover the authorization server after the first 401.

On `_all`, authorization filters the catalog rather than rejecting the call: a
caller sees only the providers it is scoped for, and a tool it may not see
answers `-32602 Unknown aggregated tool`, deliberately indistinguishable from a
name that does not exist.

## 6. Errors you can receive, and what they mean

| error | meaning |
|---|---|
| `-32000 Provider "<n>" ... not connected` | the slot exists but nothing is serving it right now |
| `-32000 Provider "<n>" disconnected` | the provider dropped while your request was in flight |
| `-32000 Provider "<n>" is no longer connected` | `_all` routed to a provider that left between list and call |
| `-32000 Provider "<n>" did not respond within <ms>ms` | the provider stayed connected and never answered; raise `providerRequestTimeoutMs` for genuinely long tools |
| `-32601 Method not found` | on `_all`, a method outside tools and prompts |
| `-32602 Unknown aggregated tool` | on `_all`, a stale or invisible prefixed name; re-list |
| HTTP 403 `invalid_origin` | your `Origin` is not on the allow list |
| HTTP 401 / 403 | bearer token missing, invalid, or missing a scope |

A request that produces no reply at all is not in this table. That is the
transport/path mismatch described in `broker://guide/troubleshooting`; call
`broker_diagnose` and it will name it.
