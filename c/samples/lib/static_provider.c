/* The MCP surface the transport samples serve. See static_provider.h. */

#include "static_provider.h"

#include <stdio.h>
#include <string.h>

/* --- Just enough scanning for the broker's frames -------------------------- */

/* Copies the value of the first `"key":"..."` after `from` into `out`.
 * Returns the length, or -1 when absent. No escape handling beyond skipping
 * a backslashed quote: enough for a method name or a protocol version. */
static int scan_string(const char *from, const char *end, const char *key,
                       char *out, size_t cap)
{
    const size_t klen = strlen(key);
    const char *p = from;
    while (p + klen + 3 < end)
    {
        if (p[0] == '"' && memcmp(p + 1, key, klen) == 0 && p[klen + 1] == '"')
        {
            const char *v = p + klen + 2;
            while (v < end && (*v == ' ' || *v == ':')) v++;
            if (v >= end || *v != '"') return -1;
            v++;
            size_t n = 0;
            while (v < end && *v != '"' && n + 1 < cap)
            {
                if (*v == '\\' && v + 1 < end) v++;
                out[n++] = *v++;
            }
            out[n] = 0;
            return (int)n;
        }
        p++;
    }
    return -1;
}

/* Copies the raw token after `"id":` into `out`: a quoted string with its
 * quotes, a number, or null. That raw form is what goes back in the reply,
 * untouched. Returns -1 for a notification (no id). */
static int scan_id(const char *json, const char *end, char *out, size_t cap)
{
    const char *p = json;
    while (p + 5 < end)
    {
        if (memcmp(p, "\"id\"", 4) == 0)
        {
            const char *v = p + 4;
            while (v < end && (*v == ' ' || *v == ':')) v++;
            size_t n = 0;
            if (v < end && *v == '"')
            {
                out[n++] = *v++;
                while (v < end && n + 2 < cap)
                {
                    const char c = *v++;
                    out[n++] = c;
                    if (c == '\\' && v < end) out[n++] = *v++;
                    else if (c == '"') break;
                }
            }
            else
            {
                while (v < end && n + 1 < cap && *v != ',' && *v != '}' &&
                       *v != ' ' && *v != '\r' && *v != '\n')
                    out[n++] = *v++;
            }
            out[n] = 0;
            return (int)n;
        }
        p++;
    }
    return -1;
}

/* Appends `s` to `out` as a JSON string body, escaping what RFC 8259
 * requires. Returns the new length, or -1 when it does not fit. */
static int json_escape_append(char *out, size_t cap, size_t len, const char *s)
{
    for (; *s != 0; s++)
    {
        const unsigned char c = (unsigned char)*s;
        const char *esc = NULL;
        char buf[8];
        switch (c)
        {
        case '"':  esc = "\\\""; break;
        case '\\': esc = "\\\\"; break;
        case '\n': esc = "\\n";  break;
        case '\r': esc = "\\r";  break;
        case '\t': esc = "\\t";  break;
        default:
            if (c < 0x20)
            {
                snprintf(buf, sizeof(buf), "\\u%04x", (unsigned)c);
                esc = buf;
            }
        }
        const size_t n = esc ? strlen(esc) : 1u;
        if (len + n + 1 > cap) return -1;
        if (esc) memcpy(out + len, esc, n); else out[len] = (char)c;
        len += n;
    }
    out[len] = 0;
    return (int)len;
}

/* --- The MCP surface, static ------------------------------------------------ */

static const char *TOOLS_LIST =
    "{\"tools\":[{\"name\":\"echo\","
    "\"description\":\"Returns the text it was given, prefixed with the slot name. "
    "Proves the tunnel end to end: client, broker, this device, and back.\","
    "\"inputSchema\":{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},"
    "\"required\":[\"text\"]}}]}";

void static_provider_method(const char *json, size_t len, char *out, size_t cap)
{
    if (scan_string(json, json + len, "method", out, cap) < 0)
        snprintf(out, cap, "(response)");
}

