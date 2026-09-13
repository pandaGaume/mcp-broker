#ifndef MCPB_WS_H
#define MCPB_WS_H

/* RFC 6455 WebSocket, client role only. Enough to talk to mcp-broker.
 *
 * The caller supplies the receive buffer, and its size bounds the largest
 * message that can be received. A larger one is refused with
 * MCPB_ERR_TOO_LARGE and the connection closed, never truncated: truncated
 * JSON is invalid JSON, and finding that out in the parser above turns a
 * sizing limit into a baffling syntax error.
 *
 * Not handled: binary frames (the broker only sends text), extensions (an
 * imposed permessage-deflate fails the handshake rather than being ignored),
 * and the server role.
 */

#include "mcpb.h"
#include "mcpb_port.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MCPB_WS_HOST_MAX 128
#define MCPB_WS_PATH_MAX 192

/* A Close frame carries at most 125 bytes: two of code, the rest of reason
 * (RFC 6455 5.5.1). 123 bytes plus the terminator. */
#define MCPB_WS_CLOSE_REASON_MAX 124

#define MCPB_WS_DETAIL_MAX 64

typedef struct
{
    const char *host;      /* resolved by the port */
    uint16_t    port;      /* 0: 80, or 443 when tls */
    const char *path;      /* e.g. "/provider/scrubber-01" */
    int         tls;

    /* Extra headers, already formatted as "Name: value\r\n" and concatenated,
     * or NULL. Authorization goes here, so the library needs to know nothing
     * about any auth scheme. */
    const char *extra_headers;

    int connect_timeout_ms;
    int handshake_timeout_ms;

    uint8_t *rx_buffer;
    size_t   rx_capacity;
} mcpb_ws_config_t;

typedef enum
{
    MCPB_WS_CLOSED = 0,
    MCPB_WS_OPEN
} mcpb_ws_state_t;

typedef struct
{
    const mcpb_port_t *port;
    mcpb_ws_state_t    state;

    uint8_t *rx;
    size_t   rx_cap;

    size_t   rx_len;         /* accumulated across continuation frames */
    int      rx_in_fragment;

    /* The frame in progress, kept across calls.
     *
     * mcpb_ws_recv_text is called with a deadline, and a frame does not care
     * about deadlines: on a slow link its bytes arrive across several of
     * them. Before 0.2.1 a deadline that fell in the middle of a frame
     * returned MCPB_ERR_TIMEOUT and forgot the bytes already consumed, so
     * the next call read a "header" out of the middle of a payload and
     * refused it as a protocol violation ("rsv bits set, header 7B 22": the
     * bytes are `{"`). Seen on an ESP32 over a weak Wi-Fi link with power
     * save on, never on a LAN. Now a timeout leaves this state where it is
     * and the next call resumes from it. */
    uint8_t  in_hdr[10];     /* 2 header bytes, then up to 8 of extended length */
    size_t   in_hdr_len;     /* bytes of in_hdr received so far */
    size_t   in_hdr_need;    /* 2 until the first two are in, then 4 or 10 */
    int      in_payload;     /* 0: still reading the header, 1: the payload */
    uint64_t in_len;         /* payload length, valid once in_payload is set */
    size_t   in_got;         /* payload bytes received so far */
    uint8_t  in_ctrl[125];   /* where a control frame's payload accumulates */

    uint16_t close_code;     /* set when the peer sent one; 1005 for none */

    /* The peer's close reason, NUL-terminated, "" when it sent none. Kept
     * because it is where the broker says why: a 1008 comes with a sentence
     * naming the transport/path mismatch or the policy that refused the
     * slot, and a client that discards it leaves its operator with a bare
     * code. */
    char     close_reason[MCPB_WS_CLOSE_REASON_MAX];

    /* The HTTP status the server answered the handshake with, 0 until it
     * answers. On a refusal it is the diagnosis: 401/403 is authentication,
     * 400 is a path the broker rejects by construction, 404 a wrong prefix,
     * 503 a broker not ready. Retained on MCPB_ERR_HANDSHAKE. */
    int      http_status;

    /* Why the LIBRARY refused, when the failure is its own decision rather
     * than the peer's: the frame rule that fired and the two header bytes it
     * read ("rsv bits set, header 41 83"), an imposed extension, a missing
     * or wrong Sec-WebSocket-Accept, a non-101 status. Set with
     * MCPB_ERR_PROTOCOL, MCPB_ERR_UNSUPPORTED and MCPB_ERR_HANDSHAKE, ""
     * otherwise. A refused frame is otherwise invisible: the peer sees a
     * close it did not ask for and the operator sees "protocol violation",
     * which names nothing. */
    char     detail[MCPB_WS_DETAIL_MAX];
} mcpb_ws_t;

/* Connects and performs the handshake.
 *
 * Verifies Sec-WebSocket-Accept, which many clients skip. It guards against
 * no adversary (the constant is public) but catches the common real case: a
 * proxy or captive portal answering 101 without being a WebSocket endpoint.
 * Without it the failure surfaces much later, as unreadable frames. */
int mcpb_ws_open(mcpb_ws_t *ws, const mcpb_port_t *port,
                 const mcpb_ws_config_t *cfg);

/* One unfragmented, masked text frame. */
int mcpb_ws_send_text(mcpb_ws_t *ws, const char *data, size_t len);

/* Receives one complete text message.
 *
 * Answers control frames itself: a Ping produces a Pong and the wait
 * continues, a Close closes and returns MCPB_ERR_CLOSED. The caller only ever
 * sees application messages.
 *
 * A timeout is never destructive: whatever part of a frame had arrived is
 * kept, and the next call resumes from it. So a caller may poll with a short
 * timeout on a link that delivers one message over several of them.
 *
 * @param out  points into the receive buffer, valid until the next call.
 * @return MCPB_OK, MCPB_ERR_TIMEOUT, MCPB_ERR_CLOSED, or an error. */
int mcpb_ws_recv_text(mcpb_ws_t *ws, const char **out, size_t *out_len,
                      int timeout_ms);

/* The matching Pong is consumed by mcpb_ws_recv_text. */
int mcpb_ws_ping(mcpb_ws_t *ws);

/* Sends a Close frame, then closes the stream. 1000 is the normal code.
 * Tolerates an already-closed websocket. */
void mcpb_ws_close(mcpb_ws_t *ws, uint16_t code);

static inline int mcpb_ws_is_open(const mcpb_ws_t *ws)
{
    return ws != NULL && ws->state == MCPB_WS_OPEN;
}

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_WS_H */
