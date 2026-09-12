# Broker configuration

`mcp-broker` reads its configuration from three sources, applied in this order
(highest priority first):

1. **Environment variables**, `MCP_BROKER_*`
2. **JSON config file**, discovered automatically (see below)
3. **Built-in defaults**

Env vars always win over file values. The file is the static baseline you ship
with the broker; env vars are the deploy-specific overrides. Arrays
(`www.mounts`, `stdioUpstreams`, `mcpServers`, `mcpbBundles`) are file-only: no
env-var equivalent.

Three keys are **library-only**: `brokerName` is honored by `IWsTunnelOptions`
but `WsTunnelBuilder` has no `withBrokerName()`, so the CLI cannot forward it;
`enableBrokerProvider` and `enableAggregateProvider` are `IWsTunnelOptions`
fields and not config-file keys at all. Call `broker_info` on the `_broker` slot
to read what a running broker actually resolved, rather than assuming the file
won.

---

## The `.mcp-broker/` convention

All broker-local files live in a hidden `.mcp-broker/` folder next to where
you launch the broker. The folder is **self-contained**: paths inside
`config.json` are resolved against it, not against the cwd.

```
your-project/
└── .mcp-broker/
    ├── config.json       ← broker configuration
    ├── certs/            ← TLS material (optional)
    │   ├── cert.pem
    │   └── key.pem
    ├── grammars/         ← local grammar overrides (optional)
    │   └── <userAgent>/
    │       └── <locale>.json
    └── www/              ← static dev harness (optional)
        └── index.html
```

A starter template ships with the package at
[`.mcp-broker.example/`](../.mcp-broker.example/). Copy it as `.mcp-broker/`
and adapt:

```sh
cp -r node_modules/@cyanmycelium/mcp-broker/.mcp-broker.example .mcp-broker
```

Property-by-property educational guides are available in
[English](../.mcp-broker.example/CONFIGURATION-EN.md) and
[French](../.mcp-broker.example/CONFIGURATION-FR.md).

### Config file discovery

The broker looks in this order:

1. `MCP_BROKER_CONFIG` env var (explicit path).
2. `./.mcp-broker/config.json` relative to `process.cwd()`.
3. `./mcp-broker.config.json` relative to `process.cwd()`, **legacy**,
   logs a deprecation warning to stderr. Move it to `.mcp-broker/config.json`
   to silence.

When none of these exist, the broker runs with env-vars-or-defaults only , 
no error, no warning.

### Path resolution

| Source | Relative to |
|---|---|
| Paths inside `config.json` (`tls.cert`, `www.mounts[*].dir`, ...) | The config file's directory (`.mcp-broker/`) |
| Paths from env vars (`MCP_BROKER_TLS_CERT`, `MCP_BROKER_WWW_DIR`) | `process.cwd()` |

This split is deliberate: the config file is a self-contained bundle, env
vars are deploy-time overrides injected by the surrounding environment.

### Grammar overrides

When `.mcp-broker/grammars/` exists, every grammar JSON file in it is
registered alongside the packaged grammar with the same key. The file
naming convention encodes the resolver key directly:

| File path | Resolver key |
|---|---|
| `<userAgent>/<locale>.json` | `<userAgent>:<locale>` |
| `<userAgent>/<locale>@<version>.json` | `<userAgent>:<locale>@<version>` |

Both layers are composed by the candidate-chain resolver in
`@cyanmycelium/mcp-core@0.3.0` at session time, so partial files only need
to declare the entries they want to change: the rest cascades from the
packaged values.

Concrete example (per-agent locale override):

```
.mcp-broker/grammars/claude/fr.json
```

```json
{
    "tools": {
        "broker_info": {
            "description": "Custom description for Claude in French, overrides the packaged one."
        }
    }
}
```

For everything else in the `claude:fr` grammar (other tools, resources,
templates), the packaged values apply.

Concrete example (version-pinned override):

```
.mcp-broker/grammars/default/fr@v2.json
```

```json
{
    "tools": {
        "broker_info": { "description": "FR description for v2 clients only." }
    }
}
```

A client that puts `capabilities.grammarVersion: "v2"` in its `initialize`
request (and the host wiring `versionFrom: (_, caps) => caps?.grammarVersion`
in `brokerGrammarResolverOptions`) sees this file's content. Clients that
don't ask for v2 fall back to `default:fr` or further down the chain.

