/* Opaque host handle. Existing C99 libraries own TLS and tunnel framing. */
#include "mcpb/mcpb_provider.h"
#include "mcpb/mcpb_mux.h"
#include "mcpb_port_host.h"
#include "mcpb_port_tls.h"
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#define PY_API __declspec(dllexport)
#else
#define PY_API __attribute__((visibility("default")))
#endif

typedef struct {
    mcpb_provider_t dedicated;
    mcpb_mux_t mux;
    int multiplex;
    int pending_error;
    mcpb_port_t port, inner;
    mcpb_port_host_t host;
    mcpb_port_tls_t tls;
    mcpb_mux_slot_t *slots;
    size_t count;
    uint8_t *rx;
    char *tx, *hostname, *headers;
    unsigned char *refused;
    char diagnostic[512];
} py_provider;

static mcpb_provider_t *link_of(py_provider *p)
{
    return p->multiplex ? &p->mux.link : &p->dedicated;
}

static char *copy_string(const char *s)
{
    size_t n = strlen(s) + 1;
    char *p = malloc(n);
    if (p != NULL) memcpy(p, s, n);
    return p;
}

static void on_event(void *user, const mcpb_event_t *event)
{
    py_provider *p = user;
    if (event->type == MCPB_EVENT_CONNECTED) memset(p->refused, 0, p->count);
    if (event->type == MCPB_EVENT_DISCONNECTED || event->type == MCPB_EVENT_RETRY_FAILED)
        p->pending_error = event->error;
    if (event->type == MCPB_EVENT_SLOT_REFUSED && event->slot < p->count) {
        p->refused[event->slot] = 1;
        p->pending_error = MCPB_ERR_STATE;
        strncpy(p->diagnostic, event->reason, sizeof(p->diagnostic) - 1);
        p->diagnostic[sizeof(p->diagnostic) - 1] = 0;
    }
}

PY_API void mcp_py_destroy(py_provider *p)
{
    size_t i;
    if (p == NULL) return;
    mcpb_provider_stop(link_of(p));
    mcpb_port_tls_deinit(&p->tls);
    for (i = 0; i < p->count; ++i) free((void *)p->slots[i].name);
    free(p->slots);
    free(p->refused);
    free(p->rx);
    free(p->tx);
    free(p->hostname);
    free(p->headers);
    free(p);
}

PY_API py_provider *mcp_py_create_ex(const char *host, unsigned short port,
        const char **names, const int *aggregates, size_t count, int multiplex,
        const char *headers, size_t capacity, int tls, const char *ca_pem)
{
    py_provider *p;
    mcpb_provider_config_t cfg;
    mcpb_port_tls_config_t tc;
    size_t i;
    if (host == NULL || names == NULL || aggregates == NULL || count == 0 ||
        count > 1024 || (!multiplex && count != 1) || capacity < 1024 ||
        capacity > (size_t)-1 - 512) return NULL;
    p = calloc(1, sizeof(*p));
    if (p == NULL) return NULL;
    p->multiplex = multiplex;
    p->hostname = copy_string(host);
    p->headers = copy_string(headers != NULL ? headers : "");
    p->rx = malloc(capacity);
    p->tx = malloc(capacity + 512);
    p->slots = calloc(count, sizeof(*p->slots));
    p->refused = calloc(count, 1);
    if (p->hostname == NULL || p->headers == NULL || p->rx == NULL ||
        p->tx == NULL || p->slots == NULL || p->refused == NULL) goto fail;
    p->count = count;
    for (i = 0; i < count; ++i) {
        if (names[i] == NULL) goto fail;
        p->slots[i].name = copy_string(names[i]);
        p->slots[i].aggregate = aggregates[i];
        if (p->slots[i].name == NULL) goto fail;
    }
    if (mcpb_port_host_init(&p->inner, &p->host) != MCPB_OK) goto fail;
    p->port = p->inner;
    if (tls) {
        memset(&tc, 0, sizeof(tc));
        tc.ca_pem = ca_pem;
        if (mcpb_port_tls_init(&p->port, &p->tls, &p->inner, &tc) != MCPB_OK) goto fail;
    }
    memset(&cfg, 0, sizeof(cfg));
    cfg.host = p->hostname;
    cfg.port = port;
    cfg.tls = tls;
    cfg.name = p->slots[0].name;
    cfg.aggregate = p->slots[0].aggregate;
    cfg.extra_headers = p->headers;
    cfg.rx_buffer = p->rx;
    cfg.rx_capacity = capacity;
    cfg.ping_interval_ms = 30000;
    cfg.on_event = on_event;
    cfg.event_user = p;
    if (multiplex) {
        mcpb_mux_config_t mc;
        memset(&mc, 0, sizeof(mc));
        mc.link = cfg;
        mc.tx_buffer = p->tx;
        mc.tx_capacity = capacity + 512;
        if (mcpb_mux_init(&p->mux, &p->port, &mc, p->slots, count) != MCPB_OK) goto fail;
    } else if (mcpb_provider_init(&p->dedicated, &p->port, &cfg) != MCPB_OK) goto fail;
    return p;
fail:
    mcp_py_destroy(p);
    return NULL;
}

