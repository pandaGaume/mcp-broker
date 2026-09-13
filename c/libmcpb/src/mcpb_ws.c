/* RFC 6455 WebSocket client. See mcpb_ws.h for what is deliberately absent. */

#include "mcpb/mcpb_ws.h"
#include "mcpb_internal.h"

#include <stdio.h>
#include <string.h>

/* Public constant, RFC 6455 section 1.3. */
#define WS_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

#define OP_CONT  0x0
#define OP_TEXT  0x1
#define OP_BIN   0x2
#define OP_CLOSE 0x8
#define OP_PING  0x9
#define OP_PONG  0xA

/* A control frame carries at most 125 bytes (RFC 6455 5.5). */
#define CTRL_MAX 125

/* --- Deadlines -------------------------------------------------------------
 *
 * One message can take several reads, so the deadline is global rather than
 * per read. Passing the same timeout to each call would let a fragmented
 * message take as many timeouts as it has pieces. */
typedef struct
{
    int      infinite;
    uint32_t at;
} deadline_t;

static deadline_t _deadline(const mcpb_ws_t *ws, int timeout_ms)
{
    deadline_t d;
    d.infinite = (timeout_ms < 0);
    d.at = d.infinite ? 0u
                      : ws->port->now_ms(ws->port->ctx) + (uint32_t)timeout_ms;
    return d;
}

static int _remaining(const mcpb_ws_t *ws, const deadline_t *d)
{
    if (d->infinite)
        return -1;
    /* Signed difference, so it survives counter wraparound. */
    const int32_t left = (int32_t)(d->at - ws->port->now_ms(ws->port->ctx));
    return (left > 0) ? (int)left : 0;
}

/* --- Refusals -------------------------------------------------------------- */

/* Records why the library refused, then returns the code. The header bytes
 * are what an operator needs to tell a real violation from a desynchronised
 * stream: garbage in both looks the same from "protocol violation". */
static int _refuse(mcpb_ws_t *ws, int code, const char *why,
                   const uint8_t *header)
{
    if (header != NULL)
        snprintf(ws->detail, sizeof(ws->detail), "%s, header %02X %02X",
                 why, header[0], header[1]);
    else
        snprintf(ws->detail, sizeof(ws->detail), "%s", why);
    return code;
}

/* --- Transport ------------------------------------------------------------ */

static int _send_all(mcpb_ws_t *ws, const uint8_t *buf, size_t len)
{
    const int n = ws->port->send(ws->port->ctx, buf, len, -1);
    if (n < 0)
        return n;
    /* The port promises all-or-fail (mcpb_port.h). If it breaks that, say so
     * rather than let the stream desynchronise unwitnessed. */
    return ((size_t)n == len) ? MCPB_OK : MCPB_ERR_IO;
}

/* Reads into buf until *got reaches want, or the deadline passes. On a
 * timeout *got keeps the progress so the caller can come back for the rest:
 * that is the whole difference with _recv_exact, and the reason a frame can
 * straddle several polls without the stream losing its framing. */
static int _recv_more(mcpb_ws_t *ws, uint8_t *buf, size_t want, size_t *got,
                      const deadline_t *d)
{
    while (*got < want)
    {
        const int left = _remaining(ws, d);
        if (left == 0 && !d->infinite)
            return MCPB_ERR_TIMEOUT;
        const int n = ws->port->recv(ws->port->ctx, buf + *got, want - *got, left);
        if (n < 0)
            return n;
        *got += (size_t)n;
    }
    return MCPB_OK;
}

static int _recv_exact(mcpb_ws_t *ws, uint8_t *buf, size_t len,
                       const deadline_t *d)
{
    size_t got = 0;
    while (got < len)
    {
        const int left = _remaining(ws, d);
        if (left == 0 && !d->infinite)
            return MCPB_ERR_TIMEOUT;
        const int n = ws->port->recv(ws->port->ctx, buf + got, len - got, left);
        if (n < 0)
            return n;
        got += (size_t)n;
    }
    return MCPB_OK;
}

/* --- Handshake ------------------------------------------------------------ */

static int _expected_accept(const char *key, char *out, size_t cap)
{
    char joined[64];
    const size_t klen = strlen(key);
    if (klen + sizeof(WS_GUID) > sizeof(joined))
        return MCPB_ERR_TOO_LARGE;
    memcpy(joined, key, klen);
    memcpy(joined + klen, WS_GUID, sizeof(WS_GUID)); /* NUL copied, not hashed */

    uint8_t digest[MCPB_SHA1_SIZE];
    mcpb_sha1((const uint8_t *)joined, klen + sizeof(WS_GUID) - 1u, digest);
    return mcpb_base64_encode(digest, sizeof(digest), out, cap);
}

