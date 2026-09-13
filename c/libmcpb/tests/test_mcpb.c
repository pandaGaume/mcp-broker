/* libmcpb bench. No network: the port is filled in by a fake whose incoming
 * bytes we write by hand.
 *
 * That is what makes it testable. A WebSocket client tested against a real
 * server only exercises the nominal path; here we can feed it a frame masked
 * by the server, a reserved bit set or a forged length, and check that it
 * refuses. */

#include "mcpb/mcpb.h"
#include "mcpb/mcpb_port.h"
#include "mcpb/mcpb_provider.h"
#include "mcpb/mcpb_ws.h"
#include "../src/mcpb_internal.h"

#include <stdio.h>
#include <string.h>

static int g_fail = 0;
static void check(int ok, const char *what)
{
    printf("  [%s] %s\n", ok ? "ok" : "FAIL", what);
    if (!ok) g_fail++;
}

/* --- Fake port -------------------------------------------------------------
 *
 * `inbox`  what the "server" will send, byte by byte.
 * `outbox` what the client sent, for inspection.
 * Randomness is deterministic, so outgoing frames are reproducible and can be
 * checked byte by byte. */
typedef struct
{
    unsigned char inbox[4096];
    size_t inbox_len, inbox_pos;
    unsigned char outbox[4096];
    size_t outbox_len;
    uint32_t clock;
    int opened, closed;
    int fail_random;
    /* Zero: deterministic randomness (0xA5 ^ i), which makes the handshake
     * key reproducible. Non-zero: a congruential generator seeded with it, to
     * simulate distinct devices. */
    uint32_t seed;
} fake_t;

static void fake_push(fake_t *f, const void *data, size_t n)
{
    memcpy(f->inbox + f->inbox_len, data, n);
    f->inbox_len += n;
}
static void fake_push_str(fake_t *f, const char *s)
{
    fake_push(f, s, strlen(s));
}

static int f_open(void *ctx, const char *host, uint16_t port, int tls, int t)
{
    (void)host; (void)port; (void)tls; (void)t;
    ((fake_t *)ctx)->opened = 1;
    return MCPB_OK;
}
static int f_send(void *ctx, const uint8_t *b, size_t n, int t)
{
    (void)t;
    fake_t *f = (fake_t *)ctx;
    if (f->outbox_len + n > sizeof(f->outbox)) return MCPB_ERR_IO;
    memcpy(f->outbox + f->outbox_len, b, n);
    f->outbox_len += n;
    return (int)n;
}
static int f_recv(void *ctx, uint8_t *b, size_t n, int t)
{
    (void)t;
    fake_t *f = (fake_t *)ctx;
    const size_t left = f->inbox_len - f->inbox_pos;
    if (left == 0) return MCPB_ERR_TIMEOUT;
    const size_t take = (n < left) ? n : left;
    memcpy(b, f->inbox + f->inbox_pos, take);
    f->inbox_pos += take;
    return (int)take;
}
static void f_close(void *ctx) { ((fake_t *)ctx)->closed = 1; }
static uint32_t f_now(void *ctx) { return ((fake_t *)ctx)->clock; }
static int f_random(void *ctx, uint8_t *b, size_t n)
{
    fake_t *f = (fake_t *)ctx;
    if (f->fail_random) return MCPB_ERR_IO;
    size_t i;
    if (f->seed == 0u)
    {
        for (i = 0; i < n; i++) b[i] = (uint8_t)(0xA5u ^ i);
        return MCPB_OK;
    }
    for (i = 0; i < n; i++)
    {
        f->seed = f->seed * 1664525u + 1013904223u;
        b[i] = (uint8_t)(f->seed >> 24);
    }
    return MCPB_OK;
}

/* Link event log. The sink only records, which is also the only safe thing to
 * do in a real application. */
typedef struct
{
    mcpb_event_t ev[16];
    int n;
} ev_log_t;

static void ev_sink(void *user, const mcpb_event_t *e)
{
    ev_log_t *l = (ev_log_t *)user;
    if (l->n < (int)(sizeof(l->ev) / sizeof(l->ev[0])))
        l->ev[l->n++] = *e;
}

static void fake_init(fake_t *f, mcpb_port_t *p)
{
    memset(f, 0, sizeof(*f));
    p->ctx = f;
    p->open = f_open; p->send = f_send; p->recv = f_recv;
    p->close = f_close; p->now_ms = f_now; p->random = f_random;
}

/* The client's key is deterministic because the randomness is: sixteen bytes
 * of 0xA5^i, base64-encoded. Compute the matching accept so the fake server
 * answers correctly. */
static void expected_accept(char *out, size_t cap)
{
    uint8_t nonce[16];
    size_t i;
    for (i = 0; i < 16; i++) nonce[i] = (uint8_t)(0xA5u ^ i);
    char key[32];
    mcpb_base64_encode(nonce, sizeof(nonce), key, sizeof(key));

    char joined[128];
    const char *guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    strcpy(joined, key);
    strcat(joined, guid);
    uint8_t d[MCPB_SHA1_SIZE];
    mcpb_sha1((const uint8_t *)joined, strlen(joined), d);
    mcpb_base64_encode(d, sizeof(d), out, cap);
}

