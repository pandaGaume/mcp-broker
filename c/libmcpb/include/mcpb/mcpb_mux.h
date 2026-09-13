#ifndef MCPB_MUX_H
#define MCPB_MUX_H

/* The multiplexed provider endpoint: several slots, one socket.
 *
 *     ws[s]://<host>/providers
 *     one envelope per frame: {"provider":"<slot>","payload":<JSON-RPC>}
 *
 * (mcp-broker/docs/protocol.md, "Multiplexed provider WebSocket".)
 *
 * For a host that publishes several MCP servers from one process and does
 * not want a socket per server: a game engine, a gateway. Each slot is
 * claimed with a registration envelope as soon as the socket opens, so an
 * MCP client arriving before any traffic finds the slot connected; the
 * broker frees every slot of the socket when it closes.
 *
 * A device with one provider does not want this: the envelope costs bytes
 * on every frame to name a slot the URL already names, and the code costs
 * flash. That is why it is a separate pair of files, compiled only with
 * MCPB_ENABLE_MUX, and why mcpb_provider.h is the default.
 *
 * Underneath it is one mcpb_provider_t link on the fixed /providers path,
 * so the connection, the retry window, the ping and the events are the
 * ones documented there; nothing is duplicated.
 */

#if !defined(MCPB_ENABLE_MUX) || !MCPB_ENABLE_MUX
#error "multiplex not built: define MCPB_ENABLE_MUX=1 and compile mcpb_envelope.c and mcpb_mux.c"
#endif

#include "mcpb.h"
#include "mcpb_envelope.h"
#include "mcpb_provider.h"

#ifdef __cplusplus
extern "C" {
#endif

/* One slot the socket publishes. The array is the caller's and must
 * outlive the mux; it is read again at every reconnection. */
typedef struct
{
    const char *name;      /* slot name, plain; escaped on the wire */
    int         aggregate; /* also join `_all` with this slot */
} mcpb_mux_slot_t;

typedef struct
{
    /* The link: host, port, tls, extra_headers, timeouts, retry window,
     * ping, rx buffer, event sink. `name` and `aggregate` are ignored: the
     * slots carry them. */
    mcpb_provider_config_t link;

    /* Where outgoing envelopes are built, since the library allocates
     * nothing. Needs the payload plus the escaped slot name plus 30 bytes;
     * a send that does not fit fails with MCPB_ERR_TOO_LARGE. */
    char  *tx_buffer;
    size_t tx_capacity;
} mcpb_mux_config_t;

/* Returned by mcpb_mux_poll in *slot for a frame whose provider matches no
 * registered slot. The broker does not do that; a frame that does is
 * handed over anyway, with its payload, so the caller can log it. */
#define MCPB_MUX_UNKNOWN_SLOT ((size_t)-1)

typedef struct
{
    mcpb_provider_t        link;
    const mcpb_mux_slot_t *slots;
    size_t                 slot_count;
    char                  *tx;
    size_t                 tx_cap;
    uint32_t               refused; /* registrations the broker refused, cumulative */
    char                   refusal[MCPB_WS_CLOSE_REASON_MAX]; /* the broker's last words about it */
} mcpb_mux_t;

/* Opens nothing, like mcpb_provider_init: the first poll connects and
 * registers every slot. */
int mcpb_mux_init(mcpb_mux_t *m, const mcpb_port_t *port,
                  const mcpb_mux_config_t *cfg,
                  const mcpb_mux_slot_t *slots, size_t slot_count);

/* Connects, reconnects, keeps the ping going, and returns one message when
 * there is one, with the index of the slot it is for.
 *
 * A registration the broker refuses (a slot held by someone else, or a
 * policy) comes back from the broker as an error envelope with id null.
 * It is not handed to the caller as a message, because an MCP server would
 * drop it silently: it is reported as an MCPB_EVENT_SLOT_REFUSED event
 * carrying the slot, the code and the broker's message, and counted in
 * `refused`. The other slots keep working.
 *
 * @param slot  index into the slots array, or MCPB_MUX_UNKNOWN_SLOT.
 * @param out   the payload, pointing into the receive buffer, valid until
 *              the next call. Not NUL-terminated.
 * @return  MCPB_OK           a message is available
 *          MCPB_ERR_TIMEOUT  nothing to read; the normal idle return
 *          MCPB_ERR_PROTOCOL a frame that is not an envelope; the link is
 *                            kept, the frame is dropped, detail names it
 *          negative          link failure; it reconnects by itself */
int mcpb_mux_poll(mcpb_mux_t *m, size_t *slot, const char **out,
                  size_t *out_len, int timeout_ms);

/* Sends an already-serialised JSON-RPC message on one slot. Fails if the
 * link is down; nothing is queued (see mcpb_provider_send). */
int mcpb_mux_send(mcpb_mux_t *m, size_t slot, const char *json, size_t len);

/* Closes the socket, which frees every slot on the broker. */
void mcpb_mux_stop(mcpb_mux_t *m);

static inline int mcpb_mux_is_connected(const mcpb_mux_t *m)
{
    return m != NULL && mcpb_provider_is_connected(&m->link);
}

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_MUX_H */
