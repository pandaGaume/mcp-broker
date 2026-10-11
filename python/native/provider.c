/* Opaque, owned host handle. No Python ABI or duplicated WebSocket protocol. */
#include "mcpb/mcpb_provider.h"
#include "mcpb_port_host.h"
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#define PY_API __declspec(dllexport)
#else
#define PY_API __attribute__((visibility("default")))
#endif

typedef struct {
    mcpb_provider_t provider;
    mcpb_port_t port;
    mcpb_port_host_t host;
    uint8_t *rx;
    char *hostname;
    char *name;
    char *headers;
} py_provider;

static char *copy_string(const char *s)
{
    size_t n = strlen(s) + 1;
    char *p = malloc(n);
    if (p != NULL) memcpy(p, s, n);
    return p;
}

PY_API void mcp_py_destroy(py_provider *p)
{
    if (p == NULL) return;
    mcpb_provider_stop(&p->provider);
    free(p->rx);
    free(p->hostname);
    free(p->name);
    free(p->headers);
    free(p);
}

PY_API py_provider *mcp_py_create(const char *host, unsigned short port,
                                const char *name, int aggregate,
                                const char *headers, size_t capacity)
{
    py_provider *p;
    mcpb_provider_config_t cfg;
    if (host == NULL || name == NULL || capacity < 1024) return NULL;
    p = calloc(1, sizeof(*p));
    if (p == NULL) return NULL;
    p->hostname = copy_string(host);
    p->name = copy_string(name);
    p->headers = copy_string(headers != NULL ? headers : "");
    p->rx = malloc(capacity);
    if (p->hostname == NULL || p->name == NULL || p->headers == NULL ||
        p->rx == NULL || mcpb_port_host_init(&p->port, &p->host) != MCPB_OK) {
        mcp_py_destroy(p);
        return NULL;
    }
    memset(&cfg, 0, sizeof(cfg));
    cfg.host = p->hostname;
    cfg.port = port;
    cfg.name = p->name;
    cfg.aggregate = aggregate;
    cfg.extra_headers = p->headers;
    cfg.rx_buffer = p->rx;
    cfg.rx_capacity = capacity;
    cfg.ping_interval_ms = 30000;
    if (mcpb_provider_init(&p->provider, &p->port, &cfg) != MCPB_OK) {
        mcp_py_destroy(p);
        return NULL;
    }
    return p;
}

/* out points into the handle's receive buffer, until the next poll. */
PY_API int mcp_py_poll(py_provider *p, const char **out, size_t *length, int timeout)
{
    return mcpb_provider_poll(&p->provider, out, length, timeout);
}

PY_API int mcp_py_send(py_provider *p, const char *json, size_t length)
{
    return mcpb_provider_send(&p->provider, json, length);
}

/* A generation prevents a late tool reply crossing a reconnect. */
PY_API unsigned long mcp_py_generation(py_provider *p)
{
    return (unsigned long)p->provider.connects;
}

PY_API int mcp_py_connected(py_provider *p)
{
    return mcpb_provider_is_connected(&p->provider);
}

PY_API const char *mcp_py_error(int code) { return mcpb_strerror(code); }

/* These strings are borrowed and must be copied before the next poll. */
PY_API const char *mcp_py_detail(py_provider *p) { return p->provider.ws.detail; }
PY_API const char *mcp_py_reason(py_provider *p) { return p->provider.ws.close_reason; }