> Pre-0.4 broker used to pre-merge `default:<locale>` into every
> `<ua>:<locale>` at boot, because `mcp-core` could only look up a single
> grammar key per session. As of mcp-core@0.3.0, the server walks a candidate
> chain and merges every matching layer (behavior / adapter / static / store),
> so the broker no longer needs that pre-merge step and gained the version
> dimension naturally. The chain narrows across four dimensions (version,
> locale region, locale, user agent), most specific first, ending at the
> configured last-resort key (`default:en`). Which dimensions are narrowed, and
> in what order, is set by the resolver's `narrowing` option, so a chain such as
> `claude:fr-CA@v2 → claude:fr-CA → claude:fr → default:fr-CA → default:fr → default:en`
> is one instance of the shape rather than a fixed sequence.

---

## Complete example

```json
{
    "port": 3001,
    "host": "0.0.0.0",
    "protocol": "https",
    "locale": "fr",
    "stdioProvider": null,

    "allowedOrigins": ["https://localhost:3001", "http://localhost:5173"],

    "providerHeartbeatIntervalMs": 30000,
    "providerRequestTimeoutMs": 60000,
    "providerTakeover": "liveness",

    "paths": {
        "provider":  "/provider",
        "providers": "/providers",
        "client":    "/",
        "mcp":       "/mcp",
        "sse":       "/sse",
        "messages":  "/messages"
    },

    "tls": {
        "cert": "certs/cert.pem",
        "key":  "certs/key.pem"
    },

    "www": {
        "open":   false,
        "mounts": [
            { "urlPrefix": "/",       "dir": "www" },
            { "urlPrefix": "/extras", "dir": "../shared/extras" }
        ]
    },

    "stdioUpstreams": [
        {
            "name":    "fs",
            "command": "npx",
            "args":    ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
            "aggregate": true
        },
        {
            "name":    "git",
            "command": "uvx",
            "args":    ["mcp-server-git", "--repository", "/data/repo"],
            "env":     { "GIT_AUTHOR_NAME": "broker" }
        }
    ],

    "mcpServers": [
        { "name": "geo", "url": "https://geo.example.com/mcp" }
    ],

    "mcpbBundles": [
        { "name": "plant-tools", "path": "bundles/plant-tools.mcpb", "publicKey": "keys/vendor.pem" }
    ]
}
```

`certs/cert.pem` → resolves to `.mcp-broker/certs/cert.pem`.
`www` (in `mounts`) → resolves to `.mcp-broker/www/`.
`../shared/extras` → resolves to `<your-project>/shared/extras/`.

In the example above, `fs` is in `_all` because it says so, `git` is not
(`stdioUpstreams` defaults to excluded), and `geo` and `plant-tools` are in
because `mcpServers` and `mcpbBundles` default to included. `brokerName` is
deliberately absent: it is a valid key that the CLI cannot forward, so setting
it here would look functional and do nothing.

---

## Schema reference

### Top-level scalars

| Field | Type | Default | Env var | Notes |
|---|---|---|---|---|
| `port` | `number` | `3000` | `MCP_BROKER_PORT` | TCP port |
| `host` | `string` | `0.0.0.0` | `MCP_BROKER_HOST` | Bind interface |
| `protocol` | `"http" \| "https"` | auto | `MCP_BROKER_PROTOCOL` | `auto` enables TLS when `tls.cert` + `tls.key` are set |
| `locale` | `string` | `en` | `MCP_BROKER_LOCALE` | BCP-47 tag (`fr`, `fr-CA`, `zh-CN`, ...) |
| `brokerName` | `string` | package name | (none) | Logical name in `broker_info` output. **Library-only**, see below |
| `stdioProvider` | `string` | (unset) | `MCP_BROKER_STDIO_PROVIDER` | Bridge stdin/stdout to this slot. Use `_all`, see below |
| `allowedOrigins` | `string[]` or `{ pattern, flags? }` | (unset) | `MCP_BROKER_ALLOWED_ORIGINS` | Browser origins allowed on the HTTP client endpoints, see below |
| `providerHeartbeatIntervalMs` | `number` | `30000` | `MCP_BROKER_PROVIDER_HEARTBEAT_MS` | ws-level ping interval on provider sockets. `0` disables |
| `providerRequestTimeoutMs` | `number` | `60000` | `MCP_BROKER_PROVIDER_REQUEST_TIMEOUT_MS` | Deadline for one provider request. `0` disables |
| `providerTakeover` | `"reject" \| "liveness" \| "always"` | `"liveness"` | `MCP_BROKER_PROVIDER_TAKEOVER` | What happens when a second provider claims an occupied slot |

### `brokerName` is library-only

The key is valid, and `WsTunnel` honors `IWsTunnelOptions.brokerName`. But
`WsTunnelBuilder` has no `withBrokerName()`, so `bin.ts` has nothing to forward
it through: setting it in `config.json` changes nothing observable. Set it
through the programmatic options if you need it, and check the result with
`broker_info`.

