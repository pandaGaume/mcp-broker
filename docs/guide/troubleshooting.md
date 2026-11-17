<!-- Generated from node/packages/broker/src/broker/broker.guides.ts by node/scripts/build-site.mjs --guides. Do not edit. -->

> **Troubleshooting.** Symptom to cause to fix, starting with the silent failures that produce no log line anywhere. This is the page a running broker serves as `broker://guide/troubleshooting` and through `broker_guide({ topic: "troubleshooting" })`; the live copy also carries that deployment's effective configuration (host, port, scheme, paths), so prefer it when you can reach a broker.

# Troubleshooting

Call `broker_diagnose()` first. It reads the live state and names the problems
it can prove, each with a fix. This page is the reference behind it, and covers
the failures the broker cannot see from the inside.

## Symptom table

| symptom | cause | fix |
|---|---|---|
| Client hangs forever on `initialize`, and the provider shows connected | transport / path mismatch: a MultiplexTransport on `/provider/<name>` | move the provider to `ws://<host>/providers`, or switch it to `DirectTransport` on `/provider/<name>` |
| Provider socket is open, but the slot never appears in `providers_list` | transport / path mismatch the other way: a DirectTransport on `/providers` | move it to `ws://<host>/provider/<name>`, or switch it to `MultiplexTransport` |
| Provider connects to `/providers/<name>` and nothing works | that path is neither endpoint: it is accepted as a CLIENT on a slot named `providers/<name>` | drop the name from the URL for multiplex, or add `/provider/` for a dedicated socket |
| WebSocket upgrade refused with HTTP 400 before it opens | the path cannot work: bare `/provider` (no slot name) or `/provider/a/b` (more than one segment) | append one slot name; percent-encode a `/` inside it. The 400 body is the full diagnosis; a browser sees only a bare `error` event, so read the broker log |
| Socket opens, then closes immediately with 1008 naming DirectTransport or MultiplexTransport | the broker detected the transport/path mismatch on your first frame | apply either correction the reason names; do not reconnect unchanged |
| WebSocket closes with 1008 `already connected` right after a page reload | a stale socket still holds the slot | release on `pagehide`; a dead holder is reaped within one heartbeat interval (default 30s), so retry rather than restart |
| MCP host reports `Connection closed` with no cause | a second broker could not bind the port | one broker per port; do not spawn one per host entry. `EADDRINUSE` is in the host's `mcp-server-<name>.log` |
| HTTP 403 `invalid_origin` from a page the broker itself serves | a static mount does not exempt the origin it serves | set `allowedOrigins` (or `MCP_BROKER_ALLOWED_ORIGINS`) to that exact origin, scheme and port included |
| `Provider "<slot>" not connected` at host start | ordering: the host starts before any provider exists | point `MCP_BROKER_STDIO_PROVIDER` at `_all` |
| Tool list is stale and never refreshes | a remote upstream's server-to-client stream dropped and is not reopened | restart the broker; the slot keeps answering requests, which is why nothing looks broken |
| `_all` shows only `_broker-*` tools | no provider opted into the aggregate, or the opt-in shape this broker honors differs from the one the provider sent | see the aggregate opt-in section in `broker://guide/publish-provider`, and never assume an opt-in took: verify with `tools/list` on `_all` |
| Host's tool list goes empty after enabling authorization | the stdio bridge reaches `_all` anonymously | grant the anonymous subject, or stop using the bridge for authorized deployments |
| Browser provider gets a bare `error` event and never connects | provider auth is on; a browser cannot send the required header | run without a provider secret, or authenticate in a reverse proxy |
| Provider gets `-32601` back for `sampling/createMessage`, `roots/list` or `elicitation/create` | the broker relays no request opened by a provider; it answers at once instead of leaving it unanswered (`ping` is answered `{}`) | do not depend on server-to-client requests behind the broker |
| Broker exits at start with `Cannot use the config file` | the designated or discovered config file is missing, is not valid JSON, or is not an object; the broker fails closed rather than start without its security settings | fix the file named in the message, or point `MCP_BROKER_CONFIG` at a valid one |
| `-32601 Method not found` on `_all` for `resources/list` | `_all` covers tools and prompts only | connect to the provider's own slot for resources |
| `-32602 Unknown aggregated tool` on a name you built yourself | prefixed names are capped, hashed and de-duplicated | re-run `tools/list` and pass the returned name back verbatim |
| Subscribed, but `notifications/resources/updated` never arrives | the provider's notification names a different URI (matching is exact), carries no `params.uri` (dropped and logged once), or your read grant was revoked (you were unsubscribed) | compare the URI byte for byte; check the broker log for a dropped update |
| `broker/authorization/declare` refused, `the provider is anonymous` or `shared secret` | declaring needs a provider identity of its own | add the provider to the security file's `providers` table and present its secret |
| `broker/authorization/declare` refused, `overlaps ... owned by provider` | another identity owns a subtree of that domain containing, or inside, yours, possibly since before it disconnected; a disconnection withdraws nothing | declare a sibling subtree, declare from the owning identity, or withdraw the old declaration: `broker/authorization/withdraw` from its owner, `broker_declaration_withdraw` (needs `broker.authorization.admin`) if it is gone; `broker_diagnose` reports it as `declaration-owner-offline` |
| `broker/authorization/declare` refused, `capability vocabulary differs from the domain's` | every owner of a domain declares the same `capabilities` and `resultsRequired` | declare the vocabulary `broker://domains` lists for the domain |
| `broker/authorization/declare` refused, `not one of its owners` or `outside the subtree the security file assigns` | `authorization.domains` in the security file fixes who declares that domain, and where | declare from a listed identity inside its subtree, or change the security file |
| `broker/authorize` answers `-32602 principal.ref is unknown, expired` | the request the reference came with was answered, or the reference is used on another slot | ask before answering, on the socket the request arrived on |
| A provider's own method, or an extension method such as `tasks/get`, answers `-32001 Forbidden` with authorization on; the audit names `mcp.unclassified-method` | an unknown request is refused by default | classify it in `auth.methodCapabilities`, then grant that capability |
| Every decision is `no-matching-grant` | the caller is anonymous (client OAuth off, or a subject mapping that yields nothing), or no assignment grants that capability | enable client auth, check `subjectMapping`, grant the capability in `auth.assignments` |
| Client refused on a protected slot (WebSocket 1008, HTTP 403) | only the declarer's own client identity may call it | that is the protection working; call it through the declaring provider |
| Broker exits at start naming the security file | it is missing or invalid, a secret variable is unset, or `auth` sits in both files | fix what the message names |
| `-32000 Subscription limit reached` | `maxSubscriptionsPerClient` or `maxSubscriptionsPerSlot` | unsubscribe what you no longer watch; raise the limit in `resourceSubscriptions` |
| `resourceSubscriptionCount` in `provider_status` only grows | Streamable HTTP clients leave without `DELETE`; their sessions and subscriptions never expire | send the DELETE on shutdown; restart the broker if the count is already large |

