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

add_subdirectory(libmcpb)
add_subdirectory(ports/host)
add_subdirectory(samples/lib)
add_subdirectory(samples/host-provider)
