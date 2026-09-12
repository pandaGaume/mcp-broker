# mcp-broker: C

The device side of the tunnel. Where [`node/packages/provider`](../node/packages/provider) lets a JavaScript application publish an MCP server through the broker, this folder does the same for firmware: a client that dials out to `ws[s]://<host>/provider/<name>`, keeps the link alive, reconnects, and hands one JSON-RPC message at a time to whatever MCP implementation the device already has.

## What is here, and what is not

| Folder | Role | State |
|---|---|---|
| [`libmcpb/`](libmcpb/) | The client: RFC 6455 WebSocket (client role), provider registration, reconnection with a jittered window, immediate link events. C99, no allocation, no platform header. Everything system-dependent goes through a six-function port | Complete, 83 checks without a network |
| `ports/posix/` | BSD sockets / Winsock port, for tests, CI and Linux-class devices | Planned |
| `espressif/` | ESP-IDF component: port over esp-tls and lwip, a FreeRTOS task running the poll loop, link events republished on `esp_event` | Planned |
| `tests/` | Roundtrip against the Node broker in this repository | Planned |

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

Both paths are exercised by [`ci-c.yml`](../.github/workflows/ci-c.yml), on gcc and clang, with warnings as errors.

## Origin

`libmcpb` was written in the CyanMycelium repository (`libmcpb/`, last commit there `c76102c`, 2026-08-31) and moved here unchanged on 2026-09-12. This repository is now its home; CyanMycelium consumes it from here.

## Licence

Apache-2.0, same as the rest of mcp-broker.
