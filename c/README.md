# mcp-broker: C

The device side of the tunnel. Where [`node/packages/provider`](../node/packages/provider) lets a JavaScript application publish an MCP server through the broker, this folder does the same for firmware: a client that dials out to `ws[s]://<host>/provider/<name>`, keeps the link alive, reconnects, and hands one JSON-RPC message at a time to whatever MCP implementation the device already has.

## What is here, and what is not

| Folder | Role | State |
|---|---|---|
| [`libmcpb/`](libmcpb/) | The client: RFC 6455 WebSocket (client role), provider registration with the `_all` opt-in, reconnection with a jittered window, immediate link events carrying the peer's refusal. C99, no allocation, no platform header. Everything system-dependent goes through a six-function port | 0.2.0, 98 checks without a network |
| [`ports/host/`](ports/host/) | The port for Linux, macOS and Windows: plain TCP over the platform's sockets, no TLS (`tls != 0` is refused, never downgraded). For the roundtrip, the CI, and a provider on a Linux-class device | Done |
| [`samples/host-provider/`](samples/host-provider/) | The smallest provider that proves the transport: dials, joins `_all`, serves one `echo` tool from static strings, prints every link event as one line. Deliberately without a JSON parser, so it shows exactly what the layer above the transport must supply | Done |
| [`tests/roundtrip/`](tests/roundtrip/) | The only test that crosses a real network: `host-provider` against the Node broker of this repository, through its own slot and through `_all`, then a broker kill and restart | Done |
| `espressif/` | ESP-IDF component: port over esp-tls and lwip, a FreeRTOS task running the poll loop, link events republished on `esp_event` | Planned |

**The scope stops at the transport.** `libmcpb` carries opaque bytes: it embeds no JSON parser, no JSON-RPC and no MCP server, because every firmware that would adopt it already has those, in its own language. On a CyanMycelium device that is the C++17 `JsonReader` / `JsonRpc::Server` / `McpServer`, plugged through an `IMessageTransport` around `mcpb_provider_t`. A C MCP layer is not planned; the byte boundary keeps that door open should a third party ever need one.

## Why C99

This is the piece other firmwares embed, so it has to build wherever they build: Xtensa, arm-none-eabi, IAR, Keil, Zephyr, and from C++ through the `extern "C"` already in the headers. C99 is the common denominator of those toolchains. The other constraints follow from the same goal: no `malloc`, so it runs on a target without a heap and memory use is visible at the call site; no host or platform include, so lifting `libmcpb/` out of this repository still builds; its own error codes, because a library that borrows its first host's types stops being extractable.

`-std=c99` is a build flag, not an ambition. The rest of this folder (ports, the ESP-IDF component) is whatever its platform needs.

## Build

Everything, through CMake:

```bash
cmake -S c -B c/build && cmake --build c/build && ctest --test-dir c/build --output-on-failure
```

`libmcpb/` alone, without CMake (cross-compiling: `make CC=arm-none-eabi-gcc AR=arm-none-eabi-ar`):

```bash
make -C c/libmcpb test
```

The roundtrip needs the Node broker built (`npm run build` in `node/`), then:

```bash
node c/tests/roundtrip/run.mjs
```

All three paths are exercised by [`ci-c.yml`](../.github/workflows/ci-c.yml), on gcc and clang, with warnings as errors.

## Try it against a broker

```bash
c/build/samples/host-provider/host-provider --host 127.0.0.1 --port 3000 --name my-device --aggregate
```

Then, from any MCP client, `tools/call echo` on `http://127.0.0.1:3000/my-device/mcp`, or `my-device-echo` on `/_all/mcp`. Kill the broker and watch the provider print `event DISCONNECTED` at once, `event RETRY_FAILED` while it is down, and `event CONNECTED ... connects=2` when it is back. `--token <secret>` sends it as `X-Provider-Token` for a broker with provider authentication.

## Origin

`libmcpb` was written in the CyanMycelium repository (`libmcpb/`, last commit there `c76102c`, 2026-08-31) and moved here unchanged on 2026-09-12. This repository is now its home; CyanMycelium consumes it from here.

## Licence

Apache-2.0, same as the rest of mcp-broker.