PY_API py_provider *mcp_py_create(const char *host, unsigned short port,
        const char *name, int aggregate, const char *headers, size_t capacity)
{
    return mcp_py_create_ex(host, port, &name, &aggregate, 1, 0, headers, capacity, 0, NULL);
}

/* Message pointers are borrowed until the next poll; Python copies them. */
PY_API int mcp_py_poll_slot(py_provider *p, size_t *slot, const char **out,
                          size_t *length, int timeout)
{
    int rc;
    if (p->multiplex) rc = mcpb_mux_poll(&p->mux, slot, out, length, timeout);
    else {
        *slot = 0;
        rc = mcpb_provider_poll(&p->dedicated, out, length, timeout);
    }
    /* Initial connection failures are otherwise reported only through events. */
    if (rc == MCPB_ERR_TIMEOUT && p->pending_error != 0) rc = p->pending_error;
    if (rc < 0 && rc != MCPB_ERR_TIMEOUT) p->pending_error = 0;
    return rc;
}

PY_API int mcp_py_poll(py_provider *p, const char **out, size_t *length, int timeout)
{
    size_t slot;
    return mcp_py_poll_slot(p, &slot, out, length, timeout);
}

PY_API int mcp_py_send_slot(py_provider *p, size_t slot, const char *json, size_t length)
{
    if (p->multiplex) return mcpb_mux_send(&p->mux, slot, json, length);
    if (slot != 0) return MCPB_ERR_ARG;
    return mcpb_provider_send(&p->dedicated, json, length);
}

PY_API int mcp_py_send(py_provider *p, const char *json, size_t length)
{
    return mcp_py_send_slot(p, 0, json, length);
}

PY_API unsigned long mcp_py_generation(py_provider *p) { return (unsigned long)link_of(p)->connects; }
PY_API int mcp_py_connected(py_provider *p) { return mcpb_provider_is_connected(link_of(p)); }
PY_API int mcp_py_refused(py_provider *p, size_t slot)
{
    return slot < p->count ? p->refused[slot] : 1;
}
PY_API const char *mcp_py_error(int code) { return mcpb_strerror(code); }
PY_API const char *mcp_py_detail(py_provider *p)
{
    if (p->tls.last_verify || p->tls.last_ssl_error)
        return mcpb_port_tls_last_error(&p->tls, p->diagnostic, sizeof(p->diagnostic));
    return link_of(p)->ws.detail;
}
PY_API const char *mcp_py_reason(py_provider *p)
{
    return p->multiplex && p->mux.refused ? p->mux.refusal : link_of(p)->ws.close_reason;
}
