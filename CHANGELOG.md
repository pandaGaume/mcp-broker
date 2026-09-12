# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Packages are versioned and released independently:

| package | folder | tag series |
|---|---|---|
| `@cyanmycelium/mcp-broker` | `node/packages/broker` | `node-v*` |
| `@cyanmycelium/mcp-broker-provider` | `node/packages/provider` | `provider-v*` |

Entries below are grouped per release and marked **broker** or **provider** when
only one package is affected. `@cyanmycelium/mcp-core` ships from its own
repository; the changes it needed for this release are listed under
[Coordinated releases](#coordinated-releases).

---

## [Unreleased]

### Added

- **c** A new `c/` folder, the device side of the tunnel in C99. `libmcpb`
  (moved from the CyanMycelium repository, now 0.2.0) gains the `_all` opt-in
  (`aggregate`, sending `notifications/register` as the first frame after
  every connection) and link events that carry the peer's refusal: the
  WebSocket close code and reason (a broker `1008` names the mismatch or the
  policy), and the HTTP status of a refused handshake. A host port for Linux,
  macOS and Windows, a transport-only sample provider (`host-provider`), and a
  roundtrip test that drives the Node broker: own slot, `_all`, broker kill
  and restart. Not published anywhere; consumed from the repository. See
  [`c/README.md`](c/README.md).
- **c** `c/espressif/`: the ESP-IDF component `mcpb_esp` (libmcpb on esp-tls
  and lwip, TLS through the certificate bundle, one FreeRTOS task, link
  events on the default `esp_event` loop, an outbox for messages from other
  tasks, sizes in Kconfig) and a Wi-Fi sample project serving the same `echo`
  tool as the host sample. Built for the ESP32-S3 in CI with the official
  IDF 6.0 image; 7.4 KB of flash code and 13 KB of RAM with the defaults.

## [1.3.0] - 2026-09-02

The theme of this release is **turning silent failures into named ones**. Nearly
every fix here converts a hang, a dropped frame or a misleading log line into a
message that says what went wrong and what to do about it. The second theme is
first-attempt integration: the broker now documents itself over MCP, and
diagnoses itself.

### Added

- **broker** `broker_guide({ topic? })` and the resources `broker://guide/index`,
  `broker://guide/publish-provider`, `broker://guide/connect-client`,
  `broker://guide/host-config`, `broker://guide/deploy`,
  `broker://guide/troubleshooting`, plus the template `broker://guide/{topic}`,
  on the reserved `_broker` slot. Six Markdown pages derived from the broker's
  own source, with the deployment's *effective* configuration (host, port,
  scheme, all six URL paths) appended to every page. An agent that can reach the
  broker no longer needs a README.
- **broker** `broker_diagnose({ slot? })` on `_broker`: live state plus the
  problems the broker can *prove*, each with `symptom`, `evidence` and an
  actionable `fix`. Twelve rules, including `transport-path-mismatch`, which
  correlates `transport: "ws"` with a climbing `pendingCount` to name the
  provider transport/path mismatch. Checks whose input is unreachable are
  reported in `checksSkipped` rather than guessed. Deliberately tool-only, with
  no backing resource, because a cached diagnosis is stale exactly when it
  matters.
- **broker** `providerHeartbeatIntervalMs` (default `30000`, `0` disables), env
  `MCP_BROKER_PROVIDER_HEARTBEAT_MS`, builder `withProviderHeartbeat()`. A
  ws-level ping/pong sweep on every provider socket. A socket that misses a full
  interval is terminated and its slot freed, which is what stops a half-open
  socket (killed tab, slept laptop, dropped VPN) from holding a slot for the ~2
  hours the OS takes to give up on the TCP connection. An RFC 6455 pong is
  answered by the network stack, so it proves the process is alive, not that the
  page's JS thread is serving; use `providerRequestTimeoutMs` for that.
- **broker** `providerTakeover: "reject" | "liveness" | "always"` (default
  `"liveness"`), env `MCP_BROKER_PROVIDER_TAKEOVER`, builder
  `withProviderTakeover()`. `"always"` is honored only when provider
  authentication is configured *and* the newcomer authenticated as the same
  principal; otherwise the broker logs why and falls back to `"liveness"`,
  because unconditional takeover would be a spoofing primitive.
