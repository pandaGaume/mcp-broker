/* host-provider: the smallest provider that proves the transport end to end.
 *
 * It dials the broker with libmcpb over the host port, optionally joins
 * `_all`, and serves one tool, `echo`, from static strings (see
 * ../lib/static_provider.h for what that layer does and does not do). Every
 * link event is printed as one line, so a test or an operator can follow the
 * connection without reading the code.
 *
 * Two endpoints, same surface:
 *   default        the dedicated path, one socket for the slot <name>
 *   --multiplex    the multiplexed path, ONE socket carrying two slots,
 *                  <name> (joining _all when --aggregate) and <name>-b
 *                  (never in _all), which is how a process hosting several
 *                  servers publishes them without a socket each
 *
 * Usage:
 *   host-provider [--host H] [--port P] [--name N] [--aggregate] [--token T]
 *                 [--retry-initial MS] [--retry-max MS] [--multiplex]
 *                 [--tls [--ca FILE]]
 *
 * --tls dials wss:// through the TLS port stacked over the host port, when
 * the binary was built with it (MCPB_TLS). --ca gives the PEM of the CA the
 * broker's certificate must chain to; without it the platform's default
 * store is used, which is right for a public certificate and wrong for a
 * private one. There is no way to skip verification: a broker whose
 * certificate is not trusted is reported as "TLS handshake or certificate
 * refused" and retried, never spoken to in the clear.
 */

#include "mcpb/mcpb_provider.h"
#if defined(MCPB_ENABLE_MUX) && MCPB_ENABLE_MUX
#include "mcpb/mcpb_mux.h"
#endif
#include "mcpb_port_host.h"
#if defined(MCPB_HAVE_TLS) && MCPB_HAVE_TLS
#include "mcpb_port_tls.h"
#endif
#include "static_provider.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RX_CAPACITY 8192
#define TX_CAPACITY 4096

static volatile sig_atomic_t g_stop = 0;
static void on_sigint(int sig)
{
    (void)sig;
    g_stop = 1;
}

#if defined(MCPB_HAVE_TLS) && MCPB_HAVE_TLS
/* The TLS port in use, or NULL. The library cannot say why a certificate
 * was refused (it never sees TLS); the port can, so the event line carries
 * its word when the error is MCPB_ERR_TLS. */
static const mcpb_port_tls_t *g_tls = NULL;
#endif

static void on_event(void *user, const mcpb_event_t *e)
{
    const mcpb_provider_t *p = (const mcpb_provider_t *)user; /* the link, in both modes */
    char line[256];
    static_provider_event_line(e, (unsigned long)p->connects, line, sizeof(line));
#if defined(MCPB_HAVE_TLS) && MCPB_HAVE_TLS
    if (e->error == MCPB_ERR_TLS && g_tls != NULL)
    {
        char why[96];
        mcpb_port_tls_last_error(g_tls, why, sizeof(why));
        printf("%s tls=\"%s\"\n", line, why);
        fflush(stdout);
        return;
    }
#endif
    puts(line);
    fflush(stdout);
}

/* Handles one incoming message for the slot `name`, printing what came in
 * and what went out. `send` is the mode's send function. */
static int serve(const char *name, const char *msg, size_t len, char *tx, size_t cap,
                 int (*send)(void *, const char *, size_t), void *link)
{
    char method[64];
    static_provider_method(msg, len, method, sizeof(method));
    printf("rx %s %s (%lu bytes)\n", name, method, (unsigned long)len);

    const int n = static_provider_handle(name, msg, len, tx, cap);
    if (n < 0)
    {
        printf("tx skipped: reply does not fit in %lu bytes\n", (unsigned long)cap);
    }
    else if (n > 0)
    {
        const int src = send(link, tx, (size_t)n);
        printf("tx %s %s (%d bytes)%s\n", name, method, n,
               src == MCPB_OK ? "" : " FAILED, link lost");
    }
    fflush(stdout);
    return n;
}

static int send_dedicated(void *link, const char *json, size_t len)
{
    return mcpb_provider_send((mcpb_provider_t *)link, json, len);
}

