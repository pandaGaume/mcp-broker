[![npm](https://img.shields.io/npm/v/@cyanmycelium/mcp-broker)](https://www.npmjs.com/package/@cyanmycelium/mcp-broker)
[![CI](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-node.yml/badge.svg)](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-node.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<p align="center">
  <img src="docs/assets/logo.png" alt="mcp-broker" width="160" />
</p>

# mcp-broker

WebSocket-based broker for the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). Aggregates multiple MCP providers behind a single endpoint so a client (Claude, MCP Inspector, custom agent) reaches any of them through one server.

> Status: v0.1 — single-provider-per-slot WebSocket tunnel with stdio bridge.
> Roadmap toward a full multi-tenant broker is in [docs/roadmap.md](docs/roadmap.md).

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
├── node/              ← TypeScript implementation (v0.1, production-ready)
├── dotnet/            ← .NET implementation (planned)
├── docs/              ← protocol, architecture, endpoints, roadmap
├── .github/workflows/ ← CI + release pipelines per implementation
└── mcp-broker.code-workspace
```

Open `mcp-broker.code-workspace` in VSCode for a multi-root workspace with the right tooling per folder.

## Implementation status

| Implementation | Status | Package | Tag prefix |
|---|---|---|---|
| [node/](node/) | v0.1 published | `@cyanmycelium/mcp-broker` on npm | `node-v*` |
| [dotnet/](dotnet/) | planned | `CyanMycelium.Mcp.Broker` on NuGet | `dotnet-v*` |

## Quick start (Node)

```sh
npx @cyanmycelium/mcp-broker
```

The broker starts on `http://localhost:3000`. Connect your MCP provider to `ws://localhost:3000/provider/<name>`, then point any MCP client at `http://localhost:3000/<name>/mcp`.

Full instructions, environment variables, and programmatic API in [node/README.md](node/README.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — overview, request flow, components
- [docs/protocol.md](docs/protocol.md) — provider WebSocket framing, JSON-RPC envelopes
- [docs/endpoints.md](docs/endpoints.md) — all HTTP and WS endpoints exposed by the broker
- [docs/roadmap.md](docs/roadmap.md) — from v0.1 to multi-tenant broker

## License

Apache-2.0. See [LICENSE](LICENSE).