/* Reads the opening response one byte at a time, up to the blank line.
 *
 * One byte at a time, not in blocks: stopping exactly on the terminator
 * guarantees no byte of the first frame is swallowed. Block reads would have
 * to keep the surplus and hand it back to the codec, which is the classic
 * source of the lost first message. */
static int _read_headers(mcpb_ws_t *ws, char *buf, size_t cap,
                         const deadline_t *d)
{
    size_t n = 0;
    int matched = 0;
    while (n + 1u < cap)
    {
        const int r = _recv_exact(ws, (uint8_t *)buf + n, 1u, d);
        if (r < 0)
            return r;
        const char c = buf[n++];
        const char want = "\r\n\r\n"[matched];
        matched = (c == want) ? matched + 1 : ((c == '\r') ? 1 : 0);
        if (matched == 4)
        {
            buf[n] = '\0';
            return (int)n;
        }
    }
    return MCPB_ERR_TOO_LARGE;
}

/* Case-insensitive: RFC 9110 requires it, and proxies rewrite header names in
 * passing. */
static const char *_header(const char *headers, const char *name,
                           size_t *out_len)
{
    const size_t nlen = strlen(name);
    const char *p = headers;
    while (*p != '\0')
    {
        size_t i = 0;
        while (i < nlen && p[i] != '\0')
        {
            char a = p[i], b = name[i];
            if (a >= 'A' && a <= 'Z') a = (char)(a + 32);
            if (b >= 'A' && b <= 'Z') b = (char)(b + 32);
            if (a != b) break;
            i++;
        }
        if (i == nlen && p[i] == ':')
        {
            const char *v = p + nlen + 1;
            while (*v == ' ' || *v == '\t') v++;
            const char *e = v;
            while (*e != '\0' && *e != '\r' && *e != '\n') e++;
            *out_len = (size_t)(e - v);
            return v;
        }
        while (*p != '\0' && *p != '\n') p++;
        if (*p == '\n') p++;
    }
    return NULL;
}

