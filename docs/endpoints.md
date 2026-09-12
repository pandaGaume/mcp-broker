# Endpoints

A reference list of every URL the broker exposes by default. All paths are configurable; defaults shown here.

> **Authorization.** By default the broker performs **no** authentication: the
> table below describes the open, trusted-network mode. When the OAuth 2.1
> resource server is enabled, client endpoints require a bearer token, provider
> endpoints require a shared secret, and a discovery endpoint is added. The
> "Auth" column notes what is required in that mode. See
> [authorization.md](authorization.md) for the full model.

## Provider side (incoming)

| Method | Path | Framing | Transport class | Reconnects | Auth (when enabled) |
|---|---|---|---|---|---|
| WS | `/provider/<encodedName>` | plain JSON-RPC, one message per frame | `DirectTransport` | **no**, reconnect yourself in `onClose` | Provider shared secret |
| WS | `/providers` | envelopes `{ provider, payload }` | `MultiplexTransport` | yes, exponential backoff with jitter, capped at 30 s | Provider shared secret |

> **The pairing rule.** The two rows are not interchangeable. The broker decides
> which framing to speak on a socket from the URL that socket connected to,
> never from what arrives on it, so a transport on the wrong path fails
> silently in the direction that matters. `/provider` is a **prefix** with the
> encoded slot name appended; `/providers` is matched **exactly**.
>
> `/providers/<name>` is neither. It matches neither branch and falls through to
> the client side, where it is accepted as an MCP *client* on a slot literally
> named `providers/<name>`.

Two more shapes are refused at the handshake with HTTP `400` and a body naming
the fix: bare `/provider` with no name (which used to mint a slot named
`(unnamed)`) and `/provider/a/b`. Use the percent-encoded `/provider/a%2Fb`
spelling for a hierarchical slot name; it aliases to the same slot and stays
supported.

Neither provider endpoint is origin-checked. WebSocket upgrades carry no
`Origin` validation at all, so `allowedOrigins` is not a substitute for provider
authentication.

## Client side (outgoing)

For each connected provider slot `<name>`:

| Method | Path | Purpose | Auth (when enabled) |
|---|---|---|---|
| WS | `/<encodedName>` | Raw WebSocket transport. | Client bearer token (at upgrade) |
| POST | `/<encodedName>/mcp` | Streamable HTTP request. Holds the response until the provider replies. | Client bearer token |
| GET | `/<encodedName>/mcp` | Streamable HTTP notification stream (long-lived). | Client bearer token |
| DELETE | `/<encodedName>/mcp` | Terminates the session named by `Mcp-Session-Id`. | Client bearer token |
| GET | `/<encodedName>/sse` | Legacy SSE notification stream. Emits one `endpoint` event with the messages URL. | Client bearer token |
| POST | `/<encodedName>/messages?sessionId=<uuid>` | Legacy SSE request channel. | Client bearer token |

### Sessions on `/<name>/mcp`

This endpoint runs the Streamable HTTP state machine from `mcp-core`, so it
behaves like any spec-compliant MCP server rather than like a blind relay:

- `initialize` opens a session and its response carries `Mcp-Session-Id`. Every
  later request must send that header back; one that does not gets `400`, and
  one naming a terminated session gets `404`, which is the signal to
  re-`initialize`.