### `allowedOrigins`

Which browser origins may reach the HTTP client endpoints: `/<slot>/mcp`,
`/<slot>/sse` and `/<slot>/messages`.

Scope, precisely. The check covers those three. It does **not** cover WebSocket
upgrades, so neither a raw-WS client (`ws://<host>/<slot>`) nor either provider
endpoint is origin-validated, and `allowedOrigins` is not a substitute for
authentication. Until this release the legacy SSE pair was not covered either;
see the changelog's Security section.

The MCP specification requires servers to validate the `Origin` header: without
it, any web page loaded in a browser that can reach the broker is able to drive
it. So the endpoint is **closed to browsers by default**, and a request carrying
an `Origin` gets `403` until an operator opens it.

A request carrying **no** `Origin` is always accepted. That covers every
non-browser client, which is what Claude Desktop, MCP Inspector and the
server-side SDKs are, so the default breaks none of them.

An array lists origins matched exactly against the whole header:

```json
{ "allowedOrigins": ["https://app.example.com", "http://localhost:5173"] }
```

An object supplies a regular expression, tested against the whole header. Anchor
it, or a lookalike domain such as `https://app.example.com.evil.test` matches:

```json
{ "allowedOrigins": { "pattern": "^https://[a-z0-9-]+\\.example\\.com$" } }
```

A pattern that fails to compile is reported on stderr and ignored, leaving the
closed default rather than a rule the operator believes is in force.

`MCP_BROKER_ALLOWED_ORIGINS` takes a comma-separated list and wins over the file.
It carries the list form only, since a regular expression cannot survive
comma-splitting; a pattern needs the config file.

In code, `WsTunnelBuilder.withAllowedOrigins` additionally accepts a predicate,
for a decision that needs more than the string:

```typescript
builder.withAllowedOrigins((origin) => origin.endsWith(".example.com"));
```

**A static mount does not exempt the origin it serves.** A page the broker
itself serves at `http://localhost:3000/` sends
`Origin: http://localhost:3000` like any other page, and is refused with `403`
until that exact string is listed. This is the single most common surprise with
this key. The 403 body echoes the refused origin and names the env var, so read
it rather than guessing.

The comparison is verbatim: scheme, host and port must all match as the browser
sends them, with no trailing slash. A broker running with TLS is reached at
`https://`, so `http://` entries match nothing.

### `providerHeartbeatIntervalMs`, `providerTakeover`, `providerRequestTimeoutMs`

Three keys covering the two ways a provider stops being useful without closing
its socket.

**`providerHeartbeatIntervalMs`** (default `30000`, `0` disables) pings every
connected provider socket. A socket that misses a full interval is terminated
and its slot freed. Without it, a half-open socket (a hard-killed browser tab, a
slept laptop, a dropped VPN) holds the slot until the OS TCP keepalive gives up,
which is roughly two hours, refusing every reconnection with close code `1008`
meanwhile.

An RFC 6455 pong is answered by the peer's network stack. It proves the
*process* is alive, not that its JavaScript thread is serving. That second case
is what the request deadline covers.

**`providerTakeover`** (default `"liveness"`) decides what happens when a
provider connects to a slot another socket already holds:

| value | behavior |
|---|---|
| `"reject"` | the incumbent always keeps the slot |
| `"liveness"` | the incumbent keeps it only while it answers the heartbeat; a socket known dead is terminated and the newcomer admitted |
| `"always"` | the newcomer wins, **but only** when provider authentication is configured and it authenticated as the same principal as the incumbent |

With provider auth unconfigured (the default), `"always"` would let anyone who
can open the provider URL evict the real provider, so the broker logs that it is
falling back to `"liveness"` and does so. With the heartbeat disabled there is
no liveness evidence, so `"liveness"` behaves like `"reject"`.

**`providerRequestTimeoutMs`** (default `60000`, `0` disables) fails a request
the provider never answered with
`-32000 Provider "<name>" did not respond within <ms>ms`, addressed to the
caller's own id, plus one log line naming the usual causes. Raise it if you host
genuinely long-running tools. The counter-argument to a deadline is those tools;
the argument for one is that a hang with no diagnostic is strictly worse than a
nameable error, and this is a knob.

### `paths` (URL routing)

Resolution is `env var → config file → default` for all six.

