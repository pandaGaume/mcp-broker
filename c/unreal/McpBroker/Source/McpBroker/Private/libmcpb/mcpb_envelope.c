/* Wrapper: UBT only compiles what sits under Source/<Module>/, and libmcpb
 * lives in c/libmcpb, the single copy in the repository. This file makes
 * that translation unit part of the module, compiled as C. */
#include "../../../../../../libmcpb/src/mcpb_envelope.c"
