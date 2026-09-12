/* SHA-1 (RFC 3174), only for the WebSocket handshake.
 *
 * No secrecy role. RFC 6455 uses it as a consistency check: the client hashes
 * its key with a public constant and compares against the server's answer.
 * Anyone can redo the computation, that is the point. SHA-1's broken
 * collision resistance does not apply to this use. */

#include "mcpb_internal.h"

#include <string.h>

#define ROL(v, n) (((v) << (n)) | ((v) >> (32 - (n))))

static void _block(uint32_t h[5], const uint8_t *p)
{
    uint32_t w[80];
    int i;

    for (i = 0; i < 16; i++)
    {
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
    }
    for (i = 16; i < 80; i++)
    {
        w[i] = ROL(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (i = 0; i < 80; i++)
    {
        uint32_t f, k;
        if (i < 20)      { f = (b & c) | (~b & d);            k = 0x5A827999u; }
        else if (i < 40) { f = b ^ c ^ d;                     k = 0x6ED9EBA1u; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d);   k = 0x8F1BBCDCu; }
        else             { f = b ^ c ^ d;                     k = 0xCA62C1D6u; }

        const uint32_t t = ROL(a, 5) + f + e + k + w[i];
        e = d;
        d = c;
        c = ROL(b, 30);
        b = a;
        a = t;
    }

    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
}

void mcpb_sha1(const uint8_t *data, size_t len, uint8_t out[MCPB_SHA1_SIZE])
{
    uint32_t h[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu,
                     0x10325476u, 0xC3D2E1F0u};
    size_t i;

    for (i = 0; i + 64 <= len; i += 64)
        _block(h, data + i);

    /* Final padding: one or two blocks, depending on whether the eight
     * length bytes still fit. */
    uint8_t tail[128];
    const size_t rem = len - i;
    memset(tail, 0, sizeof(tail));
    memcpy(tail, data + i, rem);
    tail[rem] = 0x80;

    const size_t blocks = (rem + 1 + 8 > 64) ? 2u : 1u;
    const size_t total = blocks * 64;

    /* Length in BITS, big-endian, in the last eight bytes. */
    const uint64_t bits = (uint64_t)len * 8u;
    int b;
    for (b = 0; b < 8; b++)
        tail[total - 1 - (size_t)b] = (uint8_t)(bits >> (8 * b));

    _block(h, tail);
    if (blocks == 2)
        _block(h, tail + 64);

    for (b = 0; b < 5; b++)
    {
        out[b * 4]     = (uint8_t)(h[b] >> 24);
        out[b * 4 + 1] = (uint8_t)(h[b] >> 16);
        out[b * 4 + 2] = (uint8_t)(h[b] >> 8);
        out[b * 4 + 3] = (uint8_t)(h[b]);
    }
}
