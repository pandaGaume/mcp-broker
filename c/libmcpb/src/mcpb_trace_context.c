#include "mcpb/mcpb_trace_context.h"

static int hex_value(char value)
{
    if (value >= '0' && value <= '9')
        return value - '0';
    if (value >= 'a' && value <= 'f')
        return value - 'a' + 10;
    return -1;
}

static int parse_bytes(const char *text, size_t count, uint8_t *out,
                       int *non_zero)
{
    size_t index;
    for (index = 0u; index < count; ++index)
    {
        const int high = hex_value(text[index * 2u]);
        const int low = hex_value(text[index * 2u + 1u]);
        if (high < 0 || low < 0)
            return MCPB_ERR_PROTOCOL;
        out[index] = (uint8_t)((unsigned int)high << 4u | (unsigned int)low);
        if (out[index] != 0u)
            *non_zero = 1;
    }
    return MCPB_OK;
}

int mcpb_traceparent_parse(const char *text, size_t length,
                           mcpb_trace_context_t *context)
{
    int trace_non_zero = 0;
    int parent_non_zero = 0;
    int high;
    int low;
    if (text == NULL || context == NULL)
        return MCPB_ERR_ARG;
    if (length != MCPB_TRACEPARENT_TEXT_SIZE || text[0] != '0' ||
        text[1] != '0' || text[2] != '-' || text[35] != '-' ||
        text[52] != '-')
        return MCPB_ERR_PROTOCOL;
    if (parse_bytes(text + 3, MCPB_TRACE_ID_SIZE, context->trace_id,
                    &trace_non_zero) != MCPB_OK ||
        parse_bytes(text + 36, MCPB_SPAN_ID_SIZE, context->parent_id,
                    &parent_non_zero) != MCPB_OK)
        return MCPB_ERR_PROTOCOL;
    high = hex_value(text[53]);
    low = hex_value(text[54]);
    if (high < 0 || low < 0 || !trace_non_zero || !parent_non_zero)
        return MCPB_ERR_PROTOCOL;
    context->trace_flags = (uint8_t)((unsigned int)high << 4u | (unsigned int)low);
    return MCPB_OK;
}

int mcpb_traceparent_format(const mcpb_trace_context_t *context,
                            char *out, size_t capacity)
{
    static const char hex[] = "0123456789abcdef";
    size_t index;
    int trace_non_zero = 0;
    int parent_non_zero = 0;
    if (context == NULL || out == NULL)
        return MCPB_ERR_ARG;
    if (capacity < MCPB_TRACEPARENT_BUFFER_SIZE)
        return MCPB_ERR_TOO_LARGE;
    out[0] = '0';
    out[1] = '0';
    out[2] = '-';
    for (index = 0u; index < MCPB_TRACE_ID_SIZE; ++index)
    {
        const uint8_t value = context->trace_id[index];
        out[3u + index * 2u] = hex[value >> 4u];
        out[4u + index * 2u] = hex[value & 0x0fu];
        if (value != 0u)
            trace_non_zero = 1;
    }
    out[35] = '-';
    for (index = 0u; index < MCPB_SPAN_ID_SIZE; ++index)
    {
        const uint8_t value = context->parent_id[index];
        out[36u + index * 2u] = hex[value >> 4u];
        out[37u + index * 2u] = hex[value & 0x0fu];
        if (value != 0u)
            parent_non_zero = 1;
    }
    if (!trace_non_zero || !parent_non_zero)
        return MCPB_ERR_ARG;
    out[52] = '-';
    out[53] = hex[context->trace_flags >> 4u];
    out[54] = hex[context->trace_flags & 0x0fu];
    out[55] = '\0';
    return (int)MCPB_TRACEPARENT_TEXT_SIZE;
}
