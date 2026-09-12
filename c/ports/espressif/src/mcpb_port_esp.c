/* libmcpb port for ESP-IDF. See mcpb_port_esp.h. */

#include "mcpb_port_esp.h"

#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_tls.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "mbedtls/ssl.h" /* MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY */

#include <errno.h>
#include <string.h>

static const char *TAG = "mcpb.port";

static esp_tls_t *_tls(const mcpb_port_esp_t *c)
{
    return (esp_tls_t *)c->tls;
}

/* Waits for the socket to be readable. 1 ready, 0 timed out, -1 error. */
static int _wait_readable(int fd, int timeout_ms)
{
    fd_set r;
    FD_ZERO(&r);
    FD_SET(fd, &r);
    struct timeval tv;
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    return select(fd + 1, &r, NULL, NULL, (timeout_ms >= 0) ? &tv : NULL);
}

/* --- The six functions ----------------------------------------------------- */

static int e_open(void *ctx, const char *host, uint16_t port, int tls,
                  int timeout_ms)
{
    mcpb_port_esp_t *c = (mcpb_port_esp_t *)ctx;
    if (c->tls != NULL)
        return MCPB_ERR_STATE;

    esp_tls_t *t = esp_tls_init();
    if (t == NULL)
        return MCPB_ERR_IO;

    esp_tls_cfg_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    if (tls)
    {
        /* The bundle built into the image. Without it, and without a
         * pinned certificate, esp-tls would have nothing to validate against
         * and accept any peer: encryption without authentication protects
         * from nothing. */
        cfg.crt_bundle_attach = esp_crt_bundle_attach;
    }
    else
    {
        cfg.is_plain_tcp = true;
    }
    /* esp-tls has one timeout for connection plus handshake. libmcpb's
     * handshake timeout covers the HTTP upgrade that comes after, on top. */
    cfg.timeout_ms = (timeout_ms > 0) ? timeout_ms : 10000;
    cfg.non_block = false;

    if (esp_tls_conn_new_sync(host, (int)strlen(host), (int)port, &cfg, t) != 1)
    {
        int code = 0, flags = 0;
        esp_tls_error_handle_t eh = NULL;
        if (esp_tls_get_error_handle(t, &eh) == ESP_OK)
            esp_tls_get_and_clear_last_error(eh, &code, &flags);
        c->last_err = code;
        /* The two numbers separate a network fault from a certificate
         * refusal, which a bare "failed" would not. */
        ESP_LOGW(TAG, "%s:%u refused (esp-tls err=-0x%04X flags=0x%08X)",
                 host, (unsigned)port, (unsigned)(-code), (unsigned)flags);
        esp_tls_conn_destroy(t);
        return MCPB_ERR_IO;
    }

    int fd = -1;
    if (esp_tls_get_conn_sockfd(t, &fd) != ESP_OK || fd < 0)
    {
        esp_tls_conn_destroy(t);
        return MCPB_ERR_IO;
    }

    c->tls = t;
    c->fd = fd;
    c->last_err = 0;
    return MCPB_OK;
}

static int e_send(void *ctx, const uint8_t *buf, size_t len, int timeout_ms)
{
    mcpb_port_esp_t *c = (mcpb_port_esp_t *)ctx;
    if (c->tls == NULL)
        return MCPB_ERR_STATE;

    const int64_t deadline = (timeout_ms >= 0)
        ? esp_timer_get_time() + (int64_t)timeout_ms * 1000
        : 0;

    size_t sent = 0;
    while (sent < len)
    {
        const ssize_t n = esp_tls_conn_write(_tls(c), buf + sent, len - sent);
        if (n > 0)
        {
            sent += (size_t)n;
            continue;
        }
        if (n == ESP_TLS_ERR_SSL_WANT_READ || n == ESP_TLS_ERR_SSL_WANT_WRITE)
        {
            /* The record layer is mid-flight: yield and retry, under the
             * caller's deadline. */
            if (timeout_ms >= 0 && esp_timer_get_time() >= deadline)
                return MCPB_ERR_TIMEOUT;
            vTaskDelay(1);
            continue;
        }
        c->last_err = (int)n;
        return MCPB_ERR_IO;
    }
    return (int)len;
}

static int e_recv(void *ctx, uint8_t *buf, size_t len, int timeout_ms)
{
    mcpb_port_esp_t *c = (mcpb_port_esp_t *)ctx;
    if (c->tls == NULL)
        return MCPB_ERR_STATE;

    /* Decrypted reserve FIRST. A TLS record can carry several application
     * messages: waiting on the socket while mbedTLS still holds some would
     * time out on data already received. */
    if (esp_tls_get_bytes_avail(_tls(c)) <= 0)
    {
        const int ready = _wait_readable(c->fd, timeout_ms);
        if (ready == 0)
            return MCPB_ERR_TIMEOUT;
        if (ready < 0)
        {
            c->last_err = errno;
            return MCPB_ERR_IO;
        }
    }

    const ssize_t n = esp_tls_conn_read(_tls(c), buf, len);
    if (n > 0)
        return (int)n;
    if (n == 0)
        return MCPB_ERR_CLOSED; /* the peer closed the socket */
    if (n == ESP_TLS_ERR_SSL_WANT_READ || n == ESP_TLS_ERR_SSL_WANT_WRITE)
        return MCPB_ERR_TIMEOUT; /* nothing complete yet; libmcpb loops */
    /* A close_notify alert is a clean end of stream, not a fault. It has no
     * ESP_TLS_ alias in esp_tls_errors.h, only the mbedTLS name. */
    if (n == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY)
        return MCPB_ERR_CLOSED;
    c->last_err = (int)n;
    return MCPB_ERR_IO;
}

static void e_close(void *ctx)
{
    mcpb_port_esp_t *c = (mcpb_port_esp_t *)ctx;
    if (c->tls == NULL)
        return;
    esp_tls_conn_destroy(_tls(c));
    c->tls = NULL;
    c->fd = -1;
}

static uint32_t e_now_ms(void *ctx)
{
    (void)ctx;
    /* Wraps every 49.7 days by design; libmcpb only takes differences. */
    return (uint32_t)(esp_timer_get_time() / 1000);
}

static int e_random(void *ctx, uint8_t *buf, size_t len)
{
    (void)ctx;
    /* Hardware RNG, fed by RF noise once Wi-Fi or Bluetooth is running,
     * which is the case for any device that reaches a broker. */
    esp_fill_random(buf, len);
    return MCPB_OK;
}

/* --- Init ------------------------------------------------------------------ */

int mcpb_port_esp_init(mcpb_port_t *port, mcpb_port_esp_t *ctx)
{
    if (port == NULL || ctx == NULL)
        return MCPB_ERR_ARG;

    ctx->tls = NULL;
    ctx->fd = -1;
    ctx->last_err = 0;

    port->ctx = ctx;
    port->open = e_open;
    port->send = e_send;
    port->recv = e_recv;
    port->close = e_close;
    port->now_ms = e_now_ms;
    port->random = e_random;
    return mcpb_port_check(port);
}
