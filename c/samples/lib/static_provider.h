#ifndef STATIC_PROVIDER_H
#define STATIC_PROVIDER_H

/* The MCP surface the transport samples serve, from static strings.
 *
 * Shared by samples/host-provider and espressif/samples/provider, so both
 * prove the same thing: what the layer above libmcpb must supply, and
 * nothing more. There is no JSON parser here on purpose: libmcpb carries
 * bytes, and a real device brings its own JSON layer. The scanning below is
 * enough for the frames the broker sends and would not survive a hostile
 * client; it is not a parser and does not pretend to be one.
 *
 * What the layer above the transport must do:
 *   1. find the method,
 *   2. echo the request id VERBATIM, quotes and type included, because the
 *      broker allocates string ids ("brk-7") and drops a reply whose id does
 *      not match byte for byte,
 *   3. answer initialize, ping, tools/list and tools/call, ignore
 *      notifications, refuse the rest with -32601.
 */

#include "mcpb/mcpb_provider.h"

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Builds the reply to one incoming frame into `tx`. `name` is the slot name,
 * echoed in the tool's answer. Returns the reply length, 0 for no reply (a
 * notification, or a response to nothing we sent), negative when the reply
 * does not fit in `cap`. */
int static_provider_handle(const char *name, const char *json, size_t len,
                           char *tx, size_t cap);

/* Copies the method of an incoming frame into `out`, or "(response)" when
 * the frame carries none. For logging. */
void static_provider_method(const char *json, size_t len, char *out, size_t cap);

/* Formats a link event as one line, without a newline:
 *
 *   event CONNECTED down_ms=12 connects=1
 *   event DISCONNECTED error="peer closed" code=1006 reason="" next_retry_ms=173
 *   event RETRY_FAILED error="handshake failed" http_status=401 attempts=3 next_retry_ms=812
 *
 * `connects` is the provider's counter, passed in because the event does
 * not carry it. Returns the length written. */
int static_provider_event_line(const mcpb_event_t *e, unsigned long connects,
                               char *out, size_t cap);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* STATIC_PROVIDER_H */
