# provider: the transport-only sample on ESP32. Wi-Fi station, then the
# mcpb_esp task with the same static echo tool the host sample serves.
#
#   idf.py set-target esp32s3
#   idf.py menuconfig        # Wi-Fi credentials, broker host/port, slot name
#   idf.py build flash monitor
#
# The mcpb_esp component lives in ../../components; it compiles libmcpb from
# ../../../libmcpb, so this project builds from a plain checkout.

cmake_minimum_required(VERSION 3.16)

list(APPEND EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../components")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(mcpb_provider)
