<!-- Generated from node/packages/broker/src/broker/broker.guides.ts by node/scripts/build-site.mjs --guides. Do not edit. -->

> **Publish a provider.** Put an MCP server into a slot: the transport/path pairing rule, the aggregate opt-in, the lifecycle, browser limits. This is the page a running broker serves as `broker://guide/publish-provider` and through `broker_guide({ topic: "publish-provider" })`; the live copy also carries that deployment's effective configuration (host, port, scheme, paths), so prefer it when you can reach a broker.

Operation budgets: declare budgetUnits along with capabilities, then use transport.broker.reserveBudget / settleBudget or withBudget. Reserve requires a live caller-ref, capability, native resource, resourcePath, unit, quantity and idempotencyKey. Declaring a unit grants nothing. A rule requiring a unit refuses unsupported providers.
A reservation is debited before native work. Never execute a replayed grant twice. Settlement and expiry never refund units in this version. Enforce expiry and physical network limits locally. broker/authorize only checks rights and consumes no quota.
# Publish an MCP server into a broker slot

## 1. The pairing rule

A provider's transport and its URL path are a matched pair. This is the single
most expensive mistake to make against this broker: both ways of getting it
wrong leave every side believing it succeeded.

```
  DirectTransport      <->  ws://<host>/provider/<name>    plain JSON-RPC frames
  MultiplexTransport   <->  ws://<host>/providers          envelope frames { provider, payload }
```

`ws://<host>/providers/<name>` is NEITHER of those two. The broker's router
matches `/providers` exactly and `/provider/` as a prefix, so a URL that starts
with `/providers/` falls through to the client branch and is accepted as an MCP
**client** on a slot literally named `providers/<name>`. Nothing errors. Your
provider is not published, and the slot you meant stays empty forever.

Two more paths that look plausible and are not. Both are now refused at the
WebSocket handshake with HTTP 400, and the response body is the full
diagnosis; a Node client reads it off the `unexpected-response` event, a
browser sees only a bare `error` event and you have to read the broker log:

- `ws://<host>/provider` with no name. It used to be accepted and to occupy a
  slot literally named `(unnamed)`, which no client could address.
- `ws://<host>/provider/a/b`, more than one segment after the prefix. A slot
  name containing `/` must be percent-encoded: `/provider/a%2Fb`. Both
  spellings resolve to the same slot, so only the encoded one is accepted and
  nothing is lost. Prefer a flat name anyway.

## 2. How each mismatch presents

The broker inspects the first frame on a provider socket and refuses both
directions: it answers in the framing the peer can actually decode, then
closes with code `1008` and a reason naming both corrections. Only an
unambiguous frame triggers this (an envelope with no `jsonrpc` on the
slot-scoped path, a `jsonrpc` frame that is not an envelope on the multiplex
path), so a dialect the broker does not recognize is still left alone.

Do not rely on the refusal. It cannot fire before your first frame, so a
provider that connects and stays silent still looks connected, and older
brokers say nothing at all. The signatures below are what you read then.

**MultiplexTransport pointed at `/provider/<name>`.** The slot-scoped path takes
the slot name from the URL at connect time, so registration succeeds before any
frame exists: `providers_list` reports `connected: true, transport: "ws"`. But
the broker now writes plain JSON-RPC onto that socket, and MultiplexTransport
drops every frame that is not an envelope. Your MCP server never receives
`initialize`. Meanwhile your envelope-wrapped replies carry no top-level `id`,
so the broker classifies them as notifications and broadcasts them instead of
answering the waiting request.

  Observable signature: `provider_status` shows `connected: true`,
  `transport: "ws"`, `pendingCount` climbing and never returning to 0, while the
  client's `initialize` never resolves. `broker_diagnose` reports this as
  `transport-path-mismatch`.

**DirectTransport pointed at `/providers`.** The multiplex path learns slot names
only from envelopes. A plain JSON-RPC frame has no `provider`/`payload` pair, so
it is dropped and no slot is ever claimed.

  Observable signature: the socket is open on your side, and the slot does not
  appear in `providers_list` at all. Clients get
  `-32000 Provider "<name>" not connected`.

## 3. Dedicated socket (DirectTransport)

One socket per slot. The slot is claimed the instant the socket opens, before
any frame is sent, so a client arriving first is served immediately.

```ts
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { McpServerBuilder } from "@cyanmycelium/mcp-core";

const transport = new DirectTransport("ws://localhost:3000/provider/my-slot");
const server = new McpServerBuilder()
    .withName("my-slot")
    .withTransport(transport)
    .register(/* your behaviors */)
    .build();

await server.start(); // opens the socket
```

