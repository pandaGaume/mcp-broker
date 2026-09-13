#ifndef MCPB_PORT_TLS_H
#define MCPB_PORT_TLS_H

/* libmcpb TLS port on OpenSSL: a port that sits on another port.
 *
 * Nothing in libmcpb knows about TLS; the contract in mcpb_port.h puts it
 * behind `open`. This file is one way to honour that contract for any port
 * that only speaks plain TCP: it takes the six functions of an inner port
 * (host, Unreal, whatever moves bytes) and returns six functions of its own,
 * the same shape, that encrypt on the way out and decrypt on the way in.
 * The library is handed the outer port and sees a byte stream, as always.
 *
 * The engine never touches a socket. It runs on OpenSSL memory BIOs: every
 * TLS record it produces is read out of a BIO and handed to the inner port's
 * `send`; every byte the inner port's `recv` returns is written into a BIO
 * for the engine to consume. That is what makes the same file serve a BSD
 * socket on a host and an FSocket in Unreal without a platform line in it,
 * at the cost of one copy per direction through a 4 KB staging buffer.
 *
 * What it verifies, always: the chain against the CA given here or, absent
 * one, the platform's default store; and the name, DNS name or IP literal,
 * against the certificate (SNI is sent for DNS names). There is no option to
 * skip either. A private CA is the normal case for a broker on a LAN or an
 * edge box, and a PEM in memory is how it is given; a switch that turns
 * verification off is how a demo setting ships to production.
 *
 * `tls == 0` on `open` passes straight through to the inner port, so one
 * outer port serves ws:// and wss:// alike and the caller does not choose a
 * port per scheme.
 *
 * Allocation: OpenSSL allocates for its contexts and BIOs. That is the
 * price of this backend and it is paid on hosts that have a heap; the
 * ESP-IDF port sits on esp-tls instead and does not include this file.
 *
 * Needs OpenSSL 1.1.1 or 3.x headers and libraries: libssl-dev on Debian
 * and Ubuntu, openssl@3 from Homebrew on macOS, the MSYS2 or vcpkg package
 * on Windows, and the OpenSSL module Unreal Engine ships.
 */

#include "mcpb/mcpb_port.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Bytes staged between the inner port and the engine, per direction. A TLS
 * record is at most 16 KB plus overhead; a smaller buffer only means more
 * inner calls per record, never a failure. */
#define MCPB_TLS_IO_CAPACITY 4096

typedef struct
{
    /* One or more certificates in PEM, concatenated, that the peer's chain
     * must lead to. NULL: the platform's default store (what the OS or the
     * OpenSSL build trusts), which is right for a broker behind a public
     * certificate and wrong for a private one. */
    const char *ca_pem;
    /* Length of ca_pem, or 0 for a NUL-terminated string. */
    size_t ca_pem_len;
} mcpb_port_tls_config_t;

typedef struct
{
    const mcpb_port_t *inner;   /* the port underneath, borrowed */

    void *ssl_ctx;              /* SSL_CTX *, lives from init to deinit */
    void *ssl;                  /* SSL *, one per encrypted stream, else NULL */
    void *rbio;                 /* BIO *, bytes from the inner port, owned by ssl */
    void *wbio;                 /* BIO *, bytes for the inner port, owned by ssl */

    int opened;                 /* the inner stream is open */
    int tls;                    /* and it is encrypted */

    /* For the caller's log after a failure. The port itself only returns
     * mcpb_err_t codes. `last_verify` is an X509_V_* result (0 is OK, so a
     * non-zero value names why the certificate was refused);
     * `last_ssl_error` is the top of OpenSSL's error queue at the time. */
    long          last_verify;
    unsigned long last_ssl_error;

    uint8_t io[MCPB_TLS_IO_CAPACITY];
} mcpb_port_tls_t;

/* Fills in `port` over `ctx`, encrypting what goes through `inner`. `inner`
 * must outlive `ctx`. `cfg` may be NULL for the default store.
 *
 * Returns MCPB_OK; MCPB_ERR_ARG when `ca_pem` holds no certificate; or
 * MCPB_ERR_IO when OpenSSL refuses to build a context. */
int mcpb_port_tls_init(mcpb_port_t *port, mcpb_port_tls_t *ctx,
                       const mcpb_port_t *inner,
                       const mcpb_port_tls_config_t *cfg);

/* Closes the stream if one is open and releases the OpenSSL context. The
 * inner port is not deinitialised; it was never this file's. */
void mcpb_port_tls_deinit(mcpb_port_tls_t *ctx);

/* Writes a one-line explanation of the last failure into `buf` (the X509
 * verification result by name when there is one, else OpenSSL's error
 * string) and returns `buf`. Empty when nothing failed. */
const char *mcpb_port_tls_last_error(const mcpb_port_tls_t *ctx, char *buf, size_t cap);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_PORT_TLS_H */
