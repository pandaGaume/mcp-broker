# C# provider

Publish an existing MCP server to the Node broker from .NET 8 or later. The
`CyanMycelium.Mcp.Broker.Provider` library uses `ClientWebSocket` and
`System.Text.Json` from the .NET runtime, with no NuGet dependencies or native
library.

This is the provider side of the tunnel. It carries JSON-RPC messages and leaves
MCP initialization, tools, resources and prompts to the application's MCP server.
The .NET broker port remains planned. This provider is available from a checkout;
it has no published NuGet package or release pipeline yet.

## Build and reference

From the repository root, with the .NET SDK installed:

```sh
cd dotnet
dotnet build McpBroker.sln -c Release
dotnet add ../path/to/App.csproj reference src/CyanMycelium.Mcp.Broker.Provider/CyanMycelium.Mcp.Broker.Provider.csproj
```

Run SDK commands from `dotnet/` so its `global.json` selects a compatible installed
SDK. The projects use installed .NET reference packs, and `NuGet.Config` disables
remote package sources.

The public namespace is `CyanMycelium.Mcp.Broker.Provider`. There is no dependency
on an MCP SDK: an application passes its own JSON-RPC handler to the transport.

## One server, one socket

Create a `DirectTransport` for `ws[s]://<host>/provider/<encodedName>` and call
`ConnectAsync` with the message handler. The handler is installed before the
connection opens, so it can answer a broker initialization request immediately.

```csharp
using CyanMycelium.Mcp.Broker.Provider;

await using var transport = new DirectTransport(
    new Uri("ws://localhost:3000/provider/csharp-echo"),
    new ProviderOptions { Aggregate = true });

// DispatchMcpAsync is the application's MCP request dispatcher. It returns
// a JSON response, or null for a notification that needs no response.
await transport.ConnectAsync(async (message, cancellationToken) =>
{
    var response = await DispatchMcpAsync(message, cancellationToken);
    if (response is { } reply)
        await transport.SendAsync(reply, cancellationToken);
});

await transport.Completion;
```

`ConnectAsync` waits for the first open connection, retrying if the broker is
temporarily unavailable. Completing means the WebSocket opened and any required
registration frames were sent. Broker acceptance can still fail afterwards:
observe `Completion` for terminal errors and a policy refusal's close code and
reason.

Set `Aggregate = true` only when the provider's tools and prompts should also be
visible through `_all`. The default is `false`; the provider remains reachable
on its own slot at `http://<host>/<encodedName>/mcp`.

## Several servers, one socket

Use `MultiplexConnection` with `ws[s]://<host>/providers`. Add all providers before
connecting, with one handler and aggregate choice per slot:

```csharp
await using var connection = new MultiplexConnection(
    new Uri("ws://localhost:3000/providers"));

var first = connection.AddProvider("scene-1", HandleFirstMcpAsync, aggregate: true);
var second = connection.AddProvider("scene-2", HandleSecondMcpAsync);

await connection.ConnectAsync();
// Each handler sends replies through its own transport:
// await first.SendAsync(response, cancellationToken);
await connection.Completion;
```

The connection announces every slot before application traffic and wraps each
message as `{ "provider": "scene-1", "payload": { ... } }`. A multiplex transport's
`Name` identifies its slot. Closing or disposing the connection releases every
slot on that socket. Set aggregate membership on `AddProvider`;
`ProviderOptions.Aggregate = true` on a `MultiplexConnection` is rejected.

The endpoint and transport must match. `/provider/<name>` carries plain JSON-RPC;
`/providers` carries envelopes. `/providers/<name>` is neither provider endpoint.
Custom prefixes, such as `/mcp/provider/name` and `/mcp/providers`, are accepted.
The `/provider/` and `/providers` path segments must retain these spellings.

## Authentication and lifecycle

`ProviderOptions.Secret` sets the `X-Provider-Token` header during the WebSocket
handshake. Read the secret from your application's configuration, for example
`Environment.GetEnvironmentVariable("MCP_PROVIDER_SECRET")`. Do not put it in the
URL. The broker decides which slots that provider identity may publish.

`ProviderOptions.MaxMessageBytes` bounds each received or sent UTF-8 WebSocket
message, including a multiplex envelope, and defaults to 1 MiB.
Message payloads use `JsonElement`; preserve request IDs and
their JSON types when constructing responses. Malformed JSON frames are dropped.
Binary or oversized incoming messages fail the connection. An oversized outgoing
message is rejected locally without closing the connection.

