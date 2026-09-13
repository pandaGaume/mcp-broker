/* Wrapper: the TLS port lives in c/ports/tls-openssl, next to the other
 * ports; this makes it part of the module, compiled as C against the OpenSSL
 * the engine ships. Empty on a platform without it. */
#if defined(MCPB_UNREAL_TLS) && MCPB_UNREAL_TLS
#include "../../../../../../ports/tls-openssl/src/mcpb_port_tls_openssl.c"
#else
typedef int mcpb_port_tls_openssl_not_built; /* a translation unit must not be empty */
#endif
