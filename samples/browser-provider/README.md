# browser-provider

**A web page publishes an MCP server to a broker slot, and a client calls one of its tools. End to end, one process, one origin.**

## Use this when

A tool has to run *in a browser*: it reads the DOM, drives a canvas or a 3D scene, touches IndexedDB or a WebGPU device, or holds a user session that only exists in the tab. That server cannot be a stdio process, so it connects **outbound** to a broker slot and the broker relays MCP clients to it.

This is the sample to copy first. It is also the exact case that fails silently when any of four decisions is made wrong, and each of those four is marked in `public/app.js` with `WRONG CHOICE`, saying what the wrong line looks like and what the failure looks like.

## Run it

```bash
cd samples
npm install          # once: links this repo's broker + provider packages
npm run browser-provider
```

A browser opens at `http://localhost:3000/`. Add `-- --no-open` to suppress that, `-- --port 4000` to move it.

Then, in the page:

1. Press **Publish**.
2. Press **initialize + tools/list + tools/call**.

And, from a second terminal, the same round trip with no browser involved:

```bash
cd samples
npm run browser-provider:client          # calls the slot directly
npm run browser-provider:client -- --all # calls it through the _all aggregate
```

## What you should see when it works

The broker prints its banner, including these two lines, which are the ones worth checking:

```
📁  Static mounts         http://localhost:3000/
🌍  Browser origins       http://localhost:3000, http://127.0.0.1:3000
```

The page log, newest first, after both buttons:

```
Client: echo("hello from the broker") -> "hello from the broker"  round trip complete
  tools/call → echo({"text":"hello from the broker"})
← tools/call
Client: tools/list -> page_title, echo, viewport
← tools/list
Client: session 653e7724-…, server "browser-provider (browser-demo)".
← initialize
Client: opening a session on http://localhost:3000/browser-demo/mcp ...
← prompts/list
← tools/list
← notifications/initialized (notification)
← initialize
Asked to join the _all aggregate; the broker runs initialize against this page now.
Socket open on ws://localhost:3000/provider/browser-demo. The slot is claimed.
```

The four `←` lines at the bottom are the **broker's own** handshake, not a client's: that is the aggregate registering the page into `_all`. `prompts/list` answered `-32601` is expected and correct for a tools-only provider.

The Node client prints:

```
[client] tools/list -> page_title, echo, viewport
[client] tools/call echo -> called from Node at 2026-…
[client] round trip complete: Node -> broker -> browser page -> broker -> Node.
```

and with `--all`, note how the names change:

```
[client] tools/list -> _broker-broker_info, …, browser-demo-page_title, browser-demo-echo, browser-demo-viewport
```

`_all` prefixes every tool with `<slot>-`. **Never reconstruct that name by concatenation.** The broker caps long names, hashes the part that does not fit, and appends `-2` to break ties. Read the name out of `tools/list`, which is what `client.mjs` does.

## The four decisions, and their failure modes

| # | Decision | Wrong variant | What it looks like |
|---|---|---|---|
| 1 | `DirectTransport` + `ws://host/provider/<slot>` | `MultiplexTransport` on the same URL | Socket opens, handshake succeeds, then a client's POST to `/<slot>/mcp` hangs. Recent brokers detect it on the first frame and close 1008 with both corrections in the reason. |
| 1 | as above | `DirectTransport` on `/providers` | Bare frames on the envelope path. The broker never learns the slot name, so the slot stays empty forever. |
| 1 | as above | `ws://host/providers/<slot>` | Neither endpoint. Accepted as a raw-WS **client** of a slot literally named `providers/<slot>`. Nothing ever answers. |
| 2 | assign `onMessage` **before** `connect()` | connect first, wire second | Works when a client connects to the slot directly, but the provider never appears in `_all`. The broker's `initialize` arrived before the handler existed and the 30s aggregate handshake timed out. Nothing is logged in the page. |
| 3 | `pagehide` → `transport.close()` | no listener | Reload the tab and the new socket is refused with close code **1008, "slot already connected"**, because the old page's socket is still OPEN. The page looks permanently broken. See `../provider-lifecycle/`. |
| 4 | `MCP_BROKER_ALLOWED_ORIGINS` includes this page's origin | left unset because "the broker serves the page" | The page loads, the WebSocket connects (upgrades are not origin-checked), and only the client half fails: `403 {"error":"invalid_origin"}`. The identical request from Node succeeds, because Node sends no `Origin`. |

