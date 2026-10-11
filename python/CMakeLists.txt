cmake_minimum_required(VERSION 3.16)
project(mcp_provider_native LANGUAGES C)

# Compile the existing C99 transport and host port into one Python-loadable library.
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(MCPB_MUX ON CACHE BOOL "Python supports multiplexed slots" FORCE)
add_subdirectory(../c/libmcpb libmcpb)
add_subdirectory(../c/ports/host host)
add_subdirectory(../c/ports/tls-openssl tls)
add_library(mcp_provider_native SHARED native/provider.c)
target_link_libraries(mcp_provider_native PRIVATE mcpb_port_host mcpb_port_tls)
target_compile_features(mcp_provider_native PRIVATE c_std_99)
set_target_properties(mcp_provider_native PROPERTIES C_EXTENSIONS OFF)
if(WIN32)
    set_target_properties(mcp_provider_native PROPERTIES PREFIX "")
    get_filename_component(MCPB_OPENSSL_ROOT "${OPENSSL_INCLUDE_DIR}" DIRECTORY)
    file(GLOB MCPB_TLS_DLLS "${MCPB_OPENSSL_ROOT}/bin/*ssl*.dll"
        "${MCPB_OPENSSL_ROOT}/bin/*crypto*.dll")
    foreach(dll IN LISTS MCPB_TLS_DLLS)
        add_custom_command(TARGET mcp_provider_native POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different "${dll}"
                "$<TARGET_FILE_DIR:mcp_provider_native>")
        install(FILES "${dll}" DESTINATION mcp_provider)
    endforeach()
endif()
target_compile_options(mcp_provider_native PRIVATE
    $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:-Wall;-Wextra;-Wpedantic;-Wconversion>)
install(TARGETS mcp_provider_native
    RUNTIME DESTINATION mcp_provider LIBRARY DESTINATION mcp_provider)
