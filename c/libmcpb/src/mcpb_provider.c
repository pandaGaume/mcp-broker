/* mcp-broker provider client: connection, recovery, keepalive. */

#include "mcpb/mcpb_provider.h"

#include <stdio.h>
#include <string.h>

#define DEFAULT_RETRY_INITIAL_MS 1000u
#define DEFAULT_RETRY_MAX_MS     30000u
#define DEFAULT_PING_MS          30000u

static void _apply_defaults(mcpb_provider_config_t *c)
{
    if (c->connect_timeout_ms <= 0)   c->connect_timeout_ms = 10000;
    if (c->handshake_timeout_ms <= 0) c->handshake_timeout_ms = 5000;
    if (c->retry_initial_ms == 0u)    c->retry_initial_ms = DEFAULT_RETRY_INITIAL_MS;
    if (c->retry_max_ms == 0u)        c->retry_max_ms = DEFAULT_RETRY_MAX_MS;

    /* Clamp first. Doubling stops at retry_max_ms, and retry_max_ms itself
     * cannot exceed the hard ceiling; see MCPB_RETRY_CEILING_MS. */
    if (c->retry_max_ms > MCPB_RETRY_CEILING_MS)
        c->retry_max_ms = MCPB_RETRY_CEILING_MS;
    if (c->retry_initial_ms > MCPB_RETRY_CEILING_MS)
        c->retry_initial_ms = MCPB_RETRY_CEILING_MS;

    /* A ceiling below the floor is meaningless; align rather than refuse,
     * since "wait at least this long" is still a clear intent. */
    if (c->retry_max_ms < c->retry_initial_ms)
        c->retry_max_ms = c->retry_initial_ms;

    if (c->ping_interval_ms == 0u)    c->ping_interval_ms = DEFAULT_PING_MS;
    if (c->port == 0u)                c->port = c->tls ? 443u : 80u;
}

int mcpb_provider_init(mcpb_provider_t *p, const mcpb_port_t *port,
                       const mcpb_provider_config_t *cfg)
{
    if (p == NULL || cfg == NULL || cfg->host == NULL || cfg->name == NULL)
        return MCPB_ERR_ARG;
    if (cfg->rx_buffer == NULL || cfg->rx_capacity < 256u)
        return MCPB_ERR_ARG;
    const int pc = mcpb_port_check(port);
    if (pc != MCPB_OK)
        return pc;

    memset(p, 0, sizeof(*p));
    p->port = port;
    p->cfg = *cfg;
    _apply_defaults(&p->cfg);

    /* Built once: the slot name never changes, and rebuilding it on every
     * attempt would charge the encoding to a link that fails in a loop. */
    char encoded[MCPB_PROVIDER_NAME_MAX * 3 + 1];
    const int elen = mcpb_url_encode(cfg->name, encoded, sizeof(encoded));
    if (elen < 0)
        return elen;
    const int n = snprintf(p->path, sizeof(p->path), "/provider/%s", encoded);
    if (n < 0 || (size_t)n >= sizeof(p->path))
        return MCPB_ERR_TOO_LARGE;

    p->retry_window_ms = p->cfg.retry_initial_ms;
    /* First attempt is immediate. */
    p->retry_at_ms = port->now_ms(port->ctx);
    /* A device that has never connected IS down, so the first CONNECTED
     * event reports the time to service. */
    p->down_since_ms = p->retry_at_ms;
    p->state = MCPB_PROVIDER_WAITING;
    return MCPB_OK;
}

/* Draws a wait in [0, window].
 *
 * Over the whole window rather than its upper half: halving the spread halves
 * how many devices the broker absorbs per second as it comes back up.
 *
 * Modulo bias is irrelevant here (window in the tens of thousands, source in
 * the billions). If entropy is unavailable, fall back to the full window:
 * degraded but working. Failing a reconnection for want of entropy would be
 * worse than bunching it. */
static uint32_t _jittered(mcpb_provider_t *p, uint32_t window)
{
    if (p->cfg.retry_no_jitter || window == 0u)
        return window;

    uint8_t b[4];
    if (p->port->random(p->port->ctx, b, sizeof(b)) != MCPB_OK)
        return window;

    const uint32_t r = ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) |
                       ((uint32_t)b[2] << 8) | (uint32_t)b[3];
    return r % (window + 1u);
}

static void _notify(mcpb_provider_t *p, mcpb_event_type_t type, int error,
                    uint32_t at_ms, uint32_t next_retry_ms, uint32_t down_ms)
{
    if (p->cfg.on_event == NULL)
        return;

    mcpb_event_t ev;
    ev.type = type;
    ev.error = error;
    ev.at_ms = at_ms;
    ev.next_retry_ms = next_retry_ms;
    ev.window_ms = p->retry_window_ms;
    ev.attempts = p->attempts;
    ev.down_ms = down_ms;
    p->cfg.on_event(p->cfg.event_user, &ev);
}