## Failure modes you will actually hit

**`403 {"error":"invalid_origin"}` in the page, but `npm run browser-provider:client` works.**
Decision 4. The list is compared verbatim: `http://localhost:3000` is not `http://127.0.0.1:3000`, and neither is `https://localhost:3000`. `run.mjs` lists both loopback spellings for exactly this reason. A request with no `Origin` header always passes, which is why every non-browser client is unaffected.

**The page says "Socket closed" immediately, with `code 1008`.**
Something already holds the slot. Usually a previous tab of this same page (decision 3), sometimes a second browser window. The reason text in the log is the broker's own wording and names the cause. Wait for the heartbeat to reap the dead socket (`MCP_BROKER_PROVIDER_HEARTBEAT_MS`, default 30 s), or pick a different slot name.

**`npm run browser-provider:client -- --all` says "No echo tool on slot _all".**
The page did not join the aggregate. Membership is decided by the registration frame sent when the socket **opens**, so ticking the checkbox after publishing does nothing: press Release, tick it, press Publish.

**`Cannot find @cyanmycelium/mcp-broker-provider`.**
`npm install` was not run in `samples/`, or the provider package has no `dist/`. Build it with `npm run build --workspace @cyanmycelium/mcp-broker-provider` from `node/`.

**`EADDRINUSE`.**
Another broker is already on the port. The broker's own error says so and tells you to attach to the running one at `/_broker/mcp` rather than start a second, which would share no slots with the first. `-- --port 4000` moves this one.

**Nothing loads, browser console says "Failed to resolve module specifier".**
`public/vendor/index.js` is missing. `run.mjs` writes it on every start; running `node prepare.mjs` by hand does the same.

## Files

| File | What it is |
|---|---|
| `run.mjs` | Starts the broker with the four env vars this topology needs, and prints the equivalent shell command. |
| `prepare.mjs` | Copies the provider SDK's ESM build and the sample MCP client into `public/vendor/`. |
| `client.mjs` | The client half, headless. Uses `_broker`'s `providers_list` first so a failure says which half is broken. |
| `public/index.html` | Page shell. Holds the import map, which is the only line a bundler would make unnecessary. |
| `public/app.js` | **The integration.** The four `WRONG CHOICE` blocks are here. |
| `public/mcp-server.js` | A hand-written MCP server. Knows nothing about the broker, on purpose. |

## About the import map

`@cyanmycelium/mcp-broker-provider` ships a single self-contained ES module with **zero import statements**: its only dependency, `@cyanmycelium/mcp-core`, is type-only and erased at build time. A browser can load that file directly. What a browser cannot do is turn the bare specifier into a path.

With a bundler (Vite, webpack, esbuild, Rollup) that resolution is automatic and there is nothing to do: delete the `<script type="importmap">` block and `app.js` works unchanged. These samples have no build step, so they use an import map plus a copied file instead. A CDN such as `esm.sh` would also work, but it would pull the last *published* version rather than the code in this repo, so a sample could pass against a package you are not running.

## Adapting it

- **Publishing several MCP servers from one page**: switch to `MultiplexTransport.create(name, "ws://host/providers", { aggregate: true })`, one call per server, all sharing one socket. Note the asymmetry: `MultiplexTransport`'s shared socket reconnects on its own with backoff, `DirectTransport` does not reconnect at all.
- **Using a real MCP server implementation**: replace `public/mcp-server.js` with `@cyanmycelium/mcp-core`'s `McpServer` or the official `@modelcontextprotocol/sdk` `Server`. The transport contract is the same two hooks. Decision 2 still applies: construct and wire the server, then `connect()`.
- **Over TLS**: `wss://` follows `location.protocol` in `app.js` already; give the broker a cert and key and drop `MCP_BROKER_PROTOCOL=http`. Remember to update `MCP_BROKER_ALLOWED_ORIGINS` to the `https://` origin, since the comparison is verbatim.
- **Provider authentication**: `MCP_BROKER_PROVIDER_SECRET` requires providers to present a shared secret in a header. **A browser-hosted provider cannot do this**: the `WebSocket` constructor cannot set request headers. Turning it on locks this sample out entirely. Client-side OAuth (`MCP_BROKER_AUTH_ENABLED`) is unaffected and works from a page.
