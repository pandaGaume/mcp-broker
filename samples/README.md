# mcp-broker samples

Five runnable integrations. Each one starts what it needs, proves itself end to end, and says what you should see. They exist because this stack fails **quietly**: the socket opens, the handshake succeeds, and then nothing answers. Every sample marks the decisions that produce that silence and shows what the wrong version looks like.

If you are an agent scanning this repo, **`index.json`** next to this file has the same content in machine-readable form: id, when to use it, the files, the exact command, and what success looks like.

## Setup, once

```bash
cd samples
npm install
```

That links this repo's `@cyanmycelium/mcp-broker` and `@cyanmycelium/mcp-broker-provider` into `samples/node_modules`, so every sample imports them by their real published names. It is fast and offline: both dependencies are `file:` links, nothing is fetched from a registry. In your own project, replace the two `file:` entries in `package.json` with version ranges and change nothing else.

Requires **Node >= 20.11.0**; verified on Node 22. Node 20 has no global `WebSocket`, so any sample that opens a provider socket *from Node* needs `--experimental-websocket` or a `ws` polyfill assigned to `globalThis.WebSocket` before the provider package is imported. Browser-side providers are unaffected.

## The five samples

| Sample | Use this when | Run it |
|---|---|---|
| **[browser-provider](browser-provider/)** ← start here | A tool must run in a browser (DOM, canvas, WebGPU, a user session) and be callable by an MCP client. | `npm run browser-provider` |
| **[host-config](host-config/)** | Wiring the broker into Claude Desktop, Claude Code, Cursor or VS Code. | `node host-config/check.mjs` |
| **[provider-lifecycle](provider-lifecycle/)** | A slot is stuck, you saw close code 1008, or you are choosing between the two provider transports. | `node provider-lifecycle/run.mjs` |
| **[app-host](app-host/)** | Shipping a web app whose live state should be callable over MCP, with one process and one origin. | `node app-host/run.mjs` |
| **[embedded](embedded/)** | Your Node application should *be* the broker rather than spawn one. | `node embedded/server.mjs --once` |

Each has its own README with the command, the expected output, and the failure modes with what they look like.

## Before you read any of this: ask the broker

The broker documents and diagnoses itself, on the reserved `_broker` slot, which exists before any provider connects:

- **`broker_guide({ topic })`** returns the integration guide as Markdown, with the deployment's real host, port and paths appended, so the prose cannot contradict what is actually running. Topics: `index`, `publish-provider`, `connect-client`, `host-config`, `deploy`, `troubleshooting`. Also readable as resources `broker://guide/*`.
- **`broker_diagnose({ slot })`** returns live per-slot state plus proven problems, each with a symptom, the evidence behind it, and a fix.

One line to reach them, once the broker is up:

```bash
node app-host/client.mjs --diagnose
```

## The seven rules every sample obeys

Every failure reported from the field so far came from breaking one of these.

### 1. The provider URL and the transport class are one decision

```
/provider/<slot>   plain JSON-RPC frames          -> DirectTransport
/providers         {provider, payload} envelopes  -> MultiplexTransport
/providers/<slot>  NEITHER
```

Cross them and the socket still opens and the handshake still succeeds; only the traffic is wrong. Since 1.3.0 the broker catches both crossings on your first frame, answers in the framing your peer can decode, and closes with code `1008` and a reason naming the correction. It cannot catch a provider that connects and then sends nothing, and older brokers say nothing at all, so a client's POST can still hang with no error on either side.

`/providers/<slot>` looks like the obvious combination and is in fact accepted as a raw-WebSocket **client** of a slot with that literal name; that one is not caught, because it is a legitimate shape. The broker's `[broker] ws connect path=… role=…` line tells you which of the three roles it filed your socket under, and `role=client` on a URL you meant as a provider is the whole diagnosis.

### 2. Assign the handlers before `connect()`

```js
transport.onMessage = handle;   // first
transport.connect();            // second
```

The broker runs `initialize` against a newly aggregated provider immediately and drops it from `_all` without a word if the handshake times out. Wiring the handler afterwards races that frame: intermittently on a local connection, always on a slow one.

### 3. Release the slot when the provider goes away

```js
window.addEventListener("pagehide", () => transport.close());
```

A slot holds one provider socket. A reload whose predecessor's socket is still OPEN is refused with close code **1008**, and the page you are looking at is the one that breaks while the page that is gone keeps the slot. `pagehide`, not `beforeunload` (skipped on mobile) and not `unload` (deprecated, disables the bfcache).

