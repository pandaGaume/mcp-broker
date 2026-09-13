# AGENTS.md, mcp-broker

Read this file first. It is written for an AI coding agent told "embed mcp-broker into this project" with no prior knowledge, and it is meant to be enough on its own.

## 0. Ask the broker instead of reading docs

A **running** broker documents itself over MCP on the reserved `_broker` slot (and through `_all`, which aggregates it). If you can reach one, do that instead of reading this file:

| call | gives you |
|---|---|
| `broker_guide({ topic? })` | six Markdown pages: `index`, `publish-provider`, `connect-client`, `host-config`, `deploy`, `troubleshooting` |
| resources `broker://guide/{topic}` | the same pages, as MCP resources |
| `broker_diagnose({ slot? })` | live state **plus** proven problems, each with `symptom`, `evidence`, `fix`; since 1.3.1 it also reads `_all` membership (`aggregate-empty`, `aggregate-missing-live-slots`) |
| `broker_info` | identity, version, uptime, bind address, TLS, the effective URL paths |
| `providers_list` / `provider_status({ name })` | every slot / one slot in detail |

The guide is generated from the broker's own source (`node/packages/broker/src/broker/broker.guides.ts`), and it injects the deployment's *effective* configuration into every page. When it disagrees with this file, it wins. When something is broken, call `broker_diagnose` before reading anything.

## 1. What this is, and the one decision

One process that puts N MCP servers behind one host and one port. Each server occupies a named **slot**. Servers reach a slot from the inside as *providers*; MCP clients reach a slot from the outside. Slots are lazy: any name works, nothing is declared in advance.

| your situation | do this |
|---|---|
| You need a broker, and you do not own a Node process that should host it | **Run the process**: `npx @cyanmycelium/mcp-broker` |
| Your app already owns an HTTP port, or hosts MCP servers in-process | **Embed the library**: `new WsTunnelBuilder()...build()`, then `await tunnel.start()` |
| You are wiring Claude Desktop or another stdio MCP host | Run the process with `MCP_BROKER_STDIO_PROVIDER=_all` (see §4) |
| You are writing an MCP **client** | Install nothing of ours. Point a standard MCP client at `http://<host>/<slot>/mcp` |

## 2. Topology table

| I am building | install | class / entry point | connects to |
|---|---|---|---|
| The broker, as a process | `@cyanmycelium/mcp-broker` | `npx @cyanmycelium/mcp-broker` | listens on `:3000` |
| The broker, embedded in my app | `@cyanmycelium/mcp-broker` | `WsTunnelBuilder` | listens on the port you give it |
| An MCP server published into one slot | `@cyanmycelium/mcp-broker-provider` | `DirectTransport` | `ws://<host>/provider/<name>` |
| Several MCP servers from one page/process | `@cyanmycelium/mcp-broker-provider` | `MultiplexTransport` | `ws://<host>/providers` |
| An MCP server in the **same process** as the broker | `@cyanmycelium/mcp-core` | `LoopbackTransport` + `tunnel.registerLoopbackProvider(name, transport)` | no socket at all |
| An MCP client | nothing of ours | any spec-compliant MCP client | `http://<host>/<slot>/mcp` |
| A local stdio MCP server the broker should run | nothing | config key `stdioUpstreams[]` | broker spawns it |
| A remote MCP server the broker should front | nothing | config key `mcpServers[]` | broker dials out |
| A signed `.mcpb` bundle the broker should run | nothing | config key `mcpbBundles[]` | broker verifies, unpacks, spawns |
| An MCP server on an **ESP32** (or any C99 firmware) | [`c/libmcpb`](c/libmcpb/) + a port; on ESP-IDF the [`mcpb_esp`](c/espressif/) component | `mcpb_provider_t` / `mcpb_esp_start` | `ws://<host>/provider/<name>` |
| Several MCP servers from **Unreal Engine 5** (or any native process) | the [`McpBroker`](c/unreal/) plugin, built on `c/libmcpb` | `UMcpBrokerSubsystem::Connect` | `ws://<host>/providers`, one socket for all slots |

The `_all` opt-in rides on one frame, `{"jsonrpc":"2.0","method":"notifications/register","params":{"aggregate":true}}`, sent first on the socket by provider 0.2.0 and by `libmcpb`. A broker older than 1.3.0 does not know that frame: the slot works, the provider stays out of `_all`. Pair provider 0.2.x and `c/` with broker 1.3.0 or later.

## 3. The pairing rule

