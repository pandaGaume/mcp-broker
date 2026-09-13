/* Base64, error strings, port validation, URL encoding. */

#include "mcpb/mcpb.h"
#include "mcpb/mcpb_port.h"
#include "mcpb/mcpb_provider.h"
#include "mcpb_internal.h"

#include <string.h>

static const char B64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int mcpb_base64_encode(const uint8_t *in, size_t len, char *out, size_t cap)
{
    if (in == NULL || out == NULL)
        return MCPB_ERR_ARG;

    const size_t need = ((len + 2u) / 3u) * 4u;
    if (cap < need + 1u)
        return MCPB_ERR_TOO_LARGE;

    size_t i = 0, o = 0;
    while (i + 3u <= len)
    {
        const uint32_t v = ((uint32_t)in[i] << 16) |
                           ((uint32_t)in[i + 1] << 8) | in[i + 2];
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = B64[(v >> 6) & 63];
        out[o++] = B64[v & 63];
        i += 3u;
    }

    const size_t rem = len - i;
    if (rem == 1u)
    {
        const uint32_t v = (uint32_t)in[i] << 16;
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = '=';
        out[o++] = '=';
    }
    else if (rem == 2u)
    {
        const uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i + 1] << 8);
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = B64[(v >> 6) & 63];
        out[o++] = '=';
    }

    out[o] = '\0';
    return (int)o;
}

const char *mcpb_strerror(int err)
{
    switch (err)
    {
    case MCPB_OK:              return "ok";
    case MCPB_ERR_ARG:         return "invalid argument";
    case MCPB_ERR_TIMEOUT:     return "timed out";
    case MCPB_ERR_CLOSED:      return "peer closed the connection";
    case MCPB_ERR_IO:          return "transport failure";
    case MCPB_ERR_PROTOCOL:    return "protocol violation";
    case MCPB_ERR_TOO_LARGE:   return "message larger than the buffer";
    case MCPB_ERR_HANDSHAKE:   return "handshake refused";
    case MCPB_ERR_STATE:       return "call not valid in this state";
    case MCPB_ERR_UNSUPPORTED: return "unsupported";
    case MCPB_ERR_TLS:         return "TLS handshake or certificate refused";
    default:                   return "unknown error";
    }
}

int mcpb_port_check(const mcpb_port_t *port)
{
    /* Each field separately: an incomplete port would otherwise show up as
     * a jump to address zero, far from here. */
    if (port == NULL)          return MCPB_ERR_ARG;
    if (port->open == NULL)    return MCPB_ERR_ARG;
    if (port->send == NULL)    return MCPB_ERR_ARG;
    if (port->recv == NULL)    return MCPB_ERR_ARG;
    if (port->close == NULL)   return MCPB_ERR_ARG;
    if (port->now_ms == NULL)  return MCPB_ERR_ARG;
    if (port->random == NULL)  return MCPB_ERR_ARG;
    return MCPB_OK;
}

/* RFC 3986 section 2.3 unreserved characters; everything else is encoded.
 *
 * Deliberately strict: a browser would leave ':' alone in a path segment, but
 * a qualified name like "MAC:ACA70405A4EC" then crosses routers, logs and
 * file systems that share no common table. Over-encoding always decodes
 * correctly; under-encoding depends on the laxest link in the chain. */
static int _unreserved(char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
           (c >= '0' && c <= '9') ||
           c == '-' || c == '_' || c == '.' || c == '~';
}

int mcpb_url_encode(const char *in, char *out, size_t cap)
{
    static const char HEX[] = "0123456789ABCDEF";
    if (in == NULL || out == NULL || cap == 0)
        return MCPB_ERR_ARG;

    size_t o = 0;
    for (; *in != '\0'; in++)
    {
        const unsigned char c = (unsigned char)*in;
        if (_unreserved((char)c))
        {
            if (o + 2u > cap) return MCPB_ERR_TOO_LARGE;
            out[o++] = (char)c;
        }
        else
        {
            if (o + 4u > cap) return MCPB_ERR_TOO_LARGE;
            out[o++] = '%';
            out[o++] = HEX[(c >> 4) & 15];
            out[o++] = HEX[c & 15];
        }
    }
    out[o] = '\0';
    return (int)o;
}
