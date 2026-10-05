export { WsTunnel } from "./ws/ws.tunnel";
export { WsTunnelBuilder } from "./ws/ws.tunnel.builder";
export type {
    AllowedOrigins,
    IInternalClient,
    ILoopbackProviderHandle,
    IWsTunnelOptions,
    IStaticMount,
    InternalClient,
    ProviderTakeoverMode,
    WsTunnelOptions,
    StaticMount,
} from "./ws/ws.interfaces";
export type { IResourceLimitRule } from "./authority/resource.limits";
export {
    BrokerAuthority,
    BROKER_AUDIT_RESULT_METHOD,
    BROKER_AUTHORIZE_METHOD,
    BROKER_DECLARE_METHOD,
    BROKER_METHOD_PREFIX,
    CALLER_META_KEY,
    CORRELATION_ID_PATTERN,
    DEFAULT_AUTHORIZE_BATCH_LIMIT,
} from "./authority/broker.authority";
export type { BrokerMethodOutcome, IBrokerAuthorityInfo, IBrokerAuthorityOptions, IBrokerMethodOrigin, IOverdueDecision } from "./authority/broker.authority";
export type { IDeclaredResource, IProtectedSlot, IProviderDeclaration, IResourceLimits } from "./authority/declaration";
export { StdioUpstream } from "./stdio.upstream";
export type { IStdioUpstreamConfig, StdioUpstreamConfig } from "./stdio.upstream";
export { RemoteUpstream } from "./remote.upstream";
export type { IRemoteUpstreamConfig, RemoteUpstreamConfig } from "./remote.upstream";
export type { IUpstream, Upstream } from "./upstream";
export { ResourceSubscriptionRegistry, DEFAULT_RESOURCE_SUBSCRIPTION_LIMITS, SUBSCRIPTION_LIMIT_ERROR_CODE } from "./subscriptions/resource.subscription.registry";
export type {
    ClientKey,
    IReplayResult,
    IResourceSubscriptionLimits,
    IResourceSubscriptionUpstream,
    SubscriptionOutcome,
    SubscriptionState,
} from "./subscriptions/resource.subscription.registry";

// Optional provider telemetry pipeline and OTLP/HTTP exporter.
export {
    OtlpHttpTraceExporter,
    ProviderTelemetryDispatcher,
    TELEMETRY_NOTIFICATION_METHOD,
    TRACEPARENT_META_KEY,
    createTraceparent,
    ensureTraceparent,
    formatTraceparent,
    parseTraceparent,
} from "./telemetry/index";
export type {
    IOtlpHttpTraceExporterOptions,
    IProviderTelemetryExporter,
    IProviderTelemetryOptions,
    IProviderTelemetryRecord,
    IProviderTelemetryStats,
    ITraceParent,
    ITelemetryEvent,
    ITelemetrySpan,
    TelemetryAttributeValue,
} from "./telemetry/index";

// `.mcpb` bundle loading, verifies + unpacks a bundle into a stdio upstream.
export { loadMcpbBundle } from "./mcpb/mcpb.loader";
export type { IMcpbBundleConfig, McpbBundleConfig } from "./mcpb/mcpb.loader";
export { unzipMcpb } from "./mcpb/mcpb.unzip";

// Broker introspection, tier 1.
export { BrokerInfoBehavior, BrokerProvidersBehavior, startBrokerServer, BROKER_PROVIDER_NAME } from "./broker/index";
export type { IStartBrokerServerOptions, StartBrokerServerOptions } from "./broker/index";

// Self-documentation and self-diagnosis served on the reserved `_broker` slot.
// Imported from the concrete modules rather than from `./broker/index`, which
// does not re-export them yet; switch these to the barrel once it does.
export { BrokerGuideBehavior } from "./broker/behaviors/broker.behavior.guide";
export { BrokerDiagnoseBehavior } from "./broker/behaviors/broker.behavior.diagnose";
export { BrokerGuideAdapter } from "./broker/adapters/broker.adapter.guide";
export { BrokerDiagnoseAdapter } from "./broker/adapters/broker.adapter.diagnose";
export {
    BROKER_GUIDES,
    BROKER_GUIDE_TOPICS,
    BROKER_GUIDE_MIME_TYPE,
    BROKER_GUIDE_URI_PREFIX,
    BROKER_GUIDE_URI_TEMPLATE,
    brokerGuide,
    brokerGuideIndex,
    brokerGuideUri,
    brokerGuideTopicFromUri,
} from "./broker/broker.guides";
export type { IBrokerGuide, BrokerGuideTopic } from "./broker/broker.guides";
export { diagnoseBroker } from "./broker/broker.diagnostics";
export type {
    IBrokerDiagnosis,
    IBrokerDiagnosisProblem,
    IBrokerDiagnosisSlot,
    IBrokerDiagnosisSkippedCheck,
    BrokerDiagnosisSeverity,
    BrokerDiagnosisRuleId,
} from "./broker/broker.diagnostics";
export { BROKER_AGGREGATE_NAME, BROKER_RESERVED_SLOTS, isReservedBrokerSlot } from "./broker/broker.slots";
export type { IBrokerAggregateInfo, IBrokerSecurityInfo } from "./broker/broker.context";
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
    compileProviderAllowedResources,
    normalizeProviderAuthentication,
    providerMayPublish,
    providerPublishDecision,
    ProviderTableAuthenticator,
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
    IProviderCredential,
    IProviderPrincipal,
    IProviderPublishDecision,
    ProviderPublishDenialReason,
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
export { BrokerConfigError, loadBrokerConfig, loadSecurityConfig, resolveOpenTarget, DEFAULT_CONFIG_FILENAME } from "./config";
export type {
    IBrokerAuthConfig,
    IBrokerConfig,
    ILoadedBrokerConfig,
    ILoadedSecurityConfig,
    ISecurityConfig,
    ISecurityProviderEntry,
    IOpenTargetResolution,
    BrokerAuthConfig,
    BrokerConfig,
    LoadedBrokerConfig,
} from "./config";

export {
    LimitController,
    validateLimitsConfig,
    type ILimitsConfig,
    type ILimitRule,
    type ILimitWindow,
    type ILimitContext,
    type ILimitFailure,
    type ILimitAuditEvent,
} from "./limits/controller";