```
┌──────────────────────────────────────────────────────────────────────────┐
│  A PROVIDER'S TRANSPORT AND ITS URL PATH ARE A MATCHED PAIR.             │
│                                                                          │
│    DirectTransport      <->  ws://<host>/provider/<name>                 │
│                              plain JSON-RPC frames, one slot per socket  │
│                                                                          │
│    MultiplexTransport   <->  ws://<host>/providers                       │
│                              envelopes { provider, payload }, N slots    │
│                                                                          │
│  ws://<host>/providers/<name> IS NEITHER. It falls through to the        │
│  client branch and is accepted as an MCP *client* on a slot literally    │
│  named "providers/<name>". Nothing errors. Your slot stays empty.        │
└──────────────────────────────────────────────────────────────────────────┘
```

Both mismatches used to fail silently. As of 1.3.0 the broker detects each on the first frame, answers in the framing the peer can actually decode, and closes with code `1008` and a reason naming both corrections. Do not rely on that: older brokers stay silent.

Observable signatures, if you are debugging one:

- **MultiplexTransport on `/provider/<name>`**: `provider_status` shows `connected: true`, `transport: "ws"`, `pendingCount` climbing and never falling. The client's `initialize` never resolves.
- **DirectTransport on `/providers`**: your socket is open, and the slot never appears in `providers_list` at all. Clients get `-32000 Provider "<n>" not connected`.

`broker_diagnose` reports the first as `transport-path-mismatch`.

## 4. Copy-pasteable configurations

### 4a. MCP host (Claude Desktop and friends)

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

**Pin the bridge to `_all`, never to a real slot.** The host sends `initialize` the instant it launches and treats a failure as a dead server: no retry, no backoff. Your provider does not exist yet, so a real slot answers `-32000 Provider "<slot>" not connected` and the host gives up permanently. `_all` is registered before the broker resumes stdin, answers `initialize` itself, already aggregates `_broker`, and pushes `notifications/tools/list_changed` when a provider joins later. `_broker` is the fallback if you want introspection only.

**One broker per port.** A second host entry spawning another broker cannot bind and dies; the host says `Connection closed` and the real `EADDRINUSE` diagnosis is only in `mcp-server-<name>.log`.

**The bridge is anonymous.** It reaches `_all` with no principal. Invisible until you enable authorization, at which point the host's tool list silently empties.

**A host that speaks Streamable HTTP does not need the bridge.** Claude Code (`.mcp.json`), and any host with an `http` server type, can point straight at a slot of a broker you run once, on the side:

```json
{
    "mcpServers": {
        "mcp-broker": { "type": "http", "url": "http://127.0.0.1:3000/_all/mcp" }
    }
}
```

No second process and no start-order problem: the host talks to the slot when it needs it. `_all` for the tools, `_broker` for introspection only, `/<slot>/mcp` for one provider.

### 4b. Browser provider

```ts
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { McpServerBuilder } from "@cyanmycelium/mcp-core";

const transport = new DirectTransport("ws://localhost:3000/provider/my-slot", { aggregate: true });
const server = new McpServerBuilder().withName("my-slot").withTransport(transport).register(/* behaviors */).build();

await server.start();

// Release the slot, or a reload is refused with close code 1008 until the
// heartbeat notices the old socket is dead (up to one interval, 30 s).
addEventListener("pagehide", () => transport.close());
```

- `server.start()` resolving means **the socket reported itself open**. It is not a connection guarantee and not proof the broker accepted the slot: a refusal arrives afterwards as a `1008` close whose reason says which refusal it was. Do not log "connected" there.
- `{ aggregate: true }` is what puts the slot in `_all`. Without it the slot is reachable at `/<slot>/mcp` but invisible to any stdio host bridged to `_all`.
- A bundler is required. Both packages ship ESM under `dist/`, no `browser` field, no UMD.
- **Provider authentication cannot work from a browser.** The secret is read from `X-Provider-Token` or `Authorization: Bearer`, and the browser `WebSocket` constructor cannot set headers. If the broker has a provider secret, every browser provider is refused with HTTP 401 that reaches your page as a bare `error` event. Run without a provider secret, or terminate provider auth in a reverse proxy.
- On Node 20 assign `globalThis.WebSocket` before connecting; Node 22+ has one.

### 4c. Embedded broker

