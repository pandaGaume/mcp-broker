cmake_minimum_required(VERSION 3.16)
project(mcp_provider_native LANGUAGES C)

# Compile the existing C99 transport and host port into one Python-loadable library.
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(MCPB_MUX OFF CACHE BOOL "Python uses dedicated slots")
add_subdirectory(../c/libmcpb libmcpb)
add_subdirectory(../c/ports/host host)
add_library(mcp_provider_native SHARED native/provider.c)
target_link_libraries(mcp_provider_native PRIVATE mcpb_port_host)
target_compile_features(mcp_provider_native PRIVATE c_std_99)
set_target_properties(mcp_provider_native PROPERTIES C_EXTENSIONS OFF)
if(WIN32)
    set_target_properties(mcp_provider_native PROPERTIES PREFIX "")
endif()
target_compile_options(mcp_provider_native PRIVATE
    $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:-Wall;-Wextra;-Wpedantic;-Wconversion>)
install(TARGETS mcp_provider_native
    RUNTIME DESTINATION mcp_provider LIBRARY DESTINATION mcp_provider)
