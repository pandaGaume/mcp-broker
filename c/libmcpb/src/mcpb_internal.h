#ifndef MCPB_INTERNAL_H
#define MCPB_INTERNAL_H

/* Internals. Dependencies the library would rather carry than ask of its
 * port; see the argument in mcpb_port.h. */

#include "mcpb/mcpb.h"
#include "mcpb/mcpb_provider.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MCPB_SHA1_SIZE 20

/* One-shot. The only use is verifying Sec-WebSocket-Accept, which hashes
 * under a hundred bytes; an incremental API would have no caller. */
void mcpb_sha1(const uint8_t *data, size_t len, uint8_t out[MCPB_SHA1_SIZE]);

/* Writes a trailing NUL.
 * @return length written excluding the NUL, or MCPB_ERR_TOO_LARGE. */
int mcpb_base64_encode(const uint8_t *in, size_t len, char *out, size_t cap);

/* The initialiser both endpoints share. `path` is used verbatim (the
 * dedicated path is built from the slot name by mcpb_provider_init, the
 * multiplexed one is the fixed /providers), and `on_open` runs after each
 * handshake. See mcpb_provider_t.on_open. */
int mcpb_provider_init_ex(mcpb_provider_t *p, const mcpb_port_t *port,
                          const mcpb_provider_config_t *cfg, const char *path,
                          int (*on_open)(mcpb_provider_t *, void *), void *open_user);

#ifdef __cplusplus
}
#endif

#endif /* MCPB_INTERNAL_H */
