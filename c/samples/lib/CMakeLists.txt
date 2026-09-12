# static_provider: the MCP surface the transport samples serve, from static
# strings. Shared by samples/host-provider and espressif/samples/provider.

add_library(static_provider STATIC static_provider.c)
target_include_directories(static_provider PUBLIC .)
target_link_libraries(static_provider PUBLIC mcpb)
target_compile_features(static_provider PUBLIC c_std_99)
set_target_properties(static_provider PROPERTIES C_EXTENSIONS OFF)
target_compile_options(static_provider PRIVATE
    $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:${MCPB_WARNINGS}>)
