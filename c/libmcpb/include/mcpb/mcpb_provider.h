#ifndef MCPB_PROVIDER_H
#define MCPB_PROVIDER_H

/* mcp-broker provider client.
 *
 *     ws[s]://<host>/provider/<encoded name>
 *     one text frame = one JSON-RPC message, no envelope
 *
 * (mcp-broker/docs/protocol.md, "Dedicated provider WebSocket".)
 *
 * The device dials out, so it needs no inbound port, no port forwarding and
 * no fixed address: it works from behind a NAT, a phone hotspot or a plant
 * firewall.
 *
 * The dedicated endpoint, not the multiplexed /providers one. That envelope
 * exists for a host fronting several providers; a device is one provider and
 * would be paying an encoding to name itself on every frame.
 */

#include "mcpb.h"
#include "mcpb_port.h"
#include "mcpb_ws.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MCPB_PROVIDER_NAME_MAX 64

/* Hard cap on the retry wait. retry_max_ms is clamped to this whatever the
 * caller asks for.
 *
 * Not just taste. The retry deadline is compared as a signed 32-bit
 * difference so it survives millisecond-counter wraparound, and that is only
 * correct below 2^31 ms (~24.8 days). A larger retry_max does not give a long
 * wait: it gives a device that retries constantly, or never again, depending
 * on the sign. One hour leaves three orders of magnitude of margin.
 *
 * A deployment with real reasons to wait longer (satellite link, metered
 * data) redefines this at compile time, so the choice stays bounded and
 * visible in the build. */
#ifndef MCPB_RETRY_CEILING_MS
#define MCPB_RETRY_CEILING_MS 3600000u  /* one hour */
#endif

/* --- Link events ---------------------------------------------------------
 *
 * A critical system must not learn about a lost link by noticing that replies
 * stopped. It has to know when it happens, to raise an alarm, fall back to
 * local autonomy, or refuse a command it could no longer report on.
 *
 * The rule: the notification is immediate, the random wait only delays the
 * network retry. Jittering the announcement too would make the moment an
 * application learns it is isolated depend on chance.
 */
typedef enum
{
    /* Link is up. Fired on the first connection and on every recovery;
     * `connects == 1` tells them apart. */
    MCPB_EVENT_CONNECTED = 0,

    /* The link WAS up and has just been lost. This is what an alarm hangs
     * on. */
    MCPB_EVENT_DISCONNECTED,

    /* An attempt failed while already offline. Distinct from the above: the
     * first is an incident, this is its follow-up. Merging them would raise
     * an alarm on every attempt. */
    MCPB_EVENT_RETRY_FAILED
} mcpb_event_type_t;

typedef struct
{
    mcpb_event_type_t type;
    int      error;          /* cause; MCPB_OK for CONNECTED */
    uint32_t at_ms;
    uint32_t next_retry_ms;  /* the drawn wait; 0 for CONNECTED */
    uint32_t window_ms;      /* window the wait was drawn from */
    uint32_t attempts;       /* consecutive failures; escalate on this */
    uint32_t down_ms;        /* CONNECTED: how long the link was missing.
                              * On the first connection, time since init. */
} mcpb_event_t;

/* Called from the caller's own task, inside mcpb_provider_poll or
 * mcpb_provider_send. The library creates no threads.
 *
 * Do not call mcpb_provider_* from here: the library is mid-transition. Set a
 * flag and act in your own loop. */
typedef void (*mcpb_event_cb)(void *user, const mcpb_event_t *event);

