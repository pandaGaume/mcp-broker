# mcp-broker on Unreal Engine 5

An Unreal plugin that publishes the MCP servers running inside a game (or an editor) as provider slots on a CyanMycelium mcp-broker, through **one WebSocket for all of them**. Unreal is one process; a socket per server is not what it wants, so the multiplexed endpoint is the default here and the dedicated one is the exception.

```
../ports/unreal/           the port: libmcpb's six functions on ISocketSubsystem / FSocket
McpBroker/                 the plugin: UMcpBrokerSubsystem, one link per game instance, a worker thread
Sample/                    a host project with no content: the engine's Entry map, a game mode, one actor publishing two echo slots
```

The wire code is [`libmcpb`](../libmcpb/), C99, the single copy in this repository. The plugin compiles it from `c/libmcpb` through one-line wrappers under `Source/McpBroker/Private/libmcpb/` (UBT compiles a `.c` as C), and the port from `c/ports/unreal` the same way. Nothing is duplicated: what runs on the ESP32 runs here.

Developed and run on UE 5.7 with Visual Studio 2022. No CI: there is no engine on the runners.

## The port: `ports/unreal`

[`mcpb_port_unreal.h`](../ports/unreal/include/mcpb_port_unreal.h): `open` resolves with `ISocketSubsystem::GetAddressInfo`, connects non-blocking and waits with the caller's timeout, then `SetNoDelay`; `send` loops `FSocket::Send` until the last byte; `recv` waits with `FSocket::Wait` and maps a readable socket with nothing to read to `MCPB_ERR_CLOSED`; `now_ms` is `FPlatformTime::Seconds`; `random` draws sixteen bytes at a time from `FGuid::NewGuid`. Plain TCP: `tls != 0` is refused, never downgraded. `wss://` from Unreal is a later port on the engine's `Ssl` module.

Why the engine's sockets rather than its `IWebSocket`: `IWebSocket` would have given TLS for free, at the price of a second reconnection policy, a second envelope codec and a second set of events, in C++, with no bench. With `FSocket`, libmcpb is identical on ESP32 and Unreal, and `ISocketSubsystem` already carries every platform the engine ships on.

## The plugin: `McpBroker`

One object, `UMcpBrokerSubsystem`, a game-instance subsystem:

```cpp
UMcpBrokerSubsystem* Broker = GetGameInstance()->GetSubsystem<UMcpBrokerSubsystem>();

FMcpBrokerConnectOptions Options;
Options.Host = TEXT("192.168.5.32");
Options.Port = 3000;
Options.Slots = { { TEXT("scene"), /*bAggregate*/ true }, { TEXT("input"), false } };  // one socket, two slots
Options.bMultiplex = true;                                                            // the default

Broker->BindHandler(TEXT("scene"), FMcpMessageHandler::CreateUObject(this, &AMyActor::OnSceneMessage)); // returns the reply
Broker->OnLinkEvent.AddDynamic(this, &AMyActor::OnLink);                                                // Connected, Disconnected, RetryFailed, SlotRefused
Broker->Connect(Options);
```

- `Connect` returns at once; the socket lives on a worker thread (`FMcpBrokerLink`, an `FRunnable`), because libmcpb polls and the game thread does not block.
- Incoming messages reach the slot's handler **on the game thread**; the handler returns the reply (or an empty string for a notification) and it is queued back to the worker. `Send` queues from any thread, for notifications and late results. Nothing survives a disconnection, for the reason `mcpb_provider.h` gives.
- Link events are broadcast on the game thread as `FMcpLinkEvent`, a copy of libmcpb's `mcpb_event_t`: the peer's close code and reason, the HTTP status of a refused handshake, the library's own `detail`, and for `SlotRefused` the slot name and the broker's JSON-RPC code (`-32000` held by someone else, `-32001` forbidden) with its message. The link and the other slots stay up.
- `bMultiplex = false` with exactly one slot uses the dedicated `/provider/<name>` endpoint instead.

`Disconnect` (or the subsystem's own `Deinitialize`) closes the socket, which frees every slot on the broker, and joins the worker.

## The sample: `Sample/`

`AMcpEchoActor`, spawned by `AMcpBrokerSampleGameMode` on the engine's Entry map, publishes `ue-echo` (in `_all`) and `ue-echo-b` (not in `_all`) on one socket and serves both with the static `echo` tool shared with the host and ESP32 samples (`../samples/lib/static_provider.c`, pulled in through a wrapper). Every link event is logged in the same line format as the other two samples.

Build the editor target, then run headless:

```powershell
& "C:\Program Files\EpicGames\UE_5.7\Engine\Build\BatchFiles\Build.bat" McpBrokerSampleEditor Win64 Development -Project="<repo>\c\unreal\Sample\McpBrokerSample.uproject" -WaitMutex
& "C:\Program Files\EpicGames\UE_5.7\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "<repo>\c\unreal\Sample\McpBrokerSample.uproject" -game -log -nullrhi -unattended -McpBrokerHost=127.0.0.1 -McpBrokerPort=3000 -McpBrokerExitAfter=60
```

Then, from any MCP client, `tools/call echo` on `http://127.0.0.1:3000/ue-echo/mcp` and on `/ue-echo-b/mcp`, and `ue-echo-echo` on `/_all/mcp` (which does not list `ue-echo-b-echo`: aggregate is per slot). `Saved/Logs/McpBrokerSample.log` shows the `rx <slot> <method>` lines. `-McpBrokerSlot=<name>` renames the pair.

The `.uproject` finds the plugin through `AdditionalPluginDirectories: [".."]`, so nothing is copied or junctioned: the plugin next to the sample is the one being built. To use it in your own project, copy `McpBroker/` into your `Plugins/` (the wrappers' relative includes need `c/libmcpb` and `c/ports/unreal` at the same relative place, or point `McpBroker.Build.cs` at them).

## What it costs

libmcpb's public functions carry `MCPB_API`, empty everywhere except in a build that packages the library in one shared library and calls it from another, which is what an Unreal editor build does (one DLL per module): `MCPB_BUILD_DLL` in the plugin, `MCPB_USE_DLL` in its dependents, both set by `McpBroker.Build.cs`. That is the only thing the Unreal port asked of libmcpb.
