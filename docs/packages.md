# Packages

The broker is not one artifact but four, split by **role in the tunnel** rather than by language or runtime.

## Why the split

The word *client* is ambiguous here, and that ambiguity is what this layout removes.

Two very different actors sit at the edges of the broker, and both could be called a client:

- A 3D engine, a simulation, a headless service **publishes** an MCP server through the tunnel. In MCP terms it is a *server*; in tunnel terms it is a WebSocket *client*. The broker calls it a **provider**.
- Claude, an MCP Inspector, an agent **consumes** that server through the broker. In MCP terms it is a *client*; it never speaks the tunnel protocol at all, only standard MCP transports. It is a **consumer**.

A package named `broker-client` would have to mean one or the other, and readers would guess wrong half the time. `provider` and `consumer` say which edge they serve, and they match the vocabulary already used throughout [architecture.md](architecture.md) and the broker source (`IProviderState`, `_onProviderConnect`).

## The four packages

| Package | npm | Responsibility | Runs in |
|---|---|---|---|
| server | `@cyanmycelium/mcp-broker` | The broker process: routing, sessions, auth, aggregation, MCP endpoints | Node |
| provider | `@cyanmycelium/mcp-broker-provider` | Publishing an MCP server to a broker slot, and the tunnel wire contract under `./protocol` | Browser and Node |
| consumer | `@cyanmycelium/mcp-broker-consumer` | Reaching providers through a broker, and introspecting the broker itself | Browser and Node |

The broker itself keeps the unsuffixed name it was published under: it is the artifact users install, and `npx @cyanmycelium/mcp-broker` must keep working.

```
┌───────────┐         ┌───────────┐         ┌───────────┐
│  server   │ ──────▶ │ provider  │ ◀────── │ consumer  │
└───────────┘         │ /protocol │         └───────────┘
      │               └───────────┘               │
      └──────── @cyanmycelium/mcp-core ───────────┘
                (the MCP specification itself)
```

The server depends on the provider package, which reads backwards until you notice that **the broker is itself a provider**: it publishes its own `_broker` introspection slot and its `_all` aggregate slot as in-process MCP servers. Sharing the provider's wire contract is therefore the natural way to keep one definition of the envelope, rather than two that drift.

All three additionally depend on `@cyanmycelium/mcp-core` for `IMessageTransport`, `McpServer` and `McpClient`.

### server

The broker process itself, published as a CLI and a library: WebSocket termination for providers, HTTP and stdio endpoints for consumers, sessions, OAuth resource-server enforcement, hierarchical authorization, the `_broker` introspection slot and the `_all` aggregate slot.

It is the only package that is Node-only, and the only one that opens a listening socket.

### provider

Everything an application needs to expose its MCP server through a broker: the tunnel transports (one socket per server, or one socket shared by many via envelopes), reconnection, slot registration, and the credentials a provider presents when the broker enforces provider auth.

This is where a browser application that embeds `McpServer` looks, and it should stay small enough that embedding it in a 3D engine bundle is uncontroversial.

### consumer

The mirror image: reaching a provider through a broker rather than publishing one.

Note that a plain MCP client does **not** need this package. The broker terminates standard MCP transports, so Claude or an Inspector connects with stdio or Streamable HTTP and knows nothing about the tunnel. `consumer` exists for what standard MCP does not cover: discovering which providers a broker exposes, reading their health and capabilities from the `_broker` slot, addressing the `_all` aggregate, and obtaining the tokens the broker expects.

## Where the boundary falls

When something new needs a home, the question is not which package is convenient but which of these it answers:

| Question | Home |
|---|---|
| Is it defined by the MCP specification? | `@cyanmycelium/mcp-core`, not here |
| Must both ends of the tunnel agree on it byte for byte? | `provider/protocol` |
| Does it only make sense while listening on a port? | `server` |
| Does it help an application publish a server? | `provider` |
| Does it help an application find or reach one? | `consumer` |

The first line matters most. MCP defines stdio and Streamable HTTP; those transports belong in `@cyanmycelium/mcp-core` and must never be duplicated here. The tunnel is CyanMycelium topology, not protocol, and that is the whole reason these packages exist separately.

## Status

| Package | Folder | Tag series | State |
|---|---|---|---|
| server | `node/packages/broker` | `node-v*` | Published, in production. Routes through the shared codec |
| provider | `node/packages/provider` | `provider-v*` | `0.1.0` published: wire contract under `./protocol`, plus `DirectTransport` and `MultiplexTransport`. The transports still exist in `@cyanmycelium/mcp-core@0.4.x` too and leave it in `0.5.0` |
| consumer | not created yet | `consumer-v*` | Scope to be designed; nothing exists to move into it |

`node-v*` predates the split, when `node/` held a single package. It stays as it is because the series is already published and a rename would orphan the existing tags; the newer packages use their own name instead.

### On the wire contract not having its own package

It lives in `provider`, behind a dedicated `./protocol` entry point, and the broker imports it from there. Giving it a package of its own would only pay off the day a third party needs it without needing the provider: the consumer side, most likely. Until then it would be a package with one owner and one consumer.

Everything importing it goes through the `./protocol` subpath rather than the package root, so that move stays a one-line change per call site when it becomes worthwhile.

### Build order

The broker compiles against the provider's published `dist`, and `npm run --workspaces` walks packages alphabetically rather than by dependency. The workspace `build` script therefore names its packages explicitly, downstream last. A new package added to `packages/` must be added there too, or a clean checkout will fail to build while an incremental one keeps working.

Moving the transports out of `@cyanmycelium/mcp-core` is a breaking change for that package. The order is: publish `provider` with the transports, migrate applications, then remove them from `mcp-core`. Never the reverse.