- A request carrying an `Origin` header is refused with `403` and an
  `invalid_origin` body unless that origin was allowed by the operator, which
  nothing is by default. A request carrying no origin is always accepted, so
  Claude Desktop, MCP Inspector and the server-side SDKs are unaffected. This is
  the DNS-rebinding protection the spec asks for; see `allowedOrigins` in the
  [config reference](../node/packages/broker/docs/config.md#allowedorigins).
  The same check applies to `/<name>/sse` and `/<name>/messages`, using the same
  predicate object so the two cannot drift. A page served by the broker's own
  static mount is **not** exempt.
- An `MCP-Protocol-Version` header naming a revision the broker does not
  implement is refused with `400`.
- A notification (no `id`) is acknowledged with `202`, since nothing will answer it.

## Authorization (when the resource server is enabled)

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource/<encodedName>/mcp` | Protected Resource Metadata (RFC 9728) for the slot. Public, unauthenticated. Advertises the authorization server(s). |

A missing/invalid client token yields `401` with a
`WWW-Authenticate: Bearer resource_metadata="…"` header; an insufficient scope
yields `403`. See [authorization.md](authorization.md).

## Reserved `_broker` slot: self-introspection

The broker registers itself as a provider under the reserved slot `_broker`.
The same client-side endpoints apply, with `<encodedName>` = `_broker`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/_broker/mcp` | Call the five introspection tools, or read the introspection resources |
| GET | `/_broker/mcp` | Notification stream from the broker (currently no broker-emitted notifications) |
| WS | `/_broker` | Raw WebSocket MCP transport to the broker introspection server |

Tools: `broker_info`, `providers_list`, `provider_status({ name })`,
`broker_guide({ topic? })`, `broker_diagnose({ slot? })`.

Resources: `broker://info`, `broker://providers`, the template
`broker://providers/{name}`, the six pages `broker://guide/index`,
`broker://guide/publish-provider`, `broker://guide/connect-client`,
`broker://guide/host-config`, `broker://guide/deploy`,
`broker://guide/troubleshooting`, and the template `broker://guide/{topic}`.

`broker_guide` serves the broker's own integration guide, with the deployment's
effective configuration (host, port, scheme, all six URL paths) appended to each
page, so it can never silently contradict what the process is actually doing.
`broker_diagnose` returns live state plus proven problems, each with `symptom`,
`evidence` and a `fix`; it has no backing resource on purpose, because resource
content is cached and a cached diagnosis is stale exactly when it matters.

The broker's MCP server is in-process and connected to the routing layer via
a loopback transport, there is no real network hop. Reachable through every
client-side transport the broker exposes, just like a regular provider slot.
It proxies nothing: `_broker` is not a route to other slots.

Because `_broker` is a regular slot, it rides the same client authorization gate
when auth is enabled: `/_broker/mcp` then needs a bearer token, and it can be
placed behind a dedicated admin scope. See [authorization.md](authorization.md).

## Reserved `_all` slot: the aggregate

The same client-side endpoints apply, with `<encodedName>` = `_all`. The
aggregate is registered at broker startup, before the stdio bridge resumes
stdin, so it is available from the moment the process is up. It presents the
union of the tools and prompts of every provider that opted in, with names
prefixed `<slot>-<original>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/_all/mcp` | `initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`. **Every other method returns `-32601 Method not found`**, including `resources/list` and `resources/read` |
| GET | `/_all/mcp` | Notification stream. Carries `notifications/tools/list_changed` and `notifications/prompts/list_changed` when a provider joins, leaves or changes its catalog |
| WS | `/_all` | Raw WebSocket MCP transport to the aggregate |

Membership is opt-in, and the default differs by provider kind:
`stdioUpstreams[]` needs `"aggregate": true`; `mcpServers[]` and
`mcpbBundles[]` are in unless given `"aggregate": false`; a WebSocket provider
sends the aggregate registration (the SDK's `aggregate` transport option);
`_broker` is always in. Never reconstruct a prefixed name: it is capped, hashed
when overlong, and de-duplicated with a numeric suffix, so `tools/list` is the
only authority. See [architecture.md](architecture.md).

## Utility

| Method | Path | Purpose |
|---|---|---|
| OPTIONS | (any) | CORS preflight. Returns 204. |
| GET | `/__samples_index__` | Returns `{ files: string[] }` listing the `samples/` directory of the root static mount, when one is configured. Useful when the broker also serves a dev harness. |

## Static mounts

If at least one static mount is configured, anything not matching the routes above is served from disk under the longest-prefix-matching mount. Directory requests fall back to `index.html`.

By default, no static mount is configured. To serve a dev harness, set `MCP_BROKER_WWW_DIR` (Node implementation) or call `.withStaticMount("/", "/abs/path/to/www")` in code.

## Path overrides

Every default path is configurable:

| Default | Builder method | Config key | Env var | Notes |
|---|---|---|---|---|
| `/provider` | `withProviderPath` | `paths.provider` | `MCP_BROKER_PROVIDER_PATH` | Prefix; the encoded provider name is appended. Plain JSON-RPC framing |
| `/providers` | `withProvidersPath` | `paths.providers` | `MCP_BROKER_PROVIDERS_PATH` | Exact match. Envelope framing |
| `/` | `withClientPath` | `paths.client` | `MCP_BROKER_CLIENT_PATH` | Prefix for raw WS clients |
| `/mcp` | `withMcpPath` | `paths.mcp` | `MCP_BROKER_MCP_PATH` | Suffix appended to `/<name>` |
| `/sse` | `withSsePath` | `paths.sse` | `MCP_BROKER_SSE_PATH` | Suffix appended to `/<name>` |
| `/messages` | `withMessagesPath` | `paths.messages` | `MCP_BROKER_MESSAGES_PATH` | Suffix appended to `/<name>` |
| `/__samples_index__` | `withSamplesIndexPath` | (none) | (none) | Exact match |

Resolution order for the six configurable paths is
`env var → config file → default`. Moving one moves the endpoint for **every**
peer at once: providers, clients, the startup banner and `broker_info` all have
to agree. Call `broker_info` on `_broker` to read the effective values rather
than assuming the defaults.