- **broker** `providerRequestTimeoutMs` (default `60000`, `0` disables), env
  `MCP_BROKER_PROVIDER_REQUEST_TIMEOUT_MS`, builder
  `withProviderRequestTimeout()`. A pending request that expires is failed with
  `-32000 Provider "<name>" did not respond within <ms>ms`, addressed to the
  caller's own id, plus one warn line naming the three usual causes. Previously
  such a request hung forever, which is the ordinary outcome for a throttled
  background browser tab.
- **broker** `MCP_BROKER_PROVIDERS_PATH`, `MCP_BROKER_SSE_PATH` and
  `MCP_BROKER_MESSAGES_PATH`. All six `paths.*` keys now resolve as
  `env ?? config ?? default`, and all six reach the builder.
- **broker** `www.open` accepts a string as well as a boolean: an absolute path
  on this broker (`"/app/index.html"`) or an absolute `http(s)` URL on this
  broker's own origin. New exported pure helper `resolveOpenTarget(raw, baseUrl)`
  and `IOpenTargetResolution`.
- **broker** New exports from the package root: `ProviderTakeoverMode`,
  `providerPublishDecision`, `compileProviderAllowedResources`,
  `IProviderPublishDecision`, `ProviderPublishDenialReason`, the whole guide and
  diagnostics surface (`BROKER_GUIDES`, `brokerGuide`, `brokerGuideIndex`,
  `brokerGuideUri`, `brokerGuideTopicFromUri`, `diagnoseBroker`,
  `IBrokerDiagnosis` and friends), `BROKER_AGGREGATE_NAME`,
  `BROKER_RESERVED_SLOTS`, `isReservedBrokerSlot`, `IBrokerAggregateInfo`,
  `IBrokerSecurityInfo`, and the four behaviors and adapters.
- **broker** `IBrokerContext` gained three optional read-only accessors,
  `getAggregateInfo()`, `getSecurityInfo()` and `getStdioBridgeTarget()`, which
  `broker_diagnose` reads. Optional, so external implementations keep compiling.
- **provider** `aggregate?: boolean` on both transports:
  `new DirectTransport(url, { aggregate: true })` and
  `MultiplexTransport.create(name, url, { aggregate: true })`. This is the SDK
  way into the `_all` aggregate slot, which previously required hand-writing a
  raw control frame the SDK never sent. New exported types
  `IDirectTransportOptions`, `IMultiplexTransportOptions`,
  `ITunnelRegisterOptions`, and `encodeRegisterFrame()` in `/protocol`.
- **provider** Both transports queue outbound frames while the socket is down
  (bounded at 64, drop-oldest) and flush on open, instead of discarding them.
  `DirectTransport` in particular had no queue and assigned its socket only
  inside `onopen`, so everything written between `connect()` and open was lost.
- **provider** URL guards: `DirectTransport` warns when pointed at `/providers`,
  `MultiplexTransport` warns when pointed at `/provider/<name>`. Both fire
  before a socket opens, name the correct class and print a paste-ready
  corrected URL, and both say to ignore the warning if paths were reconfigured.
- **docs** New root [`AGENTS.md`](AGENTS.md): the single file an AI coding agent
  reads first. Topology table, the transport/path pairing rule, three
  copy-pasteable configurations, the reserved slots, a symptom-to-fix table, and
  an explicit anti-goals section.
- **docs** `_broker` and `_all` are now documented in the published broker
  README, which previously named none of the introspection tools and linked to
  files npm does not ship. `mcpServers`, `mcpbBundles` and the `aggregate` flag
  on `stdioUpstreams` are documented for the first time.
- **docs** New root [`samples/`](samples/) directory: five runnable integrations
  (`browser-provider`, `host-config`, `provider-lifecycle`, `app-host`,
  `embedded`), each self-contained, each proving itself end to end and marking
  the decisions that fail silently when made wrong. `samples/index.json` is the
  same content machine-readable, for an agent choosing a sample without opening
  the folders. Repo-only: `samples/` is not in the broker package's
  `package.json` `files`, so it does not ship to npm.
- **docs** This changelog.

### Fixed

- **broker** A provider socket admitted while its predecessor was still
  `CLOSING` had its registration nulled by the predecessor's deferred `close`
  handler, wedging the slot at `connected: false, transport: "none"` forever and
  evicting the provider from `_all` unrecoverably. The dedicated-provider close
  handler now carries the same `if (state.ws !== ws) return;` guard the
  multiplex path already had. Reproduced 40/40 rounds before the fix.
