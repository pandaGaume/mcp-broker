<!-- Generated from node/packages/broker/src/broker/broker.guides.ts by node/scripts/build-site.mjs --guides. Do not edit. -->

> **MCP host configuration.** Wire Claude Desktop or another stdio host: the bridge targets your slot, the recipe, the one-broker-per-port rule. This is the page a running broker serves as `broker://guide/host-config` and through `broker_guide({ topic: "host-config" })`; the live copy also carries that deployment's effective configuration (host, port, scheme, paths), so prefer it when you can reach a broker.

# Wiring an MCP host (Claude Desktop and friends)

## 1. Point the bridge at your slot

An MCP host starts its servers when the host application launches. It sends
`initialize` immediately and treats a failure as a dead server: no retry, no
backoff, the entry is disabled for the session. Your provider, meanwhile, does
not exist yet. A browser provider needs a human to open a page; a provider in
another process needs that process to start.

That is fine: **a slot with no provider answers `initialize` itself**. It
lists nothing, and when the provider attaches the broker handshakes it and
sends `notifications/tools/list_changed` (and the prompts and resources ones),
so a page opened ten minutes into the session appears in the host's tool list
live. Only calls fail meanwhile, with `-32000 ... not connected yet`.

Brokers up to 1.12 refused `initialize` on such a slot, and the bridge had to be
pinned to `_all`. That still works: `_all` is frozen, tools and prompts only,
and stays the choice for one entry that must follow a changing set of
providers. `_broker` gives introspection only.

Hosts on protocol 2026-07-28 (Claude Code 2.1.292 and later) probe with
`server/discover` first. The broker answers it `-32601` on every slot until it
relays stateless requests, so they fall back to `initialize`.

## 2. Claude Desktop recipe

```json
{
    "mcpServers": {
        "mcp-broker": {
            "command": "npx",
            "args": ["-y", "@cyanmycelium/mcp-broker"],
            "env": {
                "MCP_BROKER_STDIO_PROVIDER": "plant",
                "MCP_BROKER_PORT": "3000",
                "MCP_BROKER_HOST": "127.0.0.1"
            }
        }
    }
}
```

`MCP_BROKER_STDIO_PROVIDER` is what turns the process into a stdio bridge: stdin
carries the host's JSON-RPC, stdout carries the replies, and all logging is
redirected to stderr so it cannot corrupt the channel. The broker keeps
listening on its port at the same time, so providers can still tunnel in.

## 3. One broker per port. Exactly one.

Do not add a second host entry that spawns another broker. The second process
cannot bind the port and dies; the host reports `Connection closed` with no
cause, and the real cause (`EADDRINUSE`) is only in the host's
`mcp-server-<name>.log`. If you want two logical servers visible to the host,
publish both into the one broker and reach the second slot over Streamable HTTP
(`/<slot>/mcp`), or let `_all` union their tools.

If a broker is already running on the port from another launcher, give the host
entry a different `MCP_BROKER_PORT`, or drop the host entry and reach the
running broker over Streamable HTTP instead.

## 4. The bridge is anonymous

The stdio bridge forwards frames to its slot with **no principal attached**. While
no authorization is configured that is invisible. The moment you enable
per-provider scopes or a policy that denies an anonymous subject, the host's
tool list silently empties: `tools/list` still returns 200 with `tools: []`, and
nothing anywhere says why. If you enable authorization and the host goes blank,
this is why.

## 5. Environment variables the host entry can set

| variable | default | meaning |
|---|---|---|
| `MCP_BROKER_STDIO_PROVIDER` | unset | slot the stdin/stdout bridge serves: your provider's slot, or `_all` |
| `MCP_BROKER_PORT` | `3000` | TCP port |
| `MCP_BROKER_HOST` | `0.0.0.0` | bind interface; `127.0.0.1` keeps it local |
| `MCP_BROKER_CONFIG` | unset | path to a JSON config file |
| `MCP_BROKER_LOCALE` | `en` | locale for the `_broker` tool descriptions |
| `MCP_BROKER_ALLOWED_ORIGINS` | unset | comma-separated browser origins for `/<slot>/mcp` |
| `MCP_BROKER_TLS_CERT` / `_KEY` | unset | PEM paths; both set means HTTPS and WSS |
| `MCP_BROKER_PROTOCOL` | auto | force `http` or `https` |
| `MCP_BROKER_WWW_DIR` | unset | serve this directory at `/` |
| `MCP_BROKER_BUNDLE_DIR` | unset | serve this directory at `/bundle` |

Environment variables win over the config file. Paths in env vars resolve
against the working directory; paths in the config file resolve against the
config file's own directory.

## 6. Verifying the wiring

From inside the host, the aggregated introspection tools are named
`_broker-broker_info`, `_broker-providers_list`, `_broker-provider_status`,
`_broker-broker_guide` and `_broker-broker_diagnose`. If you can see those, the
bridge works and `_all` is alive. If you can see nothing else, no provider has
opted into the aggregate: call `_broker-broker_diagnose` and it will say so.
