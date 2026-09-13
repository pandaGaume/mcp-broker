# The CA for a broker with a private certificate: drop its PEM at
# main/certs/ca.pem, enable "Trust the CA in main/certs/ca.pem" in menuconfig,
# and the build embeds it as _binary_ca_pem_start. Absent, nothing is
# embedded and the bundle applies.
set(SAMPLE_EMBED "")
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/certs/ca.pem")
    list(APPEND SAMPLE_EMBED "certs/ca.pem")
endif()

idf_component_register(
    SRCS
        "main.c"
        "wifi.c"
        # The static echo tool shared with the host sample: one file, one
        # copy, so both samples prove the same surface.
        "${CMAKE_CURRENT_LIST_DIR}/../../../../samples/lib/static_provider.c"
    INCLUDE_DIRS
        "."
        "${CMAKE_CURRENT_LIST_DIR}/../../../../samples/lib"
    EMBED_TXTFILES
        ${SAMPLE_EMBED}
    REQUIRES
        mcpb_esp
    PRIV_REQUIRES
        esp_event
        esp_netif
        esp_timer
        esp_wifi
        nvs_flash)