| Field | Default | Env var | Notes |
|---|---|---|---|
| `paths.provider` | `/provider` | `MCP_BROKER_PROVIDER_PATH` | **Prefix**; the encoded slot name is appended. Plain JSON-RPC frames, `DirectTransport` |
| `paths.providers` | `/providers` | `MCP_BROKER_PROVIDERS_PATH` | **Exact match**. Envelope frames, `MultiplexTransport` |
| `paths.client` | `/` | `MCP_BROKER_CLIENT_PATH` | Prefix for raw WS clients |
| `paths.mcp` | `/mcp` | `MCP_BROKER_MCP_PATH` | Suffix appended to `/<slot>` |
| `paths.sse` | `/sse` | `MCP_BROKER_SSE_PATH` | Suffix appended to `/<slot>` |
| `paths.messages` | `/messages` | `MCP_BROKER_MESSAGES_PATH` | Suffix appended to `/<slot>` |

The two provider paths are **not interchangeable**: they carry different
framing, and the broker chooses which framing to speak on a socket from the URL
that socket connected to, never from what arrives on it.

```
  DirectTransport      <->  <paths.provider>/<slot>   plain JSON-RPC frames
  MultiplexTransport   <->  <paths.providers>         envelopes { provider, payload }
```

`<paths.providers>/<name>` is neither. `/providers` is matched exactly and
`/provider/` as a prefix, so a URL starting with `/providers/` matches neither
branch and falls through to the client side, where it is accepted as an MCP
*client* on a slot literally named `providers/<name>`. Nothing errors, and the
slot you meant stays empty.

> **Changed in 1.3.0.** `paths.providers` and `paths.messages` were previously
> read by nothing, and `paths.sse` reached only the startup banner, so setting
> it advertised an endpoint that returned 404. All six now take effect. A
> deployment that sets a non-default value for any of the three has been running
> on the default, and those endpoints will move.

Moving a path moves it for **every** peer at once: providers, clients and the
banner all have to agree. `broker_info` on the `_broker` slot reports the
effective values.

### `tls`

Both fields are paths on disk, resolved against `.mcp-broker/`.

| Field | Env var |
|---|---|
| `tls.cert` | `MCP_BROKER_TLS_CERT` |
| `tls.key`  | `MCP_BROKER_TLS_KEY` |

Set both to enable HTTPS/WSS. Use `protocol: "http"` to keep plain HTTP even
when both are present, or `protocol: "https"` to force TLS.

### `www` (static-file serving)

| Field | Type | Env var | Notes |
|---|---|---|---|
| `www.open` | `boolean \| string` | `MCP_BROKER_OPEN` | Auto-launch a browser on startup, see below |
| `www.mounts` | `Array<{urlPrefix, dir}>` | (file-only) | URL-prefix → directory mappings. Longest-prefix match wins |

JSON-RPC routes always take precedence over static routes, so a slot named like
a directory shadows that directory. Directory requests fall back to
`index.html`, and a path escaping its mount is refused with `403`. Mounts whose
target directory does not exist on disk are skipped with a warning rather than
failing startup.

**Serving a page does not exempt its origin.** A page at
`http://localhost:3000/` that reaches `/<slot>/mcp` is refused with `403` until
`http://localhost:3000` is listed in `allowedOrigins`.

#### `www.open`

| Value | Effect |
|---|---|
| absent, `false`, `""`, `"0"`, `"false"` | open nothing |
| `true`, `"1"`, `"true"` | open the broker root, `<scheme>://localhost:<port>/` |
| `"/app/index.html"` | open that path on this broker |
| `"https://localhost:3000/app"` | an absolute URL **on this broker's own origin**, opened as given |
| anything else | refused, with a message naming the accepted forms |

Refused deliberately: a URL on a foreign origin, a protocol-relative
`//host/path` (which `new URL` resolves off-origin and a naive "starts with `/`"
test would let through), a non-`http(s)` scheme, and any bare word. `open` does
no validation of its own and hands a non-URL string to the platform opener, so a
config file or an inherited environment variable able to launch a browser at an
arbitrary target is a phishing primitive with no upside for a startup
convenience. Refusal is always a warning, never fatal.

The browser opens only when a static mount **actually covers the resolved
path**, checked against the mounts that were registered, from all three sources
(`www.mounts`, `MCP_BROKER_WWW_DIR`, `MCP_BROKER_BUNDLE_DIR`). When nothing
covers it the broker says which prefixes exist instead of launching a browser
onto a 404. A browser that fails to spawn (a headless box, a container) warns
and leaves the broker running.

> **Changed in 1.3.0.** `www.open` was a boolean that collapsed any value to
> `"1"`, always opened `/`, and required a mount at `/` specifically, so
> `MCP_BROKER_BUNDLE_DIR` plus `MCP_BROKER_OPEN=1` silently opened nothing. The
> pure resolver behind it is exported as `resolveOpenTarget(raw, baseUrl)`.

