#include "mcpb/mcpb_telemetry.h"

#include <string.h>

static const char prefix[] =
    "{\"jsonrpc\":\"2.0\",\"method\":\"broker/telemetry\","
    "\"params\":{\"version\":1,\"signal\":\"traces\",\"span\":";
static const char suffix[] = "}}";

int mcpb_telemetry_encode(const char *span_json, size_t span_len,
                          char *out, size_t cap)
{
    const size_t prefix_len = sizeof(prefix) - 1u;
    const size_t suffix_len = sizeof(suffix) - 1u;
    size_t begin = 0u;
    size_t end = span_len;

    if (span_json == NULL || out == NULL || cap == 0u)
        return MCPB_ERR_ARG;

    while (begin < end && (span_json[begin] == ' ' || span_json[begin] == '\t' ||
                           span_json[begin] == '\r' || span_json[begin] == '\n'))
        begin++;
    while (end > begin && (span_json[end - 1u] == ' ' || span_json[end - 1u] == '\t' ||
                           span_json[end - 1u] == '\r' || span_json[end - 1u] == '\n'))
        end--;
    if (end <= begin || span_json[begin] != '{' || span_json[end - 1u] != '}')
        return MCPB_ERR_ARG;

    if (span_len > ((size_t)-1) - prefix_len - suffix_len - 1u)
        return MCPB_ERR_TOO_LARGE;
    if (prefix_len + span_len + suffix_len + 1u > cap)
        return MCPB_ERR_TOO_LARGE;

    memcpy(out, prefix, prefix_len);
    memcpy(out + prefix_len, span_json, span_len);
    memcpy(out + prefix_len + span_len, suffix, suffix_len);
    out[prefix_len + span_len + suffix_len] = 0;
    return (int)(prefix_len + span_len + suffix_len);
}

