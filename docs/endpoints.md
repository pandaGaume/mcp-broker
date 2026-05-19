# Endpoints

A reference list of every URL the broker exposes by default. All paths are configurable; defaults shown here.

## Provider side (incoming)

| Method | Path | Purpose |
|---|---|---|
| WS | `/provider/<encodedName>` | Dedicated WebSocket. One provider per socket. |
| WS | `/providers` | Multiplexed WebSocket. Carries N providers via `{ provider, payload }` envelope. |

## Client side (outgoing)

For each connected provider slot `<name>`:

| Method | Path | Purpose |
|---|---|---|
| WS | `/<encodedName>` | Raw WebSocket transport. |
| POST | `/<encodedName>/mcp` | Streamable HTTP request. Holds the response until the provider replies. |
| GET | `/<encodedName>/mcp` | Streamable HTTP notification stream (long-lived). |
| GET | `/<encodedName>/sse` | Legacy SSE notification stream. Emits one `endpoint` event with the messages URL. |
| POST | `/<encodedName>/messages?sessionId=<uuid>` | Legacy SSE request channel. |

## Reserved `_broker` slot — self-introspection

The broker registers itself as a provider under the reserved slot `_broker`.
The same client-side endpoints apply, with `<encodedName>` = `_broker`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/_broker/mcp` | Call broker introspection tools (`broker_info`, `providers_list`, `provider_status`) or read introspection resources (`broker://info`, `broker://providers`, `broker://providers/{name}`) |
| GET | `/_broker/mcp` | Notification stream from the broker (currently no broker-emitted notifications) |
| WS | `/_broker` | Raw WebSocket MCP transport to the broker introspection server |

The broker's MCP server is in-process and connected to the routing layer via
a loopback transport — there is no real network hop. Reachable through every
client-side transport the broker exposes, just like a regular provider slot.

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

| Default | Builder method | Notes |
|---|---|---|
| `/provider` | `withProviderPath` | Prefix; the encoded provider name is appended |
| `/providers` | `withProvidersPath` | Exact match |
| `/` | `withClientPath` | Prefix for raw WS clients |
| `/mcp` | `withMcpPath` | Suffix appended to `/<name>` |
| `/sse` | `withSsePath` | Suffix appended to `/<name>` |
| `/messages` | `withMessagesPath` | Suffix appended to `/<name>` |
| `/__samples_index__` | `withSamplesIndexPath` | Exact match |