#### Env-var shortcuts (additive)

Env vars cannot express arrays, so two flat shortcuts cover the common cases.
They are **additive** with `www.mounts`, both contribute mount entries.

| Env var | Equivalent JSON |
|---|---|
| `MCP_BROKER_WWW_DIR=./public` | `www.mounts: [{ "urlPrefix": "/", "dir": "./public" }]` |
| `MCP_BROKER_BUNDLE_DIR=./bundle` | `www.mounts: [{ "urlPrefix": "/bundle", "dir": "./bundle" }]` |

## Upstream providers: three ways to fill a slot without code

The broker can populate slots itself, so a deployment needs no provider process
of its own. All three keys are file-only.

| Key | The broker | Slot `transport` reads | In `_all` by default |
|---|---|---|---|
| `stdioUpstreams` | spawns a child process | `stdio` | **no** |
| `mcpServers` | dials out to a URL | `stdio` | **yes** |
| `mcpbBundles` | verifies, unpacks and spawns a signed `.mcpb` | `stdio` | **yes** |

Two things to read twice.

First, **the `aggregate` default is not uniform.** A `stdioUpstreams` entry is
excluded from `_all` unless you write `"aggregate": true`; `mcpServers` and
`mcpbBundles` entries are included unless you write `"aggregate": false`. The
asymmetry is deliberate for now (inverting the `stdioUpstreams` default would
silently expose a local server an operator kept out by omission), and it is the
kind of thing that produces an `_all` slot showing only some of what you
expected.

Second, **all three report `transport: "stdio"`** in `providers_list` and
`provider_status`, because the broker tracks them in one upstream registry. A
`transport: "stdio"` slot is therefore not necessarily a child process; it may
be a remote URL.

### `stdioUpstreams`

Each entry spawns a child process at broker start and talks newline-delimited
JSON-RPC to it, exactly like the MCP stdio transport. Its stderr is inherited,
so it appears in the broker's logs.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | `string` | yes | Unique provider slot name |
| `command` | `string` | yes | Executable (looked up in `PATH`) |
| `args` | `string[]` | no | Arguments passed to the command |
| `env` | `Record<string, string>` | no | Extra env vars merged with the parent process env |
| `aggregate` | `boolean` | no | Join the `_all` aggregate slot. **Defaults to `false`**: omit it and this upstream is not in `_all` |

```json
{
    "stdioUpstreams": [
        {
            "name": "fs",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
            "aggregate": true
        }
    ]
}
```

Builder equivalent: `withStdioUpstream({ name, command, args, env, aggregate })`.
It takes **one object**, not positional arguments.

### `mcpServers`

Remote MCP servers the broker connects **out** to and republishes as slots. The
broker is the client on that hop; the slot's own clients are multiplexed onto
the single upstream connection exactly as they are onto a child process.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | `string` | yes | Provider slot name the remote server is bound to |
| `url` | `string` | yes | URL of the remote MCP server |
| `transport` | `"streamable-http" \| "sse" \| "websocket"` | no | Auto-detected from the URL scheme and path when omitted |
| `headers` | `Record<string, string>` | no | Extra HTTP / WebSocket headers, e.g. an `Authorization` header for the upstream |
| `aggregate` | `boolean` | no | **Defaults to `true`**; set `false` to keep this server out of `_all` |

```json
{
    "mcpServers": [
        { "name": "geo", "url": "https://geo.example.com/mcp" },
        {
            "name": "partner",
            "url": "https://partner.example.com/sse",
            "transport": "sse",
            "headers": { "Authorization": "Bearer <the-actual-token>" },
            "aggregate": false
        }
    ]
}
```

