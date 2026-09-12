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

add_subdirectory(libmcpb)