int mcpb_ws_open(mcpb_ws_t *ws, const mcpb_port_t *port,
                 const mcpb_ws_config_t *cfg)
{
    if (ws == NULL || cfg == NULL || cfg->host == NULL || cfg->path == NULL)
        return MCPB_ERR_ARG;
    if (cfg->rx_buffer == NULL || cfg->rx_capacity < 256u)
        return MCPB_ERR_ARG;
    const int pc = mcpb_port_check(port);
    if (pc != MCPB_OK)
        return pc;

    memset(ws, 0, sizeof(*ws));
    ws->port = port;
    ws->rx = cfg->rx_buffer;
    ws->rx_cap = cfg->rx_capacity;
    ws->state = MCPB_WS_CLOSED;

    const uint16_t tcp_port = (cfg->port != 0) ? cfg->port
                                               : (cfg->tls ? 443u : 80u);
    int rc = port->open(port->ctx, cfg->host, tcp_port, cfg->tls,
                        (cfg->connect_timeout_ms > 0) ? cfg->connect_timeout_ms
                                                      : 10000);
    if (rc != MCPB_OK)
        return rc;

    /* Opening key: sixteen unpredictable bytes, base64-encoded. */
    uint8_t nonce[16];
    rc = port->random(port->ctx, nonce, sizeof(nonce));
    if (rc != MCPB_OK)
        goto fail;

    char key[32];
    if (mcpb_base64_encode(nonce, sizeof(nonce), key, sizeof(key)) < 0)
    {
        rc = MCPB_ERR_IO;
        goto fail;
    }

    /* The request goes in the receive buffer, idle until the handshake ends.
     * A non-allocating library has no buffer of its own. */
    char *req = (char *)ws->rx;
    const int want = snprintf(
        req, ws->rx_cap,
        "GET %s HTTP/1.1\r\n"
        "Host: %s:%u\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "User-Agent: libmcpb/" MCPB_VERSION_STRING "\r\n"
        "%s"
        "\r\n",
        cfg->path, cfg->host, (unsigned)tcp_port, key,
        (cfg->extra_headers != NULL) ? cfg->extra_headers : "");
    if (want < 0 || (size_t)want >= ws->rx_cap)
    {
        rc = MCPB_ERR_TOO_LARGE;
        goto fail;
    }

    rc = _send_all(ws, (const uint8_t *)req, (size_t)want);
    if (rc != MCPB_OK)
        goto fail;

    const deadline_t d = _deadline(ws, (cfg->handshake_timeout_ms > 0)
                                           ? cfg->handshake_timeout_ms
                                           : 5000);
    const int hlen = _read_headers(ws, req, ws->rx_cap, &d);
    if (hlen < 0)
    {
        rc = hlen;
        goto fail;
    }

    /* The status is kept whatever it is: on a refusal it is the only
     * diagnosis the caller gets, since the body is never read. */
    if (strncmp(req, "HTTP/1.", 7) == 0 && req[8] == ' ')
    {
        int i;
        for (i = 9; i < 12 && req[i] >= '0' && req[i] <= '9'; i++)
            ws->http_status = ws->http_status * 10 + (req[i] - '0');
    }

    /* 101 is the only success; anything else, redirects included, is a
     * refusal. Following one would silently dial a different host from the
     * one that was logged. */
    if (ws->http_status != 101)
    {
        char why[24];
        snprintf(why, sizeof(why), "HTTP %d", ws->http_status);
        rc = _refuse(ws, MCPB_ERR_HANDSHAKE, why, NULL);
        goto fail;
    }

    /* An extension we cannot undo would hand us compressed bytes presented as
     * JSON. */
    size_t vlen = 0;
    if (_header(req, "sec-websocket-extensions", &vlen) != NULL && vlen > 0)
    {
        rc = _refuse(ws, MCPB_ERR_UNSUPPORTED, "extension imposed by the server", NULL);
        goto fail;
    }

    const char *acc = _header(req, "sec-websocket-accept", &vlen);
    if (acc == NULL)
    {
        rc = _refuse(ws, MCPB_ERR_HANDSHAKE, "no Sec-WebSocket-Accept", NULL);
        goto fail;
    }

    char expect[32];
    const int elen = _expected_accept(key, expect, sizeof(expect));
    if (elen < 0 || (size_t)elen != vlen || memcmp(acc, expect, vlen) != 0)
    {
        /* What this catches is not an adversary but a proxy or captive portal
         * answering 101 without being a WebSocket endpoint. Without it the
         * failure surfaces much later, as unreadable frames. */
        rc = _refuse(ws, MCPB_ERR_HANDSHAKE, "Sec-WebSocket-Accept mismatch", NULL);
        goto fail;
    }

    ws->rx_len = 0;
    ws->rx_in_fragment = 0;
    ws->state = MCPB_WS_OPEN;
    return MCPB_OK;

fail:
    port->close(port->ctx);
    ws->state = MCPB_WS_CLOSED;
    return rc;
}

/* --- Sending -------------------------------------------------------------- */

static int _send_frame(mcpb_ws_t *ws, uint8_t opcode,
                       const uint8_t *payload, size_t len)
{
    uint8_t hdr[14];
    size_t h = 0;

    hdr[h++] = (uint8_t)(0x80u | opcode); /* FIN, no fragmentation */

    /* The mask bit is always set: a server must close the connection on an
     * unmasked client frame (RFC 6455 5.1). */
    if (len < 126u)
    {
        hdr[h++] = (uint8_t)(0x80u | len);
    }
    else if (len <= 0xFFFFu)
    {
        hdr[h++] = 0x80u | 126u;
        hdr[h++] = (uint8_t)(len >> 8);
        hdr[h++] = (uint8_t)len;
    }
    else
    {
        hdr[h++] = 0x80u | 127u;
        int i;
        for (i = 7; i >= 0; i--)
            hdr[h++] = (uint8_t)((uint64_t)len >> (8 * i));
    }

    uint8_t mask[4];
    const int rc = ws->port->random(ws->port->ctx, mask, sizeof(mask));
    if (rc != MCPB_OK)
        return rc;
    memcpy(hdr + h, mask, 4);
    h += 4u;

    int r = _send_all(ws, hdr, h);
    if (r != MCPB_OK)
        return r;

    /* Masked in stack-sized chunks, so the caller's payload is left alone.
     * Masking in place would leave the caller's buffer unreadable after a
     * send, which nothing in the signature suggests. */
    uint8_t chunk[128];
    size_t off = 0;
    while (off < len)
    {
        size_t n = len - off;
        if (n > sizeof(chunk))
            n = sizeof(chunk);
        size_t i;
        for (i = 0; i < n; i++)
            chunk[i] = (uint8_t)(payload[off + i] ^ mask[(off + i) & 3u]);
        r = _send_all(ws, chunk, n);
        if (r != MCPB_OK)
            return r;
        off += n;
    }
    return MCPB_OK;
}