`server.start()` resolving means the socket reported itself open. It does NOT
mean the broker accepted the slot: a refusal arrives after the open as a
WebSocket close with code 1008, and the reason string says which refusal it was.

## 4. Shared socket (MultiplexTransport)

One socket carrying N slots, keyed per frame. Use it when one page or one
process publishes several servers.

```ts
import { MultiplexTransport } from "@cyanmycelium/mcp-broker-provider";

const a = MultiplexTransport.create("scene-1", "ws://localhost:3000/providers");
const b = MultiplexTransport.create("scene-2", "ws://localhost:3000/providers");
// a and b share one WebSocket. Same URL means same socket.
```

On open it sends one registration notification per slot,
`{ "provider": "<name>", "payload": { "jsonrpc": "2.0", "method": "notifications/register" } }`,
so the broker creates the slot before your first MCP frame. MultiplexTransport
reconnects on its own with exponential backoff and jitter, capped at 30s.
DirectTransport does not reconnect at all: if you need that, reconnect yourself
in `onClose`.

## 5. Wire format

Slot-scoped socket, both directions, plain MCP frames:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
```

Multiplex socket, both directions, every frame wrapped:

```json
{ "provider": "scene-1", "payload": { "jsonrpc": "2.0", "id": 1, "method": "tools/list" } }
```

A frame the broker cannot decode on the multiplex socket is dropped, and the
first drop per socket is logged with the reason. A plain JSON-RPC frame there
is not merely dropped: it is the DirectTransport-on-`/providers` mismatch, so
it is answered with a bare JSON-RPC error and the socket is closed with `1008`.
A tunnel-level refusal comes back as an envelope whose payload is a JSON-RPC
error with `id: null` and code `-32000` (slot unavailable) or `-32001`
(registration forbidden).

## 6. Joining the `_all` aggregate

A provider is NOT in `_all` by default. Opting in is per provider and depends on
how the provider reaches the broker.

| provider kind | how it joins `_all` |
|---|---|
| WebSocket on `/provider/<name>` | send the aggregate opt-in as the socket's **first** frame, see below |
| WebSocket on `/providers` (multiplex) | announce it in the registration envelope, see below |
| `stdioUpstreams[]` config entry | set `"aggregate": true` (omitted means NOT aggregated) |
| `mcpServers[]` config entry | aggregated by default; set `"aggregate": false` to opt out |
| `mcpbBundles[]` config entry | aggregated by default; set `"aggregate": false` to opt out |
| `_broker` | always, automatically |

### From the SDK

```ts
new DirectTransport("ws://localhost:3000/provider/my-slot", { aggregate: true });
MultiplexTransport.create("my-slot", "ws://localhost:3000/providers", { aggregate: true });
```

Both send the JSON-RPC-shaped registration notification on open,
`{"jsonrpc":"2.0","method":"notifications/register","params":{"aggregate":true}}`,
wrapped in an envelope on the shared socket.

### The raw control frame

The broker also accepts a non-JSON-RPC control frame on the slot-scoped path,
which is what to send when you drive the socket yourself:

```ts
const ws = new WebSocket("ws://localhost:3000/provider/my-slot");
ws.onopen = () => {
    ws.send(JSON.stringify({ type: "register", aggregate: true }));
    // ... then hand the socket to your transport / start the server
};
```

It must be the FIRST frame on that socket. The broker inspects exactly one frame
per socket for this, and a frame carrying `jsonrpc` is routed as traffic, so a
socket that has already sent an MCP frame stays non-aggregated for its whole life.

**Do not assume the opt-in took.** The two shapes are honored by different
broker versions, and a refused or ignored opt-in produces no error. Verify:
call `tools/list` on the `_all` slot and look for your `<slot>-<tool>` names, or
call `broker_diagnose()`, which reports `aggregate-empty` and
`aggregate-missing-live-slots` when a connected slot is not in the aggregate.

**Install your MCP message handler before you opt in.** The moment the broker
accepts the aggregate registration it opens an internal client and sends
`initialize`. A provider that is not listening yet fails that handshake and is
dropped from `_all` silently, with no log and no retry.

## 7. Lifecycle: connect, register, release

1. **Connect.** Open the WebSocket at the path that matches your transport.
2. **Register.** Slot-scoped: automatic, from the URL. Multiplex: from the first
   envelope, which the SDK sends on open. Optionally opt into `_all` first.
3. **Release.** Close the socket. There is no release message: the only control
   frame the broker understands is the registration frame. On close the broker
   clears the slot and fails every in-flight request with
   `-32000 Provider "<name>" disconnected`, echoing the original request id.

**Release explicitly anyway.** A slot is occupied while the incumbent socket is
`readyState === OPEN`, and a socket that dies without sending a close frame (a
hard kill, a crashed tab, a suspended laptop, devtools set to offline) stays
OPEN until the OS TCP keepalive gives up, which is hours.

```ts
// Browsers fire pagehide reliably on reload, navigation and tab close.
addEventListener("pagehide", () => transport.close());
```

A ws-level ping/pong heartbeat is what stops that from wedging the slot
forever. Each provider socket is pinged every `providerHeartbeatIntervalMs`
(default 30000; `0` disables it), and one that misses a full interval is
terminated and its slot freed. So a reconnect in the gap is still refused with
close code 1008 and reason `Provider "<name>" is already connected`, but the
window is one interval rather than hours. Releasing on `pagehide` is what makes
it instant instead.

`providerTakeover` decides who wins the contention: `"liveness"` (default) lets
the newcomer in only once the incumbent has missed a heartbeat, `"reject"` never
hands a slot over, and `"always"` is honored only when provider authentication
is configured and the newcomer authenticated as the same principal (otherwise
the broker logs why and falls back to `"liveness"`).

One honest limit: an RFC 6455 pong is answered by the browser's network stack,
so the heartbeat proves the process is alive, not that the page's JS thread is
serving. A throttled background tab answers pings and still never replies to a
request; `providerRequestTimeoutMs` is what covers that case.

### Resource updates

The broker answers `resources/subscribe` and `resources/unsubscribe` itself and
sends your provider **one** subscribe per URI, however many clients asked, and
one unsubscribe when the last of them leaves. Implement them the plain MCP way;
an mcp-core `McpServer` (1.3.0 or later) does it for you, and a behavior only
raises `onResourceUpdated(uri)` (an `McpAdapterBase` calls
`_forwardResourceContentChanged(uri)`).

- Every `notifications/resources/updated` must carry `params.uri`, the exact
  string the client subscribed with. The broker delivers it to the sessions
  subscribed to that URI and to no one else. One without a usable `uri` is
  dropped and logged once per slot, never broadcast.
- After a reconnect the broker restores what clients still hold: it replays the
  last `initialize` a client sent on the slot, then `notifications/initialized`,
  then one `resources/subscribe` per URI. **Install your message handler before
  the socket opens**, or that handshake waits for `providerRequestTimeoutMs`.
  Each subscriber then gets one `notifications/resources/updated`, since the
  content may have changed while you were away.
- A URI you refuse on replay is dropped along with its subscribers; their
  re-read then fails, which is how they learn.

## 8. Refusals you can receive

On the slot-scoped socket a refusal is a WebSocket close with code 1008; the
reason string is the message below. On the multiplex socket it is an error
envelope for that slot name and the socket stays open.

| reason | cause | fix |
|---|---|---|
| `Provider "<n>" is already connected` | a live socket holds the slot | release on `pagehide`; a genuinely dead holder is reaped within one heartbeat interval (default 30s), so retry |
| `Provider "<n>" is reserved by the broker` | you targeted `_broker` or `_all` | pick another slot name |
| `Provider "<n>" is managed by a stdio upstream` | the name collides with a configured upstream | rename one of them |
| HTTP 401 at the handshake | provider auth is on and no credential was presented | see below |
| HTTP 403 at the handshake | your principal may not publish on that slot | widen `allowedResources` |
| 1008 `Slot "<n>" is protected: another principal publishes it` | the slot is in `protectedSlots` and your principal is not its `publishedBy` | publish under the configured principal, or pick another slot |

## 9. In a browser

- **A bundler is required.** Both packages ship ESM under `dist/`, with no
  `browser` field and no UMD build, so a plain `<script>` tag will not do.
- **Provider authentication cannot work from a browser.** The broker reads the
  provider secret from the `X-Provider-Token` header or from
  `Authorization: Bearer`, and the browser `WebSocket` constructor cannot set
  headers. Neither transport accepts a credential. If the broker is configured
  with a provider secret, every browser provider is refused at the handshake
  with HTTP 401, which reaches your page as a bare `error` event with no status.
  Run the broker without a provider secret, or terminate provider auth in a
  reverse proxy that injects the header.
- A page served by the broker's own static mount is still a browser origin for
  the purposes of the client-side origin check. Serving the page does not
  exempt it. See `broker://guide/connect-client`.

