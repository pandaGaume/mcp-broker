export { WsTunnel } from "./ws.tunnel.js";
export { WsTunnelBuilder } from "./ws.tunnel.builder.js";
export type { IInternalClient, IWsTunnelOptions, IStaticMount, InternalClient, WsTunnelOptions, StaticMount } from "./ws.tunnel.js";
export { StdioUpstream } from "./stdio.upstream.js";
export type { IStdioUpstreamConfig, StdioUpstreamConfig } from "./stdio.upstream.js";
export { RemoteUpstream } from "./remote.upstream.js";
export type { IRemoteUpstreamConfig, RemoteUpstreamConfig } from "./remote.upstream.js";
export type { IUpstream, Upstream } from "./upstream.js";

// `.mcpb` bundle loading — verifies + unpacks a bundle into a stdio upstream.
export { loadMcpbBundle } from "./mcpb.loader.js";
export type { IMcpbBundleConfig, McpbBundleConfig } from "./mcpb.loader.js";
export { unzipMcpb } from "./mcpb.unzip.js";

// Broker introspection — tier 1.
export { BrokerInfoBehavior, BrokerProvidersBehavior, startBrokerServer, BROKER_PROVIDER_NAME } from "./broker/index.js";
export type { IStartBrokerServerOptions, StartBrokerServerOptions } from "./broker/index.js";
export { brokerGrammarKey, iterAvailableBrokerGrammars, iterBrokerGrammarsFrom, loadBrokerGrammar } from "./broker/index.js";
export type {
    IBrokerContext,
    IBrokerGrammarEntry,
    IBrokerProviderInfo,
    BrokerContext,
    BrokerGrammarEntry,
    BrokerProviderInfo,
    BrokerProviderTransport,
    BrokerLocale,
    BrokerUserAgent,
} from "./broker/index.js";

export { VERSION, PACKAGE_NAME } from "./version.js";

// OAuth 2.1 resource-server authorization.
export {
    AuthError,
    scopesOf,
    JwtTokenValidator,
    buildResourceMetadata,
    HttpAuthGuard,
    buildJwtAuth,
    normalizeProviderAuthentication,
    providerMayPublish,
    SharedSecretProviderAuthenticator,
} from "./auth/index.js";
export type {
    IAccessTokenClaims,
    ITokenValidator,
    IPrincipal,
    IResolvedAuth,
    IJwtValidatorOptions,
    IProtectedResourceMetadata,
    IJwtAuthOptions,
    IProviderAuthenticator,
    IProviderPrincipal,
    AccessTokenClaims,
    TokenValidator,
    AuthErrorCode,
    Principal,
    ResolvedAuth,
    JwtValidatorOptions,
    ProtectedResourceMetadata,
    JwtAuthOptions,
    ProviderAuthenticator,
    AggregateScopeFilter,
    ProviderAuthenticationResult,
    ProviderAuthenticatorReturn,
    ProviderPrincipal,
} from "./auth/index.js";

// Hierarchical, domain-neutral authorization.
export {
    ConfigPolicyEngine,
    ConfiguredCapabilityClassifier,
    DefaultSlotResourceResolver,
    JwtSubjectMapper,
    ResourcePath,
    ResourcePathPattern,
    SubjectMappingError,
    authorizationWithEngine,
    compileAuthorizationPolicy,
    hasAuthorizationPolicies,
    validateCapability,
} from "./authorization/index.js";
export type {
    IAuditContext,
    IAuthorizationAuditConfig,
    IAuthorizationAuditEvent,
    IAuthorizationDecision,
    IAuthorizationPolicyConfig,
    IAuthorizationRequest,
    IAuthorizationSubject,
    ICapabilityClassifier,
    IClassifiedCapability,
    IDenyPolicy,
    IMcpOperation,
    IPolicyAssignment,
    IPolicyAuthorization,
    IPolicyEngine,
    IRoleDefinition,
    ISlotResourceResolver,
    ISubjectMapper,
    ISubjectMappingConfig,
    AuditContext,
    AuthorizationAuditConfig,
    AuthorizationAuditEvent,
    AuthorizationDecision,
    AuthorizationDecisionReason,
    AuthorizationPolicyConfig,
    AuthorizationRequest,
    AuthorizationSubject,
    CapabilityClassifier,
    ClassifiedCapability,
    DenyPolicy,
    McpOperation,
    PolicyAssignment,
    PolicyAuthorization,
    PolicyEngine,
    RoleDefinition,
    SlotResourceResolver,
    SubjectMapper,
    SubjectMappingConfig,
} from "./authorization/index.js";

// JSON config file used by `bin.ts` at startup. Exported so a programmatic
// embedder can re-use the same loader against a custom path.
export { loadBrokerConfig, DEFAULT_CONFIG_FILENAME } from "./config.js";
export type { IBrokerAuthConfig, IBrokerConfig, ILoadedBrokerConfig, BrokerAuthConfig, BrokerConfig, LoadedBrokerConfig } from "./config.js";
