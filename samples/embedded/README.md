# embedded

**The broker as a library inside an existing Node application: `new WsTunnelBuilder()`, `start()`, `stop()`, and the two things only an embedder gets.**

## Use this when

Your application is already a Node process and you want it to *be* the broker rather than to spawn one: a desktop app, a dev server, a build tool, a service that hosts browser clients. You own the port, the lifetime and the shutdown, there is no config file, and two capabilities open up that a standalone broker cannot offer:

| API | What it gives you |
|---|---|
| `tunnel.registerLoopbackProvider(name, transport)` | Publish an MCP server that lives in this process, on a slot, **with no socket at all**. No WebSocket, no reconnect logic, no slot contention, no serialization across a network. |
| `tunnel.openInternalClient(name)` | Call any slot from inside this process without going through HTTP. Works for slots backed by a browser page too. |

## Run it

```bash
cd samples
npm install
node embedded/server.mjs --once       # run the demo and exit
node embedded/server.mjs              # run the demo, then keep serving until Ctrl+C
node embedded/server.mjs --port 4000
```

## What you should see when it works

```
[app] broker listening on http://127.0.0.1:3500
[app] registered the in-process provider on slot "job-runner" (no socket involved)

[app] calling it through openInternalClient(), in-process:
      [ { "id": "job-1", "status": "running", "progress": 0.42 }, … ]

[app] the same slot over Streamable HTTP at http://127.0.0.1:3500/job-runner/mcp:
      tools/list -> list_jobs, cancel_job
      tools/call cancel_job -> Cancelled job-2.

[app] tools on _all: _broker-broker_info, …, also-aggregated-ping
      note that "job-runner" is absent: a loopback provider cannot opt into the aggregate,
      while "also-aggregated", which connected over a socket with { aggregate: true }, is there.

[app] tunnel.getProvidersInfo():
      _all               transport=loopback  connected=true
      _broker            transport=loopback  connected=true
      job-runner         transport=loopback  connected=true
      also-aggregated    transport=ws        connected=true

[app] shutting down (done)
[app] stopped cleanly
```

## The loopback transport contract

This is the one thing that trips people up, because both halves of the object face the **broker**, not your server:

```js
const transport = {
    onMessage: null,   // the BROKER assigns this. You CALL it, with a frame from your server.
    onClose: null,     // the broker assigns this too.
    isOpen: true,      // the broker refuses to route to a provider that is not open.

    send(raw) {        // the BROKER calls this, with a client's request for you.
        const response = handleMcp(JSON.parse(raw));
        if (response) queueMicrotask(() => transport.onMessage?.(JSON.stringify(response)));
    },

    connect() {},      // no-op for a loopback: there is no handshake
    close() { transport.isOpen = false; transport.onClose?.(); },
};

tunnel.registerLoopbackProvider("job-runner", transport);
```

`registerLoopbackProvider` throws when the name is already used by another loopback or by a stdio upstream. It does **not** throw when a WebSocket provider holds the same slot, so pick names your application owns.

Handing the broker an `@cyanmycelium/mcp-core` `McpServer` instead of a hand-written handler works the same way: give the server a transport of this shape and register that transport.

## Known limitation: a loopback provider cannot join `_all`

`registerLoopbackProvider` takes no `aggregate` argument, and the aggregate server is not reachable from the public API, so an in-process provider is served on its own slot and is **absent from `_all`**. The sample demonstrates this rather than hiding it.

That matters because `_all` is the slot an MCP host should be pointed at. When a host has to see your in-process server, publish it over a real socket to your own loopback address:

```js
const transport = new DirectTransport(`ws://127.0.0.1:${port}/provider/job-runner`, { aggregate: true });
```

The cost is one WebSocket to `127.0.0.1` and the registration frame that carries the opt-in. Everything else is identical.

## Lifecycle

**`await tunnel.start()`, and catch it.** `start()` rejects on a listen failure, and that rejection is the only place the diagnosis exists. `ws` mirrors the HTTP server's `error` event onto its own `WebSocketServer` from a listener installed inside its constructor, so an unhandled listen failure used to surface as an uncaught exception outside any caller's `await`. For `EADDRINUSE` the rejection names the address, gives the URL to attach to the broker that already holds the port, and says how to move this one. `err.cause` carries the original `errno`.

**`await tunnel.stop()`, and await it.** It closes every provider and client socket, clears the heartbeat and request-timeout timers, and closes the HTTP listener. Without the `await`, the process can exit with sockets half-closed, and in a test runner the next test hits a port that is still bound.

## The builder

Every call in `server.mjs` is written out with its default, because an embedder is exactly the person who has to tune them.

| Method | Default | Note |
|---|---|---|
| `.withPort(n)` | required | |
| `.withHost(h)` | `0.0.0.0` | `127.0.0.1` keeps it off the network |
| `.withProviderPath(p)` | `/provider` | one provider per socket, plain frames, `DirectTransport` |
| `.withProvidersPath(p)` | `/providers` | many providers per socket, envelope frames, `MultiplexTransport` |
| `.withClientPath(p)` | `/` | raw WebSocket clients |
| `.withMcpPath(p)` | `/mcp` | Streamable HTTP, `/<slot>/mcp` |
| `.withSsePath(p)` / `.withMessagesPath(p)` | `/sse`, `/messages` | legacy SSE pair |
| `.withAllowedOrigins(list \| regexp \| predicate)` | none | omit and no browser origin passes; requests with no `Origin` always pass |
| `.withProviderHeartbeat(ms)` | `30000` | `0` disables |
| `.withProviderRequestTimeout(ms)` | `60000` | `0` disables |
| `.withProviderTakeover(mode)` | `liveness` | `reject` \| `liveness` \| `always` |
| `.withStaticMount(prefix, dir)` | none | call repeatedly; longest prefix wins. This is the `app-host` topology, embedded |
| `.withStdioUpstream(cfg)` | none | spawn an MCP server as a child process on a slot |
| `.withRemoteUpstream(cfg)` | none | reach an MCP server by URL |
| `.withStdioClient(slot)` | none | bridge this process's stdin/stdout to a slot. Point it at `_all`, and remember it takes over stdout |
| `.withTls(cert, key)` / `.withTlsFiles(certPath, keyPath)` | none | |
| `.withJwtAuth(options)` | none | OAuth 2.1 resource server on the client HTTP surface |
| `.withProviderSecret(secret)` | none | shared secret on the provider WebSocket endpoints. Locks browser providers out entirely: the `WebSocket` constructor cannot set headers |

Also useful once running: `tunnel.getProvidersInfo()`, `tunnel.getProviderInfo(name)`, `tunnel.providerNames`, `tunnel.clientCount`, `tunnel.isListening`.

## Failure modes

**`start()` rejects with `EADDRINUSE`.** Read the message: it names the port and offers the two ways out. Do not retry in a loop; a second broker on another port shares no slots with the first.

**A tool call over `openInternalClient` never resolves.** The slot has no provider and your request had no id, or your `onMessage` filter does not match the id you sent. Sending to a slot with no provider answers **synchronously** with a JSON-RPC error rather than hanging, so a hang means the frame reached a provider that did not answer. `withProviderRequestTimeout` turns that into a named error.

**`registerLoopbackProvider` throws "already registered".** The name collides with another loopback or a stdio upstream. The reserved names `_all` and `_broker` are taken by the broker itself.

**Your in-process tools do not show up for an MCP host.** They are not in `_all`. See the limitation above.

**The process will not exit.** `stop()` was not awaited, or a provider transport you created is still holding a socket. The broker's own timers are `unref()`ed and cleared in `stop()`.