### 4. A page the broker serves is still a browser origin

`/<slot>/mcp`, `/<slot>/sse` and `/<slot>/messages` compare the `Origin` header against `allowedOrigins` **verbatim**. With no list configured, no browser origin passes. Serving the page from the broker's own mount grants nothing. A request carrying no `Origin` (Node, MCP Inspector, any server-side SDK) always passes, which is why this fails only in the browser and looks like a slot problem.

`http://localhost:3000` is not `http://127.0.0.1:3000`, and neither is `https://localhost:3000`.

### 5. The stdio bridge targets `_all`, never a real slot

`MCP_BROKER_STDIO_PROVIDER=_all`. The bridge gates every frame, `initialize` included, on the slot being occupied, so a bridge pinned to a real slot fails the handshake whenever the host starts before the provider, which for a browser-hosted provider is every time, and the host then marks the server failed permanently. `_all` exists from startup, answers `initialize` itself, and pushes `notifications/tools/list_changed` as providers join.

### 6. Never rebuild an aggregated tool name

Through `_all` a tool is `<slot>-<tool>`, but the broker caps long names, hashes the overflow and appends `-2` to break ties. Read the name from `tools/list`.

### 7. `_all` membership is opt-in, with one asymmetry

| Source | Joins `_all` |
|---|---|
| WebSocket provider (`DirectTransport` / `MultiplexTransport`) | only with `{ aggregate: true }` |
| `stdioUpstreams` entry | only with `"aggregate": true` |
| `mcpServers` (remote upstreams) | **by default**, opt out with `"aggregate": false` |
| `mcpbBundles` | **by default**, opt out with `"aggregate": false` |
| a loopback provider (`registerLoopbackProvider`) | **cannot**, see [embedded](embedded/) |

`_all` is a confidentiality boundary, which is why a provider that never asks stays private to its own slot.

## Reserved slots

| Slot | What it is |
|---|---|
| `_broker` | Introspection and self-documentation. `broker_info`, `providers_list`, `provider_status`, `broker_guide`, `broker_diagnose`. Always present, needs no provider. |
| `_all` | Live aggregate of every opted-in provider. Present from startup, answers `initialize` itself, prefixes tool names, pushes `tools/list_changed`. The right target for an MCP host. |

Neither can be claimed by a provider: the broker refuses with close code 1008.

## Shared library

The samples share four small modules so no claim is duplicated in two places and able to drift:

| File | What it is |
|---|---|
| `lib/mcp-http-client.mjs` | A minimal MCP client over Streamable HTTP in ~90 lines of `fetch`. Isomorphic: the same file runs in Node and, copied into a page, in a browser. Read it for the exact wire shape `/<slot>/mcp` expects. |
| `lib/node-provider.mjs` | `publishProvider({ brokerUrl, slot, aggregate, tools, call })`: a provider in Node in one call. |
| `lib/broker-bin.mjs` | Resolves the broker's CLI inside `node_modules` and spawns it. |
| `lib/vendor.mjs` | Copies the provider package's ESM build where a page can import it. Explains why no bundler is needed. |

## Why there is no build step

`@cyanmycelium/mcp-broker-provider` ships a single self-contained ES module with **zero import statements**: its only dependency, `@cyanmycelium/mcp-core`, is type-only and erased at build time. A browser can load that file as it is. What a browser cannot do is resolve the bare specifier `"@cyanmycelium/mcp-broker-provider"` to a path, which is what a bundler does for you.

The browser samples therefore copy that one file into `public/vendor/` and add a three-line `<script type="importmap">`. The page source still reads exactly like the code you would write with a bundler; delete the import map and it works unchanged under Vite, webpack, esbuild or Rollup. A CDN such as `esm.sh` would also work but would pull the last *published* version rather than the code in this repo, so a sample could pass against a package you are not running.

`public/vendor/` is generated on every run and is git-ignored.

## Ports

Each sample uses its own port so two of them can run side by side: browser-provider `3000`, host-config `3000` (the check exits), provider-lifecycle `3300`, app-host `3400`, embedded `3500`. Every one takes `--port`.

An `EADDRINUSE` is reported by the broker with the address, the URL to attach to the broker that already holds the port, and how to move this one. Do not start a second broker on another port to work around it: it shares no slots with the first, and the tools you expect will simply be absent with no error anywhere.
