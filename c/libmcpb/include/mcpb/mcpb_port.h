#ifndef MCPB_PORT_H
#define MCPB_PORT_H

/* The port. Everything libmcpb needs from the system, and nothing else in
 * libmcpb/ includes a platform header.
 *
 * Porting the library means filling in this struct. Six functions.
 *
 * TLS lives behind `open` rather than beside it: the library only moves
 * bytes, so a port without TLS just refuses `tls != 0` and no layer above
 * takes a different path. Name resolution is also inside `open`, because
 * every stack resolves differently and the library gains nothing by
 * arbitrating.
 *
 * SHA-1 and base64 are built into the library instead of being asked of the
 * port. Every obligation removed here is one more project that can adopt it
 * without a discussion. SHA-1 is not a secret here: RFC 6455 uses it as a
 * handshake consistency check against a public constant.
 *
 * Randomness cannot be built in. The frame mask is not a secret either
 * (RFC 6455 uses it against proxy cache poisoning, not eavesdropping), but a
 * predictable generator defeats the point, and a library cannot know where
 * entropy comes from on its host.
 */

#include "mcpb.h"

#ifdef __cplusplus
extern "C" {
#endif

/* timeout_ms: 0 means non-blocking, negative means no limit. */

typedef struct mcpb_port
{
    /* Passed back to every call. The library never dereferences it. */
    void *ctx;

    /* Open a byte stream to host:port. `tls` requests an encrypted channel;
     * certificate and hostname checking are the port's job.
     *
     * A port without TLS must return MCPB_ERR_UNSUPPORTED rather than open in
     * the clear: a silent fallback to plaintext is the worst outcome, because
     * nothing reports it. */
    int (*open)(void *ctx, const char *host, uint16_t port,
                int tls, int timeout_ms);

    /* Write all `len` bytes or fail. A partial write reported as success
     * desynchronises the stream for good, the peer then reading a frame
     * length out of payload bytes.
     * @return len, or negative. */
    int (*send)(void *ctx, const uint8_t *buf, size_t len, int timeout_ms);

    /* Read at most `len` bytes; returning fewer is fine, the library loops.
     * @return  > 0                bytes read
     *          MCPB_ERR_TIMEOUT   nothing arrived in time
     *          MCPB_ERR_CLOSED    peer closed cleanly
     *          other negative     transport error
     *
     * Never return 0. Zero is not part of the convention, and confusing it
     * with a close is exactly what MCPB_ERR_CLOSED prevents. */
    int (*recv)(void *ctx, uint8_t *buf, size_t len, int timeout_ms);

    /* Must tolerate being called on an already-closed stream. */
    void (*close)(void *ctx);

    /* Monotonic milliseconds. No particular epoch is required, only that it
     * never goes backwards: the library only takes differences, and 32-bit
     * wraparound is handled by signed comparison. */
    uint32_t (*now_ms)(void *ctx);

    /* Unpredictable bytes.
     * @return MCPB_OK, or negative if no source is available. A failure fails
     *         the connection: deriving a mask from a counter would be worse,
     *         because nobody would see it. */
    int (*random)(void *ctx, uint8_t *buf, size_t len);
} mcpb_port_t;

/* Checks each field. A missing one would otherwise show up as a jump to
 * address zero, far from the offending line. */
int mcpb_port_check(const mcpb_port_t *port);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_PORT_H */
