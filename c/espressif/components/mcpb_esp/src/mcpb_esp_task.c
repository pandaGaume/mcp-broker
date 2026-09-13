/* The provider task. See mcpb_esp.h. */

#include "mcpb_esp.h"
#include "mcpb_port_esp.h"

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

ESP_EVENT_DEFINE_BASE(MCPB_ESP_EVENT);

static const char *TAG = "mcpb";

#define IP_READY_BIT (1u << 0)

/* One outbound message from another task, copied. */
typedef struct
{
    char  *data;
    size_t len;
} tx_item_t;

/* Everything static: the component is a singleton, like the Wi-Fi driver,
 * and a device is one provider. The buffers are sized by Kconfig so the
 * memory cost is visible in menuconfig rather than buried here. */
static struct
{
    mcpb_esp_config_t cfg;
    char     host[MCPB_WS_HOST_MAX];
    char     name[MCPB_PROVIDER_NAME_MAX];
    char     headers[224];

    mcpb_port_esp_t port_ctx;
    mcpb_port_t     port;
    mcpb_provider_t provider;
    uint8_t         rx[CONFIG_MCPB_ESP_RX_BUFFER];
    char            tx[CONFIG_MCPB_ESP_TX_BUFFER];

    TaskHandle_t       task;
    QueueHandle_t      outbox;
    EventGroupHandle_t flags;
    volatile bool      running;
    volatile bool      stop_requested;
    volatile bool      connected;
} s;

/* --- Link events ------------------------------------------------------------ */

static void on_link_event(void *user, const mcpb_event_t *e)
{
    (void)user;
    mcpb_esp_event_t ev;
    memset(&ev, 0, sizeof(ev));
    ev.type = e->type;
    ev.error = e->error;
    ev.at_ms = e->at_ms;
    ev.next_retry_ms = e->next_retry_ms;
    ev.window_ms = e->window_ms;
    ev.attempts = e->attempts;
    ev.down_ms = e->down_ms;
    ev.connects = s.provider.connects;
    ev.close_code = e->close_code;
    ev.http_status = e->http_status;
    strlcpy(ev.reason, e->reason, sizeof(ev.reason));
    strlcpy(ev.detail, e->detail, sizeof(ev.detail));

    s.connected = (e->type == MCPB_EVENT_CONNECTED);

    switch (e->type)
    {
    case MCPB_EVENT_CONNECTED:
        ESP_LOGI(TAG, "connected to %s:%u as \"%s\"%s (down %lu ms, connection #%lu)",
                 s.host, (unsigned)s.provider.cfg.port, s.name,
                 s.cfg.aggregate ? ", _all requested" : "",
                 (unsigned long)e->down_ms, (unsigned long)ev.connects);
        break;
    case MCPB_EVENT_DISCONNECTED:
        /* The incident. Everything the peer said is in the line, because a
         * bare code leaves the operator guessing. */
        ESP_LOGW(TAG, "link lost: %s%s%s (close %u \"%s\"), retry in %lu ms",
                 mcpb_strerror(e->error), e->detail[0] ? ": " : "", e->detail,
                 (unsigned)e->close_code, e->reason,
                 (unsigned long)e->next_retry_ms);
        break;
    case MCPB_EVENT_RETRY_FAILED:
        ESP_LOGW(TAG, "attempt %lu failed: %s%s%s, retry in %lu ms (window %lu ms)",
                 (unsigned long)e->attempts, mcpb_strerror(e->error),
                 e->detail[0] ? ": " : "", e->detail,
                 (unsigned long)e->next_retry_ms, (unsigned long)e->window_ms);
        break;
    case MCPB_EVENT_SLOT_REFUSED:
        /* Multiplexed endpoint only; this task uses the dedicated one. */
        ESP_LOGW(TAG, "slot %lu refused by the broker (%d): %s",
                 (unsigned long)e->slot, e->rpc_code, e->reason);
        break;
    }

    /* No wait: this runs on the provider task, inside libmcpb, and a full
     * default loop must not stall the link. A dropped event is logged. */
    const esp_err_t rc = esp_event_post(MCPB_ESP_EVENT, (int32_t)e->type, &ev, sizeof(ev), 0);
    if (rc != ESP_OK && rc != ESP_ERR_INVALID_STATE)
        ESP_LOGW(TAG, "event not posted: %s", esp_err_to_name(rc));
}

/* --- Network readiness ------------------------------------------------------ */

