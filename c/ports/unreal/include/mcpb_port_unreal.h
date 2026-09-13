#ifndef MCPB_PORT_UNREAL_H
#define MCPB_PORT_UNREAL_H

/* libmcpb port for Unreal Engine 5: FSocket through ISocketSubsystem.
 *
 * Plain TCP, no TLS: `open` refuses `tls != 0` with MCPB_ERR_UNSUPPORTED,
 * never downgrades. A wss:// broker from Unreal is the job of a later port
 * on the engine's Ssl module; a broker on the LAN or an edge box speaks
 * ws:// and this is enough for it.
 *
 * Why the engine's sockets rather than its IWebSocket: libmcpb is one
 * implementation of the tunnel client, benched without a network and run
 * on an ESP32 over the same code, and the port keeps it that way on
 * Unreal. IWebSocket would have meant a second reconnection policy, a
 * second envelope codec and a second set of events, in C++, with no bench.
 * ISocketSubsystem already carries every platform the engine ships on.
 *
 * The same shape as ports/host and ports/espressif: the six functions,
 * one context per connection, nothing allocated by the port beyond the
 * engine's own socket object. The context is created and destroyed by the
 * caller; call mcpb_port_unreal_init before use.
 *
 * Compiles only inside an Unreal module (it includes engine headers), so
 * the host CMake in c/ does not build it; the plugin in c/unreal does.
 */

#include "mcpb/mcpb_port.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct
{
    void *socket;      /* FSocket *, NULL when closed */
    void *subsystem;   /* ISocketSubsystem *, resolved at init */
    int   last_error;  /* ESocketErrors of the last failure, for the log */

    /* Random bytes come sixteen at a time from the engine (one GUID);
     * the unused remainder waits here for the next call. */
    unsigned char pool[16];
    unsigned int  pool_left;
} mcpb_port_unreal_t;

/* Fills in `port` over `ctx`. Returns MCPB_OK, or MCPB_ERR_UNSUPPORTED when
 * the platform has no socket subsystem. */
int mcpb_port_unreal_init(mcpb_port_t *port, mcpb_port_unreal_t *ctx);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_PORT_UNREAL_H */
