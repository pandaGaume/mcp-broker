# host-config

**How to put the broker in an MCP host's config file: the two-entry pattern, and why the second entry must not spawn anything.**

## Use this when

You are wiring the broker into Claude Desktop, Claude Code, Cursor, VS Code or any other MCP host, and you want the host to see the broker's slots.

## The ordering problem, in four sentences

An MCP host starts its servers when *it* starts, completes the `initialize` handshake immediately, and marks a server failed if that handshake does not succeed. A broker slot backed by a browser page, or by anything a user opens later, is empty at that moment. The broker's stdio bridge gates every frame on its target slot being occupied, so a bridge pinned to a real slot fails the handshake and the host gives up, permanently, before the provider ever had a chance to connect. Pin it to **`_all`** instead: that slot exists from broker startup, answers `initialize` itself, unions every opted-in provider, and pushes `notifications/tools/list_changed` when one joins, so a provider that appears an hour later still shows up live.

## Run it

There is nothing to install into a host to check this. `check.mjs` drives both entries the way a host would, against one process:

```bash
cd samples
npm install
node host-config/check.mjs                # uses port 3000
node host-config/check.mjs --port 3210    # if 3000 is busy
```

## What you should see when it works

```
[1] Spawning ENTRY 1: the broker in stdio-bridge mode, pinned to "_all", listening on http://127.0.0.1:3000

[2] initialize over stdio, BEFORE any provider exists
    ok: server "_all", protocol 2024-11-05
    THIS IS THE WHOLE POINT. Pinned to a real slot instead of "_all", this handshake fails
    with 'Provider "<slot>" not connected' and the host marks the server failed.

[3] tools/list, still with no provider connected
    5 tools: _broker-broker_info, _broker-providers_list, _broker-provider_status, _broker-broker_guide, _broker-broker_diagnose

[4] Starting a provider on "scene-editor" now, the way a browser tab would
[broker] ws connect path="/provider/scene-editor" role=dedicated-provider slot="scene-editor"
    [scene-editor] published on ws://127.0.0.1:3000/provider/scene-editor (joining _all)

[5] Waiting for notifications/tools/list_changed on the SAME stdio session
    received. The host refreshes its tool list on this notification.
    6 tools now, new: scene-editor-ping
    tools/call scene-editor-ping -> pong from "scene-editor" at 2026-…

[6] Reaching ENTRY 2 over HTTP at http://127.0.0.1:3000/scene-editor/mcp, against that same process
    tools/list -> ping
    note the names: unprefixed here, "scene-editor-ping" through _all. Same provider, two entries.

BOTH ENTRIES WORK AGAINST ONE PROCESS.
```

Steps 2 and 3 are the ordering problem solved: a successful handshake with nothing connected. Step 5 is the payoff: the provider arrives late and the host is told.

## The two entries

```json
{
    "mcpServers": {
        "broker": {
            "command": "npx",
            "args": ["-y", "@cyanmycelium/mcp-broker"],
            "env": {
                "MCP_BROKER_CONFIG": "/ABSOLUTE/PATH/TO/samples/host-config/.mcp-broker/config.json",
                "MCP_BROKER_STDIO_PROVIDER": "_all"
            }
        },
        "scene-editor": {
            "type": "http",
            "url": "http://127.0.0.1:3000/scene-editor/mcp"
        }
    }
}
```

**Entry 1 is the process.** The host spawns it, owns its lifetime, and talks to it over stdin/stdout. Because it is a normal broker it also opens its HTTP/WebSocket listener on the configured port, which is what makes entry 2 possible at all.

**Entry 2 attaches, and must never spawn.** A second `command` entry running `@cyanmycelium/mcp-broker` starts a *second broker*. Two outcomes, both bad:

- Same port: the second process exits 1 with `EADDRINUSE`. The broker's error message names the port and tells you to attach to the running one at `/_broker/mcp` instead. The host shows a failed server.
- Different port: it starts cleanly and is a **completely separate broker**. It shares no slots, no providers, no `_all`. The tools you expected are simply not there, and nothing anywhere reports an error. This is the worse one.

