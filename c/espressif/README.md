# mcp-broker on ESP-IDF

The ESP32 side of the tunnel: an IDF component that runs [`libmcpb`](../libmcpb/) on its [Espressif port](../ports/espressif/) inside one FreeRTOS task, and a sample project that publishes a device as a broker slot over Wi-Fi.

```
../ports/espressif/       the port: libmcpb's six functions on esp-tls and lwip
components/mcpb_esp/      the component: the task, Kconfig, events; compiles the port and libmcpb
samples/provider/         Wi-Fi station + the transport-only echo provider
```

Developed on ESP-IDF 6.0 for the ESP32-S3; the component uses nothing S3-specific and needs IDF 5.1 or later.

## The port: `ports/espressif`

[`mcpb_port_esp.h`](../ports/espressif/include/mcpb_port_esp.h) is the six-function port libmcpb asks for, the same shape as [`ports/host`](../ports/host/): `open` over `esp_tls_conn_new_sync` (TLS through the certificate bundle built into the image or through the private CA in `ca_pem`, or plain TCP with `is_plain_tcp`), `send` and `recv` over `esp_tls_conn_write` / `esp_tls_conn_read`, `now_ms` on `esp_timer`, `random` on `esp_fill_random`. The one subtlety is the read timeout: `esp_tls_conn_read` has none, so the socket is watched with `select`, but only after `esp_tls_get_bytes_avail` says mbedTLS holds nothing already decrypted, otherwise a wait on the socket waits for data that has already arrived. Usable alone by an application that runs the poll loop itself. It compiles only inside an IDF build, which is why the component below is what compiles it.

## The component: `mcpb_esp`

[`mcpb_esp.h`](components/mcpb_esp/include/mcpb_esp.h) is what an application uses: one task that dials, keeps the link alive, reconnects, and calls your handler for every incoming JSON-RPC message.

```c
static int handle(void *user, const char *json, size_t len, char *tx, size_t cap)
{
    /* your JSON layer: parse, dispatch, write the reply into tx */
    return reply_len; /* 0 for a notification */
}

mcpb_esp_config_t cfg = {
    .host = "broker.example.com",
    .port = 443,
    .tls = true,
    .name = NULL,          /* "esp32-" + last three bytes of the station MAC */
    .aggregate = true,     /* also join _all */
    .handler = handle,
};
ESP_ERROR_CHECK(mcpb_esp_start(&cfg));
```

`mcpb_esp_start` returns at once; the task waits for `IP_EVENT_*_GOT_IP` before its first attempt (`no_wait_for_ip` disables that), so nothing is doubled in the retry window before there is a network to reach. `mcpb_esp_send` queues a message from any other task, for notifications and late results; `mcpb_esp_stop` closes the link and ends the task.

Link events are posted on the default `esp_event` loop as `MCPB_ESP_EVENT`, ids `CONNECTED`, `DISCONNECTED`, `RETRY_FAILED`, data `mcpb_esp_event_t`. That is where an alarm belongs: the event is posted at the instant of the loss, before the jittered retry wait, and never from inside libmcpb's own callback. `DISCONNECTED` carries the broker's close code and reason (a `1008` names the transport/path mismatch or the policy that refused), `RETRY_FAILED` the HTTP status of a refused handshake (401 or 403 is authentication).

Sizes are Kconfig, under *mcp-broker provider (mcpb_esp)* in menuconfig: receive buffer (8 KB), reply buffer (4 KB), task stack (6 KB, size it for your JSON layer), priority, core, poll period, outbox depth. All static except the outbox copies.

Footprint on the S3 with the defaults: 7.4 KB of flash code and 13 KB of RAM, of which 12 KB are the two buffers.

The component compiles libmcpb and the port straight from `../../../libmcpb` and `../../../ports/espressif`, the single copies in this repository. That is why it is not on the Espressif component registry yet: a registry package must be self-contained, so publishing is a vendoring step for the day it is wanted, not a layout change.

## The sample: `samples/provider`

The same static `echo` tool as [`samples/host-provider`](../samples/host-provider/), compiled from the same file (`../samples/lib/static_provider.c`), on a Wi-Fi station. What it proves is the device side: esp-tls, the port, the task, the events, and a slot that comes back by itself after the broker or the Wi-Fi goes away.

```bash
cd c/espressif/samples/provider
idf.py set-target esp32s3
idf.py menuconfig          # Provider sample: Wi-Fi SSID/password, broker host/port, TLS, slot name, token
idf.py build flash monitor
```

Then, from any MCP client, `tools/call echo {"text":"hi"}` on `http://<broker>:3000/<slot>/mcp`, or `<slot>-echo` on `/_all/mcp`. The monitor prints one line per link event, in the same format as the host sample:

```
I (5210) sample: event CONNECTED down_ms=4980 connects=1
W (61044) mcpb: link lost: transport failure (close 0 ""), retry in 733 ms
I (61045) sample: event DISCONNECTED error="transport failure" code=0 reason="" next_retry_ms=733
```

Kill the broker, watch `DISCONNECTED` then `RETRY_FAILED` with the window doubling, restart it, and see `CONNECTED ... connects=2`. Switch the access point off for the same on the Wi-Fi side. On a broker with provider authentication, set the token in menuconfig; without it the monitor shows `RETRY_FAILED ... http_status=401`.

The broker the board dials is the one of this repository, started from `node/packages/broker` with `npm start` (see [c/README.md](../README.md#try-it-against-a-broker)); `CONFIG_SAMPLE_BROKER_HOST` is the PC's LAN address. Two things seen on a first board run worth knowing. The broker must listen beyond the loopback, which `npm start` does by default (`0.0.0.0`); a config that sets `host` to `127.0.0.1` makes it unreachable from the device, and the monitor shows attempts failing. And an attempt made right after a broker kill was once seen to last the whole connect timeout and then succeed, with no `RETRY_FAILED` in between, while attempts against a port that stays closed fail at once; a short broker restart can therefore show one long attempt instead of a failure line. `_all` membership needs a broker of 1.3.0 or later.

A `link lost: protocol violation` line means the device itself refused a frame. Since 0.2.0 the line carries the rule and the two header bytes it read (`rsv bits set, header C1 02`), which is what separates a real violation from a stream that went out of sync: report it with the bytes.

`sdkconfig`, `build/` and `.vscode/` are ignored: the ESP-IDF VS Code extension writes machine-specific paths into the latter, add yours locally.

## CI

`ci-c.yml` builds this sample for the S3 in the official `espressif/idf:v6.0` image on every change under `c/`. No hardware in CI: it proves the component compiles against the IDF it targets, and that libmcpb still passes `-Wconversion -Wshadow -Wstrict-prototypes` on Xtensa. Running it is a board's job.
