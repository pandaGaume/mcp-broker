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
    REQUIRES
        mcpb_esp
    PRIV_REQUIRES
        esp_event
        esp_netif
        esp_timer
        esp_wifi
        nvs_flash)
