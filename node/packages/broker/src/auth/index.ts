/**
 * Barrel for the broker's OAuth 2.1 resource-server layer. See the individual
 * modules for details; the transport wires these up in `ws.tunnel.ts`.
 */
export { AuthError, scopesOf } from "./auth.types";
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
} from "./auth.types";
export { JwtTokenValidator } from "./jwt.validator";
export type { IJwtValidatorOptions, JwtValidatorOptions } from "./jwt.validator";
export { buildResourceMetadata } from "./resource.metadata";
export type { IProtectedResourceMetadata, ProtectedResourceMetadata } from "./resource.metadata";
export { HttpAuthGuard } from "./http.auth";
export { buildJwtAuth } from "./auth.config";
export { buildDevAuth, DevTokenValidator, isLoopbackRequest, resolveDevCallers, DEV_ISSUER, DEV_TOKEN_MIN_LENGTH } from "./dev.auth";
export type { IDevAuthConfig, IDevAuthOptions, IDevCaller, IResolvedDevCaller } from "./dev.auth";
export type { IJwtAuthOptions, JwtAuthOptions } from "./auth.config";
export { ProviderTableAuthenticator, SharedSecretProviderAuthenticator } from "./provider.auth";
export { compileProviderAllowedResources, normalizeProviderAuthentication, providerMayPublish, providerPublishDecision } from "./provider.auth";
export type {
    IProviderAuthenticator,
    IProviderCredential,
    IProviderPrincipal,
    IProviderPublishDecision,
    ProviderAuthenticationResult,
    ProviderAuthenticator,
    ProviderAuthenticatorReturn,
    ProviderPrincipal,
    ProviderPublishDenialReason,
} from "./provider.auth";
