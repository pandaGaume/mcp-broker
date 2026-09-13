#ifndef MCPB_H
#define MCPB_H

/* libmcpb -- provider client for mcp-broker. C99, no allocation.
 *
 * Standalone: nothing here includes a host or platform header. Everything
 * system-dependent goes through mcpb_port.h. Lift the libmcpb/ directory out
 * and it still builds. That is why it declares its own error codes instead of
 * borrowing the host's.
 *
 * It carries bytes, not JSON. A JSON-RPC message goes in and comes out
 * untouched, so it stays independent of whatever MCP implementation sits
 * behind it.
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Non-negative is a byte count or success, negative is one of these.
 *
 * TIMEOUT and CLOSED are separate on purpose: a peer that closed cleanly is
 * not a slow peer. Merging them makes a client spin until its own timeout
 * instead of reconnecting. */
typedef enum
{
    MCPB_OK              =  0,
    MCPB_ERR_ARG         = -1,
    MCPB_ERR_TIMEOUT     = -2,  /* nothing arrived in time */
    MCPB_ERR_CLOSED      = -3,  /* peer closed cleanly */
    MCPB_ERR_IO          = -4,
    MCPB_ERR_PROTOCOL    = -5,  /* malformed frame or response */
    MCPB_ERR_TOO_LARGE   = -6,  /* larger than the caller's buffer */
    MCPB_ERR_HANDSHAKE   = -7,
    MCPB_ERR_STATE       = -8,  /* not valid in the current state */
    MCPB_ERR_UNSUPPORTED = -9
} mcpb_err_t;

/* Never NULL. */
const char *mcpb_strerror(int err);

#define MCPB_VERSION_MAJOR 0
#define MCPB_VERSION_MINOR 2
#define MCPB_VERSION_PATCH 1
#define MCPB_VERSION_STRING "0.2.1"

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_H */
