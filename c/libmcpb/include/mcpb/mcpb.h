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

/* Linkage of the public functions. Empty by default: a static library, or
 * sources compiled straight into the program, which is every embedded
 * build. A host that packages libmcpb inside a shared library and calls it
 * from another one (an Unreal module in an editor build is one DLL per
 * module) defines MCPB_BUILD_DLL while compiling the library and
 * MCPB_USE_DLL in the consumers. Nothing here depends on the host's own
 * headers: these files are compiled as plain C. */
#ifndef MCPB_API
#  if defined(MCPB_BUILD_DLL)
#    if defined(_WIN32)
#      define MCPB_API __declspec(dllexport)
#    else
#      define MCPB_API __attribute__((visibility("default")))
#    endif
#  elif defined(MCPB_USE_DLL)
#    if defined(_WIN32)
#      define MCPB_API __declspec(dllimport)
#    else
#      define MCPB_API
#    endif
#  else
#    define MCPB_API
#  endif
#endif

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
    MCPB_ERR_UNSUPPORTED = -9,
    /* The TLS handshake failed or the peer's certificate was refused. A
     * port's code, not the library's: the library never sees TLS. Distinct
     * from MCPB_ERR_IO so a wrong certificate does not read as a bad cable. */
    MCPB_ERR_TLS         = -10
} mcpb_err_t;

/* Never NULL. */
MCPB_API const char *mcpb_strerror(int err);

#define MCPB_VERSION_MAJOR 0
#define MCPB_VERSION_MINOR 4
#define MCPB_VERSION_PATCH 1
#define MCPB_VERSION_STRING "0.4.1"

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_H */