## 10. In Node

Both transports call the **global** `WebSocket` constructor with no import. Node
22 and later provide one. On Node 20 assign a polyfill before connecting:

```ts
import WebSocket from "ws";
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
```

If the MCP server and the broker live in the same process, skip WebSockets
entirely and call `tunnel.registerLoopbackProvider(name, transport)` with an
in-process transport. See `broker://guide/deploy`.

## 11. Declaring an authorization domain (broker 1.5.0)

A provider that serves its own kind of resource (SCADA is the first) can let
the broker decide who may do what on it, instead of carrying a policy of its
own. It needs an identity: an entry in the security file's `providers` table
(or a principal passed to `registerLoopbackProvider`). The legacy shared
secret identifies nobody in particular and is refused.

1. **Declare**, once connected: `await transport.broker.declare({ version,
   domain, namespace: { resource }, capabilities, resources?, protects?,
   resultsRequired? })`. A resource may carry engineering `limits`
   (`minValue`, `maxValue`, `allowedValues`, `destinations`, nothing else).
   A declaration describes and grants nothing: `assignments`, `roles` and
   `denies` refuse it, every capability must be `<domain>.<name>`, every
   path must lie inside `namespace.resource`, itself inside the provider's
   `allowedResources`. One problem refuses it whole; the error's
   `data.errors` lists them all. Until it resolves, serve nothing that
   needs a decision.
   A declaration belongs to (provider identity, slot). Redeclaring replaces
   only that slot. One identity may declare several domains, or the same
   domain on several slots, including overlapping namespaces. Each domain
   has one owner for the broker's lifetime, even after disconnect or
   replacement by another domain. Moving it to another identity needs a restart.
   Authorization, concrete resource checks, provider limit patterns, result
   promises and budget units use the originating slot's declaration.
   Operator limits stay global. broker_info and broker://authority list each
   declaration's slot and domain; decision and result audits carry both.
