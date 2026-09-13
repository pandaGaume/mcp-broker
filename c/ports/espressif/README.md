# libmcpb port for ESP-IDF

The six functions libmcpb asks for, on esp-tls and lwip: `open` through `esp_tls_conn_new_sync` (TLS via the certificate bundle built into the image, or plain TCP with `is_plain_tcp`), `send` and `recv` through `esp_tls_conn_write` / `esp_tls_conn_read`, `now_ms` on `esp_timer`, `random` on `esp_fill_random`.

The one subtlety is the read timeout: `esp_tls_conn_read` has none, so the socket is watched with `select`, but only after `esp_tls_get_bytes_avail` says mbedTLS holds nothing already decrypted; otherwise a wait on the socket waits for data that has already arrived.

This is the port only: the same shape as [`../host`](../host). It compiles only inside an ESP-IDF build, so the host CMake in `c/` does not build it; the component in [`../../espressif/components/mcpb_esp`](../../espressif/components/mcpb_esp) does, along with libmcpb, and adds the FreeRTOS task, the Kconfig and the events. An application that runs the poll loop itself can use the port without the component.

ESP-IDF 5.1 or later. The arduino-esp32 core is built on ESP-IDF and exposes the same headers (`esp_tls.h`, `lwip/sockets.h`, `esp_timer.h`), so a sketch can compile this file as well; what is IDF-only is the component's packaging in `c/espressif` (`idf_component_register`, Kconfig), not the port. The board does not care either way: an IDF firmware flashes on an Arduino Nano ESP32 like on any S3.
