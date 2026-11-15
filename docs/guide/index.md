<!-- Generated from node/packages/broker/src/broker/broker.guides.ts by node/scripts/build-site.mjs --guides. Do not edit. -->

> **Guide index.** What the broker is, the transport pairing rule, and which page to read next. This is the page a running broker serves as `broker://guide/index` and through `broker_guide({ topic: "index" })`; the live copy also carries that deployment's effective configuration (host, port, scheme, paths), so prefer it when you can reach a broker.

# mcp-broker integration guide

You are reading the built-in documentation of a running mcp-broker instance.
It is authoritative for THIS broker. You do not need a README, and you should
not trust one that disagrees with this text.

## What the broker is

One process that puts N MCP servers behind one host and one port. Each server
occupies a named **slot**. Servers reach a slot from the inside as *providers*;
MCP clients reach a slot from the outside over HTTP, SSE, WebSocket or stdio.
Slots are created lazily: any name works, there is no registry to declare.

## The one rule that costs the most time

A provider's transport and its URL path are a matched pair.

```
  DirectTransport      <->  ws://<host>/provider/<name>    plain JSON-RPC frames
  MultiplexTransport   <->  ws://<host>/providers          envelope frames { provider, payload }
```

`ws://<host>/providers/<name>` is NEITHER of those two. The broker's router
matches `/providers` exactly and `/provider/` as a prefix, so a URL that starts
with `/providers/` falls through to the client branch and is accepted as an MCP
**client** on a slot literally named `providers/<name>`. Nothing errors. Your
provider is not published, and the slot you meant stays empty forever.

Get it wrong in the DirectTransport-on-`/providers` direction and the slot is
never claimed. Get it wrong the other way and the slot reports itself connected
while every client request hangs. This broker detects both on your first frame
and closes the socket with code `1008` and a reason naming the correction, but
it cannot detect a provider that connects and never sends anything, and older
brokers say nothing at all. See `broker://guide/publish-provider`.

## The pages

| topic | read it when |
|---|---|
| `publish-provider` | you have an MCP server and want this broker to expose it |
| `connect-client` | you have an MCP client and want to reach a slot |
| `host-config` | you are wiring Claude Desktop or another stdio MCP host |
| `deploy` | you are choosing between embedding the broker and running it |
| `troubleshooting` | something is already broken: symptom, cause, fix |

Read a page as a resource (`broker://guide/<topic>`) or call
`broker_guide({ topic: "<topic>" })`. Calling `broker_guide` with no argument
returns this index.

## Tools on this slot

| tool | what it answers |
|---|---|
| `broker_info` | identity, version, uptime, bind address, TLS, effective URL paths |
| `providers_list` | every known slot, connected or not, with live counters |
| `provider_status({ name })` | one slot in detail |
| `broker_guide({ topic? })` | these pages |
| `broker_diagnose({ slot? })` | live state PLUS detected problems, each with a fix |

When something does not work, call `broker_diagnose` before reading anything.
It does the correlation for you and names the fix.

## Reserved slots

- `_broker`: this slot. Introspection only. It routes to nothing else.
- `_all`: an aggregate that unions the tools and prompts of every opted-in
  provider, including `_broker`. Tool names are prefixed `<slot>-<original>`.
  It is the correct target for a stdio MCP host. See `broker://guide/host-config`.

## Vocabulary

- **slot**: a name. Providers publish into it; clients connect to it.
- **provider**: an MCP *server* that connects INTO the broker to serve a slot.
- **client**: an MCP *client* that connects to the broker to reach a slot.
- **upstream**: a provider the broker itself starts or dials out to
  (a child process, a remote URL, a signed `.mcpb` bundle).
