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
