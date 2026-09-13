#ifndef MCPB_PORT_ESP_H
#define MCPB_PORT_ESP_H

/* libmcpb port for ESP-IDF: esp-tls over lwip.
 *
 * esp-tls does the connection, the TLS handshake and the encryption, and
 * carries the certificate bundle built into the image, so wss:// to a
 * public broker needs no certificate in the firmware. Plain ws:// goes
 * through the same object with is_plain_tcp, so both paths share one
 * read/write/close.
 *
 * The one point that needs care is the read timeout. esp_tls_conn_read
 * takes none: the underlying socket has to be watched with select. But the
 * socket alone is not enough, because mbedTLS may have decrypted a whole
 * record and be holding part of it while the socket has nothing left to
 * offer; waiting in that state waits for data that has already arrived. So
 * esp_tls_get_bytes_avail is consulted BEFORE any select.
 *
 * Usable on its own, without the task in mcpb_esp.h, by an application that
 * runs the poll loop itself.
 *
 * Needs the ESP-IDF headers (esp-tls, lwip, FreeRTOS, esp_timer), so the
 * host CMake in c/ does not build it; the component in
 * c/espressif/components/mcpb_esp compiles it from here, along with libmcpb.
 * The arduino-esp32 core is built on ESP-IDF and exposes the same headers,
 * so a sketch can compile this file too; what is IDF-only is the
 * component's packaging (idf_component_register, Kconfig), not the port.
 */

#include "mcpb/mcpb_port.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct
{
    void *tls;        /* esp_tls_t *, NULL when closed */
    int   fd;         /* the socket under it, -1 when closed */
    int   last_err;   /* last esp-tls / mbedTLS error code, for the log */
} mcpb_port_esp_t;

int mcpb_port_esp_init(mcpb_port_t *port, mcpb_port_esp_t *ctx);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* MCPB_PORT_ESP_H */
