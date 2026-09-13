[![npm](https://img.shields.io/npm/v/@cyanmycelium/mcp-broker)](https://www.npmjs.com/package/@cyanmycelium/mcp-broker)
[![CI](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-node.yml/badge.svg)](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-node.yml)
[![CI (C)](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-c.yml/badge.svg)](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-c.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<p align="center">
  <img src="docs/assets/logo.png" alt="mcp-broker" width="160" />
</p>

# mcp-broker

Routes MCP clients to multiple [Model Context Protocol](https://modelcontextprotocol.io/) providers through a single host. WebSocket, Streamable HTTP, SSE, and stdio transports on both sides. The broker registers itself as an MCP server under the reserved slot `_broker`, so any client can discover what is routable through standard MCP tools, and read the integration guide the broker serves about itself.

> **Working with an AI coding agent?** Point it at **[AGENTS.md](AGENTS.md)** first. It is the single self-contained file: topology table, the transport/path pairing rule, copy-pasteable configurations, the reserved slots, and a symptom-to-fix table. A *running* broker documents itself over MCP through `broker_guide` and `broker_diagnose` on the `_broker` slot, which is better still.

## Why a broker

Real-world MCP deployments rarely consist of a single isolated server. An organization typically wants to expose, behind one endpoint:

- **industrial assets** (PLCs, SCADA, machine telemetry) wrapped as MCP servers
- **sensor and data sources** that an agent can query on demand
- **agent hosts** (micro-containers, headless engines, RPA bots) reachable as tools

`mcp-broker` is the relay layer that lets all of those connect to a central point and be reached by MCP clients without each client having to know every backend.

## From simulation to the world

The providers do not have to be Node processes. The same tunnel client exists in C99 ([`c/libmcpb`](c/libmcpb/)), with no allocation and no platform header, and it runs in two places that matter to each other:

- **on the device**, an ESP32 under ESP-IDF ([`c/espressif`](c/espressif/)): one FreeRTOS task, 7.4 KB of flash, one socket for the device's MCP server;
- **in the simulator**, an Unreal Engine 5 plugin ([`c/unreal`](c/unreal/)): one socket for every simulated device the engine hosts, multiplexed, because an engine is one process.

Both publish to the same broker, under the same slot names, with the same tool schemas. An agent that learned to drive the simulated machine drives the real one with the same calls; nothing on its side changes except which provider answers. That is the whole point of putting a broker between the agent and the equipment: **the agent's world is the broker, and the broker does not care whether a slot is a game object or a board on a bench.**

```
          Unreal Engine 5 (simulation)                    ESP32 boards (the world)
          ┌────────────────────────────┐                  ┌──────────┐  ┌──────────┐
          │ McpBroker plugin           │                  │ mcpb_esp │  │ mcpb_esp │
          │ slots: pump-1, pump-2, ... │                  │ pump-1   │  │ pump-2   │
          └─────────────┬──────────────┘                  └────┬─────┘  └────┬─────┘
                        │ one socket, /providers               │ /provider/pump-1 ...
                        └──────────────────┬───────────────────┴──────────────┘
                                           ▼
                                      mcp-broker  ──  _all  ──▶  the agent
```

The C side is transport only: libmcpb carries JSON-RPC bytes and never interprets them, so the MCP layer stays whatever the host already has (a C++ server on the board and in the engine, mcp-core in Node or a browser). See [`c/README.md`](c/README.md) for why that boundary is where it is.

## Repository layout

This repo is a multi-implementation reference. Each language lives under its own folder, with its own build, dependencies, and release pipeline.

```
mcp-broker/
├── node/                       ← TypeScript implementation (current)
│   └── packages/               ← npm workspace
│       ├── broker/             ← the broker itself
│       └── provider/           ← tunnel wire contract + publishing a server to a slot
├── c/                          ← the device side, in C99
│   ├── libmcpb/                ← the tunnel client: WebSocket, dedicated and multiplexed endpoints, reconnection, events
│   ├── ports/                  ← the six-function port per platform: host (Linux/macOS/Windows), espressif, unreal
│   ├── espressif/              ← ESP-IDF component and a Wi-Fi sample for the ESP32
│   ├── unreal/                 ← Unreal Engine 5 plugin and a host project
│   ├── samples/                ← the transport-only echo provider the samples share
│   └── tests/                  ← roundtrip against the Node broker, overnight soak
├── dotnet/                     ← .NET implementation (planned)
├── samples/                    ← five runnable Node integrations
├── docs/                       ← protocol, architecture, endpoints, and the website
├── AGENTS.md                   ← start here if you are an AI coding agent
├── CHANGELOG.md
├── .github/workflows/          ← CI + release pipelines per package
└── mcp-broker.code-workspace
```

The two ends of the tunnel share one repository on purpose: a change to the envelope protocol touches the client transport and the broker at once, so it lands in a single commit and neither end can drift ahead of the other.

Open `mcp-broker.code-workspace` in VSCode for a multi-root workspace with the right tooling per folder.

## Implementation status

| Implementation | Status | Package | Tag prefix |
|---|---|---|---|
| [node/packages/broker/](node/packages/broker/) | published | `@cyanmycelium/mcp-broker` on npm | `node-v*` |
| [node/packages/provider/](node/packages/provider/) | published | `@cyanmycelium/mcp-broker-provider` on npm | `provider-v*` |
| [c/libmcpb/](c/libmcpb/) | 0.3.0, consumed from the repository | none: C99 sources, compiled into the firmware or the engine module | `c-v*` |
| [c/espressif/](c/espressif/) | validated on an Arduino Nano ESP32, built for the S3 in CI | ESP-IDF component `mcpb_esp` | with `c-v*` |
| [c/unreal/](c/unreal/) | built and run on UE 5.7 | plugin `McpBroker` | with `c-v*` |
| [dotnet/](dotnet/) | planned | `CyanMycelium.Mcp.Broker` on NuGet | `dotnet-v*` |

Each package carries its own `.npmrc` with the matching `tag-version-prefix`, so run `npm version` from inside the package directory rather than from the workspace root: npm ignores per-workspace `.npmrc` files when invoked at the root, and you would get an unprefixed `v*` tag that no release workflow listens to.

## Quick start (Node)

```sh
npx @cyanmycelium/mcp-broker
```

The broker starts on `http://localhost:3000`. Connect your MCP provider to `ws://localhost:3000/provider/<name>`, then point any MCP client at `http://localhost:3000/<name>/mcp`.

A provider's transport and its URL path are a **matched pair**: `DirectTransport` pairs with `ws://<host>/provider/<name>` (plain JSON-RPC frames), `MultiplexTransport` pairs with `ws://<host>/providers` (envelopes). `ws://<host>/providers/<name>` is neither, and is silently accepted as a *client* connection. See [AGENTS.md](AGENTS.md#3-the-pairing-rule).

Full instructions, environment variables, and programmatic API in [node/packages/broker/README.md](node/packages/broker/README.md).

## Quick start (a device, or a simulator)

An ESP32 with ESP-IDF, on the same broker:

```sh
idf.py -C c/espressif/samples/provider set-target esp32s3
idf.py -C c/espressif/samples/provider menuconfig      # Provider sample: Wi-Fi, broker host and port, slot name
idf.py -C c/espressif/samples/provider flash monitor
```

Unreal Engine 5, publishing two slots on one socket:

```powershell
& "$UE\Engine\Build\BatchFiles\Build.bat" McpBrokerSampleEditor Win64 Development -Project="c\unreal\Sample\McpBrokerSample.uproject"
& "$UE\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "c\unreal\Sample\McpBrokerSample.uproject" -game -nullrhi -McpBrokerHost=127.0.0.1
```

In both cases `tools/call echo` on `http://<broker>:3000/<slot>/mcp` answers from the device or the engine, and `_all` lists the slot next to every other provider. [`c/README.md`](c/README.md) is the map of that folder.

## Documentation

Start with **[AGENTS.md](AGENTS.md)** if you want one file that covers the decisions, or **[samples/](samples/)** if you would rather run something first: five self-contained integrations that start what they need and prove themselves end to end, indexed for agents in [samples/index.json](samples/index.json). Then, by depth:

- [docs/packages.md](docs/packages.md): the packages, what belongs in each, and why `client` was split into `provider` and `consumer`
- [docs/architecture.md](docs/architecture.md), overview, roles, request flow, the reserved `_broker` and `_all` slots
- [docs/protocol.md](docs/protocol.md), provider WebSocket framing, JSON-RPC envelopes, the aggregate opt-in frame
- [docs/endpoints.md](docs/endpoints.md): every HTTP and WS endpoint exposed by the broker
- [docs/authorization.md](docs/authorization.md): OAuth 2.1 resource server, provider auth, `_all` scope filtering (opt-in)
- [docs/hierarchical-authorization.md](docs/hierarchical-authorization.md): roles, ISA-95-aligned resource paths, inherited permissions, explicit deny, and provider namespaces
- [c/README.md](c/README.md), [c/libmcpb/README.md](c/libmcpb/README.md), [c/espressif/README.md](c/espressif/README.md), [c/unreal/README.md](c/unreal/README.md): the device side, the tunnel client in C, the ESP32 component, the Unreal plugin
- [node/packages/broker/docs/config.md](node/packages/broker/docs/config.md): every config key, default, and env var
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
