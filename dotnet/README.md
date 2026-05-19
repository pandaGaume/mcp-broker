# mcp-broker — .NET implementation

> Status: **planned**. Not started yet.

This folder will host the .NET reference implementation of the broker, with feature parity to the Node implementation under [`../node`](../node).

## Planned package

- NuGet: `CyanMycelium.Mcp.Broker`
- Target framework: .NET 8 (subject to confirmation when work starts)
- Solution: `McpBroker.sln`

## Tag prefix

When this implementation ships, releases are triggered by git tags prefixed `dotnet-v` (e.g. `dotnet-v0.1.0`) via [`.github/workflows/release-dotnet.yml`](../.github/workflows/release-dotnet.yml).

## Why we start with Node

The original code originates from a TypeScript codebase and the v0.1 broker is enough to validate the protocol and architecture. Once stable, the .NET port is more valuable than starting both in parallel.

## Contributing

If you want to start the .NET port, the wire protocol is specified language-neutrally in [`../docs/protocol.md`](../docs/protocol.md). Match the observable behavior described there and the Node integration tests will apply.
