# libmcpb: provider client for mcp-broker. C99, no allocation.
#
# Self-contained on purpose: this directory ships on its own, so it builds
# with `add_subdirectory(libmcpb)` from any project, or standalone with
#
#   cmake -S . -B build && cmake --build build && ctest --test-dir build
#
# The Makefile next to this file does the same job without CMake, for
# toolchains that have neither.

cmake_minimum_required(VERSION 3.16)
project(mcpb VERSION 0.1.0 LANGUAGES C)

# The same warnings the library is developed under. -Wconversion is not
# decoration here: this code shifts and masks its way through frame headers,
# and a silent narrowing is exactly how a length field gets truncated.
set(MCPB_WARNINGS
    -Wall -Wextra -Wpedantic -Wconversion -Wshadow -Wstrict-prototypes)

add_library(mcpb STATIC
    src/mcpb_common.c
    src/mcpb_sha1.c
    src/mcpb_ws.c
    src/mcpb_provider.c)

target_include_directories(mcpb PUBLIC include)
target_compile_features(mcpb PUBLIC c_std_99)
set_target_properties(mcpb PROPERTIES C_EXTENSIONS OFF)
target_compile_options(mcpb PRIVATE
    $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:${MCPB_WARNINGS}>)

# ---------------------------------------------------------------------------
# Bench: 83 checks, no network. Off when embedded in another project.
# ---------------------------------------------------------------------------
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR OR MCPB_BUILD_TESTS)
    enable_testing()

    # The bench includes src/mcpb_internal.h to reach SHA-1 and base64
    # directly, so it compiles against the sources, not only the public
    # headers.
    add_executable(test_mcpb tests/test_mcpb.c)
    target_link_libraries(test_mcpb PRIVATE mcpb)
    target_compile_options(test_mcpb PRIVATE
        $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:${MCPB_WARNINGS}>)

    add_test(NAME mcpb.bench COMMAND test_mcpb)
endif()
