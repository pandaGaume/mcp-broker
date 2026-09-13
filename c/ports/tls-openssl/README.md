# ports/tls-openssl

TLS as a port over another port. `mcpb_port_tls_init` takes the six functions of an inner port (host, Unreal, anything that moves bytes over plain TCP) and fills in six functions of the same shape that encrypt on the way out and decrypt on the way in. libmcpb is handed the outer port and sees a byte stream, as always; nothing in the library knows TLS exists.

The engine never touches a socket. OpenSSL runs on memory BIOs: each record it produces is read out of a BIO and passed to the inner `send`, each byte the inner `recv` returns is written into a BIO for the engine. That is what lets one file serve a BSD socket on a host and an `FSocket` in Unreal, at the cost of one copy per direction through a 4 KB staging buffer.

What it verifies, always: the chain, against the CA PEM in `mcpb_port_tls_config_t.ca_pem` or, absent one, the platform's default store; and the name, DNS name or IP literal, against the certificate (SNI sent for names). There is no option to skip either. A private CA is the normal case for a broker on a LAN or an edge box; a switch that turns verification off is how a demo setting ships to production.

`tls == 0` on `open` passes straight through, so one outer port serves ws:// and wss:// alike.

A host that already has a configured `SSL_CTX` hands it over in `mcpb_port_tls_config_t.ssl_ctx`: Unreal's `ISslManager::CreateSslContext()`, with the engine's root certificates and the project's pinning, is the case this exists for. The context is borrowed, never freed, and it supplies trust only: verification (`SSL_VERIFY_PEER`, TLS 1.2 floor) is set per connection by the port, so a context with verification off does not turn it off here. `ca_pem` still adds a private CA to that context's store.

## Use

```c
mcpb_port_host_t host_ctx;
mcpb_port_t host_port;
mcpb_port_host_init(&host_port, &host_ctx);

static mcpb_port_tls_t tls_ctx;
mcpb_port_t port;
mcpb_port_tls_config_t tls_cfg = { ca_pem, 0 };          /* or NULL for the platform's store */
mcpb_port_tls_init(&port, &tls_ctx, &host_port, &tls_cfg);

cfg.tls = 1;                                             /* mcpb_provider_config_t */
mcpb_provider_init(&provider, &port, &cfg);
```

A refused certificate reaches the provider's events as `MCPB_ERR_TLS` ("TLS handshake or certificate refused"); `mcpb_port_tls_last_error` says why in words (`self-signed certificate`, `hostname mismatch`, ...), which the host sample prints as `tls="..."` on the event line.

## Build

OpenSSL 1.1.1 or 3.x: `libssl-dev` on Debian and Ubuntu, `openssl@3` from Homebrew on macOS, the `openssl` package of the same MSYS2 environment as the compiler on Windows (`-DOPENSSL_ROOT_DIR=C:/msys64/ucrt64`), or vcpkg with MSVC. Unreal Engine ships its own copy; the plugin will compile this file against it.

From `c/`: built when CMake finds OpenSSL, skipped with a message otherwise, `-DMCPB_TLS=ON` to require it. The bench, `test_mcpb_tls`, runs an OpenSSL server in the same process behind a fake inner port, with the certificate in `c/tests/tls`, so the refusals (wrong name, wrong IP, unknown CA) are exercised without a network.