static void push_handshake_ok(fake_t *f)
{
    char accept[32];
    expected_accept(accept, sizeof(accept));
    char resp[256];
    snprintf(resp, sizeof(resp),
             "HTTP/1.1 101 Switching Protocols\r\n"
             "Upgrade: websocket\r\n"
             "Connection: Upgrade\r\n"
             "Sec-WebSocket-Accept: %s\r\n"
             "\r\n", accept);
    fake_push_str(f, resp);
}

/* Locates the first frame the client sent after its handshake request, and
 * unmasks its payload into `out`. Returns the payload length, or -1 when
 * nothing follows the handshake. */
static int first_frame_after_handshake(const fake_t *f, uint8_t *opcode,
                                       char *out, size_t cap)
{
    size_t i = 0;
    while (i + 4u <= f->outbox_len && memcmp(f->outbox + i, "\r\n\r\n", 4) != 0)
        i++;
    if (i + 4u > f->outbox_len)
        return -1;
    i += 4u;
    if (i >= f->outbox_len)
        return -1;
    const unsigned char *fr = f->outbox + i;
    *opcode = (uint8_t)(fr[0] & 0x0Fu);
    size_t len = fr[1] & 0x7Fu, h = 2;
    if (len == 126u) { len = ((size_t)fr[2] << 8) | fr[3]; h = 4; }
    const unsigned char *mask = fr + h;
    if (len >= cap) return -1;
    size_t k;
    for (k = 0; k < len; k++)
        out[k] = (char)(fr[h + 4u + k] ^ mask[k & 3u]);
    out[len] = 0;
    return (int)len;
}

/* Builds a SERVER frame (unmasked). */
static size_t make_frame(unsigned char *out, int fin, uint8_t opcode,
                         const void *payload, size_t len)
{
    size_t h = 0;
    out[h++] = (unsigned char)((fin ? 0x80u : 0u) | opcode);
    if (len < 126u)
    {
        out[h++] = (unsigned char)len;
    }
    else
    {
        out[h++] = 126u;
        out[h++] = (unsigned char)(len >> 8);
        out[h++] = (unsigned char)len;
    }
    if (len > 0) memcpy(out + h, payload, len);
    return h + len;
}

