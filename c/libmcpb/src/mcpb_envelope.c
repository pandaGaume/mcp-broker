/* Tunnel envelope codec. See mcpb_envelope.h. */

#include "mcpb/mcpb_envelope.h"

#include <stdio.h>
#include <string.h>

/* --- Writing --------------------------------------------------------------- */

/* Appends `s` to out as a JSON string body (no quotes), escaping what
 * RFC 8259 requires. Returns the new length, or -1 when it does not fit. */
static int _append_escaped(char *out, size_t cap, size_t len, const char *s)
{
    for (; *s != 0; s++)
    {
        const unsigned char c = (unsigned char)*s;
        char buf[8];
        const char *esc = NULL;
        switch (c)
        {
        case '"':  esc = "\\\""; break;
        case '\\': esc = "\\\\"; break;
        case '\n': esc = "\\n";  break;
        case '\r': esc = "\\r";  break;
        case '\t': esc = "\\t";  break;
        case '\b': esc = "\\b";  break;
        case '\f': esc = "\\f";  break;
        default:
            if (c < 0x20u)
            {
                snprintf(buf, sizeof(buf), "\\u%04x", (unsigned)c);
                esc = buf;
            }
        }
        const size_t n = esc ? strlen(esc) : 1u;
        if (len + n + 1u > cap)
            return -1;
        if (esc)
            memcpy(out + len, esc, n);
        else
            out[len] = (char)c;
        len += n;
    }
    return (int)len;
}

static int _append(char *out, size_t cap, size_t len, const char *s, size_t n)
{
    if (len + n + 1u > cap)
        return -1;
    memcpy(out + len, s, n);
    return (int)(len + n);
}

int mcpb_envelope_encode(const char *provider, const char *payload,
                         size_t payload_len, char *out, size_t cap)
{
    if (provider == NULL || payload == NULL || out == NULL || cap == 0)
        return MCPB_ERR_ARG;
    int n = _append(out, cap, 0, "{\"provider\":\"", 13);
    if (n >= 0) n = _append_escaped(out, cap, (size_t)n, provider);
    if (n >= 0) n = _append(out, cap, (size_t)n, "\",\"payload\":", 12);
    if (n >= 0) n = _append(out, cap, (size_t)n, payload, payload_len);
    if (n >= 0) n = _append(out, cap, (size_t)n, "}", 1);
    if (n < 0)
        return MCPB_ERR_TOO_LARGE;
    out[n] = 0;
    return n;
}

int mcpb_envelope_register(const char *provider, int aggregate,
                           char *out, size_t cap)
{
    const char *body = aggregate
        ? "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/register\",\"params\":{\"aggregate\":true}}"
        : "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/register\"}";
    return mcpb_envelope_encode(provider, body, strlen(body), out, cap);
}

/* --- Reading --------------------------------------------------------------- */

typedef struct
{
    const char *p;
    const char *end;
} cursor_t;

static void _ws(cursor_t *c)
{
    while (c->p < c->end && (*c->p == ' ' || *c->p == '\t' || *c->p == '\r' || *c->p == '\n'))
        c->p++;
}

/* Skips a string starting at the opening quote; leaves p after the closing
 * quote. Returns 0 when the string is unterminated. */
static int _skip_string(cursor_t *c)
{
    if (c->p >= c->end || *c->p != '"')
        return 0;
    c->p++;
    while (c->p < c->end)
    {
        const char ch = *c->p++;
        if (ch == '\\')
        {
            if (c->p >= c->end) return 0;
            c->p++; /* whatever follows a backslash is part of the string */
        }
        else if (ch == '"')
        {
            return 1;
        }
    }
    return 0;
}

/* Skips one JSON value of any kind; leaves p just after it. Nesting is
 * tracked by a counter, which is all a balanced scan needs. */
static int _skip_value(cursor_t *c)
{
    _ws(c);
    if (c->p >= c->end)
        return 0;
    if (*c->p == '"')
        return _skip_string(c);
    if (*c->p == '{' || *c->p == '[')
    {
        int depth = 0;
        while (c->p < c->end)
        {
            const char ch = *c->p;
            if (ch == '"')
            {
                if (!_skip_string(c)) return 0;
                continue;
            }
            c->p++;
            if (ch == '{' || ch == '[') depth++;
            else if (ch == '}' || ch == ']')
            {
                depth--;
                if (depth == 0) return 1;
            }
        }
        return 0;
    }
    /* number, true, false, null: runs to a delimiter */
    while (c->p < c->end && *c->p != ',' && *c->p != '}' && *c->p != ']' &&
           *c->p != ' ' && *c->p != '\t' && *c->p != '\r' && *c->p != '\n')
        c->p++;
    return 1;
}

/* Walks the members of the object at the cursor and reports each one to
 * `visit` as (key, key_len, value, value_len). The key is the raw string
 * content; the value is the raw JSON value. Returns 0 on malformed input. */
static int _each_member(cursor_t *c,
                        void (*visit)(void *user, const char *key, size_t klen,
                                      const char *val, size_t vlen),
                        void *user)
{
    _ws(c);
    if (c->p >= c->end || *c->p != '{')
        return 0;
    c->p++;
    for (;;)
    {
        _ws(c);
        if (c->p >= c->end) return 0;
        if (*c->p == '}') { c->p++; return 1; }

        const char *key = c->p + 1;
        if (!_skip_string(c)) return 0;
        const size_t klen = (size_t)(c->p - 1 - key);

        _ws(c);
        if (c->p >= c->end || *c->p != ':') return 0;
        c->p++;
        _ws(c);
        const char *val = c->p;
        if (!_skip_value(c)) return 0;
        visit(user, key, klen, val, (size_t)(c->p - val));

        _ws(c);
        if (c->p >= c->end) return 0;
        if (*c->p == ',') { c->p++; continue; }
        if (*c->p == '}') { c->p++; return 1; }
        return 0;
    }
}

