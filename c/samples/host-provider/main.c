/* host-provider: the smallest provider that proves the transport end to end.
 *
 * It dials the broker with libmcpb over the host port, optionally joins
 * `_all`, and serves one tool, `echo`, from static strings (see
 * ../lib/static_provider.h for what that layer does and does not do). Every
 * link event is printed as one line, so a test or an operator can follow the
 * connection without reading the code.
 *
 * Usage:
 *   host-provider [--host H] [--port P] [--name N] [--aggregate] [--token T]
 *                 [--retry-initial MS] [--retry-max MS]
 */

#include "mcpb/mcpb_provider.h"
#include "mcpb_port_host.h"
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

static void on_event(void *user, const mcpb_event_t *e)
{
    const mcpb_provider_t *p = (const mcpb_provider_t *)user;
    char line[256];
    static_provider_event_line(e, (unsigned long)p->connects, line, sizeof(line));
    puts(line);
    fflush(stdout);
}

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

    mcpb_port_host_t host_ctx;
    mcpb_port_t port;
    if (mcpb_port_host_init(&port, &host_ctx) != MCPB_OK)
    {
        fprintf(stderr, "host port: initialisation failed\n");
        return 2;
    }

    mcpb_provider_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.host = arg(argc, argv, "--host", "127.0.0.1");
    cfg.port = (uint16_t)atoi(arg(argc, argv, "--port", "3000"));
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

    mcpb_provider_t provider;
    cfg.on_event = on_event;
    cfg.event_user = &provider;
    const int rc = mcpb_provider_init(&provider, &port, &cfg);
    if (rc != MCPB_OK)
    {
        fprintf(stderr, "provider init: %s\n", mcpb_strerror(rc));
        return 2;
    }

    printf("host-provider %s: dialing ws://%s:%u%s%s\n", MCPB_VERSION_STRING,
           cfg.host, (unsigned)cfg.port, provider.path,
           cfg.aggregate ? " (joining _all)" : "");
    fflush(stdout);

    signal(SIGINT, on_sigint);
    signal(SIGTERM, on_sigint);

    while (!g_stop)
    {
        const char *msg;
        size_t len;
        const int prc = mcpb_provider_poll(&provider, &msg, &len, 200);
        if (prc != MCPB_OK)
            continue; /* TIMEOUT is the idle case; failures were announced */

        char method[64];
        static_provider_method(msg, len, method, sizeof(method));
        printf("rx %s (%lu bytes)\n", method, (unsigned long)len);

        const int n = static_provider_handle(cfg.name, msg, len, tx, sizeof(tx));
        if (n < 0)
        {
            printf("tx skipped: reply does not fit in %d bytes\n", TX_CAPACITY);
        }
        else if (n > 0)
        {
            const int src = mcpb_provider_send(&provider, tx, (size_t)n);
            printf("tx %s (%d bytes)%s\n", method, n,
                   src == MCPB_OK ? "" : " FAILED, link lost");
        }
        fflush(stdout);
    }

    mcpb_provider_stop(&provider);
    printf("stopped: connects=%lu disconnects=%lu rx=%lu tx=%lu\n",
           (unsigned long)provider.connects, (unsigned long)provider.disconnects,
           (unsigned long)provider.rx_messages, (unsigned long)provider.tx_messages);
    return 0;
}