#if defined(MCPB_ENABLE_MUX) && MCPB_ENABLE_MUX
typedef struct { mcpb_mux_t *mux; size_t slot; } mux_target_t;
static int send_mux(void *target, const char *json, size_t len)
{
    const mux_target_t *t = (const mux_target_t *)target;
    return mcpb_mux_send(t->mux, t->slot, json, len);
}
#endif

static const char *arg(int argc, char **argv, const char *flag, const char *fallback)
{
    int i;
    for (i = 1; i + 1 < argc; i++)
        if (strcmp(argv[i], flag) == 0)
            return argv[i + 1];
    return fallback;
}

static int has(int argc, char **argv, const char *flag)
{
    int i;
    for (i = 1; i < argc; i++)
        if (strcmp(argv[i], flag) == 0)
            return 1;
    return 0;
}

int main(int argc, char **argv)
{
    static uint8_t rx[RX_CAPACITY];
    static char tx[TX_CAPACITY];
    static char headers[256];
#if defined(MCPB_ENABLE_MUX) && MCPB_ENABLE_MUX
    static char envelope[TX_CAPACITY + 128];
    static char name_b[MCPB_PROVIDER_NAME_MAX];
#endif

    mcpb_port_host_t host_ctx;
    mcpb_port_t host_port;
    if (mcpb_port_host_init(&host_port, &host_ctx) != MCPB_OK)
    {
        fprintf(stderr, "host port: initialisation failed\n");
        return 2;
    }

    /* The port the library gets: the host port, or the TLS port over it. */
    mcpb_port_t port = host_port;
    const int use_tls = has(argc, argv, "--tls");
#if defined(MCPB_HAVE_TLS) && MCPB_HAVE_TLS
    static mcpb_port_tls_t tls_ctx;
    static char ca_pem[16384];
    if (use_tls)
    {
        mcpb_port_tls_config_t tls_cfg;
        memset(&tls_cfg, 0, sizeof(tls_cfg));
        const char *ca_path = arg(argc, argv, "--ca", NULL);
        if (ca_path != NULL)
        {
            FILE *f = fopen(ca_path, "rb");
            if (f == NULL)
            {
                fprintf(stderr, "--ca %s: cannot open\n", ca_path);
                return 2;
            }
            const size_t n = fread(ca_pem, 1, sizeof(ca_pem) - 1u, f);
            fclose(f);
            ca_pem[n] = '\0';
            tls_cfg.ca_pem = ca_pem;
            tls_cfg.ca_pem_len = n;
        }
        const int trc = mcpb_port_tls_init(&port, &tls_ctx, &host_port, &tls_cfg);
        if (trc != MCPB_OK)
        {
            fprintf(stderr, "tls port: %s (%s)\n", mcpb_strerror(trc),
                    ca_path != NULL ? "no certificate in --ca" : "no OpenSSL context");
            return 2;
        }
        g_tls = &tls_ctx;
    }
#else
    if (use_tls)
    {
        fputs("--tls: this binary was built without the TLS port (MCPB_TLS=OFF)", stderr);
        fputc(10, stderr);
        return 2;
    }
#endif

    mcpb_provider_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.host = arg(argc, argv, "--host", "127.0.0.1");
    cfg.port = (uint16_t)atoi(arg(argc, argv, "--port", "3000"));
    cfg.tls = use_tls;
    cfg.name = arg(argc, argv, "--name", "host-provider");
    cfg.aggregate = has(argc, argv, "--aggregate");
    cfg.retry_initial_ms = (uint32_t)atoi(arg(argc, argv, "--retry-initial", "1000"));
    cfg.retry_max_ms = (uint32_t)atoi(arg(argc, argv, "--retry-max", "30000"));
    cfg.rx_buffer = rx;
    cfg.rx_capacity = sizeof(rx);

    const char *token = arg(argc, argv, "--token", NULL);
    if (token != NULL)
    {
        /* Either header the broker accepts; X-Provider-Token keeps
         * Authorization free for a proxy in front of it. */
        snprintf(headers, sizeof(headers), "X-Provider-Token: %s\r\n", token);
        cfg.extra_headers = headers;
    }

    signal(SIGINT, on_sigint);
    signal(SIGTERM, on_sigint);

    if (!has(argc, argv, "--multiplex"))
    {
        mcpb_provider_t provider;
        cfg.on_event = on_event;
        cfg.event_user = &provider;
        const int rc = mcpb_provider_init(&provider, &port, &cfg);
        if (rc != MCPB_OK)
        {
            fprintf(stderr, "provider init: %s\n", mcpb_strerror(rc));
            return 2;
        }

        printf("host-provider %s: dialing %s://%s:%u%s%s\n", MCPB_VERSION_STRING,
               use_tls ? "wss" : "ws", cfg.host, (unsigned)cfg.port, provider.path,
               cfg.aggregate ? " (joining _all)" : "");
        fflush(stdout);

        while (!g_stop)
        {
            const char *msg;
            size_t len;
            if (mcpb_provider_poll(&provider, &msg, &len, 200) != MCPB_OK)
                continue; /* TIMEOUT is the idle case; failures were announced */
            serve(cfg.name, msg, len, tx, sizeof(tx), send_dedicated, &provider);
        }

        mcpb_provider_stop(&provider);
        printf("stopped: connects=%lu disconnects=%lu rx=%lu tx=%lu\n",
               (unsigned long)provider.connects, (unsigned long)provider.disconnects,
               (unsigned long)provider.rx_messages, (unsigned long)provider.tx_messages);
        return 0;
    }

#if !defined(MCPB_ENABLE_MUX) || !MCPB_ENABLE_MUX
    fputs("--multiplex: this binary was built without the multiplexed endpoint (MCPB_MUX=OFF)", stderr);
    fputc(10, stderr);
    return 2;
#else
    /* Multiplexed: one socket, two slots, one of them in _all. */
    snprintf(name_b, sizeof(name_b), "%s-b", cfg.name);
    const mcpb_mux_slot_t slots[2] = { { cfg.name, cfg.aggregate }, { name_b, 0 } };
    mux_target_t targets[2];

    mcpb_mux_t mux;
    mcpb_mux_config_t mc;
    memset(&mc, 0, sizeof(mc));
    mc.link = cfg;
    mc.link.on_event = on_event;
    mc.link.event_user = &mux.link;
    mc.tx_buffer = envelope;
    mc.tx_capacity = sizeof(envelope);
    const int rc = mcpb_mux_init(&mux, &port, &mc, slots, 2);
    if (rc != MCPB_OK)
    {
        fprintf(stderr, "mux init: %s\n", mcpb_strerror(rc));
        return 2;
    }
    targets[0].mux = &mux; targets[0].slot = 0;
    targets[1].mux = &mux; targets[1].slot = 1;

    printf("host-provider %s: dialing %s://%s:%u/providers, slots %s%s and %s\n",
           MCPB_VERSION_STRING, use_tls ? "wss" : "ws", cfg.host, (unsigned)cfg.port,
           cfg.name, cfg.aggregate ? " (joining _all)" : "", name_b);
    fflush(stdout);

    while (!g_stop)
    {
        const char *msg;
        size_t len, slot;
        const int prc = mcpb_mux_poll(&mux, &slot, &msg, &len, 200);
        if (prc == MCPB_ERR_PROTOCOL)
        {
            printf("dropped: %s\n", mux.link.ws.detail);
            continue;
        }
        if (prc != MCPB_OK)
            continue;
        if (slot == MCPB_MUX_UNKNOWN_SLOT)
        {
            printf("rx for an unknown slot (%lu bytes), ignored\n", (unsigned long)len);
            continue;
        }
        serve(slots[slot].name, msg, len, tx, sizeof(tx), send_mux, &targets[slot]);
    }

    mcpb_mux_stop(&mux);
    printf("stopped: connects=%lu disconnects=%lu rx=%lu tx=%lu refused=%lu\n",
           (unsigned long)mux.link.connects, (unsigned long)mux.link.disconnects,
           (unsigned long)mux.link.rx_messages, (unsigned long)mux.link.tx_messages,
           (unsigned long)mux.refused);
    return 0;
#endif
}