int mcpb_ws_send_text(mcpb_ws_t *ws, const char *data, size_t len)
{
    if (ws == NULL || (data == NULL && len > 0))
        return MCPB_ERR_ARG;
    if (ws->state != MCPB_WS_OPEN)
        return MCPB_ERR_STATE;
    return _send_frame(ws, OP_TEXT, (const uint8_t *)data, len);
}

int mcpb_ws_ping(mcpb_ws_t *ws)
{
    if (ws == NULL)
        return MCPB_ERR_ARG;
    if (ws->state != MCPB_WS_OPEN)
        return MCPB_ERR_STATE;
    return _send_frame(ws, OP_PING, NULL, 0);
}

void mcpb_ws_close(mcpb_ws_t *ws, uint16_t code)
{
    if (ws == NULL || ws->state != MCPB_WS_OPEN)
        return;
    uint8_t body[2];
    body[0] = (uint8_t)(code >> 8);
    body[1] = (uint8_t)code;
    /* Return ignored: we close either way, and a send failure on a dead link
     * teaches nothing. */
    (void)_send_frame(ws, OP_CLOSE, body, sizeof(body));
    ws->port->close(ws->port->ctx);
    ws->state = MCPB_WS_CLOSED;
}

/* --- Receiving ------------------------------------------------------------ */

/* Forgets the frame in progress. Called once a frame is fully consumed, and
 * on every error: after an error the connection is dropped by the caller,
 * and a half-read frame must not survive into the next connection. */
static void _frame_reset(mcpb_ws_t *ws)
{
    ws->in_hdr_len = 0;
    ws->in_hdr_need = 2;
    ws->in_payload = 0;
    ws->in_len = 0;
    ws->in_got = 0;
}