static void on_ip_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base; (void)data;
    if (id == IP_EVENT_STA_GOT_IP || id == IP_EVENT_ETH_GOT_IP || id == IP_EVENT_PPP_GOT_IP)
        xEventGroupSetBits(s.flags, IP_READY_BIT);
}

/* --- Outbox --------------------------------------------------------------- */

static void drain_outbox(void)
{
    tx_item_t item;
    while (xQueueReceive(s.outbox, &item, 0) == pdTRUE)
    {
        if (mcpb_provider_is_connected(&s.provider))
        {
            const int rc = mcpb_provider_send(&s.provider, item.data, item.len);
            if (rc != MCPB_OK)
                ESP_LOGW(TAG, "queued message dropped: %s", mcpb_strerror(rc));
        }
        else
        {
            /* Nothing is queued across a disconnection (mcpb_provider.h). */
            ESP_LOGW(TAG, "queued message dropped: link down");
        }
        free(item.data);
    }
}

/* --- The task ------------------------------------------------------------- */

static void provider_task(void *arg)
{
    (void)arg;

    if (!s.cfg.no_wait_for_ip)
    {
        ESP_LOGI(TAG, "waiting for an IP address before dialing %s", s.host);
        xEventGroupWaitBits(s.flags, IP_READY_BIT, pdFALSE, pdFALSE, portMAX_DELAY);
    }
    ESP_LOGI(TAG, "dialing %s://%s:%u%s%s", s.cfg.tls ? "wss" : "ws", s.host,
             (unsigned)s.provider.cfg.port, s.provider.path,
             s.cfg.aggregate ? " (_all requested)" : "");

    while (!s.stop_requested)
    {
        drain_outbox();

        const char *msg;
        size_t len;
        const int rc = mcpb_provider_poll(&s.provider, &msg, &len, CONFIG_MCPB_ESP_POLL_MS);
        if (rc != MCPB_OK)
            continue; /* TIMEOUT is the idle case; failures were announced */

        const int n = s.cfg.handler(s.cfg.handler_user, msg, len, s.tx, sizeof(s.tx));
        if (n < 0)
        {
            ESP_LOGW(TAG, "handler refused a %u-byte message (%d)", (unsigned)len, n);
        }
        else if (n > 0)
        {
            const int src = mcpb_provider_send(&s.provider, s.tx, (size_t)n);
            if (src != MCPB_OK)
                ESP_LOGW(TAG, "reply not sent: %s", mcpb_strerror(src));
        }
    }

    mcpb_provider_stop(&s.provider);
    s.connected = false;
    drain_outbox();
    s.running = false;
    s.task = NULL;
    vTaskDelete(NULL);
}

/* --- API ------------------------------------------------------------------ */

static esp_err_t default_name(char *out, size_t cap)
{
    uint8_t mac[6];
    const esp_err_t rc = esp_read_mac(mac, ESP_MAC_WIFI_STA);
    if (rc != ESP_OK)
        return rc;
    snprintf(out, cap, "esp32-%02X%02X%02X", mac[3], mac[4], mac[5]);
    return ESP_OK;
}

