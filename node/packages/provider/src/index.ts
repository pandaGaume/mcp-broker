/**
 * Provider side of the CyanMycelium MCP broker tunnel: what an application uses
 * to publish its MCP server to a broker slot.
 *
 * The tunnel envelope protocol is also published on its own entry point,
 * `@cyanmycelium/mcp-broker-provider/protocol`, which the broker imports so both
 * ends of the tunnel share one definition of the wire format.
 */
export * from "./protocol/index";
export { DirectTransport, type IDirectTransportOptions } from "./direct.transport";
export { MultiplexTransport, type IMultiplexTransportOptions } from "./multiplex.transport";
export {
    BrokerClient,
    AUDIT_RESULT_NOTIFICATION_METHOD,
    BrokerRequestError,
    CALLER_META_KEY,
    TELEMETRY_NOTIFICATION_METHOD,
    TRACEPARENT_META_KEY,
    childTraceparent,
    callerReferenceOf,
    formatTraceparent,
    parseTraceparent,
    traceparentOf,
    withTraceparent,
    type IAuthorizationAnswer,
    type IAuthorizationCheck,
    type IAuthorizationDeclaration,
    type IAuditResult,
    type IAuthorizationDecision,
    type IAuthorizationObligations,
    type IAuthorizationQuery,
    type IBrokerClientOptions,
    type ICallerReference,
    type IDeclarationAccepted,
    type IDeclaredResource,
    type IResourceLimits,
    type ITelemetryEvent,
    type ITelemetrySpan,
    type ITraceParent,
    type TelemetryAttributeValue,
} from "./broker.client";