static void _drop(mcpb_provider_t *p, int reason)
{
    const int was_connected = (p->state == MCPB_PROVIDER_CONNECTED);
    if (was_connected)
    {
        p->disconnects++;
        mcpb_ws_close(&p->ws, 1000u);
    }

    const uint32_t now = p->port->now_ms(p->port->ctx);
    if (was_connected)
        p->down_since_ms = now;

    p->state = MCPB_PROVIDER_WAITING;
    p->attempts++;

    const uint32_t wait = _jittered(p, p->retry_window_ms);
    p->retry_at_ms = now + wait;

    /* The window doubles up to the ceiling and stays deterministic. */
    uint32_t next = p->retry_window_ms * 2u;
    if (next > p->cfg.retry_max_ms || next < p->retry_window_ms /* overflow */)
        next = p->cfg.retry_max_ms;
    p->retry_window_ms = next;

    /* Notified immediately, before any wait. The drawn delay only postpones
     * the network attempt; announcing after waiting it out would make the
     * moment a critical system learns it is isolated depend on chance. The
     * event carries that delay so the caller need not poll for it.
     *
     * Emitted last, once the state is coherent: the sink sees up-to-date
     * counters, never a half-written state. */
    _notify(p,
            was_connected ? MCPB_EVENT_DISCONNECTED : MCPB_EVENT_RETRY_FAILED,
            reason, now, wait, 0u);
}

static int _connect(mcpb_provider_t *p)
{
    mcpb_ws_config_t wc;
    memset(&wc, 0, sizeof(wc));
    wc.host = p->cfg.host;
    wc.port = p->cfg.port;
    wc.path = p->path;
    wc.tls = p->cfg.tls;
    wc.extra_headers = p->cfg.extra_headers;
    wc.connect_timeout_ms = p->cfg.connect_timeout_ms;
    wc.handshake_timeout_ms = p->cfg.handshake_timeout_ms;
    wc.rx_buffer = p->cfg.rx_buffer;
    wc.rx_capacity = p->cfg.rx_capacity;

    const int rc = mcpb_ws_open(&p->ws, p->port, &wc);
    if (rc != MCPB_OK)
    {
        _drop(p, rc);
        return rc;
    }

    const uint32_t now = p->port->now_ms(p->port->ctx);
    p->state = MCPB_PROVIDER_CONNECTED;
    p->connects++;
    p->last_ping_ms = now;
    p->attempts = 0u;
    /* Back to the floor. Without this reset, one isolated outage would leave
     * the device at thirty seconds for every later recovery. */
    p->retry_window_ms = p->cfg.retry_initial_ms;

    const uint32_t down = now - p->down_since_ms;
    p->down_since_ms = now;

    _notify(p, MCPB_EVENT_CONNECTED, MCPB_OK, now, 0u, down);
    return MCPB_OK;
}

int mcpb_provider_poll(mcpb_provider_t *p, const char **out, size_t *out_len,
                       int timeout_ms)
{
    if (p == NULL || out == NULL || out_len == NULL)
        return MCPB_ERR_ARG;
    *out = NULL;
    *out_len = 0;

    if (p->state == MCPB_PROVIDER_IDLE)
        return MCPB_ERR_STATE;

    const uint32_t now = p->port->now_ms(p->port->ctx);

    if (p->state == MCPB_PROVIDER_WAITING)
    {
        /* Signed comparison, to survive counter wraparound. */
        if ((int32_t)(now - p->retry_at_ms) < 0)
            return MCPB_ERR_TIMEOUT; /* not yet: idle, not an error */

        /* Result deliberately ignored: a just-opened connection has no
         * message yet, and a failure is already counted and rescheduled by
         * _drop. Either way the caller does nothing different. */
        (void)_connect(p);
        return MCPB_ERR_TIMEOUT;
    }

    /* Keepalive. An idle link crossing a NAT or a proxy gets cut silently:
     * with no traffic the device believes it is connected for hours while the
     * broker lists it as absent. */
    if (p->cfg.ping_interval_ms > 0u &&
        (int32_t)(now - p->last_ping_ms) >= (int32_t)p->cfg.ping_interval_ms)
    {
        p->last_ping_ms = now;
        const int prc = mcpb_ws_ping(&p->ws);
        if (prc != MCPB_OK)
        {
            _drop(p, prc);
            return MCPB_ERR_IO;
        }
    }

    const int rc = mcpb_ws_recv_text(&p->ws, out, out_len, timeout_ms);
    if (rc == MCPB_OK)
    {
        p->rx_messages++;
        return MCPB_OK;
    }
    if (rc == MCPB_ERR_TIMEOUT)
        return MCPB_ERR_TIMEOUT;

    /* Everything else breaks the link, protocol violations included: reading
     * on past a lost framing only yields noise. */
    _drop(p, rc);
    return rc;
}

int mcpb_provider_send(mcpb_provider_t *p, const char *json, size_t len)
{
    if (p == NULL || json == NULL)
        return MCPB_ERR_ARG;
    if (p->state != MCPB_PROVIDER_CONNECTED)
        return MCPB_ERR_STATE;

    const int rc = mcpb_ws_send_text(&p->ws, json, len);
    if (rc != MCPB_OK)
    {
        _drop(p, rc);
        return rc;
    }
    p->tx_messages++;
    return MCPB_OK;
}

void mcpb_provider_stop(mcpb_provider_t *p)
{
    if (p == NULL)
        return;
    if (p->state == MCPB_PROVIDER_CONNECTED)
    {
        p->disconnects++;
        mcpb_ws_close(&p->ws, 1000u);
    }
    p->state = MCPB_PROVIDER_IDLE;
}