- **broker** No inbound WebSocket had an `'error'` listener, and Node rethrows
  an unhandled one. A single malformed text frame (an invalid UTF-8 sequence is
  enough) killed the whole process, taking every other provider and every client
  session with it. All three inbound handlers plus the WebSocket server and the
  HTTP server now have named error listeners.
- **broker** A listen failure was an uncaught `EventEmitter` throw outside the
  promise chain, so `main().catch` never ran. `start()` now rejects, and the
  message names the port, tells you to attach to the running broker at
  `<scheme>://<host>:<port>/_broker/mcp` rather than spawn a second instance
  that shares no slot, and names `MCP_BROKER_PORT`. `EACCES` and
  `EADDRNOTAVAIL` get their own text; the original error is preserved as
  `cause`. `stop()` no longer masks the real diagnosis when the tunnel never
  listened.
- **broker** Two clients on one slot could collide on JSON-RPC ids. Reproduced:
  two Streamable HTTP sessions both sending id `2` left one POST hanging
  indefinitely while the other received the *first* client's result body, a hang
  and a cross-session response leak that defeats the authorization layer above
  it. Pending requests are now namespaced per sink: the broker allocates its own
  `brk-<n>` id on the way out and restores the caller's id before delivery.
- **broker** A provider response whose id matched nothing was dropped in
  silence. It now warns once per slot, naming the unmatched id and both real
  causes: an id not echoed verbatim (including a `1` versus `"1"` type
  mismatch), or a server-to-client request the broker does not relay.
- **broker** The raw-WebSocket "not connected" error hardcoded `id: null`, so a
  client correlating by id discarded it and hung. It now echoes the request id
  and names `providers_list` as the way to see which slots are live. The same
  path also registered a pending entry *before* checking connectivity, pinning
  an id for a frame that was never sent; the legacy SSE path had the same bug.
- **broker** Both directions of the provider transport/path framing mismatch are
  now detected on the first frame, answered in the framing the peer can actually
  decode (an error envelope on the slot-scoped path, a bare JSON-RPC error on
  the multiplex path), and closed with `1008` and a reason naming both
  corrections. A merely malformed frame is left alone.
- **broker** WebSocket paths that are broken by construction are refused at the
  handshake with HTTP 400 and a body naming the fix: bare `/provider` (which
  used to mint a slot literally named `(unnamed)`) and `/provider/a/b`. The
  percent-encoded `/provider/a%2Fb` spelling, which aliases to the same slot,
  keeps working. Route classification is now shared between the connection
  handler and `verifyClient`, which previously duplicated it and could disagree.
- **broker** A close reason longer than 123 bytes made `ws` throw a
  `RangeError` inside a connection handler; several reasons interpolate a slot
  name, so a long hierarchical name was a latent uncaught exception. Every close
  reason is now truncated, written actionable-part-first. A `%zz` sequence in a
  URL slot name made `decodeURIComponent` throw a `URIError` in the same place;
  both call sites now fall back to the raw segment.
- **broker** Provider registration on the multiplexed `/providers` path could
  never join `_all`: the handler had no `addProvider` call at all. It now honors
  the aggregate opt-in, and the slot-scoped path accepts the JSON-RPC-shaped
  `notifications/register` with `params.aggregate` alongside the legacy
  `{"type":"register"}` control frame.
- **broker** A provider whose aggregate handshake failed was registered in
  `_all` with an empty catalog and no log. `initialize()` now throws on an error
  outcome, the request layer rejects on its 30 s timeout instead of resolving a
  synthetic error every caller read as a real answer, and `addProvider` logs the
  provider, the slot it did not join, the reason, and the fix.
- **broker** A dropped server-to-client stream on a remote (`mcpServers`)
  upstream was thrown away and never reopened, so the slot's tool list went
  stale permanently while POST traffic kept working and `providers_list` kept
  reporting it connected. It is now logged with the upstream's configured name
  and reopened with exponential backoff (500 ms base, capped at 30 s), gated so
  a deliberate `close()` never reconnects. A `405`/`501` still means "no GET
  stream" and stops quietly; `401`/`403` says the POST channel still works and
  to check the upstream headers are honored on GET.
- **broker** A frame from a provider that failed to parse was broadcast to every
  client as a notification with no log, so an integrator debugging
  `unexpected token <` had no way to tell which provider emitted a proxy's HTML
  error page. It is still broadcast (dropping it would turn a visible parse
  error into an indefinite hang), but now warned once per slot with the provider
  name and a 200-character excerpt.