2. **Read the caller reference**: once a declaration is accepted, every
   request the provider receives carries `params._meta["io.cyanmycelium/caller"]`
   = `{ ref, correlationId, traceId? }`. It is opaque, valid on this slot while that
   request is pending, and good for nothing else. The broker removes any such
   key a client wrote, on every slot.
3. **Ask**: `await transport.broker.authorize({ principal: { type: "caller-ref",
   ref }, checks: [{ capability, resource, resourcePath, attributes? }] })`.
   `resource` is your native identifier, kept for the audit; `resourcePath`
   is the policy path. Prefer a qualified native id such as
   `vannes:/site/nord/valves/V-012`; this format is not enforced. The path
   is what the broker evaluates. One decision per check: `{ decisionId,
   effect: "allow" | "deny" | "allow-with-constraints", allowed, reason,
   policies?, obligations? }`. An allow on a resource with declared `limits`
   is `allow-with-constraints` and carries them in `obligations.constraints`:
   apply them right before executing. `allowed` is true only for a plain
   allow. `{ type: "provider" }` asks on the provider's own behalf, for
   background work. Anything else in `principal`, an identity above all,
   refuses the request.

   Resources can also declare `{ resourcePattern: '/nord/valves/{id}',
   where: { id: 'V-1\\d{2}' }, limits: { maxValue: 60 } }`. Named segments
   match one full segment; where uses RE2, compiled at declaration time.
   Literal segments, * and a final ** are supported. Patterns stay inside
   the namespace and provider allowedResources. Concrete limits, every
   matching declaration pattern and authorization.resourceLimits from the
   security file are intersected. Empty intersections deny (empty-limits).
   The audit names limitSources; broker_info and broker://authority show
   the patterns and operator limits. Budget reservations use the same limits.
4. **Report**: once the operation is over, `transport.broker.reportResult({
   decisionId, result: "success" | "failure" | "refused", nativeStatus?,
   errorCode? })` (the `broker/audit/result` notification). The broker writes
   it next to the decision in its audit. For capabilities listed in
   `resultsRequired`, an allowed decision left without a report is shown by
   `broker_diagnose` (`decision-result-overdue`).

The `correlationId` is the client's `X-Correlation-Id` when a Streamable
HTTP or SSE client sent a usable one (`[A-Za-z0-9._:-]`, at most 128
characters); otherwise the broker makes one up.

Reasons specific to this API: `undeclared-resource` (outside the namespace,
or a declared resource under another path), `undeclared-capability`, and
`no-policy` (the broker has no policy engine, so it grants nothing). Grants
come from the security file's `auth.roles` and `auth.assignments`, written by
the broker's operators; the caller's subjects come from its OAuth token (or,
in development mode, from its `auth.dev` token), so without client
authentication every caller is anonymous and denied.

**Protected slots** (`authorization.protectedSlots` in the security file) are
configured by the operators and closed from startup: only clients holding one
of the declarer's `subjects` may call one, only `publishedBy` may publish it,
and it never joins `_all`. A declaration lists them in `protects` to confirm
them; it cannot create one.

A broker from 1.4.1 on answers every `broker/*` request at once, refusals
included. An older one drops them, which is why the transports accept
`brokerRequestTimeoutMs`, off by default.