Both connection types reconnect automatically by default. After a connection
failure, attempts wait 1, 2, 4, 8, 16, then 30 seconds, remaining at 30 seconds
while the outage continues. Each delay starts when the previous attempt ends.
A session that stays open for at least `ReconnectMaxDelay` resets the next delay
to `ReconnectInitialDelay`; short sessions retain the growing delay.

```csharp
var options = new ProviderOptions
{
    AutoReconnect = true,
    ReconnectInitialDelay = TimeSpan.FromSeconds(1),
    ReconnectMaxDelay = TimeSpan.FromSeconds(30)
};
```

Every attempt creates a fresh socket and sends the same provider credential and
registrations, including each slot's aggregate choice. `IsOpen` is false while
connecting or waiting to retry, and `Completion` remains pending during recovery.
Call `ConnectAsync` once per instance. Its cancellation token stops initial
attempts and cancels `Completion` if the first connection has not opened yet;
after the first open, that token no longer controls the connection.

Transport interruptions and remote normal closes are retried. Unavailable-slot
registration errors (`-32000`) are also retried. For a direct provider, close code
`1008` is retried only when its reason starts with
`Slot already held by a live provider`, the broker's temporary liveness refusal.
Other policy refusals, HTTP 4xx responses except 408 and 429, TLS failures,
handler failures and invalid incoming message sizes end recovery and fault
`Completion`. A terminal multiplex refusal closes the whole shared connection.

Set `AutoReconnect = false` for one connection attempt with no recovery after a
disconnect. Neither mode queues application messages or replays them after an
outage. `SendAsync` throws while disconnected; an interrupted send must be handled
by the application.

Messages are dispatched serially. A handler may await `SendAsync` to reply, and
its `JsonElement` is detached from the parser and may be retained after the
callback returns. Handlers receive the current session's token, which is canceled
when that socket ends. Await `CloseAsync` and `Completion` from the owning
application, outside a message handler.

`CloseAsync` stops active attempts and retry waits promptly, releases the slots
and completes `Completion` normally. `await using` also closes and disposes the
connection. Cleanup does not rethrow an earlier terminal failure, so inspect
`Completion` explicitly to observe it.

| API | Purpose |
|---|---|
| `ProviderMessageHandler(JsonElement, CancellationToken)` | Asynchronous message handler returning `ValueTask` |
| `DirectTransport.ConnectAsync(handler, cancellationToken)` | Install the handler and await the first dedicated socket opening |
| `MultiplexConnection.AddProvider(name, handler, aggregate)` | Define a slot before connecting; returns its `MultiplexTransport` |
| `MultiplexConnection.ConnectAsync(cancellationToken)` | Await the first shared socket opening and register its slots |
| `DirectTransport.SendAsync(message, cancellationToken)` | Send plain JSON-RPC |
| `MultiplexTransport.SendAsync(message, cancellationToken)` | Send JSON-RPC for that transport's `Name` |
| `IsOpen` / `Completion` | Observe readiness and the final outcome, with Completion pending during retries |
| `CloseAsync(cancellationToken)` / `DisposeAsync()` | Shut down the dedicated or multiplex connection |

## Sample and verification

Start the Node broker, then run the echo sample from the repository root:

```sh
cd dotnet
dotnet run --project samples/EchoProvider -- ws://localhost:3000/provider/dotnet-echo --aggregate
```

The sample answers MCP initialization, lists its `echo` tool and handles calls.
Connect an MCP client to `http://localhost:3000/dotnet-echo/mcp`. For two slots on
one socket, from the same `dotnet/` folder:

```sh
dotnet run --project samples/EchoProvider -- ws://localhost:3000/providers --multiplex --aggregate
```

That publishes `dotnet-echo` and `dotnet-second`. Both modes read provider
credentials from the `MCP_PROVIDER_SECRET` environment variable.

Build the .NET solution and the Node workspace before running the integration
suite. Starting at the repository root:

```sh
cd dotnet
dotnet build McpBroker.sln -c Release
cd ..
npm --prefix node run build
node dotnet/tests/run.mjs
```

The test runner starts the broker and the compiled C# test executable itself. It
does not install dependencies or build either implementation. See
[`samples/EchoProvider`](samples/EchoProvider/),
[`tests/ProviderTests`](tests/ProviderTests/) and [`tests/run.mjs`](tests/run.mjs).

The language-neutral wire contract is in [`docs/protocol.md`](../docs/protocol.md).
See [`AGENTS.md`](../AGENTS.md) for broker setup, endpoint pairing and diagnostics.