- **broker** A thrown policy evaluation was audited as `"no-matching-grant"`,
  sending operators to write grants that could never help. It now logs the slot,
  subject ids, resource, capability, tool and the error message, and audits as
  `"evaluation-error"`. An invalid capability string audits as
  `"invalid-capability"` rather than as a policy miss.
- **broker** `SubjectMappingError` was caught and deliberately *not* logged, so
  the most likely authorization misconfiguration was the one case producing no
  output at all, after which every request was denied. Both the WebSocket path
  and the aggregate path now log it with the same diagnosis the HTTP path
  already returned, plus the consequence.
- **broker** A malformed `allowedResources` pattern denied every provider
  registration on that principal indistinguishably from a policy miss, and was
  re-parsed on every registration. Patterns are now compiled once and cached,
  the failure is logged loudly with the offending pattern and the consequence,
  and the new `providerPublishDecision()` returns the reason. A new
  `compileProviderAllowedResources()` throws for startup-time validation.
- **broker** All six `paths.*` config keys are now consulted. `paths.providers`
  and `paths.messages` were read nowhere, and `paths.sse` reached only the
  startup banner, so setting it advertised an endpoint that returned 404.
- **broker** `www.open` was root-only and gated on an undiagnosable flag: it
  collapsed any value to `"1"`, always opened `/`, and required a mount at `/`
  specifically, so `MCP_BROKER_BUNDLE_DIR` plus `MCP_BROKER_OPEN=1` silently
  opened nothing. The gate now checks the resolved path against the mounts that
  were actually registered, and says which prefixes exist when none covers it.
  A browser that fails to spawn warns instead of exiting 1.
- **broker** The startup banner now carries both provider endpoints with the
  framing and transport class each requires, the messages endpoint beside the
  SSE one, the reserved slots and the five `_broker` tools, the static mounts,
  and the `allowedOrigins` state. Every accepted WebSocket upgrade now logs one
  line naming the path, the role the router assigned and the slot; a provider
  URL that came out as `role=client` is the mismatch, caught for free. In the
  default setup a connection previously produced literally zero output.
- **broker** The stdio bridge warns when `MCP_BROKER_STDIO_PROVIDER` names a
  slot this broker does not host, naming the slots it does host and
  recommending `_all` with the reasons it works. Its "not connected" error now
  says a stdio host cannot wait for a provider to appear.
- **broker** `withTlsFiles` reads both PEMs synchronously, so a copied config
  template naming a `certs/` directory that does not exist failed with a bare
  `ENOENT` and no hint that TLS was on because a config file said so. The error
  now names both paths, the two path-resolution rules and the three ways out.
- **provider** Frames were silently discarded on both transports whenever the
  socket was not `OPEN`, with no queue, no `onError` and no log. See Added.
- **provider** `MultiplexSocket` had no stale-socket guard, so an orphaned
  socket's `close` nulled the live socket out from under the transports the
  broker was serving, after which the server silently stopped answering while
  reporting itself open. Every handler now checks socket identity, the reconnect
  timer is tracked and cleared, and a torn-down instance is marked dead rather
  than opening a rival socket to the same URL.
- **provider** A WebSocket close with a code other than `1000` now reaches
  `onError` with the code and the broker's own reason *before* `onClose`, which
  is what recovers the broker's refusal strings; they were thrown away at the
  transport boundary. A `1008` gets an explicit "policy refusal, not a network
  drop" hint.
- **provider** Every drop `MultiplexTransport` used to swallow is now a console
  line naming the cause and the fix: a non-envelope frame, an envelope for a
  slot no transport publishes, and a tunnel-level error. Repeats are sampled at
  one in 50 per socket.
- **docs** `docs/packages.md` said "four packages" over a three-row table and
  then "All three packages", and claimed the transports "leave
  `@cyanmycelium/mcp-core` in 0.5.0" when mcp-core is at 0.7.0 and no longer
  exports them.
- **docs** The broker README showed `withStdioUpstream` with three positional
  arguments; it takes one object, so the snippet did not compile.
- **docs** The broker README said `MCP_BROKER_OPEN` "requires
  `MCP_BROKER_WWW_DIR`"; it requires a static mount that covers the resolved
  path, from any of the three mount sources.