There is **no** variable interpolation in the config file: `headers` values are
sent literally, so `"Bearer ${SOME_TOKEN}"` transmits those eleven characters.
Either put the real value there (and keep the file out of version control, which
the repository's `.gitignore` already does for `.mcp-broker/`), or use the
programmatic API and read it from the environment yourself.

Local servers should be shipped as `.mcpb` bundles rather than named here.

Builder equivalent: `withRemoteUpstream({ name, url, transport, headers, aggregate })`.

### `mcpbBundles`

Local `.mcpb` bundles the broker loads at startup and runs as stdio provider
slots. A bundle is a ZIP with a `manifest.json`; the broker verifies a detached
signature against a trusted public key **before** unpacking and spawning it. A
bundle that fails verification is skipped and never spawned.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | `string` | yes | Provider slot name the bundle is bound to |
| `path` | `string` | yes | Path to the `.mcpb` file, resolved against the config file's directory |
| `publicKey` | `string` | yes | Path to the trusted public key (PEM) used to verify the signature |
| `signature` | `string` | no | Path to the detached signature file. Defaults to `<path>.sig` |
| `userConfig` | `Record<string, string \| number \| boolean \| Array<string \| number>>` | no | Values substituted into the manifest's `${user_config.*}` placeholders |
| `aggregate` | `boolean` | no | **Defaults to `true`**; set `false` to keep this bundle out of `_all` |

```json
{
    "mcpbBundles": [
        {
            "name": "plant-tools",
            "path": "bundles/plant-tools.mcpb",
            "publicKey": "keys/vendor.pem",
            "userConfig": { "site": "site-a" }
        }
    ]
}
```

Bundle slot names are known synchronously from the config, before any bundle is
loaded, so `stdioProvider` may name one.

### `stdioProvider` (the stdio bridge)

Setting it turns the process into a stdio MCP server for a host such as Claude
Desktop: stdin carries the host's JSON-RPC, stdout carries the replies, and all
logging is redirected to stderr so it cannot corrupt the channel. The broker
keeps listening on its port at the same time, so providers can still tunnel in.

**Set it to `_all`.** Pinning a real slot is an ordering failure that happens
every time: the host sends `initialize` the instant it launches, treats a
failure as a dead server with no retry, and your provider does not exist yet, so
the bridge answers `-32000 Provider "<slot>" not connected` and the host gives
up for the session. `_all` is registered before the broker resumes stdin,
answers `initialize` itself, already aggregates `_broker`, and pushes
`notifications/tools/list_changed` when a provider joins later. `_broker` is the
fallback if you want introspection only.

The broker warns at startup when `stdioProvider` names a slot it does not host,
listing the slots it does.

The bridge reaches `_all` with **no principal attached**. That is invisible
until you enable authorization, at which point the host's tool list silently
empties.

A ready-made pairing ships as
[`.mcp-broker.example/config.stdio-bridge.json`](../.mcp-broker.example/config.stdio-bridge.json).
It is a separate file on purpose: `stdioProvider` moves stdout to the JSON-RPC
stream, so a broker started in a terminal with it set looks dead.

### `auth` (OAuth 2.1 authorization)

Opt-in. Absent or `enabled: false` ⇒ the broker performs **no** authentication
(trusted-network mode, the historical behavior). When `enabled: true`, the
broker becomes an OAuth 2.1 resource server: client requests need a bearer token
and the broker publishes Protected Resource Metadata (RFC 9728). See the
language-neutral [authorization guide](https://github.com/pandaGaume/mcp-broker/blob/main/docs/authorization.md) for the full
OAuth model, flows, and endpoints. The domain-neutral namespace model, including
the recommended ISA-95 / IEC 62264-aligned industrial profile and UMD
compatibility, is in
[hierarchical authorization](https://github.com/pandaGaume/mcp-broker/blob/main/docs/hierarchical-authorization.md).

| Field | Type | Env var | Notes |
|---|---|---|---|
| `auth.enabled` | `boolean` | `MCP_BROKER_AUTH_ENABLED` (`1`/`true`) | Master switch. Requires `publicBaseUrl`, `jwks`, and an issuer/AS when on |
| `auth.publicBaseUrl` | `string` | `MCP_BROKER_PUBLIC_BASE_URL` | Public origin, e.g. `https://mcp.example.com`. Builds canonical resource URIs |
| `auth.authorizationServers` | `string[]` | (file-only) | AS issuer URL(s) advertised in the metadata. Defaults to `[issuer]` |
| `auth.jwks` | `string` | `MCP_BROKER_JWKS` | AS JWKS URL, used to verify token signatures |
| `auth.issuer` | `string` | `MCP_BROKER_ISSUER` | Expected token `iss`. Defaults to the sole `authorizationServers` entry |
| `auth.scopesSupported` | `string[]` | (file-only) | Advertised in the metadata `scopes_supported` |
| `auth.requiredScopes` | `string[]` | (file-only) | Baseline scope(s) any caller must hold. Empty ⇒ any valid token |
| `auth.perSlotScopes` | `Record<string,string[]>` | (file-only) | Per-slot scope overrides (e.g. an admin scope for `_broker`) |
| `auth.providerScopes` | `Record<string,string[]>` | (file-only) | Deprecated per-provider scope filter. Emits a warning |
| `auth.providerSecret` | `string` | `MCP_BROKER_PROVIDER_SECRET` | Shared secret every provider must present to occupy a slot |
| `auth.subjectMapping` | `object` | (file-only) | Maps validated JWT claims to user, group, client, and service subjects |
| `auth.roles` | `Record<string,Role>` | (file-only) | Stable capability sets with optional `inherits` |
| `auth.assignments` | `Assignment[]` | (file-only) | Binds subjects and roles to exact or wildcard resource paths |
| `auth.denies` | `Deny[]` | (file-only) | Explicit capability denies that override grants |
| `auth.slotResources` | `Record<string,string>` | (file-only) | Maps technical slot names to stable resource paths |
| `auth.toolCapabilities` | `Record<string,string>` | (file-only) | Global tool to functional capability mapping |
| `auth.providerToolCapabilities` | `Record<path,Record<tool,capability>>` | (file-only) | Resource-qualified tool mapping |
| `auth.audit.logAllowed` | `boolean` | (file-only) | Logs allowed decisions when true. Default false |

`providerSecret` is independent of client auth, and is **not gated by
`auth.enabled`**: setting it alone turns provider authentication on. That is
deliberate, and it is also the trap in a copied template. A config carrying
`"providerSecret": "change-me"` inside a disabled `auth` block still refuses
every provider, while the banner reads `Authorization: disabled` one line above
`Provider auth: shared secret required`. The shipped
[`.mcp-broker.example/config.json`](../.mcp-broker.example/config.json)
deliberately omits the key for that reason.

Two limits worth knowing before you set it:

- **A browser-hosted provider cannot authenticate.** The secret is read from the
  `X-Provider-Token` header or from `Authorization: Bearer`, and the browser
  `WebSocket` constructor cannot set headers. Neither SDK transport accepts a
  credential. Every browser provider is then refused at the handshake with
  HTTP 401, which surfaces in the page as a bare `error` event with no status.
  Run without a provider secret, or terminate provider auth in a reverse proxy
  that injects the header.
- **The stdio bridge is anonymous.** `stdioProvider` forwards to `_all` with no
  principal attached, so enabling per-provider scopes or any policy that denies
  an anonymous subject silently empties an MCP host's tool list: `tools/list`
  still succeeds and returns `tools: []`.

Hierarchical policy is enabled only when roles, assignments, or denies are
present. Without them, legacy OAuth behavior is unchanged. When enabled,
`requiredScopes` and `perSlotScopes` run first. `providerScopes`, if retained
during migration, must pass in addition to the hierarchical policy.

```json
{
    "auth": {
        "enabled": true,
        "publicBaseUrl": "https://mcp.example.com",
        "authorizationServers": ["https://auth.example.com"],
        "jwks": "https://auth.example.com/.well-known/jwks.json",
        "issuer": "https://auth.example.com",
        "scopesSupported": ["mcp:call", "broker:admin"],
        "requiredScopes": ["mcp:call"],
        "perSlotScopes": { "_broker": ["broker:admin"] },
        "subjectMapping": {
            "userClaim": "sub",
            "groupClaims": ["groups"],
            "clientClaim": "client_id"
        },
        "roles": {
            "viewer": {
                "capabilities": [
                    "mcp.resources.read",
                    "mcp.tools.list",
                    "mcp.prompts.read"
                ]
            },
            "maintenance": {
                "inherits": ["viewer"],
                "capabilities": ["mcp.tools.diagnose"]
            }
        },
        "assignments": [
            {
                "id": "site-a-maintenance",
                "subject": "group:maintenance-site-a",
                "role": "maintenance",
                "resource": "/enterprise/site-a/**"
            }
        ],
        "slotResources": {
            "motor-7": "/enterprise/site-a/area-a/line-3/cell-2/motor-7"
        },
        "toolCapabilities": {
            "diagnose_motor": "mcp.tools.diagnose"
        },
        "providerSecret": "change-me"
    }
}
```

---

## Common patterns

### Persistent custom port + locale

```json
{
    "port": 3001,
    "locale": "fr"
}
```

The most frequent use case: no env vars needed across shell sessions.

### Local TLS

`gen-cert` is a repository script, not part of the published package: it needs
`selfsigned`, a devDependency. It resolves its output directory against the
**working directory** and defaults to `../certs`, which for an npm script is
one level above the package, never `.mcp-broker/certs/`. Pass `--out`:

```sh
# from a checkout, in node/packages/broker
npm run gen-cert -- --out .mcp-broker/certs
```

Outside the repository, `openssl` does the same job:

```sh
mkdir -p .mcp-broker/certs && openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout .mcp-broker/certs/key.pem -out .mcp-broker/certs/cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Then, in `.mcp-broker/config.json`:

```json
{
    "tls": {
        "cert": "certs/cert.pem",
        "key":  "certs/key.pem"
    }
}
```

Self-contained: moving `.mcp-broker/` to another machine carries the certs.

Two consequences of turning TLS on. The switch is **all or nothing**: providers
then connect with `wss://`, clients with `https://`, and every `allowedOrigins`
entry must be spelled `https://` or it matches nothing. And both PEMs are read
synchronously when the tunnel is built, so a path that does not exist fails
before the port is bound. This is the first wall a copied config template hits;
the error names both paths and the two path-resolution rules.

To run a config that carries `tls` without the certs, force plain HTTP:

```sh
MCP_BROKER_PROTOCOL=http npx @cyanmycelium/mcp-broker
```

### Bridge a local stdio MCP server

```json
{
    "stdioUpstreams": [
        {
            "name": "fs",
            "command": "npx",
            "args":   ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
        }
    ]
}
```

`http://localhost:3000/fs/mcp` proxies to that child process.

### Expose the broker publicly (OAuth 2.1)

Never expose the default (unauthenticated) broker to an untrusted network. Turn
on the resource server and provider auth:

```json
{
    "tls": { "cert": "certs/cert.pem", "key": "certs/key.pem" },
    "auth": {
        "enabled": true,
        "publicBaseUrl": "https://mcp.example.com",
        "authorizationServers": ["https://auth.example.com"],
        "jwks": "https://auth.example.com/.well-known/jwks.json",
        "requiredScopes": ["mcp:call"],
        "providerSecret": "change-me"
    }
}
```

Clients now need a bearer token whose audience is `https://mcp.example.com/<slot>/mcp`;
providers need the shared secret. Full details in the
[authorization guide](https://github.com/pandaGaume/mcp-broker/blob/main/docs/authorization.md).

### Customize tool descriptions for your org

Drop a JSON file at `.mcp-broker/grammars/claude/en.json`:

```json
{
    "tools": {
        "broker_info": {
            "description": "Your org-specific description for Claude in English."
        }
    }
}
```

The packaged grammar provides the baseline; only your overrides take effect
on the conflicting keys. No need to fork the package.

### Dev harness with auto-open

```json
{
    "allowedOrigins": ["http://localhost:3000"],
    "www": {
        "open": true,
        "mounts": [
            { "urlPrefix": "/", "dir": "www" }
        ]
    }
}
```

Put your `index.html` etc. in `.mcp-broker/www/`. The broker opens
`http://localhost:3000/` in the default browser on startup, and warns rather
than exiting when no browser can be launched (headless boxes, containers).

`allowedOrigins` is there because the harness is a browser page reaching
`/<slot>/mcp`, and the broker serving that page does **not** exempt its origin.
Omit it and every request from the harness comes back `403 invalid_origin`. A
page that only opens WebSockets does not need it; WebSocket upgrades are not
origin-checked.

To open a sub-path rather than the root, give `open` a string. It works with a
mount at any prefix that covers it, not only a mount at `/`:

```json
{ "www": { "open": "/app/index.html", "mounts": [{ "urlPrefix": "/app", "dir": "app" }] } }
```

### Deploy-specific override

Ship the config file with sensible defaults, override per environment via
env vars:

```sh
MCP_BROKER_PORT=4000 mcp-broker     # staging
```

The env var wins; the rest of the file applies as-is.

---

## Programmatic loading

Embedders that build the broker themselves can re-use the loader:

```ts
import { loadBrokerConfig, WsTunnelBuilder } from "@cyanmycelium/mcp-broker";
import * as path from "node:path";

const { config, baseDir } = loadBrokerConfig();

const tunnel = new WsTunnelBuilder()
    .withPort(config.port ?? 3000)
    .withHost(config.host ?? "0.0.0.0")
    .withBrokerLocalGrammarsDir(path.join(baseDir, "grammars"))
    .build();
```

`loadBrokerConfig` never throws; an absent or invalid file returns
`{ config: {}, baseDir: process.cwd(), sourcePath: null }`.

The `IBrokerConfig` and `ILoadedBrokerConfig` interfaces are exported for
static typing of custom loaders.

---

## Caveats

- **Secrets**: by default the repo's `.gitignore` excludes `.mcp-broker/`
  entirely. Adjust if you want to commit a non-sensitive `config.json` but
  keep certs/grammars overrides local.
- **Relative paths**: config-file paths are resolved against the config
  file's directory; env-var paths against `process.cwd()`.
- **JSON, not JSON5**: no comments. Use a `_comment` field or split into
  multiple keys if you need annotations.
- **Hot reload**: the config is read once at broker startup. Restart to pick
  up changes.
