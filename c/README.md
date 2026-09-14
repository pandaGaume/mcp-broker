# mcp-broker: C

The device side of the tunnel. Where [`node/packages/provider`](../node/packages/provider) lets a JavaScript application publish an MCP server through the broker, this folder does the same for firmware: a client that dials out to `ws[s]://<host>/provider/<name>`, keeps the link alive, reconnects, and hands one JSON-RPC message at a time to whatever MCP implementation the device already has.

## What is here, and what is not

| Folder | Role | State |
|---|---|---|
| [`libmcpb/`](libmcpb/) | The client: RFC 6455 WebSocket (client role), provider registration with the `_all` opt-in, reconnection with a jittered window, immediate link events carrying the peer's refusal. Two endpoints: dedicated (one socket per provider, the default) and multiplexed (several slots on one socket, opt-in at build time so a one-provider firmware carries none of it). C99, no allocation, no platform header. Everything system-dependent goes through a six-function port (plus an optional `sleep_ms`, so a link waiting to reconnect never spins) | 0.4.1, 160 checks without a network |
| [`ports/host/`](ports/host/) | The port for Linux, macOS and Windows: plain TCP over the platform's sockets. On its own it refuses `tls != 0` (never downgrades); with the TLS port below stacked on it, it speaks wss:// | Done |
| [`ports/tls-openssl/`](ports/tls-openssl/) | TLS as a port over another port: OpenSSL driven through memory BIOs, so it never touches a socket and stacks on the host port today and the Unreal port next. Chain verified against a given CA PEM or the platform's store, name verified (DNS or IP literal, SNI for names), no way to skip either. `MCPB_ERR_TLS` names a refused certificate. Built when OpenSSL is found (`MCPB_TLS=ON` to require it) | Done, 42 checks against an in-process OpenSSL server |
| [`ports/espressif/`](ports/espressif/) | The port for ESP-IDF: esp-tls and lwip, TLS through the certificate bundle or a private CA (`ca_pem`). Compiles only inside an IDF build, through the component below | Done |
| [`ports/unreal/`](ports/unreal/) | The port for Unreal Engine 5: `ISocketSubsystem` / `FSocket`, plain TCP; wss:// is the TLS port stacked on it, on the OpenSSL the engine ships, with the engine's roots and pinning from its certificate manager. Compiles only inside an Unreal module, through the plugin below | Done |
| [`samples/lib/`](samples/lib/) | The MCP surface both samples serve, from static strings: `initialize`, `ping`, `tools/list`, one `echo` tool, the request id echoed verbatim. Deliberately without a JSON parser, so it shows exactly what the layer above the transport must supply | Done |
| [`samples/host-provider/`](samples/host-provider/) | The smallest provider that proves the transport on a PC: dials, joins `_all`, serves `echo`, prints every link event as one line. `--multiplex` publishes two slots on one socket instead; `--tls [--ca FILE]` dials wss:// | Done |
| [`tests/roundtrip/`](tests/roundtrip/) | The only test that crosses a real network: `host-provider` against the Node broker of this repository, through its own slot and through `_all`, a multiplexed provider with two slots on one socket, then a broker kill and restart that both must survive; then wss:// against the broker on HTTPS with the certificate in `tests/tls`, accepted through its CA and refused in words without it | Done |
| [`tests/tls/`](tests/tls/) | The self-signed certificate the TLS bench and the roundtrip use. Test material: a century of validity and its private key in the repository, so never trusted anywhere else | Test only |
| [`tests/soak/`](tests/soak/) | Overnight load: calls a provider through the broker every few seconds for hours, a fresh session per round, and logs the numbers a leak would move (failures, latency percentiles, broker RSS, pending count, sessions). The device's own heap low-water mark is on its monitor | Done |
| [`espressif/`](espressif/) | ESP-IDF packaging: the `mcpb_esp` component (one FreeRTOS task around libmcpb and its port, link events on `esp_event`, Kconfig) and a Wi-Fi sample project serving the same `echo` tool. Built for the S3 in CI | Done, see [its README](espressif/README.md) |
| [`unreal/`](unreal/) | Unreal Engine 5 packaging: the `McpBroker` plugin (`UMcpBrokerSubsystem`, one multiplexed socket per game instance for every slot the process publishes, a worker thread, events on the game thread, `bTls` + `CaPem` for wss://) and a host project publishing two `echo` slots. Built and run on UE 5.7, over ws:// and wss://; no engine in CI | Done, see [its README](unreal/README.md) |

**The scope stops at the transport.** `libmcpb` carries opaque bytes: it embeds no JSON parser, no JSON-RPC and no MCP server, because every firmware that would adopt it already has those, in its own language. On a CyanMycelium device that is the C++17 `JsonReader` / `JsonRpc::Server` / `McpServer`, plugged through an `IMessageTransport` around `mcpb_provider_t`. A C MCP layer is not planned; the byte boundary keeps that door open should a third party ever need one.

## Why C99

This is the piece other firmwares embed, so it has to build wherever they build: Xtensa, arm-none-eabi, IAR, Keil, Zephyr, and from C++ through the `extern "C"` already in the headers. C99 is the common denominator of those toolchains. The other constraints follow from the same goal: no `malloc`, so it runs on a target without a heap and memory use is visible at the call site; no host or platform include, so lifting `libmcpb/` out of this repository still builds; its own error codes, because a library that borrows its first host's types stops being extractable.

`-std=c99` is a build flag, not an ambition. The rest of this folder (ports, the ESP-IDF component) is whatever its platform needs.

## Build

Everything, through CMake:

```bash
cmake -S c -B c/build && cmake --build c/build && ctest --test-dir c/build --output-on-failure
```

The TLS port needs OpenSSL 1.1.1 or 3.x (`libssl-dev`, Homebrew `openssl@3`, the MSYS2 or vcpkg package). It is built when CMake finds it and skipped with a message otherwise; `-DMCPB_TLS=ON` makes a missing OpenSSL a configure error, which is what the CI passes. `-DOPENSSL_ROOT_DIR=<prefix>` when it is installed somewhere CMake does not look (with MSYS2 ucrt64: `C:/msys64/ucrt64`).

`libmcpb/` alone, without CMake (cross-compiling: `make CC=arm-none-eabi-gcc AR=arm-none-eabi-ar`):

```bash
make -C c/libmcpb test
```

The roundtrip needs the Node broker built (`npm run build` in `node/`), then:

```bash
node c/tests/roundtrip/run.mjs
```

The ESP-IDF sample, with the IDF environment exported:

```bash
idf.py -C c/espressif/samples/provider set-target esp32s3 build
```

All four paths are exercised by [`ci-c.yml`](../.github/workflows/ci-c.yml): gcc and clang with warnings as errors, the Makefile, the roundtrip against the Node broker, and the S3 build in the official IDF image.

## Try it against a broker

The broker is the one in this repository, from its own working tree, so a change on either side is tested against the other at once. Build it once, then start it from its package (keep that terminal open):

```bash
cd node && npm install && npm run build && cd packages/broker && npm start
```

It listens on `0.0.0.0:3000` by default, so a board on the LAN reaches it at the PC's address; a `node/packages/broker/.mcp-broker/config.json` (gitignored, see the [broker README](../node/packages/broker/README.md#running-the-broker-of-this-checkout)) adds the web explorer and any other setting. Then the host sample, in another terminal:

```bash
c/build/samples/host-provider/host-provider --host 127.0.0.1 --port 3000 --name my-device --aggregate
```

Then, from any MCP client, `tools/call echo` on `http://127.0.0.1:3000/my-device/mcp`, or `my-device-echo` on `/_all/mcp`. Kill the broker and watch the provider print `event DISCONNECTED` at once, `event RETRY_FAILED` while it is down, and `event CONNECTED ... connects=2` when it is back. `--token <secret>` sends it as `X-Provider-Token` for a broker with provider authentication.

## Origin

`libmcpb` was written in the CyanMycelium repository (`libmcpb/`, last commit there `c76102c`, 2026-08-31) and moved here unchanged on 2026-09-12. This repository is now its home; CyanMycelium consumes it from here.

## Licence

Apache-2.0, same as the rest of mcp-broker.
