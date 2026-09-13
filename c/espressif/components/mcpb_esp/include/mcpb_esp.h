#ifndef MCPB_ESP_H
#define MCPB_ESP_H

/* mcpb_esp: libmcpb on ESP-IDF.
 *
 * Two pieces. The port (mcpb_port_esp.h) puts libmcpb on esp-tls and lwip,
 * TLS included through the certificate bundle built into the image. This
 * file is the piece an application actually uses: one FreeRTOS task that
 * dials the broker, keeps the link alive, reconnects, and hands every
 * incoming JSON-RPC message to the handler you give it, on that task.
 *
 * Link events go to the default esp_event loop as MCPB_ESP_EVENT, so a
 * component that raises an alarm on a lost link subscribes there, the way it
 * does for WIFI_EVENT, and is never called from inside libmcpb (which
 * forbids calling mcpb_provider_* from its sink). The event is posted
 * BEFORE the retry wait, at the instant of the loss; see
 * mcpb_provider.h, "Critical systems: the notification is immediate".
 *
 * What the broker expects of the device, and what this task guarantees:
 * the task polls every CONFIG_MCPB_ESP_POLL_MS, far inside the broker's
 * 30 s heartbeat, and answers the broker's ping from inside the poll. Your
 * handler must return within the broker's 60 s request timeout; a tool
 * that needs longer answers first and reports later with mcpb_esp_send.
 *
 * Nothing here is thread-safe except mcpb_esp_send and the read-only
 * queries: libmcpb is single-threaded by design, and the provider task is
 * the only one that touches it.
 */

#include "mcpb/mcpb_provider.h"

#include "esp_err.h"
#include "esp_event_base.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

ESP_EVENT_DECLARE_BASE(MCPB_ESP_EVENT);

/* Event ids on MCPB_ESP_EVENT. Same values as mcpb_event_type_t. */
typedef enum
{
    MCPB_ESP_EVENT_CONNECTED    = MCPB_EVENT_CONNECTED,
    MCPB_ESP_EVENT_DISCONNECTED = MCPB_EVENT_DISCONNECTED,
    MCPB_ESP_EVENT_RETRY_FAILED = MCPB_EVENT_RETRY_FAILED
} mcpb_esp_event_id_t;

/* The event data: mcpb_event_t with the reason inlined. esp_event copies
 * the struct it is handed, so the pointer libmcpb gives would dangle. */
typedef struct
{
    mcpb_event_type_t type;
    int      error;          /* mcpb_err_t; MCPB_OK for CONNECTED */
    uint32_t at_ms;
    uint32_t next_retry_ms;
    uint32_t window_ms;
    uint32_t attempts;       /* consecutive failures; escalate on this */
    uint32_t down_ms;        /* CONNECTED: how long the link was missing */
    uint32_t connects;       /* 1 on the first connection */
    uint16_t close_code;     /* with error == MCPB_ERR_CLOSED */
    int      http_status;    /* with error == MCPB_ERR_HANDSHAKE */
    char     reason[MCPB_WS_CLOSE_REASON_MAX]; /* "" when the peer sent none */
    char     detail[MCPB_WS_DETAIL_MAX];       /* the library's own refusal, or "" */
} mcpb_esp_event_t;

/* Called on the provider task for every incoming JSON-RPC message. Write
 * the reply into `tx` (at most `cap` bytes) and return its length; 0 for no
 * reply (a notification); negative to drop the message, which is logged.
 * `json` is valid until the handler returns. */
typedef int (*mcpb_esp_handler_t)(void *user, const char *json, size_t len,
                                  char *tx, size_t cap);

typedef struct
{
    const char *host;           /* copied; at most MCPB_WS_HOST_MAX - 1 bytes */
    uint16_t    port;           /* 0: 80, or 443 with tls */
    bool        tls;            /* wss:// through the certificate bundle */

    /* Slot name, copied. NULL: "esp32-" plus the last three bytes of the
     * station MAC, so a fleet of identical firmwares gets distinct slots
     * without configuration. */
    const char *name;

    /* NULL, or sent as X-Provider-Token for a broker with provider
     * authentication. Copied. */
    const char *token;

    bool aggregate;             /* also join the _all aggregate slot */

    /* 0 takes libmcpb's defaults: 1000 / 30000 / 30000 / 10000 / 5000. */
    uint32_t retry_initial_ms;
    uint32_t retry_max_ms;
    uint32_t ping_interval_ms;
    int      connect_timeout_ms;
    int      handshake_timeout_ms;

    mcpb_esp_handler_t handler; /* required */
    void              *handler_user;

    /* Default true: the task waits for IP_EVENT_*_GOT_IP before its first
     * attempt. Without it, attempts made before the network is up fail and
     * double the retry window, so the device may sit out up to retry_max_ms
     * once the network is finally there. Set to false when the interface is
     * already up at start, or is not one that raises IP_EVENT. */
    bool no_wait_for_ip;
} mcpb_esp_config_t;

/* Starts the provider task. The config is copied. Buffers, task stack and
 * queue depth come from Kconfig (CONFIG_MCPB_ESP_*).
 *
 * @return ESP_OK, ESP_ERR_INVALID_ARG (no handler, host too long, bad
 *         name), ESP_ERR_INVALID_STATE (already started), ESP_ERR_NO_MEM. */
esp_err_t mcpb_esp_start(const mcpb_esp_config_t *cfg);

/* Closes the link and stops the task. Blocks until the task has exited. */
esp_err_t mcpb_esp_stop(void);

/* Sends an already-serialised JSON-RPC message from ANY task: queued, and
 * sent by the provider task between two polls. For notifications and late
 * results. The bytes are copied.
 *
 * Nothing survives a disconnection: a message queued while the link is
 * down, or before it comes back, is dropped with a warning, for the reason
 * mcpb_provider.h gives under "Nothing is queued".
 *
 * @return ESP_OK, ESP_ERR_INVALID_STATE (not started, or link down),
 *         ESP_ERR_NO_MEM (queue full, or no heap for the copy). */
esp_err_t mcpb_esp_send(const char *json, size_t len);

bool mcpb_esp_is_connected(void);

/* The slot name in use, after the MAC default was applied. Valid after
 * mcpb_esp_start. */
const char *mcpb_esp_slot_name(void);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_ESP_H */
