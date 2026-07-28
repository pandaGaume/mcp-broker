export { WsTunnel } from "./ws/ws.tunnel";
export { WsTunnelBuilder } from "./ws/ws.tunnel.builder";
export type { AllowedOrigins, IInternalClient, IWsTunnelOptions, IStaticMount, InternalClient, WsTunnelOptions, StaticMount } from "./ws/ws.interfaces";
export { StdioUpstream } from "./stdio.upstream";
export type { IStdioUpstreamConfig, StdioUpstreamConfig } from "./stdio.upstream";
export { RemoteUpstream } from "./remote.upstream";
export type { IRemoteUpstreamConfig, RemoteUpstreamConfig } from "./remote.upstream";
export type { IUpstream, Upstream } from "./upstream";

// `.mcpb` bundle loading, verifies + unpacks a bundle into a stdio upstream.
export { loadMcpbBundle } from "./mcpb/mcpb.loader";
export type { IMcpbBundleConfig, McpbBundleConfig } from "./mcpb/mcpb.loader";
export { unzipMcpb } from "./mcpb/mcpb.unzip";

// Broker introspection, tier 1.
export { BrokerInfoBehavior, BrokerProvidersBehavior, startBrokerServer, BROKER_PROVIDER_NAME } from "./broker/index";
export type { IStartBrokerServerOptions, StartBrokerServerOptions } from "./broker/index";
export { brokerGrammarKey, iterAvailableBrokerGrammars, iterBrokerGrammarsFrom, loadBrokerGrammar } from "./broker/index";
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
} from "./broker/index";

export { VERSION, PACKAGE_NAME } from "./version";

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
} from "./auth/index";
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
} from "./auth/index";

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
} from "./authorization/index";
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
} from "./authorization/index";

// JSON config file used by `bin.ts` at startup. Exported so a programmatic
// embedder can re-use the same loader against a custom path.
export { loadBrokerConfig, DEFAULT_CONFIG_FILENAME } from "./config";
export type { IBrokerAuthConfig, IBrokerConfig, ILoadedBrokerConfig, BrokerAuthConfig, BrokerConfig, LoadedBrokerConfig } from "./config";
