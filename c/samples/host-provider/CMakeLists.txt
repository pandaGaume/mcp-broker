# host-provider: the smallest provider that proves the transport end to end.
# Static replies, no JSON parser; see main.c for what it does and does not do.

add_executable(host-provider main.c)
target_link_libraries(host-provider PRIVATE mcpb mcpb_port_host static_provider)
target_compile_features(host-provider PRIVATE c_std_99)
set_target_properties(host-provider PROPERTIES C_EXTENSIONS OFF)
target_compile_options(host-provider PRIVATE
    $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:${MCPB_WARNINGS}>)
