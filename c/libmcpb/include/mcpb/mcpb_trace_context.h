#ifndef MCPB_TRACE_CONTEXT_H
#define MCPB_TRACE_CONTEXT_H

/* W3C Trace Context helpers. C99, fixed-size, no allocation. */

#include "mcpb.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MCPB_TRACE_ID_SIZE 16u
#define MCPB_SPAN_ID_SIZE 8u
#define MCPB_TRACEPARENT_TEXT_SIZE 55u
#define MCPB_TRACEPARENT_BUFFER_SIZE 56u

typedef struct
{
    uint8_t trace_id[MCPB_TRACE_ID_SIZE];
    uint8_t parent_id[MCPB_SPAN_ID_SIZE];
    uint8_t trace_flags;
} mcpb_trace_context_t;

/* Parses the strict W3C version 00 form: 00-<trace-id>-<parent-id>-<flags>. */
MCPB_API int mcpb_traceparent_parse(const char *text, size_t length,
                                    mcpb_trace_context_t *context);

/* Writes 55 lowercase ASCII characters plus a trailing NUL. */
MCPB_API int mcpb_traceparent_format(const mcpb_trace_context_t *context,
                                     char *out, size_t capacity);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_TRACE_CONTEXT_H */
