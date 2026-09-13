#ifndef MCPB_PORT_HOST_H
#define MCPB_PORT_HOST_H

/* libmcpb port for a host: Linux, macOS, Windows.
 *
 * Plain TCP over the platform's sockets, no TLS of its own. `open` refuses
 * `tls != 0` with MCPB_ERR_UNSUPPORTED rather than fall back to the clear,
 * which is what mcpb_port.h asks of a port without TLS. For wss://, stack
 * the TLS port (../../tls-openssl) on this one: it asks this port for plain
 * TCP and does the encryption itself. Or terminate TLS in front of the
 * device.
 *
 * What it is for: the roundtrip test against the Node broker, the CI, and a
 * provider on a Linux-class device (a gateway, a Raspberry Pi). It is not the
 * model for the ESP-IDF port, which sits on esp-tls and has its own file.
 *
 * One context per connection. The struct is the caller's, like every buffer
 * in libmcpb; nothing here allocates.
 */

#include "mcpb/mcpb_port.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct
{
    /* The socket, or -1 when closed. Wide enough for a Windows SOCKET. */
    intptr_t fd;

    /* errno (or WSAGetLastError) of the last failure, for the caller's log.
     * The port itself only returns mcpb_err_t codes. */
    int last_errno;
} mcpb_port_host_t;

/* Fills in `port` over `ctx`. On Windows this also initialises Winsock, once
 * per process. Returns MCPB_OK, or MCPB_ERR_IO when Winsock refuses. */
int mcpb_port_host_init(mcpb_port_t *port, mcpb_port_host_t *ctx);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_PORT_HOST_H */
