# mcpb_esp: libmcpb on ESP-IDF. The port over esp-tls and lwip, plus the
# provider task.
#
# libmcpb's sources are compiled straight from ../../../libmcpb, the single
# copy in this repository: nothing is duplicated here, so a fix to the
# library reaches the device on the next build. Publishing this component on
# the Espressif registry would need those files vendored in, which is a
# packaging step for that day, not a layout change.

set(MCPB_LIB "${CMAKE_CURRENT_LIST_DIR}/../../../libmcpb")

set(MCPB_LIB_SRCS
    "${MCPB_LIB}/src/mcpb_common.c"
    "${MCPB_LIB}/src/mcpb_sha1.c"
    "${MCPB_LIB}/src/mcpb_ws.c"
    "${MCPB_LIB}/src/mcpb_provider.c")

idf_component_register(
    SRCS
        ${MCPB_LIB_SRCS}
        "src/mcpb_port_esp.c"
        "src/mcpb_esp_task.c"
    INCLUDE_DIRS
        "include"
        "${MCPB_LIB}/include"
    REQUIRES
        esp_event
    PRIV_REQUIRES
        esp-tls
        esp_hw_support
        esp_netif
        esp_timer
        lwip
        mbedtls)

# libmcpb is developed warning-free under its own set, which is stricter
# than IDF's default; keep it that way when it is built here. The two
# ESP-side files include IDF headers that do not pass -Wconversion, so they
# stay on IDF's defaults.
set_source_files_properties(${MCPB_LIB_SRCS}
    PROPERTIES COMPILE_OPTIONS "-Wconversion;-Wshadow;-Wstrict-prototypes")
