/* provider: the transport-only sample on ESP32.
 *
 * Wi-Fi station, then the mcpb_esp task. The MCP surface is the same static
 * `echo` tool the host sample serves (../../../../samples/lib), so what this
 * proves is the device side of the tunnel: esp-tls, the port, the task, the
 * events, and a slot that comes back by itself after the broker or the Wi-Fi
 * goes away.
 *
 * A real firmware replaces `handle` with its own JSON layer and keeps the
 * rest. Run it, then from any MCP client:
 *
 *   tools/call echo {"text":"hi"}   on  http://<broker>:3000/<slot>/mcp
 *   tools/call <slot>-echo          on  http://<broker>:3000/_all/mcp
 *
 * and watch the monitor: one log line per link event, before any retry wait.
 */

#include "mcpb_esp.h"
#include "static_provider.h"
#include "wifi.h"

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

static const char *TAG = "sample";

/* A bool Kconfig option set to n is not defined at all, not defined to 0. */
#ifdef CONFIG_SAMPLE_BROKER_TLS
#  define SAMPLE_TLS true
#else
#  define SAMPLE_TLS false
#endif
#ifdef CONFIG_SAMPLE_BROKER_AGGREGATE
#  define SAMPLE_AGGREGATE true
#else
#  define SAMPLE_AGGREGATE false
#endif

/* Runs on the provider task. The slot name is read back from the component
 * because it may have been derived from the MAC. */
static int handle(void *user, const char *json, size_t len, char *tx, size_t cap)
{
    (void)user;
    char method[64];
    static_provider_method(json, len, method, sizeof(method));
    ESP_LOGI(TAG, "rx %s (%u bytes)", method, (unsigned)len);
    return static_provider_handle(mcpb_esp_slot_name(), json, len, tx, cap);
}

/* Where an alarm would hang. This one only logs, in the same line format as
 * the host sample, so the two are comparable side by side. */
static void on_link(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base; (void)id;
    const mcpb_esp_event_t *e = (const mcpb_esp_event_t *)data;

    mcpb_event_t ev;
    ev.type = e->type;
    ev.error = e->error;
    ev.at_ms = e->at_ms;
    ev.next_retry_ms = e->next_retry_ms;
    ev.window_ms = e->window_ms;
    ev.attempts = e->attempts;
    ev.down_ms = e->down_ms;
    ev.close_code = e->close_code;
    ev.http_status = e->http_status;
    ev.reason = e->reason;

    char line[256];
    static_provider_event_line(&ev, (unsigned long)e->connects, line, sizeof(line));
    ESP_LOGI(TAG, "%s", line);
}

void app_main(void)
{
    esp_err_t rc = nvs_flash_init();
    if (rc == ESP_ERR_NVS_NO_FREE_PAGES || rc == ESP_ERR_NVS_NEW_VERSION_FOUND)
    {
        ESP_ERROR_CHECK(nvs_flash_erase());
        rc = nvs_flash_init();
    }
    ESP_ERROR_CHECK(rc);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    ESP_ERROR_CHECK(esp_event_handler_register(MCPB_ESP_EVENT, ESP_EVENT_ANY_ID, on_link, NULL));

    wifi_start_station();

    mcpb_esp_config_t cfg = {
        .host = CONFIG_SAMPLE_BROKER_HOST,
        .port = CONFIG_SAMPLE_BROKER_PORT,
        .tls = SAMPLE_TLS,
        .name = (CONFIG_SAMPLE_BROKER_SLOT[0] != 0) ? CONFIG_SAMPLE_BROKER_SLOT : NULL,
        .token = (CONFIG_SAMPLE_BROKER_TOKEN[0] != 0) ? CONFIG_SAMPLE_BROKER_TOKEN : NULL,
        .aggregate = SAMPLE_AGGREGATE,
        .handler = handle,
    };
    /* Starts now, dials once the station has an address. */
    ESP_ERROR_CHECK(mcpb_esp_start(&cfg));
    ESP_LOGI(TAG, "provider task started, slot \"%s\"", mcpb_esp_slot_name());

    for (;;)
    {
        vTaskDelay(pdMS_TO_TICKS(30000));
        ESP_LOGI(TAG, "%s, free heap %u", mcpb_esp_is_connected() ? "connected" : "offline",
                 (unsigned)esp_get_free_heap_size());
    }
}