esp_err_t mcpb_esp_start(const mcpb_esp_config_t *cfg)
{
    if (cfg == NULL || cfg->handler == NULL || cfg->host == NULL)
        return ESP_ERR_INVALID_ARG;
    if (strlen(cfg->host) >= sizeof(s.host))
        return ESP_ERR_INVALID_ARG;
    if (cfg->name != NULL && (cfg->name[0] == 0 || strlen(cfg->name) >= sizeof(s.name)))
        return ESP_ERR_INVALID_ARG;
    if (s.running)
        return ESP_ERR_INVALID_STATE;

    memset(&s, 0, sizeof(s));
    s.cfg = *cfg;
    strlcpy(s.host, cfg->host, sizeof(s.host));
    if (cfg->name != NULL)
        strlcpy(s.name, cfg->name, sizeof(s.name));
    else
    {
        const esp_err_t rc = default_name(s.name, sizeof(s.name));
        if (rc != ESP_OK)
            return rc;
    }
    if (cfg->token != NULL)
    {
        const int n = snprintf(s.headers, sizeof(s.headers), "X-Provider-Token: %s\r\n", cfg->token);
        if (n < 0 || (size_t)n >= sizeof(s.headers))
            return ESP_ERR_INVALID_ARG;
    }

    if (mcpb_port_esp_init(&s.port, &s.port_ctx) != MCPB_OK)
        return ESP_FAIL;

    mcpb_provider_config_t pc;
    memset(&pc, 0, sizeof(pc));
    pc.host = s.host;
    pc.port = cfg->port;
    pc.tls = cfg->tls;
    pc.name = s.name;
    pc.aggregate = cfg->aggregate;
    pc.extra_headers = (cfg->token != NULL) ? s.headers : NULL;
    pc.retry_initial_ms = cfg->retry_initial_ms;
    pc.retry_max_ms = cfg->retry_max_ms;
    pc.ping_interval_ms = cfg->ping_interval_ms;
    pc.connect_timeout_ms = cfg->connect_timeout_ms;
    pc.handshake_timeout_ms = cfg->handshake_timeout_ms;
    pc.rx_buffer = s.rx;
    pc.rx_capacity = sizeof(s.rx);
    pc.on_event = on_link_event;
    pc.event_user = NULL;

    const int rc = mcpb_provider_init(&s.provider, &s.port, &pc);
    if (rc != MCPB_OK)
    {
        ESP_LOGE(TAG, "provider init: %s", mcpb_strerror(rc));
        return (rc == MCPB_ERR_ARG || rc == MCPB_ERR_TOO_LARGE) ? ESP_ERR_INVALID_ARG : ESP_FAIL;
    }

    s.flags = xEventGroupCreate();
    s.outbox = xQueueCreate(CONFIG_MCPB_ESP_TX_QUEUE_LEN, sizeof(tx_item_t));
    if (s.flags == NULL || s.outbox == NULL)
        goto nomem;

    if (!cfg->no_wait_for_ip)
    {
        /* ESP_ERR_INVALID_STATE here means no default loop yet: then the
         * application has not started networking either, and the task would
         * wait forever. Say so instead. */
        const esp_err_t er = esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, on_ip_event, NULL);
        if (er != ESP_OK)
        {
            ESP_LOGE(TAG, "cannot watch IP_EVENT (%s): create the default event loop first, "
                          "or set no_wait_for_ip", esp_err_to_name(er));
            goto fail;
        }
    }

    s.running = true;
    s.stop_requested = false;
    const BaseType_t ok = xTaskCreatePinnedToCore(
        provider_task, "mcpb", CONFIG_MCPB_ESP_TASK_STACK, NULL,
        CONFIG_MCPB_ESP_TASK_PRIORITY, &s.task,
        (CONFIG_MCPB_ESP_TASK_CORE < 0) ? tskNO_AFFINITY : CONFIG_MCPB_ESP_TASK_CORE);
    if (ok != pdPASS)
    {
        s.running = false;
        goto nomem;
    }
    return ESP_OK;

nomem:
    ESP_LOGE(TAG, "out of memory starting the provider task");
fail:
    if (!cfg->no_wait_for_ip)
        esp_event_handler_unregister(IP_EVENT, ESP_EVENT_ANY_ID, on_ip_event);
    if (s.outbox) vQueueDelete(s.outbox);
    if (s.flags) vEventGroupDelete(s.flags);
    s.outbox = NULL;
    s.flags = NULL;
    return ESP_ERR_NO_MEM;
}

esp_err_t mcpb_esp_stop(void)
{
    if (!s.running)
        return ESP_ERR_INVALID_STATE;

    s.stop_requested = true;
    /* The task may be blocked waiting for an IP: release it so it sees the
     * flag. */
    xEventGroupSetBits(s.flags, IP_READY_BIT);
    while (s.running)
        vTaskDelay(pdMS_TO_TICKS(10));

    if (!s.cfg.no_wait_for_ip)
        esp_event_handler_unregister(IP_EVENT, ESP_EVENT_ANY_ID, on_ip_event);
    vQueueDelete(s.outbox);
    vEventGroupDelete(s.flags);
    s.outbox = NULL;
    s.flags = NULL;
    return ESP_OK;
}

esp_err_t mcpb_esp_send(const char *json, size_t len)
{
    if (json == NULL)
        return ESP_ERR_INVALID_ARG;
    if (!s.running || !s.connected)
        return ESP_ERR_INVALID_STATE;

    tx_item_t item;
    item.data = (char *)malloc(len);
    if (item.data == NULL)
        return ESP_ERR_NO_MEM;
    memcpy(item.data, json, len);
    item.len = len;
    if (xQueueSend(s.outbox, &item, 0) != pdTRUE)
    {
        free(item.data);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

bool mcpb_esp_is_connected(void)
{
    return s.running && s.connected;
}

const char *mcpb_esp_slot_name(void)
{
    return s.name;
}
