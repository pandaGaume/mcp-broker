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
| core | `@cyanmycelium/mcp-broker-core` | The tunnel wire format: envelopes, registration, error codes, shared types | Browser and Node |
| server | `@cyanmycelium/mcp-broker` | The broker process: routing, sessions, auth, aggregation, MCP endpoints | Node |
| provider | `@cyanmycelium/mcp-broker-provider` | Publishing an MCP server to a broker slot | Browser and Node |
| consumer | `@cyanmycelium/mcp-broker-consumer` | Reaching providers through a broker, and introspecting the broker itself | Browser and Node |

The broker itself keeps the unsuffixed name it was published under: it is the artifact users install, and `npx @cyanmycelium/mcp-broker` must keep working.

```
            ┌───────────────┐
            │     core      │   envelopes, types, codec — no dependencies
            └───────────────┘
              ▲     ▲     ▲
      ┌───────┘     │     └───────┐
┌───────────┐ ┌───────────┐ ┌───────────┐
│ provider  │ │  server   │ │ consumer  │
└───────────┘ └───────────┘ └───────────┘
      │             │             │
      └──────── @cyanmycelium/mcp-core ─────────┘
                (the MCP specification itself)
```

`core` depends on nothing, which is what lets both ends of the tunnel share one definition instead of two that drift. `provider` and `consumer` additionally depend on `@cyanmycelium/mcp-core` for `IMessageTransport`, `McpServer` and `McpClient`. `server` depends on it too, for the behaviors it exposes on its own `_broker` slot.

### core

The wire contract, and only that: the `{ provider, payload }` envelope, its codec, the `notifications/register` claim, and the tunnel error codes. No transport, no I/O, no dependency.

Anything that both ends must agree on byte for byte belongs here. Anything one end can change alone does not.

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
| Must both ends of the tunnel agree on it byte for byte? | `core` |
| Does it only make sense while listening on a port? | `server` |
| Does it help an application publish a server? | `provider` |
| Does it help an application find or reach one? | `consumer` |

The first line matters most. MCP defines stdio and Streamable HTTP; those transports belong in `@cyanmycelium/mcp-core` and must never be duplicated here. The tunnel is CyanMycelium topology, not protocol, and that is the whole reason these packages exist separately.

## Status

`core` and `server` have content today. `provider` and `consumer` are named but not yet populated.

| Package | Folder | Tag series | State |
|---|---|---|---|
| server | `node/packages/broker` | `node-v*` | Published, in production |
| provider | `node/packages/provider` | `provider-v*` | Written but unpublished. Holds the envelope codec today; receives `DirectTransport` and `MultiplexTransport` next, from `@cyanmycelium/mcp-core` |
| core | not created yet | `core-v*` | The envelope codec lives in `provider/src/protocol` for now, exposed as the `./protocol` subpath |
| consumer | not created yet | `consumer-v*` | Scope to be designed; nothing exists to move into it |

`node-v*` predates the split, when `node/` held a single package. It stays as it is because the series is already published and a rename would orphan the existing tags; the newer packages use their own name instead.

### On `core` not existing yet

The wire contract is written and tested, but it sits inside `provider` under a dedicated `./protocol` entry point rather than in its own package. That is deliberate: a package with one consumer is not yet a package.

It graduates the day a second end needs it, which will be when the broker stops re-declaring the envelope inline in `ws.tunnel.ts`. At that point `server` would otherwise have to depend on `provider`, and a broker depending on the provider-side package is exactly the confusion this whole split removes. Anything importing the protocol should use the `./protocol` subpath, so that move costs one line per call site.

Moving the transports out of `@cyanmycelium/mcp-core` is a breaking change for that package. The order is: publish `provider` with the transports, migrate applications, then remove them from `mcp-core`. Never the reverse.
