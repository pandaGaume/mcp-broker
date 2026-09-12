/* host-provider: the smallest provider that proves the transport end to end.
 *
 * It dials the broker with libmcpb over the host port, optionally joins
 * `_all`, and serves one tool, `echo`, from static strings. There is no JSON
 * parser here on purpose: libmcpb carries bytes, and this file shows exactly
 * what the layer above the transport must supply and nothing more:
 *
 *   1. find the method,
 *   2. echo the request id VERBATIM, quotes and type included, because the
 *      broker allocates string ids ("brk-7") and drops a reply whose id does
 *      not match byte for byte,
 *   3. answer initialize, ping, tools/list and tools/call, ignore
 *      notifications, refuse the rest with -32601.
 *
 * A real device does these with its own JSON layer. The string scanning
 * below is enough for the frames the broker sends and would not survive a
 * hostile client; it is not a parser and does not pretend to be one.
 *
 * Every link event is printed as one line, so a test (or an operator) can
 * follow the connection without reading the code:
 *
 *   event CONNECTED down_ms=12 connects=1
 *   event DISCONNECTED error=peer closed code=1006 reason="" next_retry_ms=173
 *   event RETRY_FAILED error=handshake failed http_status=401 attempts=3
 *
 * Usage:
 *   host-provider [--host H] [--port P] [--name N] [--aggregate] [--token T]
 *                 [--retry-initial MS] [--retry-max MS]
 */

#include "mcpb/mcpb_provider.h"
#include "mcpb_port_host.h"

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

/* --- Just enough scanning for the broker's frames -------------------------- */

/* Copies the value of the first `"key":"..."` after `from` into `out`.
 * Returns the length, or -1 when absent. No escape handling beyond skipping
 * a backslashed quote: enough for a method name or a protocol version. */
static int scan_string(const char *from, const char *end, const char *key,
                       char *out, size_t cap)
{
    const size_t klen = strlen(key);
    const char *p = from;
    while (p + klen + 3 < end)
    {
        if (p[0] == '"' && memcmp(p + 1, key, klen) == 0 && p[klen + 1] == '"')
        {
            const char *v = p + klen + 2;
            while (v < end && (*v == ' ' || *v == ':')) v++;
            if (v >= end || *v != '"') return -1;
            v++;
            size_t n = 0;
            while (v < end && *v != '"' && n + 1 < cap)
            {
                if (*v == '\\' && v + 1 < end) v++;
                out[n++] = *v++;
            }
            out[n] = 0;
            return (int)n;
        }
        p++;
    }
    return -1;
}

/* Copies the raw token after `"id":` into `out`: a quoted string with its
 * quotes, a number, or null. That raw form is what goes back in the reply,
 * untouched. Returns -1 for a notification (no id). */
static int scan_id(const char *json, const char *end, char *out, size_t cap)
{
    const char *p = json;
    while (p + 5 < end)
    {
        if (memcmp(p, "\"id\"", 4) == 0)
        {
            const char *v = p + 4;
            while (v < end && (*v == ' ' || *v == ':')) v++;
            size_t n = 0;
            if (v < end && *v == '"')
            {
                out[n++] = *v++;
                while (v < end && n + 2 < cap)
                {
                    const char c = *v++;
                    out[n++] = c;
                    if (c == '\\' && v < end) out[n++] = *v++;
                    else if (c == '"') break;
                }
            }
            else
            {
                while (v < end && n + 1 < cap && *v != ',' && *v != '}' &&
                       *v != ' ' && *v != '\r' && *v != '\n')
                    out[n++] = *v++;
            }
            out[n] = 0;
            return (int)n;
        }
        p++;
    }
    return -1;
}

/* Appends `s` to `out` as a JSON string body, escaping what RFC 8259
 * requires. Returns the new length, or -1 when it does not fit. */
static int json_escape_append(char *out, size_t cap, size_t len, const char *s)
{
    for (; *s != 0; s++)
    {
        const unsigned char c = (unsigned char)*s;
        const char *esc = NULL;
        char buf[8];
        switch (c)
        {
        case '"':  esc = "\\\""; break;
        case '\\': esc = "\\\\"; break;
        case '\n': esc = "\\n";  break;
        case '\r': esc = "\\r";  break;
        case '\t': esc = "\\t";  break;
        default:
            if (c < 0x20)
            {
                snprintf(buf, sizeof(buf), "\\u%04x", (unsigned)c);
                esc = buf;
            }
        }
        const size_t n = esc ? strlen(esc) : 1u;
        if (len + n + 1 > cap) return -1;
        if (esc) memcpy(out + len, esc, n); else out[len] = (char)c;
        len += n;
    }
    out[len] = 0;
    return (int)len;
}

/* --- The MCP surface, static ------------------------------------------------ */