int main(void)
{
    printf("== SHA-1, FIPS 180-1 vectors ==\n");
    {
        uint8_t d[MCPB_SHA1_SIZE];
        mcpb_sha1((const uint8_t *)"abc", 3, d);
        static const uint8_t want1[20] = {
            0xA9,0x99,0x3E,0x36,0x47,0x06,0x81,0x6A,0xBA,0x3E,
            0x25,0x71,0x78,0x50,0xC2,0x6C,0x9C,0xD0,0xD8,0x9D};
        check(memcmp(d, want1, 20) == 0, "\"abc\"");

        mcpb_sha1((const uint8_t *)"", 0, d);
        static const uint8_t want2[20] = {
            0xDA,0x39,0xA3,0xEE,0x5E,0x6B,0x4B,0x0D,0x32,0x55,
            0xBF,0xEF,0x95,0x60,0x18,0x90,0xAF,0xD8,0x07,0x09};
        check(memcmp(d, want2, 20) == 0, "empty string");

        /* 56 bytes: the case that needs two padding blocks, and the one
         * implementations get wrong. */
        const char *m56 = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
        mcpb_sha1((const uint8_t *)m56, strlen(m56), d);
        static const uint8_t want3[20] = {
            0x84,0x98,0x3E,0x44,0x1C,0x3B,0xD2,0x6E,0xBA,0xAE,
            0x4A,0xA1,0xF9,0x51,0x29,0xE5,0xE5,0x46,0x70,0xF1};
        check(memcmp(d, want3, 20) == 0, "56 bytes, two padding blocks");
    }

    printf("== base64, RFC 4648 vectors ==\n");
    {
        char b[32];
        mcpb_base64_encode((const uint8_t *)"f", 1, b, sizeof(b));
        check(strcmp(b, "Zg==") == 0, "\"f\" -> Zg==");
        mcpb_base64_encode((const uint8_t *)"fo", 2, b, sizeof(b));
        check(strcmp(b, "Zm8=") == 0, "\"fo\" -> Zm8=");
        mcpb_base64_encode((const uint8_t *)"foobar", 6, b, sizeof(b));
        check(strcmp(b, "Zm9vYmFy") == 0, "\"foobar\" -> Zm9vYmFy");
        check(mcpb_base64_encode((const uint8_t *)"foobar", 6, b, 4)
              == MCPB_ERR_TOO_LARGE, "short buffer refused");
    }

    printf("== RFC 6455 section 1.3 accept vector ==\n");
    {
        /* The normative example: key "dGhlIHNhbXBsZSBub25jZQ==" must yield
         * accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=". */
        char joined[128];
        strcpy(joined, "dGhlIHNhbXBsZSBub25jZQ==");
        strcat(joined, "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
        uint8_t d[MCPB_SHA1_SIZE];
        mcpb_sha1((const uint8_t *)joined, strlen(joined), d);
        char acc[32];
        mcpb_base64_encode(d, sizeof(d), acc, sizeof(acc));
        check(strcmp(acc, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") == 0,
              "the normative example is reproduced");
    }

    printf("== URL encoding ==\n");
    {
        char b[64];
        mcpb_url_encode("MAC:ACA70405A4EC", b, sizeof(b));
        /* The ':' of a qualified name must travel encoded. */
        check(strcmp(b, "MAC%3AACA70405A4EC") == 0, "':' becomes %3A");
        mcpb_url_encode("scrubber-01", b, sizeof(b));
        check(strcmp(b, "scrubber-01") == 0, "a plain name passes through");
        check(mcpb_url_encode("MAC:ACA70405A4EC", b, 4) == MCPB_ERR_TOO_LARGE,
              "short buffer refused");
    }

    printf("== handshake ==\n");
    {
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
        mcpb_ws_config_t c;
        fake_init(&f, &p);
        push_handshake_ok(&f);

        memset(&c, 0, sizeof(c));
        c.host = "broker.local"; c.port = 3000; c.path = "/provider/x";
        c.rx_buffer = rx; c.rx_capacity = sizeof(rx);

        check(mcpb_ws_open(&ws, &p, &c) == MCPB_OK, "valid accept");
        f.outbox[f.outbox_len] = '\0';
        check(strstr((char *)f.outbox, "GET /provider/x HTTP/1.1") != NULL,
              "the request line carries the path");
        check(strstr((char *)f.outbox, "Host: broker.local:3000") != NULL,
              "the Host header carries the port");
        check(strstr((char *)f.outbox, "Sec-WebSocket-Version: 13") != NULL,
              "version 13 announced");
    }
    {
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
        mcpb_ws_config_t c;
        fake_init(&f, &p);
        fake_push_str(&f,
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Sec-WebSocket-Accept: bidonbidonbidonbidonbidon=\r\n\r\n");
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        /* The real case this catches: a captive portal answering 101 without
         * being a WebSocket endpoint. */
        check(mcpb_ws_open(&ws, &p, &c) == MCPB_ERR_HANDSHAKE,
              "wrong accept refused");
        check(f.closed == 1, "and the stream is closed");
    }
    {
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
        mcpb_ws_config_t c;
        fake_init(&f, &p);
        fake_push_str(&f, "HTTP/1.1 401 Unauthorized\r\n\r\n");
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        check(mcpb_ws_open(&ws, &p, &c) == MCPB_ERR_HANDSHAKE, "401 refused");
    }
    {
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
        mcpb_ws_config_t c;
        char accept[32]; expected_accept(accept, sizeof(accept));
        char resp[256];
        fake_init(&f, &p);
        snprintf(resp, sizeof(resp),
                 "HTTP/1.1 101 Switching Protocols\r\n"
                 "Sec-WebSocket-Accept: %s\r\n"
                 "Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n", accept);
        fake_push_str(&f, resp);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        /* Accepting an extension we cannot undo would yield compressed bytes
         * presented as JSON. */
        check(mcpb_ws_open(&ws, &p, &c) == MCPB_ERR_UNSUPPORTED,
              "imposed extension refused");
    }
    {
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
        mcpb_ws_config_t c;
        fake_init(&f, &p);
        f.fail_random = 1;
        push_handshake_ok(&f);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        /* Better not to connect at all than to use a predictable mask. */
        check(mcpb_ws_open(&ws, &p, &c) < 0, "no entropy: outright failure");
    }

    printf("== sending ==\n");
    {
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
        mcpb_ws_config_t c;
        fake_init(&f, &p);
        push_handshake_ok(&f);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        mcpb_ws_open(&ws, &p, &c);

        const size_t before = f.outbox_len;
        const char *msg = "{\"jsonrpc\":\"2.0\",\"id\":1}";
        check(mcpb_ws_send_text(&ws, msg, strlen(msg)) == MCPB_OK, "send accepted");

        const unsigned char *fr = f.outbox + before;
        check(fr[0] == 0x81, "FIN set, text opcode");
        /* The mask bit is mandatory on the client side: without it the
         * server closes the connection (RFC 6455 5.1). */
        check((fr[1] & 0x80u) != 0, "mask bit set");
        check((fr[1] & 0x7Fu) == strlen(msg), "exact length");

        /* Unmask, to check the payload survived. */
        const unsigned char *mask = fr + 2;
        const unsigned char *pl = fr + 6;
        char back[64]; size_t i;
        for (i = 0; i < strlen(msg); i++)
            back[i] = (char)(pl[i] ^ mask[i & 3u]);
        back[strlen(msg)] = '\0';
        check(strcmp(back, msg) == 0, "payload intact after unmasking");

        /* The library must not have touched the caller's buffer. */
        check(strcmp(msg, "{\"jsonrpc\":\"2.0\",\"id\":1}") == 0,
              "the caller's buffer is not masked in place");
    }

    printf("== receiving ==\n");
    {
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
        mcpb_ws_config_t c; unsigned char fr[256];
        const char *out; size_t olen;
        fake_init(&f, &p);
        push_handshake_ok(&f);
        fake_push(&f, fr, make_frame(fr, 1, 0x1, "{\"method\":\"tools/list\"}", 23));
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        mcpb_ws_open(&ws, &p, &c);

        check(mcpb_ws_recv_text(&ws, &out, &olen, 1000) == MCPB_OK, "message received");
        check(olen == 23 && memcmp(out, "{\"method\":\"tools/list\"}", 23) == 0,
              "exact content");
        check(mcpb_ws_recv_text(&ws, &out, &olen, 0) == MCPB_ERR_TIMEOUT,
              "nothing left: idle, not an error");
    }
    {
        /* Fragmented: a non-final text frame, then a continuation. */
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
        mcpb_ws_config_t c; unsigned char fr[256];
        const char *out; size_t olen;
        fake_init(&f, &p);
        push_handshake_ok(&f);
        fake_push(&f, fr, make_frame(fr, 0, 0x1, "{\"a\":", 5));
        fake_push(&f, fr, make_frame(fr, 1, 0x0, "1}", 2));
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        mcpb_ws_open(&ws, &p, &c);
        check(mcpb_ws_recv_text(&ws, &out, &olen, 1000) == MCPB_OK,
              "fragmented message received");
        check(olen == 7 && memcmp(out, "{\"a\":1}", 7) == 0, "fragments reassembled");
    }
    {
        /* Ping: the library must answer on its own and keep waiting. */
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
        mcpb_ws_config_t c; unsigned char fr[256];
        const char *out; size_t olen;
        fake_init(&f, &p);
        push_handshake_ok(&f);
        fake_push(&f, fr, make_frame(fr, 1, 0x9, "hb", 2));      /* ping */
        fake_push(&f, fr, make_frame(fr, 1, 0x1, "{}", 2));       /* then a message */
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        mcpb_ws_open(&ws, &p, &c);
        const size_t before = f.outbox_len;
        check(mcpb_ws_recv_text(&ws, &out, &olen, 1000) == MCPB_OK,
              "the ping is not surfaced to the caller");
        check(olen == 2 && memcmp(out, "{}", 2) == 0, "the message is what surfaces");
        check(f.outbox_len > before && (f.outbox[before] & 0x0Fu) == 0xA,
              "a pong was sent");
    }
    {
        /* Close: the library returns CLOSED, distinct from a timeout. */
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
        mcpb_ws_config_t c; unsigned char fr[256];
        const char *out; size_t olen;
        unsigned char body[2] = {0x03, 0xE8}; /* 1000 */
        fake_init(&f, &p);
        push_handshake_ok(&f);
        fake_push(&f, fr, make_frame(fr, 1, 0x8, body, 2)); /* peer closes */
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        mcpb_ws_open(&ws, &p, &c);
        check(mcpb_ws_recv_text(&ws, &out, &olen, 1000) == MCPB_ERR_CLOSED,
              "close is distinct from a timeout");
        check(ws.close_code == 1000, "close code retained");
        check(!mcpb_ws_is_open(&ws), "the websocket is closed");
    }

    printf("== malformed frames ==\n");
    {
        struct { const char *what; unsigned char b0, b1; int expect; } cases[] = {
            {"reserved bit set",        0xC1, 0x02, MCPB_ERR_PROTOCOL},
            {"frame masked by the server", 0x81, 0x82, MCPB_ERR_PROTOCOL},
            {"reserved opcode",          0x83, 0x02, MCPB_ERR_PROTOCOL},
            {"binary frame",           0x82, 0x02, MCPB_ERR_UNSUPPORTED},
            {"orphan continuation",  0x80, 0x02, MCPB_ERR_PROTOCOL},
        };
        size_t k;
        for (k = 0; k < sizeof(cases) / sizeof(cases[0]); k++)
        {
            fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
            mcpb_ws_config_t c; const char *out; size_t olen;
            unsigned char bad[8];
            fake_init(&f, &p);
            push_handshake_ok(&f);
            bad[0] = cases[k].b0; bad[1] = cases[k].b1;
            bad[2] = 'h'; bad[3] = 'i'; bad[4] = 0; bad[5] = 0;
            fake_push(&f, bad, 6);
            memset(&c, 0, sizeof(c));
            c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
            mcpb_ws_open(&ws, &p, &c);
            check(mcpb_ws_recv_text(&ws, &out, &olen, 1000) == cases[k].expect,
                  cases[k].what);
        }
    }
    {
        /* Larger than the buffer: refused outright, not truncated. Truncated
         * JSON is invalid JSON, and finding that out in the parser above turns
         * a sizing limit into a baffling syntax error. */
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[300];
        mcpb_ws_config_t c; unsigned char fr[1024]; char big[600];
        const char *out; size_t olen;
        memset(big, 'x', sizeof(big));
        fake_init(&f, &p);
        push_handshake_ok(&f);
        fake_push(&f, fr, make_frame(fr, 1, 0x1, big, sizeof(big)));
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        mcpb_ws_open(&ws, &p, &c);
        check(mcpb_ws_recv_text(&ws, &out, &olen, 1000) == MCPB_ERR_TOO_LARGE,
              "oversized message refused, not truncated");
    }

    printf("== provider client ==\n");
    {
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[2048];
        unsigned char fr[256]; const char *out; size_t olen;
        fake_init(&f, &p);
        push_handshake_ok(&f);
        fake_push(&f, fr, make_frame(fr, 1, 0x1, "{\"id\":1}", 8));

        memset(&c, 0, sizeof(c));
        c.host = "broker.local"; c.port = 3000;
        c.name = "MAC:ACA70405A4EC";
        c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        check(mcpb_provider_init(&pr, &p, &c) == MCPB_OK, "init");
        check(strcmp(pr.path, "/provider/MAC%3AACA70405A4EC") == 0,
              "the path carries the encoded name");

        /* First poll: it connects, and has nothing to return yet. */
        check(mcpb_provider_poll(&pr, &out, &olen, 0) == MCPB_ERR_TIMEOUT,
              "the first poll connects");
        check(mcpb_provider_is_connected(&pr), "and the link is up");
        check(pr.connects == 1, "one connection counted");

        check(mcpb_provider_poll(&pr, &out, &olen, 100) == MCPB_OK, "message returned");
        check(olen == 8 && memcmp(out, "{\"id\":1}", 8) == 0, "exact content");

        check(mcpb_provider_send(&pr, "{\"result\":{}}", 13) == MCPB_OK, "reply sent");
        check(pr.tx_messages == 1 && pr.rx_messages == 1, "counters up to date");
    }
    {
        /* The window doubles and caps. Deterministic, therefore checkable,
         * which is the whole point of keeping it separate from the applied
         * wait. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[512];
        const char *out; size_t olen;
        fake_init(&f, &p);
        fake_push_str(&f, "HTTP/1.1 503 Service Unavailable\r\n\r\n");

        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.retry_initial_ms = 1000; c.retry_max_ms = 4000;
        c.retry_no_jitter = 1; /* bench: reproducible scheduling */
        mcpb_provider_init(&pr, &p, &c);

        mcpb_provider_poll(&pr, &out, &olen, 0);   /* echoue, planifie a +1000 */
        check(pr.retry_window_ms == 2000, "the window doubled");
        check(mcpb_provider_poll(&pr, &out, &olen, 0) == MCPB_ERR_TIMEOUT,
              "before the deadline, no retry");
        f.clock += 1500;
        mcpb_provider_poll(&pr, &out, &olen, 0);   /* retente, echoue encore */
        check(pr.retry_window_ms == 4000, "it doubled again");
        f.clock += 5000;
        mcpb_provider_poll(&pr, &out, &olen, 0);
        check(pr.retry_window_ms == 4000, "and caps");
    }
    {
        /* Doubling stops. Forty failures in a row: with no cap the window
         * would pass a year by the thirtieth and the device would retry once
         * a century, which nobody diagnoses. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[512];
        const char *out; size_t olen;
        int i; uint32_t worst = 0;
        fake_init(&f, &p);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.retry_initial_ms = 1000; c.retry_max_ms = 30000;
        c.retry_no_jitter = 1;
        mcpb_provider_init(&pr, &p, &c);
        for (i = 0; i < 40; i++)
        {
            /* Nothing in the inbox: the handshake fails. */
            f.inbox_len = 0; f.inbox_pos = 0;
            f.clock += 60000;
            mcpb_provider_poll(&pr, &out, &olen, 0);
            if (pr.retry_window_ms > worst) worst = pr.retry_window_ms;
        }
        check(worst == 30000u, "after 40 failures the window never exceeds the cap");
        check(pr.retry_window_ms == 30000u, "and stays there");
    }
    {
        /* The requested cap is itself clamped. One extra zero on
         * retry_max_ms must not produce a device absent for eight hours, and
         * above all must not break the signed-difference deadline comparison,
         * which is only correct below ~24.8 days. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[512];
        fake_init(&f, &p);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.retry_initial_ms = 1000;
        c.retry_max_ms = 4000000000u; /* ~46 days: past the signed wrap */
        mcpb_provider_init(&pr, &p, &c);
        check(pr.cfg.retry_max_ms == MCPB_RETRY_CEILING_MS,
              "an absurd cap is brought back to the hard ceiling");

        /* Same for the floor, otherwise an oversized floor would defeat the
         * cap clamp through the coherence step. */
        fake_init(&f, &p);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.retry_initial_ms = 4000000000u;
        c.retry_max_ms = 30000;
        mcpb_provider_init(&pr, &p, &c);
        check(pr.cfg.retry_initial_ms == MCPB_RETRY_CEILING_MS,
              "an absurd floor too");
        check(pr.cfg.retry_max_ms == MCPB_RETRY_CEILING_MS,
              "and the cap follows the floor rather than staying below it");
    }

    printf("== mass recovery: the draw decorrelates devices ==\n");
    {
        /* The scenario that matters: a whole fleet loses the link at the
         * same instant, on a broker restart or a site outage. With no draw,
         * the N devices share one schedule and come back in lockstep; the
         * broker comes up and gets N handshakes in the same millisecond.
         *
         * Bring up N devices, fail them all at t=0, and look at where their
         * next attempt lands. */
#define N_DEV 64
        static fake_t fs[N_DEV];
        static mcpb_port_t ps[N_DEV];
        static mcpb_provider_t prs[N_DEV];
        static uint8_t rxs[N_DEV][512];
        static uint32_t when[N_DEV];
        mcpb_provider_config_t c;
        const char *out; size_t olen;
        int i, j;

        for (i = 0; i < N_DEV; i++)
        {
            fake_init(&fs[i], &ps[i]);
            fs[i].seed = (uint32_t)(i + 1) * 2654435761u; /* distinct devices */
            fake_push_str(&fs[i], "HTTP/1.1 503 Service Unavailable\r\n\r\n");
            memset(&c, 0, sizeof(c));
            c.host = "h"; c.name = "x";
            c.rx_buffer = rxs[i]; c.rx_capacity = sizeof(rxs[i]);
            c.retry_initial_ms = 1000; c.retry_max_ms = 30000;
            mcpb_provider_init(&prs[i], &ps[i], &c);
            mcpb_provider_poll(&prs[i], &out, &olen, 0); /* fails */
            when[i] = prs[i].retry_at_ms;                /* clock at 0 */
        }

        uint32_t lo = when[0], hi = when[0];
        int distinct = 0;
        for (i = 0; i < N_DEV; i++)
        {
            if (when[i] < lo) lo = when[i];
            if (when[i] > hi) hi = when[i];
            int seen = 0;
            for (j = 0; j < i; j++) if (when[j] == when[i]) { seen = 1; break; }
            if (!seen) distinct++;
        }
        printf("       (%d distinct instants out of %d, spread from %u to %u ms)\n",
               distinct, N_DEV, lo, hi);

        check(hi <= 1000u, "no attempt beyond the window");
        /* The point: the devices do not come back together. */
        check(distinct >= N_DEV / 2, "retry instants are spread out");
        check(hi - lo > 500u, "and cover a large part of the window");
    }
    {
        /* The counter-test, which gives the previous one its value: with no
         * draw, the same devices all restart at exactly the same instant. */
        static fake_t fs[8];
        static mcpb_port_t ps[8];
        static mcpb_provider_t prs[8];
        static uint8_t rxs[8][512];
        mcpb_provider_config_t c;
        const char *out; size_t olen;
        int i, same = 1;

        for (i = 0; i < 8; i++)
        {
            fake_init(&fs[i], &ps[i]);
            fs[i].seed = (uint32_t)(i + 1) * 2654435761u;
            fake_push_str(&fs[i], "HTTP/1.1 503 Service Unavailable\r\n\r\n");
            memset(&c, 0, sizeof(c));
            c.host = "h"; c.name = "x";
            c.rx_buffer = rxs[i]; c.rx_capacity = sizeof(rxs[i]);
            c.retry_initial_ms = 1000; c.retry_max_ms = 30000;
            c.retry_no_jitter = 1;
            mcpb_provider_init(&prs[i], &ps[i], &c);
            mcpb_provider_poll(&prs[i], &out, &olen, 0);
            if (prs[i].retry_at_ms != prs[0].retry_at_ms) same = 0;
        }
        check(same, "with no draw, the whole fleet restarts at the same instant");
    }
    {
        /* No entropy: fall back to the full window. Degraded but working.
         * Failing a reconnection for want of entropy would be worse than
         * bunching it. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[512];
        const char *out; size_t olen;
        fake_init(&f, &p);
        fake_push_str(&f, "HTTP/1.1 503 Service Unavailable\r\n\r\n");
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.retry_initial_ms = 1000; c.retry_max_ms = 30000;
        mcpb_provider_init(&pr, &p, &c);
        f.fail_random = 1;
        mcpb_provider_poll(&pr, &out, &olen, 0);
        check(pr.retry_at_ms == 1000u, "with no entropy, the wait equals the window");
    }

    printf("== link events ==\n");
    {
        /* What a critical system needs: to learn about the lost link when it
         * happens, not by noticing that replies stopped. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[2048];
        unsigned char fr[256]; const char *out; size_t olen;
        unsigned char body[2] = {0x03, 0xE8};
        ev_log_t log;
        memset(&log, 0, sizeof(log));

        fake_init(&f, &p);
        push_handshake_ok(&f);
        fake_push(&f, fr, make_frame(fr, 1, 0x8, body, 2)); /* peer closes */

        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.retry_initial_ms = 1000; c.retry_max_ms = 30000;
        c.on_event = ev_sink; c.event_user = &log;
        mcpb_provider_init(&pr, &p, &c);

        f.clock = 500; /* init was at 0: 500 ms to service */
        mcpb_provider_poll(&pr, &out, &olen, 0);   /* connects */
        check(log.n == 1 && log.ev[0].type == MCPB_EVENT_CONNECTED,
              "connection announced");
        check(log.ev[0].down_ms == 500u,
              "the first CONNECTED carries the time to service");

        mcpb_provider_poll(&pr, &out, &olen, 100); /* receives the Close */
        check(log.n == 2 && log.ev[1].type == MCPB_EVENT_DISCONNECTED,
              "link loss announced");
        check(log.ev[1].error == MCPB_ERR_CLOSED, "with its cause");
        check(log.ev[1].attempts == 1, "first failure counted");

        /* The point. The event carries the chosen delay and reached the
         * caller BEFORE that delay elapsed: the bench clock has not moved,
         * while the next attempt is scheduled later. Notifying after the wait
         * would make the moment a critical system learns it is isolated
         * depend on chance. */
        check(log.ev[1].at_ms == 500u, "announced at the instant of the loss");
        check(pr.retry_at_ms >= 500u, "while the retry is scheduled later");
        check(log.ev[1].next_retry_ms <= 1000u,
              "and the event carries the drawn delay");
    }
    {
        /* A failure while already offline is follow-up, not an incident.
         * Merging them would raise an alarm on every attempt. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[512];
        const char *out; size_t olen;
        ev_log_t log;
        memset(&log, 0, sizeof(log));

        fake_init(&f, &p);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.retry_initial_ms = 1000; c.retry_max_ms = 30000;
        c.retry_no_jitter = 1;
        c.on_event = ev_sink; c.event_user = &log;
        mcpb_provider_init(&pr, &p, &c);

        mcpb_provider_poll(&pr, &out, &olen, 0);   /* fails: never connected */
        check(log.n == 1 && log.ev[0].type == MCPB_EVENT_RETRY_FAILED,
              "a failure with no prior link is not a disconnection");
        f.clock += 2000;
        mcpb_provider_poll(&pr, &out, &olen, 0);
        check(log.n == 2 && log.ev[1].type == MCPB_EVENT_RETRY_FAILED,
              "later attempts too");
        check(log.ev[1].attempts == 2, "the consecutive failure counter rises");
        check(log.ev[1].window_ms == 4000u, "and the current window is carried");
    }
    {
        /* Recovery after an outage: the failure counter drops and the
         * downtime is reported. That is what lets an application decide
         * whether the interruption was tolerable. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[2048];
        const char *out; size_t olen;
        ev_log_t log;
        memset(&log, 0, sizeof(log));

        fake_init(&f, &p);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.retry_initial_ms = 1000; c.retry_max_ms = 30000;
        c.retry_no_jitter = 1;
        c.on_event = ev_sink; c.event_user = &log;
        mcpb_provider_init(&pr, &p, &c);

        mcpb_provider_poll(&pr, &out, &olen, 0);   /* failure 1 */
        f.clock += 2000;
        mcpb_provider_poll(&pr, &out, &olen, 0);   /* failure 2 */
        check(pr.attempts == 2, "two failures accumulated");

        f.clock += 5000;
        push_handshake_ok(&f);                     /* the broker is back */
        mcpb_provider_poll(&pr, &out, &olen, 0);
        check(log.ev[log.n - 1].type == MCPB_EVENT_CONNECTED, "recovery announced");
        check(log.ev[log.n - 1].down_ms == 7000u,
              "with the downtime");
        check(pr.attempts == 0, "and the failure counter is reset");
    }
    {
        /* With no sink nothing changes: the field is optional. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[512];
        const char *out; size_t olen;
        fake_init(&f, &p);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        mcpb_provider_init(&pr, &p, &c);
        check(mcpb_provider_poll(&pr, &out, &olen, 0) == MCPB_ERR_TIMEOUT,
              "no sink declared: no callback, no crash");
    }

    printf("== _all opt-in ==\n");
    {
        /* The register frame is the FIRST thing after the handshake: the
         * broker inspects exactly one frame per socket for it. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[2048];
        const char *out; size_t olen;
        char payload[256]; uint8_t op = 0;
        fake_init(&f, &p);
        push_handshake_ok(&f);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.aggregate = 1;
        mcpb_provider_init(&pr, &p, &c);
        mcpb_provider_poll(&pr, &out, &olen, 0); /* connects */
        const int n = first_frame_after_handshake(&f, &op, payload, sizeof(payload));
        check(n > 0 && op == 0x1, "with aggregate, a text frame follows the handshake");
        check(n == (int)strlen(MCPB_REGISTER_FRAME) &&
              strcmp(payload, MCPB_REGISTER_FRAME) == 0,
              "and it is notifications/register {aggregate:true}");
        check(pr.tx_messages == 0, "not counted as an application message");
        check(mcpb_provider_is_connected(&pr), "the link is up");
    }
    {
        /* Without it, nothing: a provider that does not ask stays on its own
         * slot, and the broker must not see a frame it would route. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[2048];
        const char *out; size_t olen;
        char payload[256]; uint8_t op = 0;
        fake_init(&f, &p);
        push_handshake_ok(&f);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        mcpb_provider_init(&pr, &p, &c);
        mcpb_provider_poll(&pr, &out, &olen, 0);
        check(first_frame_after_handshake(&f, &op, payload, sizeof(payload)) == -1,
              "without aggregate, nothing follows the handshake");
    }
    {
        /* A register frame that cannot be sent is a failed attempt, not a
         * connection: the link never served, so it is RETRY_FAILED and the
         * socket is closed rather than left open in a half-registered state. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[2048];
        const char *out; size_t olen;
        ev_log_t log;
        memset(&log, 0, sizeof(log));
        fake_init(&f, &p);
        push_handshake_ok(&f);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.aggregate = 1;
        c.on_event = ev_sink; c.event_user = &log;
        mcpb_provider_init(&pr, &p, &c);
        /* Room for the handshake request but not for one more frame. */
        f.outbox_len = sizeof(f.outbox) - 240u;
        mcpb_provider_poll(&pr, &out, &olen, 0);
        check(!mcpb_provider_is_connected(&pr) && f.closed,
              "a register frame that cannot be sent closes the socket");
        check(log.n == 1 && log.ev[0].type == MCPB_EVENT_RETRY_FAILED &&
              log.ev[0].error == MCPB_ERR_IO,
              "and is reported as a failed attempt, not a lost link");
    }

    printf("== the peer's reason travels with the event ==\n");
    {
        /* The broker closes with 1008 and a sentence naming the fix. A client
         * that keeps only the code leaves its operator with "policy
         * violation" and nothing else. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[2048];
        unsigned char fr[256]; const char *out; size_t olen;
        const char *why = "transport/path mismatch: this is the slot-scoped path";
        unsigned char body[128];
        ev_log_t log;
        memset(&log, 0, sizeof(log));
        body[0] = 0x03; body[1] = 0xF0; /* 1008 */
        memcpy(body + 2, why, strlen(why));
        fake_init(&f, &p);
        push_handshake_ok(&f);
        fake_push(&f, fr, make_frame(fr, 1, 0x8, body, 2 + strlen(why)));
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.on_event = ev_sink; c.event_user = &log;
        mcpb_provider_init(&pr, &p, &c);
        mcpb_provider_poll(&pr, &out, &olen, 0);   /* connects */
        check(log.ev[0].close_code == 0 && log.ev[0].http_status == 0 &&
              log.ev[0].reason != NULL && log.ev[0].reason[0] == 0,
              "CONNECTED carries no refusal");
        mcpb_provider_poll(&pr, &out, &olen, 100); /* receives the Close */
        check(log.n == 2 && log.ev[1].error == MCPB_ERR_CLOSED, "closed by the peer");
        check(log.ev[1].close_code == 1008, "with its code");
        check(strcmp(log.ev[1].reason, why) == 0, "and its reason, verbatim");
    }
    {
        /* No payload at all: 1005 by convention, and an empty reason rather
         * than a NULL the caller would have to guard before printing. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[2048];
        unsigned char fr[256]; const char *out; size_t olen;
        ev_log_t log;
        memset(&log, 0, sizeof(log));
        fake_init(&f, &p);
        push_handshake_ok(&f);
        fake_push(&f, fr, make_frame(fr, 1, 0x8, NULL, 0));
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.on_event = ev_sink; c.event_user = &log;
        mcpb_provider_init(&pr, &p, &c);
        mcpb_provider_poll(&pr, &out, &olen, 0);
        mcpb_provider_poll(&pr, &out, &olen, 100);
        check(log.n == 2 && log.ev[1].close_code == 1005 &&
              log.ev[1].reason != NULL && log.ev[1].reason[0] == 0,
              "a bare Close reports 1005 and an empty reason");
    }
    {
        /* A refused handshake: the HTTP status is the whole diagnosis, since
         * the body is never read. 401 says authentication, not network. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[512];
        const char *out; size_t olen;
        ev_log_t log;
        memset(&log, 0, sizeof(log));
        fake_init(&f, &p);
        fake_push_str(&f, "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.on_event = ev_sink; c.event_user = &log;
        mcpb_provider_init(&pr, &p, &c);
        mcpb_provider_poll(&pr, &out, &olen, 0);
        check(log.n == 1 && log.ev[0].type == MCPB_EVENT_RETRY_FAILED &&
              log.ev[0].error == MCPB_ERR_HANDSHAKE,
              "a non-101 answer is a handshake failure");
        check(log.ev[0].http_status == 401, "and the event carries the HTTP status");
        check(log.ev[0].close_code == 0 && log.ev[0].reason[0] == 0,
              "with no websocket close, since none happened");
        check(strcmp(log.ev[0].detail, "HTTP 401") == 0,
              "and detail names the status the library refused");
    }

    printf("== the library's own refusals are named ==\n");
    {
        /* "protocol violation" alone names nothing. The rule that fired and
         * the header bytes are what tells a real violation from a
         * desynchronised stream. */
        fake_t f; mcpb_port_t p; mcpb_ws_t ws; uint8_t rx[2048];
        mcpb_ws_config_t c; unsigned char fr[4];
        const char *out; size_t olen;
        fake_init(&f, &p);
        push_handshake_ok(&f);
        fr[0] = 0xC1; fr[1] = 0x02; fr[2] = '{'; fr[3] = '}'; /* RSV1 set */
        fake_push(&f, fr, 4);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.path = "/p"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        mcpb_ws_open(&ws, &p, &c);
        check(ws.detail[0] == 0, "no detail while nothing was refused");
        check(mcpb_ws_recv_text(&ws, &out, &olen, 100) == MCPB_ERR_PROTOCOL,
              "a frame with a reserved bit is refused");
        check(strcmp(ws.detail, "rsv bits set, header C1 02") == 0,
              "and detail names the rule and the header bytes");
    }
    {
        /* Through the provider: the event carries it. */
        fake_t f; mcpb_port_t p; mcpb_provider_t pr;
        mcpb_provider_config_t c; uint8_t rx[2048];
        unsigned char fr[4]; const char *out; size_t olen;
        ev_log_t log;
        memset(&log, 0, sizeof(log));
        fake_init(&f, &p);
        push_handshake_ok(&f);
        fr[0] = 0x81; fr[1] = 0x82; fr[2] = 0; fr[3] = 0; /* masked by the server */
        fake_push(&f, fr, 4);
        memset(&c, 0, sizeof(c));
        c.host = "h"; c.name = "x"; c.rx_buffer = rx; c.rx_capacity = sizeof(rx);
        c.on_event = ev_sink; c.event_user = &log;
        mcpb_provider_init(&pr, &p, &c);
        mcpb_provider_poll(&pr, &out, &olen, 0);
        check(log.ev[0].detail != NULL && log.ev[0].detail[0] == 0,
              "CONNECTED carries an empty detail");
        mcpb_provider_poll(&pr, &out, &olen, 100);
        check(log.n == 2 && log.ev[1].error == MCPB_ERR_PROTOCOL,
              "the refusal drops the link");
        check(strcmp(log.ev[1].detail, "server frame masked, header 81 82") == 0,
              "and DISCONNECTED carries the library's account");
    }

    printf("\n%s\n", g_fail ? "SOME TESTS FAILED" : "all pass");
    return g_fail ? 1 : 0;
}