typedef struct
{
    const char *host;
    uint16_t    port;          /* 0: 80, or 443 when tls */
    int         tls;

    /* Slot name. URL-encoded by the library, so a qualified name like
     * "MAC:ACA70405A4EC" travels as MAC%3AACA70405A4EC. */
    const char *name;

    const char *extra_headers; /* authorization, etc. */

    int connect_timeout_ms;    /* <= 0: 10000 */
    int handshake_timeout_ms;  /* <= 0: 5000 */

    /* Retry window: starts at retry_initial_ms, doubles on each failure,
     * stops at retry_max_ms (itself clamped to MCPB_RETRY_CEILING_MS).
     * 0 takes the defaults, 1000 and 30000.
     *
     * The actual wait is drawn at random inside that window. Exponential
     * growth bounds the RATE of one device's attempts; it does not
     * DECORRELATE devices. A hundred that lose the link at the same instant
     * share the same schedule and come back in lockstep. The draw is what
     * spreads them. */
    uint32_t retry_initial_ms;
    uint32_t retry_max_ms;

    /* Disables the draw: the wait becomes the whole window. For test benches,
     * where reproducible scheduling is what makes a result readable. Setting
     * it in a deployment brings the lockstep wave back. */
    int retry_no_jitter;

    /* Keepalive ping, 0 for none, default 30000. An idle link crossing a NAT
     * or a proxy gets cut silently: with no traffic the device believes it is
     * connected for hours while the broker lists it as absent. */
    uint32_t ping_interval_ms;

    uint8_t *rx_buffer;
    size_t   rx_capacity;

    mcpb_event_cb on_event;    /* NULL for no notifications */
    void         *event_user;
} mcpb_provider_config_t;

typedef enum
{
    MCPB_PROVIDER_IDLE = 0,    /* never started, or stopped */
    MCPB_PROVIDER_WAITING,
    MCPB_PROVIDER_CONNECTED
} mcpb_provider_state_t;

typedef struct
{
    mcpb_provider_config_t cfg;
    const mcpb_port_t     *port;
    mcpb_ws_t              ws;
    mcpb_provider_state_t  state;

    char     path[MCPB_WS_PATH_MAX];

    /* The window is deterministic and stays observable even though the
     * applied wait is random. */
    uint32_t retry_window_ms;
    uint32_t retry_at_ms;
    uint32_t last_ping_ms;
    uint32_t attempts;
    uint32_t down_since_ms;

    uint32_t connects;
    uint32_t disconnects;
    uint32_t rx_messages;
    uint32_t tx_messages;
} mcpb_provider_t;

/* Opens nothing: the connection happens on the first poll, so a device
 * booting without a network does not stall its startup on an unreachable
 * broker. */
int mcpb_provider_init(mcpb_provider_t *p, const mcpb_port_t *port,
                       const mcpb_provider_config_t *cfg);

/* Connects, reconnects, keeps the ping going, and returns one message when
 * there is one.
 *
 * @param out  points into the receive buffer, valid until the next call.
 * @return  MCPB_OK           a message is available
 *          MCPB_ERR_TIMEOUT  nothing to read; the normal return of an idle
 *                            loop, not an error
 *          negative          failure; the client will reconnect by itself */
int mcpb_provider_poll(mcpb_provider_t *p, const char **out, size_t *out_len,
                       int timeout_ms);

/* Sends an already-serialised JSON-RPC message. Fails if the link is down;
 * nothing is queued.
 *
 * That is a choice. A JSON-RPC reply answers a request carried by a link;
 * once that link drops, the client on the other side has already had its
 * error from the broker, and delivering the reply after reconnecting would
 * hand it to an id nobody is waiting for. */
int mcpb_provider_send(mcpb_provider_t *p, const char *json, size_t len);

/* Closes and returns to IDLE. No further reconnection until a new init. */
void mcpb_provider_stop(mcpb_provider_t *p);

static inline int mcpb_provider_is_connected(const mcpb_provider_t *p)
{
    return p != NULL && p->state == MCPB_PROVIDER_CONNECTED;
}

/* URL-encodes a slot name (RFC 3986). Exposed because callers usually want to
 * log the exact URL they will dial.
 * @return bytes written, or MCPB_ERR_TOO_LARGE. */
int mcpb_url_encode(const char *in, char *out, size_t cap);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_PROVIDER_H */