int mcpb_ws_recv_text(mcpb_ws_t *ws, const char **out, size_t *out_len,
                      int timeout_ms)
{
    if (ws == NULL || out == NULL || out_len == NULL)
        return MCPB_ERR_ARG;
    if (ws->state != MCPB_WS_OPEN)
        return MCPB_ERR_STATE;

    const deadline_t d = _deadline(ws, timeout_ms);
    if (ws->in_hdr_need == 0)
        _frame_reset(ws); /* first call on this connection */

    for (;;)
    {
        int rc;

        /* --- Header, possibly across several calls ------------------------ */
        if (!ws->in_payload)
        {
            rc = _recv_more(ws, ws->in_hdr, ws->in_hdr_need, &ws->in_hdr_len, &d);
            if (rc == MCPB_ERR_TIMEOUT)
                return rc; /* progress kept in in_hdr_len */
            if (rc < 0)
            {
                _frame_reset(ws);
                return rc;
            }

            const uint8_t *h2 = ws->in_hdr;
            if (ws->in_hdr_need == 2)
            {
                /* The first two bytes decide whether more header follows.
                 * Validate them now, before asking for more: a wrong header
                 * must be refused as soon as it is seen. */
                if ((h2[0] & 0x70u) != 0)
                {
                    _frame_reset(ws);
                    return _refuse(ws, MCPB_ERR_PROTOCOL, "rsv bits set", h2);
                }
                /* A server never masks (RFC 6455 5.1). */
                if ((h2[1] & 0x80u) != 0)
                {
                    _frame_reset(ws);
                    return _refuse(ws, MCPB_ERR_PROTOCOL, "server frame masked", h2);
                }
                const uint8_t l7 = (uint8_t)(h2[1] & 0x7Fu);
                if (l7 == 126u)
                {
                    ws->in_hdr_need = 4;
                    continue; /* two more bytes of length */
                }
                if (l7 == 127u)
                {
                    ws->in_hdr_need = 10;
                    continue; /* eight more */
                }
                ws->in_len = l7;
            }
            else if (ws->in_hdr_need == 4)
            {
                ws->in_len = ((uint64_t)h2[2] << 8) | h2[3];
            }
            else
            {
                uint64_t len = 0;
                int i;
                for (i = 0; i < 8; i++)
                    len = (len << 8) | h2[2 + i];
                /* Top bit must be zero (RFC 6455 5.2). Without this check a
                 * forged length would overflow the size comparisons below. */
                if (len & 0x8000000000000000ull)
                {
                    _frame_reset(ws);
                    return _refuse(ws, MCPB_ERR_PROTOCOL, "64-bit length top bit set", h2);
                }
                ws->in_len = len;
            }

            /* Header complete: the checks that need the length. */
            const int     fin    = (h2[0] & 0x80u) != 0;
            const uint8_t opcode = (uint8_t)(h2[0] & 0x0Fu);

            if (opcode == OP_PING || opcode == OP_PONG || opcode == OP_CLOSE)
            {
                if (ws->in_len > CTRL_MAX || !fin)
                {
                    const char *why = (ws->in_len > CTRL_MAX) ? "control frame over 125 bytes"
                                                              : "control frame fragmented";
                    _frame_reset(ws);
                    return _refuse(ws, MCPB_ERR_PROTOCOL, why, h2); /* RFC 6455 5.5 */
                }
            }
            else if (opcode == OP_BIN)
            {
                _frame_reset(ws);
                return _refuse(ws, MCPB_ERR_UNSUPPORTED, "binary frame", h2); /* the broker only sends text */
            }
            else if (opcode == OP_TEXT)
            {
                if (ws->rx_in_fragment)
                {
                    _frame_reset(ws);
                    return _refuse(ws, MCPB_ERR_PROTOCOL, "text frame inside a fragmented message", h2);
                }
                ws->rx_len = 0;
            }
            else if (opcode == OP_CONT)
            {
                if (!ws->rx_in_fragment)
                {
                    _frame_reset(ws);
                    return _refuse(ws, MCPB_ERR_PROTOCOL, "continuation with no start", h2);
                }
            }
            else
            {
                _frame_reset(ws);
                return _refuse(ws, MCPB_ERR_PROTOCOL, "reserved opcode", h2);
            }

            if (opcode == OP_TEXT || opcode == OP_CONT)
            {
                /* Refuse outright and drop the connection. Truncating would
                 * yield invalid JSON, and the parser above would report a
                 * syntax error where the real problem is an undersized
                 * buffer. */
                if (ws->rx_len + (size_t)ws->in_len > ws->rx_cap)
                {
                    _frame_reset(ws);
                    mcpb_ws_close(ws, 1009u); /* Message Too Big */
                    return MCPB_ERR_TOO_LARGE;
                }
            }

            ws->in_payload = 1;
            ws->in_got = 0;
        }

        /* --- Payload, possibly across several calls ----------------------- */
        const int     fin    = (ws->in_hdr[0] & 0x80u) != 0;
        const uint8_t opcode = (uint8_t)(ws->in_hdr[0] & 0x0Fu);
        const size_t  len    = (size_t)ws->in_len;

        if (opcode == OP_PING || opcode == OP_PONG || opcode == OP_CLOSE)
        {
            /* Control frames are handled here and never surfaced: they carry
             * nothing for the application, and making every caller answer
             * Pings would drop the link in every project that forgets. */
            rc = _recv_more(ws, ws->in_ctrl, len, &ws->in_got, &d);
            if (rc == MCPB_ERR_TIMEOUT)
                return rc;
            if (rc < 0)
            {
                _frame_reset(ws);
                return rc;
            }
            _frame_reset(ws); /* consumed, whatever happens next */

            if (opcode == OP_PING)
            {
                rc = _send_frame(ws, OP_PONG, ws->in_ctrl, len);
                if (rc != MCPB_OK)
                    return rc;
            }
            else if (opcode == OP_CLOSE)
            {
                ws->close_code = (len >= 2u)
                    ? (uint16_t)(((uint16_t)ws->in_ctrl[0] << 8) | ws->in_ctrl[1])
                    : 1005u; /* no code supplied */
                /* len <= CTRL_MAX was checked above, so the reason always
                 * fits with its terminator. */
                if (len > 2u)
                    memcpy(ws->close_reason, ws->in_ctrl + 2, len - 2u);
                ws->close_reason[(len > 2u) ? len - 2u : 0u] = 0;
                (void)_send_frame(ws, OP_CLOSE, ws->in_ctrl, (len >= 2u) ? 2u : 0u);
                ws->port->close(ws->port->ctx);
                ws->state = MCPB_WS_CLOSED;
                return MCPB_ERR_CLOSED;
            }
            continue; /* Pong: nothing to do, keep waiting */
        }

        /* Text or continuation: straight into the receive buffer, after
         * what earlier fragments left there. */
        rc = _recv_more(ws, ws->rx + ws->rx_len, len, &ws->in_got, &d);
        if (rc == MCPB_ERR_TIMEOUT)
            return rc;
        if (rc < 0)
        {
            _frame_reset(ws);
            return rc;
        }
        ws->rx_len += len;
        _frame_reset(ws);

        if (!fin)
        {
            ws->rx_in_fragment = 1;
            continue; /* wait for the rest, under the same deadline */
        }

        ws->rx_in_fragment = 0;
        *out = (const char *)ws->rx;
        *out_len = ws->rx_len;
        return MCPB_OK;
    }
}
