<p align="center">
  <img src="https://raw.githubusercontent.com/pandaGaume/mcp-broker/main/docs/assets/logo.png" alt="mcp-broker" width="160" />
</p>

[![npm](https://img.shields.io/npm/v/@cyanmycelium/mcp-broker)](https://www.npmjs.com/package/@cyanmycelium/mcp-broker)
[![CI](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-node.yml/badge.svg)](https://github.com/pandaGaume/mcp-broker/actions/workflows/ci-node.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

# @cyanmycelium/mcp-broker

WebSocket-based [Model Context Protocol](https://modelcontextprotocol.io/) broker. Aggregates multiple MCP providers behind a single endpoint, with WebSocket, Streamable HTTP, SSE, and stdio client transports.

> This is the Node/TypeScript implementation of the broker. Architecture, wire protocol, and endpoints are documented language-neutrally in [../docs](../docs).

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

## Configuration

Two sources, env vars **always win** over the file. The file is the static baseline you ship with the broker; env vars are deploy-specific overrides.

### Option A — `.mcp-broker/` folder (recommended)

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
    "tls": {
        "cert": "certs/cert.pem",
        "key":  "certs/key.pem"
    },
    "www": {
        "open":   false,
        "mounts": [{ "urlPrefix": "/", "dir": "www" }]
    },
    "stdioUpstreams": [
        {
            "name": "fs",
            "command": "npx",
            "args":   ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
        }
    ]
}
```

Start from the [`.mcp-broker.example/`](.mcp-broker.example/) template:

```sh
cp -r node_modules/@cyanmycelium/mcp-broker/.mcp-broker.example .mcp-broker
```

Full reference (every field, defaults, recipes, grammar overrides): **[docs/config.md](docs/config.md)**.

### Option B — Environment variables

| Variable | Default | Notes |
|---|---|---|
| `MCP_BROKER_CONFIG` | `./.mcp-broker/config.json` | Path to a JSON config file (see above) |
| `MCP_BROKER_PORT` | `3000` | TCP port to listen on |
| `MCP_BROKER_HOST` | `0.0.0.0` | Interface to bind |
| `MCP_BROKER_PROVIDER_PATH` | `/provider` | Prefix for provider WS connections |
| `MCP_BROKER_CLIENT_PATH` | `/` | Prefix for raw WS clients |
| `MCP_BROKER_MCP_PATH` | `/mcp` | Suffix for Streamable HTTP |
| `MCP_BROKER_WWW_DIR` | (unset) | If set, serve this directory at `/` |
| `MCP_BROKER_BUNDLE_DIR` | (unset) | If set, serve this directory at `/bundle` |
| `MCP_BROKER_OPEN` | (unset) | `1` to auto-open the browser at the root URL on startup (requires `MCP_BROKER_WWW_DIR`) |
| `MCP_BROKER_TLS_CERT` | (unset) | Path to a PEM certificate. Enables HTTPS/WSS |
| `MCP_BROKER_TLS_KEY` | (unset) | Path to a PEM private key. Enables HTTPS/WSS |
| `MCP_BROKER_PROTOCOL` | auto | `http` forces plain, `https` forces TLS, unset auto-detects from cert+key |
| `MCP_BROKER_STDIO_PROVIDER` | (unset) | When set, bridge stdin/stdout JSON-RPC to this provider (Claude Desktop integration) |

## Programmatic API

```ts
import { WsTunnelBuilder } from "@cyanmycelium/mcp-broker";

const broker = new WsTunnelBuilder()
    .withPort(3000)
    .withHost("0.0.0.0")
    .withProviderPath("/provider")
    .withMcpPath("/mcp")
    // Optional: bridge a local stdio MCP server as a provider.
    .withStdioUpstream("my-server", "node", ["./my-server.js"])
    // Optional: serve a dev harness at /
    .withStaticMount("/", "/abs/path/to/www")
    .build();

await broker.start();
```

All builder methods are documented inline. The full options interface is `WsTunnelOptions`, also exported.

## TLS for local development

```sh
npm run gen-cert
# Writes ../certs/cert.pem and ../certs/key.pem (repo root)

$env:MCP_BROKER_TLS_CERT="../certs/cert.pem"
$env:MCP_BROKER_TLS_KEY="../certs/key.pem"
npm start
```

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

The broker can act as a stdio MCP server for Claude Desktop, bridging to any provider it manages:

```json
{
  "mcpServers": {
    "broker": {
      "command": "npx",
      "args": ["-y", "@cyanmycelium/mcp-broker"],
      "env": { "MCP_BROKER_STDIO_PROVIDER": "<your-provider-name>" }
    }
  }
}
```

In this mode all broker logging goes to stderr; stdout is reserved for the JSON-RPC stream Claude expects.

## Development

```sh
npm install
npm run build      # tsc -b
npm test           # vitest run
npm run lint
npm start          # node dist/bin.js
```

Requires Node 20.11+.

## Releasing

The package is published to npm by [`.github/workflows/release-node.yml`](../.github/workflows/release-node.yml), triggered by tags of the form `node-v*`.

```sh
# from the node/ directory:
npm version patch            # creates a "node-v0.1.1" tag (.npmrc sets the prefix)
git push --follow-tags
```

The workflow runs lint, build, test, then `npm publish --access public --provenance` and creates a GitHub Release with auto-generated notes.

## License

Apache-2.0. See [LICENSE](LICENSE).