```ts
import { WsTunnelBuilder } from "@cyanmycelium/mcp-broker";
import { LoopbackTransport, McpServerBuilder } from "@cyanmycelium/mcp-core";

const tunnel = new WsTunnelBuilder()
    .withPort(3000)
    .withHost("127.0.0.1")
    .withAllowedOrigins(["http://localhost:5173"])   // browsers are refused until listed
    .withStaticMount("/", "/abs/path/to/www")
    .withStdioUpstream({ name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"], aggregate: true })
    .build();

await tunnel.start();   // rejects on EADDRINUSE with a message naming the port and the fix

// An MCP server in this same process: no socket, no framing to get wrong.
const [serverEnd, clientEnd] = LoopbackTransport.createPair();
const server = new McpServerBuilder().withTransport(serverEnd).register(/* behaviors */).build();
await server.start();
tunnel.registerLoopbackProvider("in-process", clientEnd);

// ... on shutdown
await tunnel.stop();
```

## 5. Reserved slots

| slot | what it is | anti-goal |
|---|---|---|
| `_broker` | The broker's own introspection MCP server: `broker_info`, `providers_list`, `provider_status`, `broker_guide`, `broker_diagnose`, plus resources `broker://info`, `broker://providers`, `broker://providers/{name}`, `broker://guide/{topic}` | It proxies **nothing**. It is not a route to other slots. |
| `_all` | An aggregate presenting the union of the tools and prompts of every **opted-in** provider as one MCP server | It is **not** a proxy and **not** automatic. |

`_all`, precisely:

- **Membership is opt-in, per provider.** WebSocket providers join by asking (`{ aggregate: true }` on the transport). `stdioUpstreams[]` entries need `"aggregate": true`. `mcpServers[]` and `mcpbBundles[]` are aggregated **by default**; set `"aggregate": false` to opt out. That asymmetry is real. `_broker` is always in.
- **Names are prefixed** `<slot>-<original>`, descriptions tagged `[<slot>] ...`. **Never reconstruct a prefixed name**: it is capped at 64 characters, an overlong one is truncated and hash-suffixed, and a collision is broken with `-2`, `-3`. Call `tools/list` and pass the returned string back verbatim.
- **Tools and prompts only.** `initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`. Everything else, `resources/list` and `resources/read` included, returns `-32601 Method not found`. For resources, connect to the provider's own slot.
- It emits `notifications/tools/list_changed` and `notifications/prompts/list_changed`, so a provider that appears mid-session shows up without a reconnect.
- Neither name can be claimed by a provider: `/provider/_all` is refused with `Provider "_all" is reserved by the broker`.

## 6. Symptom to fix

| symptom | cause | fix |
|---|---|---|
| Client hangs on `initialize`, provider shows `connected: true` | MultiplexTransport on `/provider/<name>` | move to `ws://<host>/providers`, or switch to `DirectTransport` |
| Provider socket open, slot never appears in `providers_list` | DirectTransport on `/providers` | move to `ws://<host>/provider/<name>`, or switch to `MultiplexTransport` |
| Provider on `/providers/<name>`, nothing works | that path is neither endpoint, it is a **client** slot | drop the name (multiplex) or add `/provider/` (dedicated) |
| WebSocket closes `1008 Slot already held by a live provider` after a reload | a stale socket still holds the slot and answered the last heartbeat | release on `pagehide`; under the default `providerTakeover: "liveness"` the newcomer takes the slot as soon as the incumbent misses a ping (one interval, default 30 s). `"reject"` never hands over; `"always"` needs `providerAuth` and the same principal, else it falls back to `"liveness"` and says so |
| MCP host: `Connection closed`, no cause | a second broker could not bind the port | one broker per port; read `mcp-server-<name>.log` for `EADDRINUSE` |
| HTTP 403 `invalid_origin` from a page the broker itself serves | **a static mount does not exempt the origin it serves** | list that exact origin (scheme and port included) in `allowedOrigins` / `MCP_BROKER_ALLOWED_ORIGINS` |
| `Provider "<slot>" not connected` at host start | ordering: the host starts before any provider exists | point `MCP_BROKER_STDIO_PROVIDER` at `_all` |
| `_all` shows only `_broker-*` tools | nothing opted in | see §5; verify with `tools/list` on `_all`, never assume an opt-in took |
| Host's tool list goes empty after enabling authorization | the stdio bridge is anonymous | grant the anonymous subject, or stop bridging in authorized deployments |
| Browser provider gets a bare `error` event | provider auth is on; a browser cannot send the header | run without a provider secret, or authenticate in a proxy |
| `-32601 Method not found` on `_all` | `_all` covers tools and prompts only | use the provider's own slot |
| `-32602 Unknown aggregated tool` | you built the prefixed name yourself | re-run `tools/list`, pass the name back verbatim |
| Request errors with `did not respond within 60000ms` | the provider never answered | raise `providerRequestTimeoutMs`, or fix the provider |