static const char *TOOLS_LIST =
    "{\"tools\":[{\"name\":\"echo\","
    "\"description\":\"Returns the text it was given, prefixed with the slot name. "
    "Proves the tunnel end to end: client, broker, this process, and back.\","
    "\"inputSchema\":{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},"
    "\"required\":[\"text\"]}}]}";

/* Builds the reply to one incoming frame into `tx`. Returns its length, 0 for
 * no reply (a notification), negative when it does not fit. */
static int handle(const char *name, const char *json, size_t len,
                  char *tx, size_t cap)
{
    const char *end = json + len;
    char id[128], method[64];

    if (scan_id(json, end, id, sizeof(id)) < 0)
        return 0; /* notification: nothing to answer */
    if (scan_string(json, end, "method", method, sizeof(method)) < 0)
        return 0; /* a response to something we never sent */

    int n;
    if (strcmp(method, "initialize") == 0)
    {
        /* Answer with the version the client asked for. A server that
         * insists on its own makes every client renegotiate for nothing. */
        char version[32];
        if (scan_string(json, end, "protocolVersion", version, sizeof(version)) < 0)
            strcpy(version, "2025-06-18");
        n = snprintf(tx, cap,
                     "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{"
                     "\"protocolVersion\":\"%s\",\"capabilities\":{\"tools\":{}},"
                     "\"serverInfo\":{\"name\":\"host-provider\",\"version\":\"" MCPB_VERSION_STRING "\"}}}",
                     id, version);
    }
    else if (strcmp(method, "ping") == 0)
    {
        n = snprintf(tx, cap, "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{}}", id);
    }
    else if (strcmp(method, "tools/list") == 0)
    {
        n = snprintf(tx, cap, "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":%s}", id, TOOLS_LIST);
    }
    else if (strcmp(method, "tools/call") == 0)
    {
        char tool[64], text[1024];
        const char *params = strstr(json, "\"params\"");
        if (params == NULL || scan_string(params, end, "name", tool, sizeof(tool)) < 0 ||
            strcmp(tool, "echo") != 0)
        {
            n = snprintf(tx, cap,
                         "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"content\":[{\"type\":\"text\","
                         "\"text\":\"unknown tool; this provider serves echo only\"}],\"isError\":true}}",
                         id);
        }
        else
        {
            if (scan_string(params, end, "text", text, sizeof(text)) < 0)
                text[0] = 0;
            n = snprintf(tx, cap,
                         "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"",
                         id);
            if (n < 0 || (size_t)n >= cap) return -1;
            n = json_escape_append(tx, cap, (size_t)n, name);
            if (n < 0) return -1;
            n = json_escape_append(tx, cap, (size_t)n, ": ");
            if (n < 0) return -1;
            n = json_escape_append(tx, cap, (size_t)n, text);
            if (n < 0) return -1;
            const char *tail = "\"}]}}";
            if ((size_t)n + strlen(tail) + 1 > cap) return -1;
            strcpy(tx + n, tail);
            n += (int)strlen(tail);
        }
    }
    else
    {
        n = snprintf(tx, cap,
                     "{\"jsonrpc\":\"2.0\",\"id\":%s,\"error\":{\"code\":-32601,"
                     "\"message\":\"Method not found: %s\"}}",
                     id, method);
    }

    if (n < 0 || (size_t)n >= cap)
        return -1;
    return n;
}

/* --- Link events, one line each --------------------------------------------- */

static void on_event(void *user, const mcpb_event_t *e)
{
    const mcpb_provider_t *p = (const mcpb_provider_t *)user;
    switch (e->type)
    {
    case MCPB_EVENT_CONNECTED:
        printf("event CONNECTED down_ms=%lu connects=%lu\n",
               (unsigned long)e->down_ms, (unsigned long)p->connects);
        break;
    case MCPB_EVENT_DISCONNECTED:
        printf("event DISCONNECTED error=\"%s\" code=%u reason=\"%s\" next_retry_ms=%lu\n",
               mcpb_strerror(e->error), (unsigned)e->close_code, e->reason,
               (unsigned long)e->next_retry_ms);
        break;
    case MCPB_EVENT_RETRY_FAILED:
        printf("event RETRY_FAILED error=\"%s\" http_status=%d attempts=%lu next_retry_ms=%lu\n",
               mcpb_strerror(e->error), e->http_status,
               (unsigned long)e->attempts, (unsigned long)e->next_retry_ms);
        break;
    }
    fflush(stdout);
}

/* --- main ------------------------------------------------------------------- */

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
        if (scan_string(msg, msg + len, "method", method, sizeof(method)) < 0)
            strcpy(method, "(response)");
        printf("rx %s (%lu bytes)\n", method, (unsigned long)len);

        const int n = handle(cfg.name, msg, len, tx, sizeof(tx));
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