- **docs** The broker README linked to `../docs/authorization.md`, which 404s on
  npmjs.com because `docs/` is not in `package.json` `files`. Links that leave
  the package are now absolute GitHub URLs.
- **docs** `config.md`'s local-TLS recipe was unrunnable: `gen-cert` resolves
  `../certs` against the working directory and never writes `.mcp-broker/certs/`,
  so following it verbatim threw `ENOENT` before the server bound. It now shows
  `--out`.
- **docs** `protocol.md` stated a fixed `Access-Control-Allow-Headers` value the
  broker does not always send; it echoes the request's
  `Access-Control-Request-Headers` and the documented string is only the
  fallback, so a second implementation written from that spec would have
  rejected preflights carrying `Authorization`.
- **docs** `config.md` repeated the same "Pre-0.4 broker" note twice with two
  different candidate chains, so a reader could not tell which was
  authoritative.
- **docs** `web/README.md` pointed at `node/web/` (the directory is
  `node/packages/broker/web`) and gave an `npm start` recipe from a workspace
  root that has no `start` script, so the only static-mount recipe in the repo
  could not work as written.

### Changed

- **broker** Providers now receive broker-allocated string ids (`brk-<n>`)
  instead of the client's raw id. This is invisible to a conforming client,
  which gets its own id back, but a provider that assumes numeric ids or keys
  anything on the id's *type* will break. The JSON-RPC specification allows
  string ids and every SDK echoes them verbatim.
- **broker** A deployment that sets a non-default `paths.providers`,
  `paths.sse` or `paths.messages` in `config.json` has been silently running on
  the defaults. Those endpoints now move to the configured values.
- **broker** A pending provider request now fails after 60 s by default. If you
  host genuinely long-running tools, raise `providerRequestTimeoutMs` before you
  hit it.
- **broker** Provider sockets are pinged every 30 s by default, and a slot whose
  incumbent misses a full interval can be taken over by a reconnecting provider.
  Set `providerHeartbeatIntervalMs: 0` and `providerTakeover: "reject"` for the
  previous refuse-always behavior.
- **broker** Audit consumers: a thrown policy evaluation now writes
  `"reason":"evaluation-error"` and an invalid capability writes
  `"reason":"invalid-capability"`. Both values are new members of
  `AuthorizationDecisionReason`; the union is widened additively.
- **broker** A provider whose aggregate handshake fails is removed from `_all`
  and logged rather than registered with an empty catalog, so `_all`'s provider
  count can now be *lower* than the number of providers that opted in. That is
  the intended fix.
- **broker** `stop()` no longer rejects on `ERR_SERVER_NOT_RUNNING`, so a
  double `stop()` is silent. Every other close error still rejects.
- **broker** The `@cyanmycelium/mcp-core` dependency moves from `^0.7.0` to
  `^1.0.0`. mcp-core 1.0.0 is source-compatible with 0.7.0; the major bump
  aligns its version line with the broker's.
- **provider** The `@cyanmycelium/mcp-core` peer range widens from
  `>=0.4.0 <1.0.0` to `>=0.7.0 <2.0.0`, so an application on mcp-core 1.x no
  longer gets a peer warning, and one still on 0.7.x keeps installing.
- **broker** `start()` can now reject. It previously could not, so this strictly
  widens what an embedder can do, but a caller doing `void tunnel.start()` will
  see an unhandled rejection where it previously saw an uncaught exception.
- **broker** Log volume: every accepted WebSocket upgrade writes one line, and
  several previously silent failure paths now write one. In stdio mode all of it
  goes to stderr and cannot corrupt the JSON-RPC channel.
- **broker** The shipped `.mcp-broker.example/` template now has
  `auth.enabled: false`, with the whole block kept as a production reference,
  and no longer carries `providerSecret`, which is not gated by `auth.enabled`
  and therefore silently turned provider authentication on and refused every
  provider. It gained `allowedOrigins`, all six `paths` keys, the three
  provider-liveness keys and `aggregate: true` on its upstream. A second file,
  `config.stdio-bridge.json`, carries the `stdioProvider: "_all"` pairing;
  keeping it out of the main template avoids shipping a config that redirects
  stdout to JSON-RPC and makes a broker started in a terminal look dead.
- **provider** `DirectTransport.onError` now fires on ordinary network drops
  too, not only on refusals, because any close code other than `1000` is
  reported. `onClose` still fires in all cases.
