/* Multiplexed provider endpoint. See mcpb_mux.h. */

#include "mcpb/mcpb_mux.h"
#include "mcpb_internal.h"

#include <string.h>

/* What the multiplexed path expects first: one registration per slot, so
 * every slot exists on the broker before any MCP client asks for it. Sent
 * again at each reconnection, because the broker forgot them all when the
 * socket dropped. */
static int _mux_on_open(mcpb_provider_t *link, void *user)
{
    mcpb_mux_t *m = (mcpb_mux_t *)user;
    size_t i;
    for (i = 0; i < m->slot_count; i++)
    {
        const int n = mcpb_envelope_register(m->slots[i].name, m->slots[i].aggregate,
                                             m->tx, m->tx_cap);
        if (n < 0)
            return n;
        const int rc = mcpb_ws_send_text(&link->ws, m->tx, (size_t)n);
        if (rc != MCPB_OK)
            return rc;
    }
    return MCPB_OK;
}

int mcpb_mux_init(mcpb_mux_t *m, const mcpb_port_t *port,
                  const mcpb_mux_config_t *cfg,
                  const mcpb_mux_slot_t *slots, size_t slot_count)
{
    if (m == NULL || cfg == NULL || slots == NULL || slot_count == 0)
        return MCPB_ERR_ARG;
    if (cfg->tx_buffer == NULL || cfg->tx_capacity < 128u)
        return MCPB_ERR_ARG;
    size_t i;
    for (i = 0; i < slot_count; i++)
        if (slots[i].name == NULL || slots[i].name[0] == 0)
            return MCPB_ERR_ARG;

    memset(m, 0, sizeof(*m));
    m->slots = slots;
    m->slot_count = slot_count;
    m->tx = cfg->tx_buffer;
    m->tx_cap = cfg->tx_capacity;

    /* The link never sends the dedicated path's opt-in: aggregate is per
     * slot here, inside each registration envelope. */
    mcpb_provider_config_t lc = cfg->link;
    lc.name = "providers"; /* unused on this path; init_ex takes the path verbatim */
    lc.aggregate = 0;
    return mcpb_provider_init_ex(&m->link, port, &lc, "/providers", _mux_on_open, m);
}

static size_t _slot_of(const mcpb_mux_t *m, const char *raw, size_t raw_len)
{
    size_t i;
    for (i = 0; i < m->slot_count; i++)
        if (mcpb_envelope_name_equals(raw, raw_len, m->slots[i].name))
            return i;
    return MCPB_MUX_UNKNOWN_SLOT;
}

/* Reports a refused registration through the link's event sink, with the
 * broker's message copied so the callback sees a C string. */
static void _refused(mcpb_mux_t *m, size_t slot, int code,
                     const char *message, size_t message_len)
{
    m->refused++;
    if (m->link.cfg.on_event == NULL)
        return;

    /* Kept in the mux rather than on the stack, so the pointer the sink
     * receives stays valid after the callback, like every other reason. */
    char *reason = m->refusal;
    const size_t n = (message_len < sizeof(m->refusal) - 1u) ? message_len : sizeof(m->refusal) - 1u;
    memcpy(reason, message, n);
    reason[n] = 0;

    mcpb_event_t ev;
    memset(&ev, 0, sizeof(ev));
    ev.type = MCPB_EVENT_SLOT_REFUSED;
    ev.error = MCPB_OK;
    ev.at_ms = m->link.port->now_ms(m->link.port->ctx);
    ev.window_ms = m->link.retry_window_ms;
    ev.attempts = m->link.attempts;
    ev.reason = reason;
    ev.detail = "";
    ev.slot = slot;
    ev.rpc_code = code;
    m->link.cfg.on_event(m->link.cfg.event_user, &ev);
}

int mcpb_mux_poll(mcpb_mux_t *m, size_t *slot, const char **out,
                  size_t *out_len, int timeout_ms)
{
    if (m == NULL || slot == NULL || out == NULL || out_len == NULL)
        return MCPB_ERR_ARG;
    *slot = MCPB_MUX_UNKNOWN_SLOT;
    *out = NULL;
    *out_len = 0;

    for (;;)
    {
        const char *frame;
        size_t frame_len;
        const int rc = mcpb_provider_poll(&m->link, &frame, &frame_len, timeout_ms);
        if (rc != MCPB_OK)
            return rc;

        const char *raw, *payload;
        size_t raw_len, payload_len;
        if (mcpb_envelope_decode(frame, frame_len, &raw, &raw_len, &payload, &payload_len) != MCPB_OK)
        {
            /* Not an envelope. The broker never sends one on this path, so
             * this is either a mismatch (a slot-scoped frame reached a
             * multiplexed socket) or garbage; either way the frame is
             * dropped and named, the link is kept. */
            strcpy(m->link.ws.detail, "frame is not a tunnel envelope");
            return MCPB_ERR_PROTOCOL;
        }
        const size_t index = _slot_of(m, raw, raw_len);

        int code;
        const char *message;
        size_t message_len;
        if (index != MCPB_MUX_UNKNOWN_SLOT &&
            mcpb_envelope_tunnel_error(payload, payload_len, &code, &message, &message_len))
        {
            /* The broker refusing the slot. Not a message for the server
             * behind the slot: reported, then the next frame is awaited
             * under the same call, which is what a caller polling for
             * traffic expects. */
            _refused(m, index, code, message, message_len);
            continue;
        }

        *slot = index;
        *out = payload;
        *out_len = payload_len;
        return MCPB_OK;
    }
}

int mcpb_mux_send(mcpb_mux_t *m, size_t slot, const char *json, size_t len)
{
    if (m == NULL || json == NULL || slot >= m->slot_count)
        return MCPB_ERR_ARG;
    const int n = mcpb_envelope_encode(m->slots[slot].name, json, len, m->tx, m->tx_cap);
    if (n < 0)
        return n;
    return mcpb_provider_send(&m->link, m->tx, (size_t)n);
}

void mcpb_mux_stop(mcpb_mux_t *m)
{
    if (m == NULL)
        return;
    mcpb_provider_stop(&m->link);
}
