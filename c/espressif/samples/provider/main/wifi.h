#ifndef SAMPLE_WIFI_H
#define SAMPLE_WIFI_H

/* Brings the Wi-Fi station up with the credentials from menuconfig and keeps
 * it associated. Requires NVS, the default netif and the default event loop
 * to be initialised first. */
void wifi_start_station(void);

#endif