- **provider** After a reconnect the broker receives a burst of queued frames
  rather than nothing, possibly including responses whose ids the broker already
  failed. Those are now warned about rather than dropped in silence.
- **provider** The transports write to `console.warn` / `console.error` where
  they were silent. Callbacks are unchanged, repeats are sampled, but a host
  that captures stdio should know the package can now print.

### Security

- **broker** **The legacy SSE endpoints did not check the `Origin` header.**
  `allowedOrigins` reached exactly one place, the Streamable HTTP endpoint at
  `/<slot>/mcp`. `GET /<slot>/sse` and `POST /<slot>/messages` were not covered,
  while `Access-Control-Allow-Origin: *` and a blanket 204 preflight were
  returned unconditionally. Any web page loaded in a browser that could reach
  the broker could therefore open an `EventSource` on `/<slot>/sse`, read the
  session id off the `endpoint` event, and drive the slot by POSTing JSON to
  `/<slot>/messages` as a CORS *simple* request, with no `Content-Type` check to
  stop it. That is verbatim the attack the origin check exists to prevent, and
  the startup banner advertised the unguarded endpoint one line above the
  guarded one.

  Both SSE endpoints now run the same origin predicate as `/<slot>/mcp`, so the
  two cannot drift. The contract is unchanged: a request carrying **no**
  `Origin` always passes (Claude Desktop, MCP Inspector, every server-side SDK),
  and a request carrying one passes only if that exact origin is allowed. The
  403 body matches the Streamable HTTP shape, echoes the refused origin, states
  the verbatim-comparison rule that catches scheme, port and trailing-slash
  mismatches, distinguishes "unset, so closed by default" from "set but does not
  list this one", names `MCP_BROKER_ALLOWED_ORIGINS`, and says that a page the
  broker serves itself is not exempt.

  **Action required.** A browser page currently driving a no-auth broker over
  legacy SSE starts receiving 403 until its origin is listed. That population is
  exactly what the check targets, and listing the origin is the intended
  migration, not a workaround.
- **broker** `providerTakeover: "always"` is honored only when provider
  authentication is configured and the newcomer matches the incumbent's
  principal. Without provider auth (the default) an unconditional takeover would
  let anyone who can open the provider URL evict the live provider, so the
  broker falls back to `"liveness"` and logs why.
- **broker** `www.open` refuses a string naming a foreign origin, a
  protocol-relative `//host/path`, a non-`http(s)` scheme, and any bare word,
  each with a message naming the accepted forms. `open` performs no validation
  of its own and hands a non-URL string to the platform opener, so a config file
  or an inherited environment variable able to launch a browser at an arbitrary
  target is a phishing primitive with no upside for a startup convenience.
- **broker** A malformed `allowedResources` pattern used to fail closed but
  indistinguishably from a policy decision, and the broker started cleanly with
  a configuration it could never honor. The failure is now named, once, with the
  offending pattern.

### Coordinated releases

`@cyanmycelium/mcp-core` **1.0.0** ships alongside this release. The broker now
requires `^1.0.0` and the provider's peer range is `>=0.7.0 <2.0.0`. The broker
itself does not subscribe to the new events; the dependency is behavioral: the
provider transports now report post-open failures through `onError`, and
mcp-core 0.7.0 discarded every such error, so the fix on one side is invisible
without the other. The mcp-core changes are additive and source-compatible:

- `IMcpServer` gained the optional events `onTransportError: IEventSource<Error>`
  and `onDisconnected: IEventSource<void>`. `McpServer._connect` discarded every
  transport error that arrived *after* the transport reported open, which is
  every post-open refusal and every network drop; it now routes them to
  `onTransportError`, falling back to `console.error` when nothing is
  subscribed.
- `start()`'s documentation now says plainly that resolving means the transport
  reported itself open, not that a remote peer accepted the connection. Do not
  log "connected" there.
- The Streamable HTTP endpoint's `403 invalid_origin` body now echoes the
  refused `Origin` verbatim and names what it was compared against: the
  configured list, a predicate, or an unset `allowedOrigins` that refuses every
  browser origin by default. The error *code* is unchanged; code matching the
  literal description string needs updating.

---

## [1.2.1] and earlier

Not recorded here. See the
[GitHub releases](https://github.com/pandaGaume/mcp-broker/releases) and the
`node-v*` / `provider-v*` tags.
