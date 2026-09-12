# libmcpb host port: plain TCP on Linux, macOS and Windows. No TLS.

add_library(mcpb_port_host STATIC src/mcpb_port_host.c)
target_include_directories(mcpb_port_host PUBLIC include)
target_link_libraries(mcpb_port_host PUBLIC mcpb)
target_compile_features(mcpb_port_host PUBLIC c_std_99)
set_target_properties(mcpb_port_host PROPERTIES C_EXTENSIONS OFF)
target_compile_options(mcpb_port_host PRIVATE
    $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:${MCPB_WARNINGS}>)

if(WIN32)
    target_link_libraries(mcpb_port_host PUBLIC ws2_32 bcrypt)
endif()
