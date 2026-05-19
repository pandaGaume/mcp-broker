[![npm](https://img.shields.io/npm/v/@cyanmycelium/mcp-broker)](https://www.npmjs.com/package/@cyanmycelium/mcp-broker)
[![CI](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-node.yml/badge.svg)](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-node.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<p align="center">
  <img src="docs/assets/logo.png" alt="mcp-broker" width="160" />
</p>

# mcp-broker

Routes MCP clients to multiple [Model Context Protocol](https://modelcontextprotocol.io/) providers through a single host. WebSocket, Streamable HTTP, SSE, and stdio transports on both sides. The broker registers itself as an MCP server under the reserved slot `_broker`, so any client can discover what is routable through standard MCP tools.

## Why a broker

Real-world MCP deployments rarely consist of a single isolated server. An organization typically wants to expose, behind one endpoint:

- **industrial assets** (PLCs, SCADA, machine telemetry) wrapped as MCP servers
- **sensor and data sources** that an agent can query on demand
- **agent hosts** (micro-containers, headless engines, RPA bots) reachable as tools

`mcp-broker` is the relay layer that lets all of those connect to a central point and be reached by MCP clients without each client having to know every backend.

## Repository layout

This repo is a multi-implementation reference. Each language lives under its own folder, with its own build, dependencies, and release pipeline.

```
mcp-broker/
├── node/              ← TypeScript implementation (current)
├── dotnet/            ← .NET implementation (planned)
├── docs/              ← protocol, architecture, endpoints
├── .github/workflows/ ← CI + release pipelines per implementation
└── mcp-broker.code-workspace
```

Open `mcp-broker.code-workspace` in VSCode for a multi-root workspace with the right tooling per folder.

## Implementation status

| Implementation | Status | Package | Tag prefix |
|---|---|---|---|
| [node/](node/) | published | `@cyanmycelium/mcp-broker` on npm | `node-v*` |
| [dotnet/](dotnet/) | planned | `CyanMycelium.Mcp.Broker` on NuGet | `dotnet-v*` |

## Quick start (Node)

```sh
npx @cyanmycelium/mcp-broker
```

The broker starts on `http://localhost:3000`. Connect your MCP provider to `ws://localhost:3000/provider/<name>`, then point any MCP client at `http://localhost:3000/<name>/mcp`.

Full instructions, environment variables, and programmatic API in [node/README.md](node/README.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — overview, roles, request flow, the reserved `_broker` slot
- [docs/protocol.md](docs/protocol.md) — provider WebSocket framing, JSON-RPC envelopes
- [docs/endpoints.md](docs/endpoints.md) — every HTTP and WS endpoint exposed by the broker

## License

Apache-2.0. See [LICENSE](LICENSE).