int static_provider_handle(const char *name, const char *json, size_t len,
                           char *tx, size_t cap)
{
    const char *end = json + len;
    char id[128], method[64];

    if (scan_id(json, end, id, sizeof(id)) < 0)
        return 0; /* notification: nothing to answer */
    if (scan_string(json, end, "method", method, sizeof(method)) < 0)
        return 0; /* a response to something we never sent */

    int n;
    if (strcmp(method, "initialize") == 0)
    {
        /* Answer with the version the client asked for. A server that
         * insists on its own makes every client renegotiate for nothing. */
        char version[32];
        if (scan_string(json, end, "protocolVersion", version, sizeof(version)) < 0)
            strcpy(version, "2025-06-18");
        n = snprintf(tx, cap,
                     "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{"
                     "\"protocolVersion\":\"%s\",\"capabilities\":{\"tools\":{}},"
                     "\"serverInfo\":{\"name\":\"%s\",\"version\":\"" MCPB_VERSION_STRING "\"}}}",
                     id, version, name);
    }
    else if (strcmp(method, "ping") == 0)
    {
        n = snprintf(tx, cap, "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{}}", id);
    }
    else if (strcmp(method, "tools/list") == 0)
    {
        n = snprintf(tx, cap, "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":%s}", id, TOOLS_LIST);
    }
    else if (strcmp(method, "tools/call") == 0)
    {
        char tool[64], text[1024];
        const char *params = strstr(json, "\"params\"");
        if (params == NULL || scan_string(params, end, "name", tool, sizeof(tool)) < 0 ||
            strcmp(tool, "echo") != 0)
        {
            n = snprintf(tx, cap,
                         "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"content\":[{\"type\":\"text\","
                         "\"text\":\"unknown tool; this provider serves echo only\"}],\"isError\":true}}",
                         id);
        }
        else
        {
            if (scan_string(params, end, "text", text, sizeof(text)) < 0)
                text[0] = 0;
            n = snprintf(tx, cap,
                         "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"",
                         id);
            if (n < 0 || (size_t)n >= cap) return -1;
            n = json_escape_append(tx, cap, (size_t)n, name);
            if (n < 0) return -1;
            n = json_escape_append(tx, cap, (size_t)n, ": ");
            if (n < 0) return -1;
            n = json_escape_append(tx, cap, (size_t)n, text);
            if (n < 0) return -1;
            const char *tail = "\"}]}}";
            if ((size_t)n + strlen(tail) + 1 > cap) return -1;
            strcpy(tx + n, tail);
            n += (int)strlen(tail);
        }
    }
    else
    {
        n = snprintf(tx, cap,
                     "{\"jsonrpc\":\"2.0\",\"id\":%s,\"error\":{\"code\":-32601,"
                     "\"message\":\"Method not found: %s\"}}",
                     id, method);
    }

    if (n < 0 || (size_t)n >= cap)
        return -1;
    return n;
}

int static_provider_event_line(const mcpb_event_t *e, unsigned long connects,
                               char *out, size_t cap)
{
    int n = 0;
    switch (e->type)
    {
    case MCPB_EVENT_CONNECTED:
        n = snprintf(out, cap, "event CONNECTED down_ms=%lu connects=%lu",
                     (unsigned long)e->down_ms, connects);
        break;
    case MCPB_EVENT_DISCONNECTED:
        n = snprintf(out, cap,
                     "event DISCONNECTED error=\"%s\" code=%u reason=\"%s\" detail=\"%s\" next_retry_ms=%lu",
                     mcpb_strerror(e->error), (unsigned)e->close_code, e->reason,
                     e->detail, (unsigned long)e->next_retry_ms);
        break;
    case MCPB_EVENT_RETRY_FAILED:
        n = snprintf(out, cap,
                     "event RETRY_FAILED error=\"%s\" http_status=%d detail=\"%s\" attempts=%lu next_retry_ms=%lu",
                     mcpb_strerror(e->error), e->http_status, e->detail,
                     (unsigned long)e->attempts, (unsigned long)e->next_retry_ms);
        break;
    case MCPB_EVENT_SLOT_REFUSED:
        n = snprintf(out, cap,
                     "event SLOT_REFUSED slot=%lu code=%d reason=\"%s\"",
                     (unsigned long)e->slot, e->rpc_code, e->reason);
        break;
    }
    if (n < 0) { out[0] = 0; return 0; }
    if ((size_t)n >= cap) n = (int)cap - 1;
    return n;
}