## The transport/path mismatch, in detail

This one deserves its own section because it produces the least evidence.

The broker refuses both directions on the first frame, answering in the framing
the peer can decode and closing with `1008` and a reason naming both
corrections. That covers the common case. It cannot cover a provider that
connects and sends nothing, and it does not exist in brokers before 1.3.0, so
the manual diagnosis below is still what you fall back to.

`DirectTransport` speaks plain JSON-RPC; `MultiplexTransport` speaks
`{ provider, payload }` envelopes. The broker decides which language to speak on
a socket from the URL that socket connected to, not from what arrives on it.

- Slot-scoped path `/provider/<name>`: the broker registers the slot from the
  URL at connect time and then writes plain frames. A multiplex provider on that
  path shows `connected: true` while silently discarding everything the broker
  sends, because it is not an envelope.
- Multiplex path `/providers`: the broker learns slot names from envelopes only.
  A plain frame decodes to nothing and is dropped, so no slot is ever created.

**How to confirm it in ten seconds.** Call
`provider_status({ name: "<slot>" })` while a client request is outstanding:

- `connected: true`, `transport: "ws"`, `pendingCount` > 0 and never falling:
  a multiplex provider is sitting on the slot-scoped path. This is the case.
- the slot is absent from `providers_list` entirely while your socket is open:
  a direct provider is sitting on the multiplex path.

`broker_diagnose` runs exactly these two checks for you.

## The slot is wedged after a crash

A slot is occupied while the incumbent socket is `readyState === OPEN`, and a
socket killed without a close frame stays OPEN until the OS TCP keepalive
expires, which is hours. The heartbeat is what bounds that: every provider
socket is pinged every `providerHeartbeatIntervalMs` (default 30000), and one
that misses a full interval is terminated and its slot freed. So the wedge
lasts one interval, not a restart.

If it lasts longer, check the three things that disable the recovery:

- `providerHeartbeatIntervalMs: 0` turns the heartbeat off entirely. With no
  liveness evidence the broker refuses every takeover, by design.
- `providerTakeover: "reject"` never hands a live slot over, whatever the
  heartbeat says.
- The incumbent is answering pings but not serving. An RFC 6455 pong comes from
  the network stack, so a throttled or wedged JS thread still looks alive. The
  request timeout below is what catches that.

The broker prints the reason it refused a takeover on every 1008, including
which of these applies. Prevention is still cheaper: release explicitly on
`pagehide` in a browser and on `SIGTERM` / `SIGINT` in a process.

## Requests that never come back

A pending entry is released by a matching response, by the provider
disconnecting, by the caller's own connection closing, or by
`providerRequestTimeoutMs` expiring (default 60000; `0` disables it). On expiry
the caller gets `-32000 Provider "<name>" did not respond within <ms>ms`,
addressed to its own request id, and the broker logs the three usual causes.

So a request that hangs *forever* now means either the timeout is disabled or
the request never reached a provider at all, which is the transport/path
mismatch above. A request that fails at the deadline means the provider is
connected and not answering: the ordinary case is a throttled background browser
tab. `pendingCount` in `provider_status` is the number of requests in flight,
and one that only grows is the signal. Raise the timeout only if you host
genuinely long-running tools.

## Sessions outliving their clients

Streamable HTTP and SSE sessions do not expire. A client that closes its tab
without sending `DELETE /<slot>/mcp` leaves its session alive, and every
notification the provider broadcasts is queued into it, without bound, and
every resource subscription it took stays held, pinning the provider's own.

The broker cannot tell a live session from an abandoned one, so no single
reading proves a leak. `sessionCount` in `provider_status` growing monotonically
across a run, and never falling when clients go away, is the signal. Note that
`clientCount` counts raw WebSocket clients only: a perfectly healthy HTTP client
shows as `clientCount: 0, sessionCount: 1`. Send the DELETE when a client is
done; restart the broker if the count is already large.

## Reading the console

The broker prints one line per accepted WebSocket upgrade, naming the path, the
role the router assigned (`dedicated-provider`, `multiplex-provider` or
`client`) and the slot it landed on. A provider URL that came out as
`role=client` is the mismatch, caught for free. In stdio mode every log goes to
stderr, so look in the host's `mcp-server-<name>.log`, never on stdout.

Do not read silence as success or as failure. Client sessions, routed frames and
provider replies are not logged at all. `providers_list` and `broker_diagnose`
are the ground truth for what is actually connected.
