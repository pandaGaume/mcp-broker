#ifndef MCPB_TELEMETRY_H
#define MCPB_TELEMETRY_H

/* Optional telemetry notification codec.
 *
 * The caller owns both the serialized span and the destination buffer. The
 * codec performs no allocation and has no OpenTelemetry dependency. It only
 * wraps one compact OTLP-compatible span for the broker telemetry extension.
 */

#include "mcpb.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MCPB_TELEMETRY_METHOD "broker/telemetry"

/* Writes a JSON-RPC telemetry notification and a trailing NUL into out:
 *
 * {"jsonrpc":"2.0","method":"broker/telemetry","params":
 *   {"version":1,"signal":"traces","span":<span_json>}}
 *
 * span_json must be one JSON object. It is copied verbatim and is not parsed.
 *
 * @return length excluding the trailing NUL, MCPB_ERR_ARG for invalid input,
 *         or MCPB_ERR_TOO_LARGE when the caller's buffer is too small. */
MCPB_API int mcpb_telemetry_encode(const char *span_json, size_t span_len,
                                   char *out, size_t cap);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_TELEMETRY_H */

