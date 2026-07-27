/**
 * Barrel for the broker's OAuth 2.1 resource-server layer. See the individual
 * modules for details; the transport wires these up in `ws.tunnel.ts`.
 */
export { AuthError, scopesOf } from "./auth.types.js";
export type {
    IAccessTokenClaims,
    ITokenValidator,
    AuthErrorCode,
    IPrincipal,
    IResolvedAuth,
    AggregateScopeFilter,
    AccessTokenClaims,
    TokenValidator,
    Principal,
    ResolvedAuth,
} from "./auth.types.js";
export { JwtTokenValidator } from "./jwt.validator.js";
export type { IJwtValidatorOptions, JwtValidatorOptions } from "./jwt.validator.js";
export { buildResourceMetadata } from "./resource.metadata.js";
export type { IProtectedResourceMetadata, ProtectedResourceMetadata } from "./resource.metadata.js";
export { HttpAuthGuard } from "./http.auth.js";
export { buildJwtAuth } from "./auth.config.js";
export type { IJwtAuthOptions, JwtAuthOptions } from "./auth.config.js";
export { SharedSecretProviderAuthenticator } from "./provider.auth.js";
export { normalizeProviderAuthentication, providerMayPublish } from "./provider.auth.js";
export type {
    IProviderAuthenticator,
    IProviderPrincipal,
    ProviderAuthenticationResult,
    ProviderAuthenticator,
    ProviderAuthenticatorReturn,
    ProviderPrincipal,
} from "./provider.auth.js";
