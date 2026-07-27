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
├── node/                       ← TypeScript implementation (current)
│   └── packages/               ← npm workspace
│       ├── broker/             ← the broker itself
│       └── provider/           ← tunnel wire contract + publishing a server to a slot
├── dotnet/                     ← .NET implementation (planned)
├── docs/                       ← protocol, architecture, endpoints
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
| [dotnet/](dotnet/) | planned | `CyanMycelium.Mcp.Broker` on NuGet | `dotnet-v*` |

Each package carries its own `.npmrc` with the matching `tag-version-prefix`, so run `npm version` from inside the package directory rather than from the workspace root: npm ignores per-workspace `.npmrc` files when invoked at the root, and you would get an unprefixed `v*` tag that no release workflow listens to.

## Quick start (Node)

```sh
npx @cyanmycelium/mcp-broker
```

The broker starts on `http://localhost:3000`. Connect your MCP provider to `ws://localhost:3000/provider/<name>`, then point any MCP client at `http://localhost:3000/<name>/mcp`.

Full instructions, environment variables, and programmatic API in [node/packages/broker/README.md](node/packages/broker/README.md).

## Documentation

- [docs/packages.md](docs/packages.md) — the four packages, what belongs in each, and why `client` was split into `provider` and `consumer`
- [docs/architecture.md](docs/architecture.md) — overview, roles, request flow, the reserved `_broker` slot
- [docs/protocol.md](docs/protocol.md) — provider WebSocket framing, JSON-RPC envelopes
- [docs/endpoints.md](docs/endpoints.md) — every HTTP and WS endpoint exposed by the broker
- [docs/authorization.md](docs/authorization.md): OAuth 2.1 resource server, provider auth, `_all` scope filtering (opt-in)
- [docs/hierarchical-authorization.md](docs/hierarchical-authorization.md): roles, ISA-95-aligned resource paths, inherited permissions, explicit deny, and provider namespaces

## License

Apache-2.0. See [LICENSE](LICENSE).