static int _key_is(const char *key, size_t klen, const char *name)
{
    return klen == strlen(name) && memcmp(key, name, klen) == 0;
}

typedef struct
{
    const char *provider; size_t provider_len; int provider_seen;
    const char *payload;  size_t payload_len;  int payload_seen;
} envelope_scan_t;

static void _envelope_visit(void *user, const char *key, size_t klen,
                            const char *val, size_t vlen)
{
    envelope_scan_t *e = (envelope_scan_t *)user;
    if (_key_is(key, klen, "provider") && vlen >= 2u && val[0] == '"')
    {
        e->provider = val + 1;
        e->provider_len = vlen - 2u;
        e->provider_seen = 1;
    }
    else if (_key_is(key, klen, "payload"))
    {
        e->payload = val;
        e->payload_len = vlen;
        e->payload_seen = 1;
    }
}

int mcpb_envelope_decode(const char *frame, size_t len,
                         const char **provider, size_t *provider_len,
                         const char **payload, size_t *payload_len)
{
    if (frame == NULL || provider == NULL || provider_len == NULL ||
        payload == NULL || payload_len == NULL)
        return MCPB_ERR_ARG;

    envelope_scan_t e;
    memset(&e, 0, sizeof(e));
    cursor_t c = { frame, frame + len };
    if (!_each_member(&c, _envelope_visit, &e))
        return MCPB_ERR_PROTOCOL;
    _ws(&c);
    if (c.p != c.end)
        return MCPB_ERR_PROTOCOL; /* trailing bytes: not one envelope */
    if (!e.provider_seen || e.provider_len == 0 || !e.payload_seen)
        return MCPB_ERR_PROTOCOL;

    *provider = e.provider;
    *provider_len = e.provider_len;
    *payload = e.payload;
    *payload_len = e.payload_len;
    return MCPB_OK;
}

typedef struct
{
    int id_null;
    const char *error; size_t error_len;
} error_scan_t;

static void _error_visit(void *user, const char *key, size_t klen,
                         const char *val, size_t vlen)
{
    error_scan_t *e = (error_scan_t *)user;
    if (_key_is(key, klen, "id") && vlen == 4u && memcmp(val, "null", 4) == 0)
        e->id_null = 1;
    else if (_key_is(key, klen, "error") && vlen >= 2u && val[0] == '{')
    {
        e->error = val;
        e->error_len = vlen;
    }
}

typedef struct
{
    int code; int code_seen;
    const char *message; size_t message_len;
} code_scan_t;

static void _code_visit(void *user, const char *key, size_t klen,
                        const char *val, size_t vlen)
{
    code_scan_t *e = (code_scan_t *)user;
    if (_key_is(key, klen, "code"))
    {
        int sign = 1, v = 0; size_t i = 0;
        if (vlen > 0 && val[0] == '-') { sign = -1; i = 1; }
        for (; i < vlen && val[i] >= '0' && val[i] <= '9'; i++)
            v = v * 10 + (val[i] - '0');
        e->code = sign * v;
        e->code_seen = 1;
    }
    else if (_key_is(key, klen, "message") && vlen >= 2u && val[0] == '"')
    {
        e->message = val + 1;
        e->message_len = vlen - 2u;
    }
}

int mcpb_envelope_tunnel_error(const char *payload, size_t len, int *code,
                               const char **message, size_t *message_len)
{
    if (payload == NULL || code == NULL || message == NULL || message_len == NULL)
        return 0;
    error_scan_t e;
    memset(&e, 0, sizeof(e));
    cursor_t c = { payload, payload + len };
    if (!_each_member(&c, _error_visit, &e) || !e.id_null || e.error == NULL)
        return 0;

    code_scan_t k;
    memset(&k, 0, sizeof(k));
    cursor_t ce = { e.error, e.error + e.error_len };
    if (!_each_member(&ce, _code_visit, &k) || !k.code_seen)
        return 0;
    *code = k.code;
    *message = k.message ? k.message : "";
    *message_len = k.message_len;
    return 1;
}

int mcpb_envelope_name_equals(const char *raw, size_t raw_len, const char *name)
{
    size_t i = 0;
    while (i < raw_len && *name != 0)
    {
        char ch = raw[i++];
        if (ch == '\\' && i < raw_len)
        {
            const char e = raw[i++];
            switch (e)
            {
            case 'n': ch = '\n'; break;
            case 'r': ch = '\r'; break;
            case 't': ch = '\t'; break;
            case 'b': ch = '\b'; break;
            case 'f': ch = '\f'; break;
            case 'u':
                /* Only the ASCII range is decoded; a name that needs more
                 * than that on the multiplexed path is not one this
                 * comparison supports, and reports unequal. */
                if (i + 4u > raw_len) return 0;
                {
                    unsigned v = 0; size_t k;
                    for (k = 0; k < 4u; k++)
                    {
                        const char h = raw[i + k];
                        v <<= 4;
                        if (h >= '0' && h <= '9') v |= (unsigned)(h - '0');
                        else if (h >= 'a' && h <= 'f') v |= (unsigned)(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') v |= (unsigned)(h - 'A' + 10);
                        else return 0;
                    }
                    if (v > 0x7Fu) return 0;
                    ch = (char)v;
                    i += 4u;
                }
                break;
            default: ch = e; break; /* \" \\ \/ */
            }
        }
        if (ch != *name++)
            return 0;
    }
    return i == raw_len && *name == 0;
}
