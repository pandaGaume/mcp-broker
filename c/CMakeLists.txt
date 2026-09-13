# The C side of mcp-broker: the device-facing provider client and its ports.
#
#   cmake -S c -B c/build && cmake --build c/build && ctest --test-dir c/build
#
# Each subdirectory also builds on its own; this file only gathers them so
# one command exercises everything the CI does.

cmake_minimum_required(VERSION 3.16)
project(mcp-broker-c LANGUAGES C)

set(MCPB_BUILD_TESTS ON CACHE BOOL "Build the libmcpb bench")
enable_testing()

# The warnings every C target here is built under. -Wconversion is not
# decoration: this code shifts and masks its way through frame headers, and a
# silent narrowing is exactly how a length field gets truncated.
set(MCPB_WARNINGS
    -Wall -Wextra -Wpedantic -Wconversion -Wshadow -Wstrict-prototypes)

# The TLS port needs OpenSSL. AUTO builds it when OpenSSL is found and says
# so either way; ON fails the configure when it is missing, which is what the
# CI asks for so a runner without OpenSSL cannot pass by skipping it.
set(MCPB_TLS "AUTO" CACHE STRING "Build the TLS port on OpenSSL: ON, OFF or AUTO")
if(MCPB_TLS STREQUAL "AUTO")
    find_package(OpenSSL QUIET)
    set(MCPB_TLS_ENABLED ${OpenSSL_FOUND})
elseif(MCPB_TLS)
    set(MCPB_TLS_ENABLED ON)
else()
    set(MCPB_TLS_ENABLED OFF)
endif()

add_subdirectory(libmcpb)
add_subdirectory(ports/host)
if(MCPB_TLS_ENABLED)
    add_subdirectory(ports/tls-openssl)
else()
    message(STATUS "mcpb: TLS port skipped (OpenSSL not found or MCPB_TLS=OFF); wss:// is refused by host-provider")
endif()
add_subdirectory(samples/lib)
add_subdirectory(samples/host-provider)
