/**
 * Barrel for the broker's OAuth 2.1 resource-server layer. See the individual
 * modules for details; the transport wires these up in `ws.tunnel.ts`.
 */
export { AuthError, scopesOf } from "./auth.types.js";
export type { AccessTokenClaims, TokenValidator, AuthErrorCode, Principal, ResolvedAuth } from "./auth.types.js";
export { JwtTokenValidator } from "./jwt.validator.js";
export type { JwtValidatorOptions } from "./jwt.validator.js";
export { buildResourceMetadata } from "./resource.metadata.js";
export type { ProtectedResourceMetadata } from "./resource.metadata.js";
export { HttpAuthGuard } from "./http.auth.js";
export { buildJwtAuth } from "./auth.config.js";
export type { JwtAuthOptions } from "./auth.config.js";
export { SharedSecretProviderAuthenticator } from "./provider.auth.js";
export type { ProviderAuthenticator } from "./provider.auth.js";
