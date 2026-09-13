#ifndef MCPB_ENVELOPE_H
#define MCPB_ENVELOPE_H

/* The tunnel envelope of the multiplexed /providers endpoint.
 *
 *     { "provider": "scene-1", "payload": { "jsonrpc": "2.0", ... } }
 *
 * (mcp-broker/node/packages/provider/src/protocol/envelope.ts is the
 * definition; this file mirrors it byte for byte on the encoding side.)
 *
 * This is transport framing, not MCP: it names the slot a frame belongs to,
 * the way the WebSocket frame names its length. That is why it lives in
 * libmcpb without breaking its rule of carrying opaque bytes: the payload is
 * never interpreted, only located. Locating it needs a balanced scan of one
 * JSON value, strings and escapes included, which is forty lines; it is not
 * a parser and the payload comes out exactly as the peer wrote it.
 *
 * Built only with MCPB_ENABLE_MUX. A device with one provider uses the
 * dedicated path and never compiles this file.
 */

#if !defined(MCPB_ENABLE_MUX) || !MCPB_ENABLE_MUX
#error "multiplex not built: define MCPB_ENABLE_MUX=1 and compile mcpb_envelope.c and mcpb_mux.c"
#endif

#include "mcpb.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Writes {"provider":"<name>","payload":<payload>} into out, with the name
 * escaped per RFC 8259. The payload is copied verbatim; it must be one JSON
 * value already. Writes a trailing NUL.
 * @return length written excluding the NUL, or MCPB_ERR_TOO_LARGE. */
MCPB_API int mcpb_envelope_encode(const char *provider, const char *payload,
                         size_t payload_len, char *out, size_t cap);

/* The registration notification for one slot, wrapped:
 *   {"provider":"<name>","payload":{"jsonrpc":"2.0","method":"notifications/register"}}
 * with `,"params":{"aggregate":true}` inside the payload when `aggregate`.
 * Byte-identical to what the TypeScript transport sends. */
MCPB_API int mcpb_envelope_register(const char *provider, int aggregate,
                           char *out, size_t cap);

/* Locates the two members of an envelope, in whatever order they appear.
 *
 * `provider` points into `frame` at the string's content (between the
 * quotes, escapes left as written, not NUL-terminated) and `payload` at the
 * JSON value, both with their lengths. Members other than these two are
 * skipped. Whitespace is tolerated wherever JSON allows it.
 *
 * @return MCPB_OK, or MCPB_ERR_PROTOCOL when `frame` is not an object with a
 *         non-empty string "provider" and a "payload". The peer's garbage is
 *         reported, not trusted. */
MCPB_API int mcpb_envelope_decode(const char *frame, size_t len,
                         const char **provider, size_t *provider_len,
                         const char **payload, size_t *payload_len);

/* Reads a tunnel-level error out of a payload, when there is one:
 *   {"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"..."}}
 * That is how the broker refuses a slot (code -32000: unavailable, -32001:
 * forbidden), and a plain MCP server handed such a frame would classify it
 * as an unknown notification and drop it without a word.
 *
 * @return 1 and fills code/message when the payload carries an error with
 *         id null; 0 otherwise. `message` is not NUL-terminated. */
MCPB_API int mcpb_envelope_tunnel_error(const char *payload, size_t len, int *code,
                               const char **message, size_t *message_len);

/* Compares a raw (still escaped) name from a frame with a plain C string,
 * decoding the JSON escapes on the fly. Slot names are usually ASCII with
 * nothing to escape, but a name is a name. @return 1 when equal. */
MCPB_API int mcpb_envelope_name_equals(const char *raw, size_t raw_len, const char *name);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_ENVELOPE_H */
