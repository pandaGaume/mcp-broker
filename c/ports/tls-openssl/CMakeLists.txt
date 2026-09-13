# libmcpb TLS port on OpenSSL: a port over another port. See include/mcpb_port_tls.h.
#
# OpenSSL 1.1.1 or 3.x. On a Debian or Ubuntu host: libssl-dev. On macOS:
# openssl@3 from Homebrew (and OPENSSL_ROOT_DIR if CMake does not find it).
# On Windows with MSYS2: the openssl package of the same environment as the
# compiler; with MSVC: vcpkg. Unreal Engine ships its own copy, and the plugin
# compiles this file against it, not through this CMake.

find_package(OpenSSL REQUIRED)
message(STATUS "mcpb: TLS port on OpenSSL ${OPENSSL_VERSION} (${OPENSSL_SSL_LIBRARY})")

add_library(mcpb_port_tls STATIC src/mcpb_port_tls_openssl.c)
target_include_directories(mcpb_port_tls PUBLIC include)
target_link_libraries(mcpb_port_tls PUBLIC mcpb OpenSSL::SSL OpenSSL::Crypto)
target_compile_features(mcpb_port_tls PUBLIC c_std_99)
set_target_properties(mcpb_port_tls PROPERTIES C_EXTENSIONS OFF)
target_compile_options(mcpb_port_tls PRIVATE
    $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:${MCPB_WARNINGS}>)

# Bench: an OpenSSL server in the same process behind a fake inner port, so
# the certificate checks run in both directions without a network. The
# certificate is the roundtrip's, in c/tests/tls.
if(MCPB_BUILD_TESTS)
    add_executable(test_mcpb_tls tests/test_tls.c)
    target_link_libraries(test_mcpb_tls PRIVATE mcpb_port_tls)
    target_compile_definitions(test_mcpb_tls PRIVATE
        MCPB_TEST_TLS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../tests/tls")
    target_compile_options(test_mcpb_tls PRIVATE
        $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:${MCPB_WARNINGS}>)
    add_test(NAME mcpb.tls COMMAND test_mcpb_tls)
endif()