Entry 2 is **optional**. Through entry 1 every aggregated provider is already reachable as `<slot>-<tool>`. Add entry 2 when you want one slot to have its own identity in the host: its own permission prompts, its own tool namespace, unprefixed tool names.

### If your host cannot do URL entries

Some hosts only support `command`. Bridge the URL with a *generic* stdio-to-HTTP proxy, never with a second broker:

```json
"scene-editor": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "http://127.0.0.1:3000/scene-editor/mcp"]
}
```

`mcp-remote` is a third-party package, not part of this project. The rule that matters is unchanged: entry 2 connects to the listener entry 1 opened.

## Files

| File | What it is |
|---|---|
| `claude_desktop_config.json` | The pattern, with the reasoning in a `_readme` array. Copy the `mcpServers` block. |
| `claude_desktop_config.with-auth.json` | Same, with client OAuth and provider authentication on, and the difference between the two spelled out. |
| `.mcp-broker/config.json` | The broker config entry 1 points at. Runnable as-is. |
| `.mcp-broker/config.auth.json` | The authorization variant. **A template, not runnable**: it references `certs/` and an authorization server that do not exist here. |
| `check.mjs` | Drives both entries end to end. Read it to see exactly what a host does. |

## Two mechanisms called "auth", and they are independent

| | Client authorization | Provider authentication |
|---|---|---|
| Turned on by | `MCP_BROKER_AUTH_ENABLED` / `auth.enabled` | `MCP_BROKER_PROVIDER_SECRET` / `auth.providerSecret` |
| Protects | `/<slot>/mcp`, `/<slot>/sse`, `/<slot>/messages` | the WebSocket provider endpoints |
| Applies to entry 1 | **No.** A stdio bridge is authorized by the host having spawned it; the broker never asks a pipe for a bearer token. | No |
| Applies to entry 2 | Yes, it is on the HTTP surface | No |
| Applies to a provider | No | Yes |

Turning one on does not turn the other on. `auth.providerSecret` in particular is **not** gated by `auth.enabled`: setting it turns provider authentication on even with authorization disabled, which is why the sample config file does not carry it and the host entry sets `MCP_BROKER_PROVIDER_SECRET` instead.

**A browser-hosted provider cannot authenticate.** The broker reads the secret from the `X-Provider-Token` or `Authorization` header of the WebSocket upgrade, and the browser `WebSocket` constructor cannot set request headers. Setting `MCP_BROKER_PROVIDER_SECRET` locks every browser page out of every slot. Use it when all providers are server-side.

## Failure modes

**The host shows the broker as failed, with no output.**
Look at the host's server log; the broker writes every diagnostic to **stderr** in stdio mode, keeping stdout pure JSON-RPC. The most common causes are a wrong `MCP_BROKER_CONFIG` path (hosts do not expand `~` or relatives) and `EADDRINUSE`.

**Tools appear, then vanish, then reappear.**
Normal. `_all` reflects live membership: a provider that disconnects is removed and `tools/list_changed` is pushed. A browser tab closing does this.

**A provider connected but its tools never reach the host.**
It did not opt into the aggregate. Membership is requested at registration time, by the `aggregate` option on the transport (`{ aggregate: true }`) or by `"aggregate": true` on a `stdioUpstreams` entry. Note the asymmetry in the defaults: `mcpServers` (remote upstreams) and `mcpbBundles` join `_all` unless you write `"aggregate": false`, while `stdioUpstreams` and WebSocket providers stay out unless they ask.
Check with `broker_diagnose` on the `_broker` slot, or `providers_list`.

**`initialize` on the bridge fails with `Provider "x" not connected`.**
`MCP_BROKER_STDIO_PROVIDER` is pinned to a real slot. That is the ordering problem. Set it to `_all`. The broker warns about this at startup, naming the slots it actually hosts.

**Everything works from `check.mjs` but not from a browser page.**
That is not this sample. Browsers add an `Origin` header and the client HTTP surface refuses unlisted origins. See `../browser-provider/`.