## 7. Anti-goals, stated plainly

- `start()` resolving is **not** a connection guarantee, on either side of the tunnel.
- A `www` static mount does **not** exempt the origin it serves from the origin check. Conversely, the origin check covers the **HTTP** client endpoints only (`/<slot>/mcp`, `/<slot>/sse`, `/<slot>/messages`): a WebSocket upgrade carries no origin check at all.
- `_all` is **not** automatic, **not** a proxy, and does **not** carry resources.
- `_broker` routes to **nothing** else.
- Grammar files (`.mcp-broker/grammars/<userAgent>/<locale>.json`, `MCP_BROKER_LOCALE`) reword the `_broker` tools, resources and templates **only**. Provider tools are relayed as published, on their slot and in `_all`; a provider localizes its own descriptions in its own server.
- Slots are **not** declared. An unknown name is not an error; it is an empty slot that answers `not connected`.
- Streamable HTTP and SSE sessions do **not** expire. A client that closes its tab without `DELETE /<slot>/mcp` leaves its session alive forever, and `sessionCount` growing monotonically is the only signal.
- `brokerName` is **library-only**. It is a valid `config.json` key and `WsTunnel` honors it, but `WsTunnelBuilder` has no `withBrokerName()`, so the CLI never forwards it and setting it in the file changes nothing. `enableBrokerProvider` and `enableAggregateProvider` are `IWsTunnelOptions` fields only, not config-file keys at all. Confirm effective values with `broker_info` rather than assuming the file won.

## 8. Where the runnable samples live

Start with **[`samples/`](samples/)**. Every sample starts what it needs, proves itself end to end, and marks the decisions that produce a silent failure. [`samples/index.json`](samples/index.json) is the same content machine-readable: id, when to use it, the exact command, the files, and what success looks like. Run `cd samples && npm install` once; both dependencies are `file:` links, so it is offline and instant.

| path | what it shows |
|---|---|
| [`samples/browser-provider/`](samples/browser-provider/) ← start here | an MCP server published from a browser page, with the four wrong choices marked inline |
| [`samples/host-config/`](samples/host-config/) | the two-entry Claude Desktop pattern, driven over stdio and HTTP against one process |
| [`samples/provider-lifecycle/`](samples/provider-lifecycle/) | connect, 1008 refusal, release, broker crash, reconnect, narrated |
| [`samples/app-host/`](samples/app-host/) | the broker as your app's HTTP host: two mounts, `www.open` on a sub-path, the origin list |
| [`samples/embedded/`](samples/embedded/) | `WsTunnelBuilder` in-process, with a loopback provider and no socket |
| `node/packages/broker/.mcp-broker.example/` | a complete config template plus per-key guides in [EN](node/packages/broker/.mcp-broker.example/CONFIGURATION-EN.md) and [FR](node/packages/broker/.mcp-broker.example/CONFIGURATION-FR.md); `config.stdio-bridge.json` is the `stdioProvider: "_all"` pairing |
| `node/packages/broker/web/demos/provider-tunnel/` | a browser page hosting an MCP server and tunnelling it to a slot |
| `node/packages/broker/web/demos/broker-explorer/` | a browser MCP **client** driving `_broker`, `_all` or any slot |
| `node/packages/broker/web/demos/oauth-lab/` | a full local OAuth 2.1 + policy environment, `npm run demo:oauth` from `node/packages/broker` |
| [`c/samples/host-provider/`](c/samples/host-provider/) | the C client on a PC: dedicated or `--multiplex`, static `echo` tool, one line per link event |
| [`c/espressif/samples/provider/`](c/espressif/samples/provider/) | the same provider on an ESP32 over Wi-Fi, `menuconfig` for the broker host and slot name |
| [`c/unreal/Sample/`](c/unreal/Sample/) | the same provider from Unreal Engine 5, two slots on one socket, headless with `-game -nullrhi` |
| [`c/tests/roundtrip/`](c/tests/roundtrip/) and [`c/tests/soak/`](c/tests/soak/) | the C client against the Node broker: slots, `_all`, broker kill and restart; and an overnight load with the numbers a leak would move |

Reference docs, deepest last: [broker README](node/packages/broker/README.md) → [config reference](node/packages/broker/docs/config.md) → [endpoints](docs/endpoints.md) → [protocol](docs/protocol.md) → [architecture](docs/architecture.md) → [authorization](docs/authorization.md). For the device side: [c/README.md](c/README.md) → [libmcpb](c/libmcpb/README.md) → [ESP-IDF](c/espressif/README.md) → [Unreal](c/unreal/README.md).
