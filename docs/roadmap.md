# Roadmap

## v0.1 — single-provider-per-slot tunnel (current)

- Provider transports: dedicated WS, multiplexed WS, stdio upstream
- Client transports: raw WS, Streamable HTTP (2025-03-26), legacy SSE, stdio bridge
- TLS via PEM files
- Static file serving for an optional dev harness
- Reference TypeScript implementation under [node/](../node/)

## v0.2 — quality and platform

- .NET implementation under [dotnet/](../dotnet/), feature parity with Node v0.1
- Structured logging (JSON to stderr) with configurable level
- Health endpoint `GET /healthz` with provider connectivity summary
- Container image (Dockerfile + GHCR publish)

## v0.3 — auth

- Bearer token on provider WS handshake (`Authorization: Bearer …`)
- Bearer or mTLS on client side, per-route ACLs (which clients can reach which providers)
- Audit log of every JSON-RPC request

## v0.4 — discovery and aggregation

- `GET /providers` returns the live list of connected provider names and their metadata
- Optional **aggregation mode**: a single client endpoint exposes the union of tools and resources across N providers, with provider name prefixed onto tool names (`<provider>.<tool>`). This is the broker behavior the use case asks for: agents in an organization see one interface regardless of how many backends are wired in.
- Tool-level routing rules (regex on tool name → target provider) for cases where two providers expose the same tool name

## v1.0 — multi-tenant broker

- Tenant separation (by host header or path prefix). Same broker process serves multiple orgs without cross-talk.
- Provider health checks with active failover when two providers register under the same logical name in different tenants
- Configurable persistence of the grammar / description-override layer (cf. `@cyanmycelium/mcp-core`'s grammar store) so the broker can ship per-tenant tool descriptions
- Plugin hooks for custom request transformation (rate limit, redaction, billing meter)
