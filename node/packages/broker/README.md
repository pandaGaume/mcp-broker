<p align="center">
  <img src="https://raw.githubusercontent.com/pandaGaume/mcp-broker/main/docs/assets/logo.png" alt="mcp-broker" width="160" />
</p>

[![npm](https://img.shields.io/npm/v/@cyanmycelium/mcp-broker)](https://www.npmjs.com/package/@cyanmycelium/mcp-broker)
[![CI](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-node.yml/badge.svg)](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-node.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

# @cyanmycelium/mcp-broker

WebSocket-based [Model Context Protocol](https://modelcontextprotocol.io/) broker. Aggregates multiple MCP providers behind a single endpoint, with WebSocket, Streamable HTTP, SSE, and stdio client transports.

> This is the Node/TypeScript implementation of the broker. Architecture, wire protocol, and endpoints are documented language-neutrally in the [repository `docs/` folder](https://github.com/pandaGaume/mcp-broker/tree/main/docs), which is not shipped in the npm package. Every link out of this file is therefore absolute.

| I want to | go to |
|---|---|
| publish my MCP server into a slot | [the pairing rule](#the-one-rule-that-costs-the-most-time) |
| wire Claude Desktop or another stdio host | [Claude Desktop integration](#claude-desktop-integration) |
| reach a slot as a client | [Install and run](#install-and-run), [Browser origins](#browser-origins) |
| know what `_broker` and `_all` are | [Reserved slots](#reserved-slots-_broker-and-_all) |
| configure the process | [Configuration](#configuration) |
| embed the broker in my own process | [Programmatic API](#programmatic-api) |
| fix something that is already broken | [Troubleshooting](#troubleshooting), or call `broker_diagnose` |

## Install and run

```sh
# Run the broker without installing
npx @cyanmycelium/mcp-broker

# Or install globally
npm install -g @cyanmycelium/mcp-broker
mcp-broker
```

The broker starts on `http://localhost:3000` by default.

- Connect your MCP provider to: `ws://localhost:3000/provider/<name>`
- Point an MCP client at: `http://localhost:3000/<name>/mcp` (Streamable HTTP) or `http://localhost:3000/<name>/sse` (legacy SSE) or `ws://localhost:3000/<name>` (raw WS)

### The broker documents itself

Once it is running you do not need this README. The reserved `_broker` slot
serves the integration guide over MCP, and diagnoses the deployment:

| call it with | and you get |
|---|---|
| `broker_guide({ topic? })`, or read `broker://guide/{topic}` | six Markdown pages (`index`, `publish-provider`, `connect-client`, `host-config`, `deploy`, `troubleshooting`) with **this** broker's effective configuration injected into each |
| `broker_diagnose({ slot? })` | live state plus the problems the broker can prove, each with `symptom`, `evidence` and a `fix` |

Point any MCP client at `http://localhost:3000/_broker/mcp` and call them. From
a stdio host bridged to `_all` they are named `_broker-broker_guide` and
`_broker-broker_diagnose`. When something does not work, call `broker_diagnose`
before reading anything: it does the correlation for you and names the fix.

### The one rule that costs the most time

A provider's transport and its URL path are a matched pair:

```
  DirectTransport      <->  ws://<host>/provider/<name>   plain JSON-RPC frames
  MultiplexTransport   <->  ws://<host>/providers         envelopes { provider, payload }
```

`ws://<host>/providers/<name>` is **neither**. The router matches `/providers`
exactly and `/provider/` as a prefix, so a URL starting with `/providers/` falls
through to the client branch and is accepted as an MCP *client* on a slot named
`providers/<name>`. Nothing errors; your slot stays empty.

Both mismatches are detected on the first frame and refused with WebSocket close
code `1008` and a reason naming the correction. Older brokers stay silent, so
the observable signatures are worth knowing:

- **MultiplexTransport on `/provider/<name>`**: `provider_status` reports
  `connected: true`, `transport: "ws"`, `pendingCount` climbing and never
  falling, while the client's `initialize` never resolves.
- **DirectTransport on `/providers`**: your socket is open and the slot never
  appears in `providers_list` at all.

`broker_diagnose` reports the first as `transport-path-mismatch`.

## Configuration

Two sources, env vars **always win** over the file. The file is the static baseline you ship with the broker; env vars are deploy-specific overrides.

### Option A: `.mcp-broker/` folder (recommended)

Drop a `.mcp-broker/` folder next to where you launch the broker. Paths
inside `config.json` are resolved against this folder, so it stays
self-contained (certs, www, grammar overrides all next to the config).

```
your-project/
└── .mcp-broker/
    ├── config.json       ← broker configuration
    ├── certs/            ← TLS material (optional)
    ├── grammars/         ← local grammar overrides (optional)
    └── www/              ← static dev harness (optional)
```

Minimal `config.json`:

```json
{
    "port": 3001,
    "locale": "fr",
    "allowedOrigins": ["http://localhost:3001"],
    "www": {
        "open":   false,
        "mounts": [{ "urlPrefix": "/", "dir": "www" }]
    },
    "stdioUpstreams": [
        {
            "name": "fs",
            "command": "npx",
            "args":   ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
            "aggregate": true
        }
    ],
    "mcpServers": [
        { "name": "geo", "url": "https://geo.example.com/mcp" }
    ]
}
```

Three ways to give the broker a provider without writing any code:
`stdioUpstreams[]` spawns a child process, `mcpServers[]` dials out to a remote
MCP server by URL, and `mcpbBundles[]` verifies and runs a signed `.mcpb`
bundle. Note that `stdioUpstreams` entries are **not** in `_all` unless you
write `"aggregate": true`, while the other two are in unless you write
`"aggregate": false`.

Start from the [`.mcp-broker.example/`](.mcp-broker.example/) template, which
ships with authorization off and every key annotated:

```sh
cp -r node_modules/@cyanmycelium/mcp-broker/.mcp-broker.example .mcp-broker
```

Full reference (every field, defaults, recipes, grammar overrides): **[docs/config.md](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/docs/config.md)**.

### Option B: Environment variables

This table is complete: it lists every `MCP_BROKER_*` variable the CLI reads.

| Variable | Default | Notes |
|---|---|---|
| `MCP_BROKER_CONFIG` | `./.mcp-broker/config.json` | Path to a JSON config file (see above) |
| `MCP_BROKER_PORT` | `3000` | TCP port to listen on |
| `MCP_BROKER_HOST` | `0.0.0.0` | Interface to bind |
| `MCP_BROKER_LOCALE` | `en` | BCP-47 tag driving the `_broker` tool descriptions |
| `MCP_BROKER_ALLOWED_ORIGINS` | (unset) | Comma-separated browser origins allowed on the client endpoints. **Unset means no browser origin passes.** See below |
| `MCP_BROKER_PROVIDER_PATH` | `/provider` | Prefix for dedicated provider WS connections (`DirectTransport`, plain frames) |
| `MCP_BROKER_PROVIDERS_PATH` | `/providers` | Exact path for multiplexed provider WS connections (`MultiplexTransport`, envelopes) |
| `MCP_BROKER_CLIENT_PATH` | `/` | Prefix for raw WS clients |
| `MCP_BROKER_MCP_PATH` | `/mcp` | Per-slot suffix for Streamable HTTP |
| `MCP_BROKER_SSE_PATH` | `/sse` | Per-slot suffix for the legacy SSE stream |
| `MCP_BROKER_MESSAGES_PATH` | `/messages` | Per-slot suffix for legacy SSE posts |
| `MCP_BROKER_PROVIDER_HEARTBEAT_MS` | `30000` | ws-level ping interval on provider sockets. `0` disables |
| `MCP_BROKER_PROVIDER_REQUEST_TIMEOUT_MS` | `60000` | How long a provider has to answer one request before it is failed. `0` disables |
| `MCP_BROKER_PROVIDER_TAKEOVER` | `liveness` | `reject`, `liveness` or `always` when a second provider claims an occupied slot |
| `MCP_BROKER_WWW_DIR` | (unset) | If set, serve this directory at `/` |
| `MCP_BROKER_BUNDLE_DIR` | (unset) | If set, serve this directory at `/bundle` |
| `MCP_BROKER_OPEN` | (unset) | `1` opens the broker root on startup; a `/path` or a same-origin absolute URL opens that page. Opens only when a static mount actually covers the resolved path |
| `MCP_BROKER_TLS_CERT` | (unset) | Path to a PEM certificate. Enables HTTPS/WSS |
| `MCP_BROKER_TLS_KEY` | (unset) | Path to a PEM private key. Enables HTTPS/WSS |
| `MCP_BROKER_PROTOCOL` | auto | `http` forces plain, `https` forces TLS, unset auto-detects from cert+key |
| `MCP_BROKER_STDIO_PROVIDER` | (unset) | When set, bridge stdin/stdout JSON-RPC to this slot. **Use `_all`**, see [Claude Desktop integration](#claude-desktop-integration) |
| `MCP_BROKER_AUTH_ENABLED` | (unset) | `1` to turn on the OAuth 2.1 resource server (requires the three below) |
| `MCP_BROKER_PUBLIC_BASE_URL` | (unset) | Public origin used to build canonical resource URIs, e.g. `https://mcp.example.com` |
| `MCP_BROKER_JWKS` | (unset) | Authorization server's JWKS URL, used to verify token signatures |
| `MCP_BROKER_ISSUER` | (unset) | Expected token issuer (defaults to the sole authorization server) |
| `MCP_BROKER_PROVIDER_SECRET` | (unset) | Shared secret every provider must present to occupy a slot. **Not gated by `auth.enabled`**: setting it alone turns provider authentication on |

`mcp-broker --help` prints the same list against the running build.

### Browser origins

Client endpoints (`/<slot>/mcp`, `/<slot>/sse`, `/<slot>/messages`) refuse any
request carrying an `Origin` header that is not allowed, with `403` and an
`invalid_origin` body. **The allow list is empty by default**, so out of the box
no browser origin passes while every non-browser client, which sends no
`Origin`, passes unchanged. This is the DNS-rebinding protection the MCP
specification asks for.

**A static mount does not exempt the origin it serves.** A page the broker
itself serves at `http://localhost:3000/` is still a browser origin and must be
listed:

```sh
MCP_BROKER_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
```

Match the scheme, host and port exactly as the browser sends them. If the broker
runs with TLS, the origin is `https://`, not `http://`.

Scope, precisely: the check covers the three **HTTP** client endpoints. A raw
WebSocket upgrade (`ws://<host>/<slot>`) and both provider endpoints are not
origin-checked, so `allowedOrigins` is not a substitute for authentication.

Full reference, including the regular-expression form and the
`withAllowedOrigins` predicate, in [docs/config.md](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/docs/config.md#allowedorigins).

## Reserved slots: `_broker` and `_all`

Two slot names are reserved. A provider that tries to claim either is refused
with `Provider "<name>" is reserved by the broker`.

### `_broker`, introspection

The broker registers **itself** as a provider under `_broker`, over an
in-process loopback transport. Reach it through any client transport, e.g.
`http://localhost:3000/_broker/mcp`. It proxies nothing: it is not a route to
other slots.

| tool | arguments | returns |
|---|---|---|
| `broker_info` | none | `{ name, version, uptimeSeconds, host, port, tls, paths }` |
| `providers_list` | none | every slot known to the broker, connected or not |
| `provider_status` | `{ name }` | one slot in detail |
| `broker_guide` | `{ topic? }` | one of the six guide pages; no argument returns the index |
| `broker_diagnose` | `{ slot? }` | live state plus proven problems, each with `symptom`, `evidence`, `fix` |

Matching resources for clients that prefer `resources/read`: `broker://info`,
`broker://providers`, the template `broker://providers/{name}`, the six
`broker://guide/<topic>` pages and the template `broker://guide/{topic}`.

Each provider entry from `providers_list` / `provider_status`:

```json
{
    "name": "weather",
    "transport": "ws",
    "connected": true,
    "aggregate": true,
    "connectedSince": "2026-09-14T08:12:03.417Z",
    "connectedForMs": 184211,
    "clientCount": 0,
    "sessionCount": 1,
    "pendingCount": 0
}
```

- The first six fields are about the **provider**: whether something serves
  the slot, over what, whether it is in `_all`, and since when. A
  `connectedSince` that is always a few seconds old is a provider that keeps
  reconnecting.
- The three counts are about the slot's **callers**. A connected provider that
  nobody is calling right now reads `clientCount: 0, sessionCount: 0,
  pendingCount: 0`; that is not a fault.
- `transport` is `ws` (dedicated socket), `ws-multiplex` (shared socket),
  `stdio` (**any** configured upstream: a child process from `stdioUpstreams`,
  a `.mcpb` bundle, *or* a remote URL from `mcpServers`), `loopback`
  (in-process), or `none` (the slot exists but nothing is serving it).
- `clientCount` counts **raw WebSocket clients only**. A perfectly healthy
  Streamable HTTP client reads as `clientCount: 0, sessionCount: 1`.
- `pendingCount` is the number of in-flight requests. One that only grows is the
  signature of a provider that is connected and not answering.

### `_all`, the aggregate

`_all` presents the union of the tools and prompts of every **opted-in**
provider as one MCP server. It is not a proxy and not automatic.

Membership, per provider kind:

| provider kind | joins `_all` when |
|---|---|
| WebSocket, `DirectTransport` | `new DirectTransport(url, { aggregate: true })` |
| WebSocket, `MultiplexTransport` | `MultiplexTransport.create(name, url, { aggregate: true })` |
| `stdioUpstreams[]` | `"aggregate": true` (**omitted means NOT aggregated**) |
| `mcpServers[]` | by default; `"aggregate": false` opts out |
| `mcpbBundles[]` | by default; `"aggregate": false` opts out |
| `_broker` | always, automatically |

That default asymmetry between `stdioUpstreams` and the other two is real and it
is worth re-reading before assuming a slot is in.

Names are prefixed with the origin slot, `<slot>-<original>`, and descriptions
are tagged `[<slot>] <original description>`.

> **Never reconstruct a prefixed name.** It is capped at 64 characters, an
> overlong one is truncated and given a hash suffix, and a collision between two
> providers is broken with a `-2`, `-3` suffix. The mapping back to
> `(provider, original)` is a lookup table, not a parse. Call `tools/list` on
> `_all` and pass the returned string back verbatim in `tools/call`.

`_all` implements `initialize`, `ping`, `tools/list`, `tools/call`,
`prompts/list` and `prompts/get`. **Everything else returns `-32601 Method not
found`, including `resources/list` and `resources/read`.** For a provider's
resources, connect to that provider's own slot.

It emits `notifications/tools/list_changed` and
`notifications/prompts/list_changed` when a provider joins, leaves or changes
its catalog, so a subscribing client sees a provider that arrives mid-session
without reconnecting. That is what makes `_all` the correct stdio-bridge target.

Registration snippets must **install the MCP message handler before announcing
the slot**. The broker sends `initialize` the moment it accepts an aggregate
registration; a provider not listening yet fails that handshake, is dropped from
`_all` and logged, with no retry. The SDK's `aggregate` option already does this
in the right order.

When authorization is enabled, `_all` **filters the catalog** rather than
rejecting the call: a caller sees only the providers it is scoped for, and a
tool it may not see answers `-32602 Unknown aggregated tool`, deliberately
indistinguishable from a name that does not exist.

## Authorization (OAuth 2.1)

By default the broker performs **no** authentication. That is fine behind a
trusted network boundary, but do not expose it publicly as-is. Turn on the OAuth 2.1
resource server to require a bearer token on every client request, authenticate
providers, and filter the `_all` aggregate per caller.

Enabled via the `auth` config block (or env vars). Minimal `.mcp-broker/config.json`:

The resource paths below use a compact ISA-95 / IEC 62264-aligned industrial
profile. The engine remains domain-neutral, does not claim full ISA-95
compliance, and can map UMD-style namespaces through `slotResources`.

```json
{
    "auth": {
        "enabled": true,
        "publicBaseUrl": "https://mcp.example.com",
        "authorizationServers": ["https://auth.example.com"],
        "jwks": "https://auth.example.com/.well-known/jwks.json",
        "requiredScopes": ["mcp:call"],
        "perSlotScopes": { "_broker": ["broker:admin"] },
        "subjectMapping": {
            "userClaim": "sub",
            "groupClaims": ["groups"],
            "clientClaim": "client_id"
        },
        "roles": {
            "viewer": {
                "capabilities": ["mcp.tools.list", "mcp.resources.read"]
            },
            "maintenance": {
                "inherits": ["viewer"],
                "capabilities": ["mcp.tools.diagnose"]
            }
        },
        "assignments": [
            {
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

With this on:

- `POST /<slot>/mcp` (and `/sse`, `/messages`, `ws://…/<slot>`) require
  `Authorization: Bearer <token>`; the token's audience must be
  `https://mcp.example.com/<slot>/mcp`.
- Clients discover the authorization server via
  `GET /.well-known/oauth-protected-resource/<slot>/mcp` (RFC 9728), advertised
  in the `401` challenge.
- Providers must present `providerSecret` (via `X-Provider-Token` or
  `Authorization: Bearer`) to connect to `/provider/<slot>` or `/providers`.
- `_all` only shows providers allowed by the caller's hierarchical policy.
- Explicit denies override inherited role grants.
- Structured provider principals can publish only inside their allowed resource
  namespace.

Two things this does **not** do. It does not authenticate the stdio bridge:
`MCP_BROKER_STDIO_PROVIDER` reaches `_all` with no principal attached, so
enabling per-provider scopes silently empties an MCP host's tool list. And it
cannot authenticate a browser-hosted provider: the secret is read from the
`X-Provider-Token` header or from `Authorization: Bearer`, and the browser
`WebSocket` constructor cannot set headers, so setting `providerSecret` locks
every browser provider out permanently with an HTTP 401 that reaches the page as
a bare `error` event. Run without a provider secret, or terminate provider auth
in a reverse proxy that injects the header.

Full model, flows, scopes, and endpoints:
**[docs/authorization.md](https://github.com/pandaGaume/mcp-broker/blob/main/docs/authorization.md)**.
Roles, resource paths, denies, and migration:
**[docs/hierarchical-authorization.md](https://github.com/pandaGaume/mcp-broker/blob/main/docs/hierarchical-authorization.md)**.
Config field reference: **[docs/config.md](https://github.com/pandaGaume/mcp-broker/blob/main/node/packages/broker/docs/config.md#auth-oauth-21-authorization)**.
(The first two live in the repository and are not shipped in the npm package.)

## Programmatic API

```ts
import { WsTunnelBuilder } from "@cyanmycelium/mcp-broker";

const broker = new WsTunnelBuilder()
    .withPort(3000)
    .withHost("0.0.0.0")
    .withProviderPath("/provider")
    .withMcpPath("/mcp")
    // Required before any browser page can reach a client endpoint.
    .withAllowedOrigins(["http://localhost:5173"])
    // Optional: bridge a local stdio MCP server as a provider. One object, not positional args.
    .withStdioUpstream({ name: "my-server", command: "node", args: ["./my-server.js"], aggregate: true })
    // Optional: front a remote MCP server reached by URL.
    .withRemoteUpstream({ name: "geo", url: "https://geo.example.com/mcp" })
    // Optional: serve a dev harness at /
    .withStaticMount("/", "/abs/path/to/www")
    // Optional: enable the OAuth 2.1 resource server + provider auth
    .withJwtAuth({
        publicBaseUrl: "https://mcp.example.com",
        authorizationServers: ["https://auth.example.com"],
        jwksUri: "https://auth.example.com/.well-known/jwks.json",
        requiredScopes: ["mcp:call"],
        roles: {
            viewer: { capabilities: ["mcp.tools.list"] },
        },
        assignments: [
            {
                subject: "group:operators",
                role: "viewer",
                resource: "/enterprise/site-a/**",
            },
        ],
        subjectMapping: { groupClaims: ["groups"] },
    })
    .withProviderSecret(process.env.PROVIDER_SECRET!)
    .build();

await broker.start();
```

`start()` **rejects** on a listen failure, with a message naming the port and
what to do about it. Await it, or handle the rejection: `void broker.start()`
produces an unhandled rejection.

An MCP server living in the same process needs no WebSocket at all:

```ts
import { LoopbackTransport, McpServerBuilder } from "@cyanmycelium/mcp-core";

const [serverEnd, clientEnd] = LoopbackTransport.createPair();
const server = new McpServerBuilder().withTransport(serverEnd).register(/* behaviors */).build();
await server.start();
broker.registerLoopbackProvider("in-process", clientEnd);
```

A loopback slot outranks a WebSocket provider of the same name: the WebSocket
one is refused with `Provider "<name>" is reserved by the broker`.

Provider liveness has three knobs, all also settable from the config file and
from `MCP_BROKER_*`:

| method | default | what it addresses |
|---|---|---|
| `withProviderHeartbeat(ms)` | `30000` | a half-open socket holding a slot until TCP keepalive expires, hours later. `0` disables |
| `withProviderTakeover(mode)` | `"liveness"` | `"reject"` keeps the incumbent always; `"always"` needs provider auth and a matching principal, and degrades to `"liveness"` with a log otherwise |
| `withProviderRequestTimeout(ms)` | `60000` | a provider that stays connected and never answers, the ordinary state of a throttled background browser tab. `0` disables |

A pong is answered by the peer's network stack, so the heartbeat proves the
*process* is alive, not that it is serving. `withProviderRequestTimeout` is what
covers the second case.

All builder methods are documented inline. The full options interface is
`IWsTunnelOptions`, also exported. Use `withAuthorizationPolicy` for a
standalone policy configuration, `withPolicyEngine` for a custom engine, and
`withSlotResourceResolver` for a custom namespace mapping. For a custom token
validator (for example RFC 7662 introspection) or provider authenticator, use
`withAuth(resolvedAuth)` or `withProviderAuth(authenticator)` with your own
`ITokenValidator` or `IProviderAuthenticator`.

`brokerName` is honored by `IWsTunnelOptions` but there is no
`withBrokerName()`, so the CLI cannot forward the config-file key. Set it
through `IWsTunnelOptions` directly if you need it.

## Runnable samples

Five self-contained integration samples live in the repository, outside this
package: [samples/](https://github.com/pandaGaume/mcp-broker/tree/main/samples).
Each starts what it needs and proves itself end to end, and
[samples/index.json](https://github.com/pandaGaume/mcp-broker/blob/main/samples/index.json)
indexes them for an agent. They are not in this package's `files`, so they are
on GitHub rather than in `node_modules`.

Everything below *does* ship inside the npm package under `web/`, so it is
available from `node_modules/@cyanmycelium/mcp-broker/web`.

| path | what it shows |
|---|---|
| [`web/demos/provider-tunnel/`](web/demos/provider-tunnel/) | a browser page hosting an MCP server and tunnelling it into a slot |
| [`web/demos/broker-explorer/`](web/demos/broker-explorer/) | a browser MCP **client** driving `_broker`, `_all` or any slot |
| [`web/demos/oauth-lab/`](web/demos/oauth-lab/) | a complete local OAuth 2.1 and policy environment |
| [`.mcp-broker.example/`](.mcp-broker.example/) | a config template with per-key guides in [English](.mcp-broker.example/CONFIGURATION-EN.md) and [French](.mcp-broker.example/CONFIGURATION-FR.md), plus `config.stdio-bridge.json` |

Serve the whole `web/` folder from an installed package in one command:

```sh
MCP_BROKER_WWW_DIR=node_modules/@cyanmycelium/mcp-broker/web \
MCP_BROKER_ALLOWED_ORIGINS=http://localhost:3000 \
MCP_BROKER_OPEN=1 \
npx @cyanmycelium/mcp-broker
```

`MCP_BROKER_ALLOWED_ORIGINS` is there because a page that reaches a slot over
**HTTP** (`/<slot>/mcp`, `/<slot>/sse`, `/<slot>/messages`) is origin-checked,
and the broker serving the page does not exempt it. A page that uses only
WebSocket transports does not need it: WebSocket upgrades carry no origin check
at all, which is worth knowing in both directions.

## Interactive OAuth demo

The bundled [OAuth Policy Lab](web/demos/oauth-lab/) runs a complete local
Authorization Code and PKCE flow with signed JWTs, JWKS validation,
audience-bound tokens, hierarchical policies, explicit denies, and a live
audit:

```sh
npm run demo:oauth
```

The page opens at `http://127.0.0.1:3001/demos/oauth-lab/`. See the
[demo README](web/demos/oauth-lab/README.md) for its identities, policy matrix,
and automated smoke test.

## TLS for local development

`gen-cert` is a repository script, not part of the published package: it needs
`selfsigned`, which is a devDependency. From a checkout of this repo, in
`node/packages/broker`:

```sh
npm run gen-cert -- --out .mcp-broker/certs
# Writes .mcp-broker/certs/cert.pem and .mcp-broker/certs/key.pem

MCP_BROKER_TLS_CERT=.mcp-broker/certs/cert.pem \
MCP_BROKER_TLS_KEY=.mcp-broker/certs/key.pem \
npm start
```

Without `--out` the script writes to `../certs` resolved against the working
directory, which for an npm script is the package directory. Pass `--out`
whenever you care where the files land.

Outside this repository, `openssl` does the same job:

```sh
mkdir -p .mcp-broker/certs && openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout .mcp-broker/certs/key.pem -out .mcp-broker/certs/cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Setting both a certificate and a key switches the **whole** server to HTTPS and
WSS at once. There is no mixed mode: providers then connect with `wss://`,
clients with `https://`, and every entry in `allowedOrigins` must be spelled
`https://` or it will match nothing. The files are read synchronously when the
tunnel is built, so a wrong path fails before the port is bound.

The generated certificate covers `localhost`, `127.0.0.1`, `::1` for 365 days. Browsers will warn about an untrusted issuer on first visit. Click "Advanced → Proceed". MCP clients (Claude, Inspector) ignore certificate validation by default.

## Docker

A multi-stage `Dockerfile` ships with the package: build stage compiles TypeScript and copies grammar JSON, runtime stage carries only the compiled `dist/`, production `node_modules`, and runs as a non-root user.

```sh
# From the node/ directory
docker build -t cyanmycelium/mcp-broker:0.1.0 .

# Run on host port 3000
docker run --rm -p 3000:3000 cyanmycelium/mcp-broker:0.1.0

# With a custom locale and host port
docker run --rm -p 4000:4000 \
    -e MCP_BROKER_PORT=4000 \
    -e MCP_BROKER_LOCALE=fr-CA \
    cyanmycelium/mcp-broker:0.1.0
```

### Mounting TLS material

```sh
# Generate localhost certs on the host first
npm run gen-cert  # writes ../certs/cert.pem and ../certs/key.pem

docker run --rm -p 3000:3000 \
    -v "$(pwd)/../certs:/certs:ro" \
    -e MCP_BROKER_TLS_CERT=/certs/cert.pem \
    -e MCP_BROKER_TLS_KEY=/certs/key.pem \
    cyanmycelium/mcp-broker:0.1.0
```

### Mounting a static dev harness

```sh
docker run --rm -p 3000:3000 \
    -v "$(pwd)/public:/www:ro" \
    -e MCP_BROKER_WWW_DIR=/www \
    cyanmycelium/mcp-broker:0.1.0
```

### Health check

The image declares a `HEALTHCHECK` that opens a TCP socket on `MCP_BROKER_PORT`. Orchestrators (Docker Compose, Kubernetes liveness probe) pick it up automatically.

### docker-compose snippet

```yaml
services:
  broker:
    build: .
    # Or pull a published image once available:
    # image: ghcr.io/pandagaume/mcp-broker:0.1.0
    ports:
      - "3000:3000"
    environment:
      MCP_BROKER_PORT: "3000"
      MCP_BROKER_LOCALE: "en"
    restart: unless-stopped
```

## Claude Desktop integration

The broker can act as a stdio MCP server for Claude Desktop and any other stdio
MCP host. **Point the bridge at `_all`, not at one of your slots:**

```json
{
  "mcpServers": {
    "mcp-broker": {
      "command": "npx",
      "args": ["-y", "@cyanmycelium/mcp-broker"],
      "env": {
        "MCP_BROKER_STDIO_PROVIDER": "_all",
        "MCP_BROKER_PORT": "3000",
        "MCP_BROKER_HOST": "127.0.0.1"
      }
    }
  }
}
```

### Why `_all` and not your slot

This is an ordering problem, and pinning a real slot fails every single time.

An MCP host starts its servers when the host application launches. It sends
`initialize` immediately and treats a failure as a dead server: no retry, no
backoff, the entry is disabled for the session. Your provider does not exist
yet. A browser provider needs a human to open a page; a provider in another
process needs that process to start. So the bridge answers the host's very first
`initialize` with `-32000 Provider "<slot>" not connected`, and the host gives
up. **Pinning a real slot never works for a browser-hosted provider at all.**

`_all` is registered before the broker resumes stdin, so the slot exists before
the host's first byte arrives. It answers `initialize` itself. It already
aggregates `_broker`, so the host always has at least the five introspection
tools. And it pushes `notifications/tools/list_changed` when a provider joins,
so a page opened ten minutes into the session appears in the host's tool list
live, with no reconnect.

`_broker` is the fallback if you want introspection only. It is also always up,
but it will never show anything except the broker's own five tools.

Providers still have to **opt in** to `_all` (see
[Reserved slots](#reserved-slots-_broker-and-_all)). If the host shows only
`_broker-*` tools, nothing opted in; call `_broker-broker_diagnose` and it will
say so.

### One broker per port

Do not add a second host entry that spawns another broker. The second process
cannot bind the port and dies; the host reports `Connection closed` with no
cause, and the real `EADDRINUSE` diagnosis is only in the host's
`mcp-server-<name>.log`. If you want two logical servers visible to the host,
publish both into the one broker and let `_all` union them.

### The bridge is anonymous

The stdio bridge forwards frames to `_all` with **no principal attached**. While
no authorization is configured that is invisible. The moment you enable
per-provider scopes, or any policy that denies an anonymous subject, the host's
tool list silently empties: `tools/list` still succeeds and returns
`tools: []`, and nothing anywhere says why.

In this mode all broker logging goes to stderr; stdout is reserved for the JSON-RPC stream the host expects.

## Troubleshooting

Call `broker_diagnose()` on the `_broker` slot first. It reads the live state
and names the problems it can prove. This table is the reference behind it, and
covers the failures the broker cannot see from the inside.

| symptom | cause | fix |
|---|---|---|
| Client hangs forever on `initialize`, provider shows `connected: true` | `MultiplexTransport` on `/provider/<name>` | move it to `ws://<host>/providers`, or switch it to `DirectTransport` |
| Provider socket open, slot never appears in `providers_list` | `DirectTransport` on `/providers` | move it to `ws://<host>/provider/<name>`, or switch it to `MultiplexTransport` |
| Provider on `/providers/<name>`, nothing works | that path is neither endpoint: it is accepted as a **client** on a slot named `providers/<name>` | drop the name for multiplex, or add `/provider/` for a dedicated socket |
| WebSocket closes `1008 already connected` after a reload | a stale socket still holds the slot | release on `pagehide`; the heartbeat frees a genuinely dead one within one interval |
| Host reports `Connection closed` with no cause | a second broker could not bind the port | one broker per port; `EADDRINUSE` is in `mcp-server-<name>.log` |
| `403 invalid_origin` from a page this broker serves | a static mount does not exempt the origin it serves | list that exact origin, scheme and port included |
| `Provider "<slot>" not connected` at host start | ordering: the host starts before any provider exists | point `MCP_BROKER_STDIO_PROVIDER` at `_all` |
| `_all` shows only `_broker-*` tools | nothing opted into the aggregate | see [Reserved slots](#reserved-slots-_broker-and-_all); verify with `tools/list` on `_all` |
| Host's tool list empties after enabling authorization | the stdio bridge is anonymous | grant the anonymous subject, or stop bridging in authorized deployments |
| Browser provider gets a bare `error` event | provider auth is on; a browser cannot send the header | run without a provider secret, or authenticate in a proxy |
| `-32601 Method not found` on `_all` | `_all` covers tools and prompts only | use the provider's own slot for resources |
| `-32602 Unknown aggregated tool` | the prefixed name was reconstructed rather than echoed | re-run `tools/list`, pass the name back verbatim |
| `did not respond within 60000ms` | the provider stayed connected and never answered | raise `providerRequestTimeoutMs`, or fix the provider |
| `sessionCount` grows and never falls | Streamable HTTP and SSE sessions do not expire | send `DELETE /<slot>/mcp` when a client is done; restart if it is already large |

Reading the console: the broker prints one line per accepted WebSocket upgrade
naming the path, the role the router assigned (`dedicated-provider`,
`multiplex-provider` or `client`) and the slot. **A provider URL that came out
as `role=client` is the mismatch, caught for free.** In stdio mode every log
goes to stderr, so look in the host's `mcp-server-<name>.log`, never on stdout.
Do not read silence as success: routed frames and provider replies are not
logged at all, and `providers_list` plus `broker_diagnose` are the ground truth.

## Development

```sh
npm install
npm run build      # tsc -b
npm test           # vitest run
npm run lint
npm start          # node dist/bin.js
```

Requires Node 20.11+.

### Running the broker of this checkout

`npm start` runs `dist/bin.js`, the code of the working tree once `npm run
build` has been run (from `node/`, which builds the provider package first).
It reads `.mcp-broker/config.json` next to `package.json` when there is one;
that folder is gitignored, so each checkout keeps its own. A config that makes
the broker reachable from a device on the LAN and serves this package's `web/`
(the broker explorer at `/demos/broker-explorer/`) from the same port:

```json
{
    "port": 3000,
    "host": "0.0.0.0",
    "www": { "open": false, "mounts": [{ "urlPrefix": "/", "dir": "../web" }] },
    "allowedOrigins": ["http://localhost:3000", "http://127.0.0.1:3000"]
}
```

Paths in the file resolve against the file's own directory, hence `../web`.
Keep the terminal open: the process lives as long as it does. Without the
file the defaults apply, `0.0.0.0:3000` and no static mount. Every C sample,
the roundtrip and the soak in [`c/`](https://github.com/pandaGaume/mcp-broker/tree/main/c)
target this broker, not an installed one.

## Releasing

The package is published to npm by [`.github/workflows/release-node.yml`](https://github.com/pandaGaume/mcp-broker/blob/main/.github/workflows/release-node.yml), triggered by tags of the form `node-v*`.

```sh
# from the node/ directory:
npm version patch            # creates a "node-v0.1.1" tag (.npmrc sets the prefix)
git push --follow-tags
```

The workflow runs lint, build, test, then `npm publish --access public --provenance` and creates a GitHub Release with auto-generated notes.

## License

Apache-2.0. See [LICENSE](LICENSE).
