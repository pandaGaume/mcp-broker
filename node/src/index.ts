export { WsTunnel } from "./ws.tunnel.js";
export { WsTunnelBuilder } from "./ws.tunnel.builder.js";
export type { WsTunnelOptions, StaticMount } from "./ws.tunnel.js";
export { StdioUpstream } from "./stdio.upstream.js";
export type { StdioUpstreamConfig } from "./stdio.upstream.js";
export { RemoteUpstream } from "./remote.upstream.js";
export type { RemoteUpstreamConfig } from "./remote.upstream.js";
export type { Upstream } from "./upstream.js";

// Broker introspection — tier 1.
export { BrokerInfoBehavior, BrokerProvidersBehavior, startBrokerServer, BROKER_PROVIDER_NAME } from "./broker/index.js";
export type { StartBrokerServerOptions } from "./broker/index.js";
export {
    brokerGrammarKey,
    defaultBrokerLocaleResolver,
    defaultBrokerUserAgentResolver,
    iterAvailableBrokerGrammars,
    loadBrokerGrammar,
    resolveBrokerLocale,
    resolveBrokerUserAgent,
} from "./broker/index.js";
export type { BrokerContext, BrokerProviderInfo, BrokerProviderTransport, BrokerLocale, BrokerLocaleResolver, BrokerUserAgent, BrokerUserAgentResolver } from "./broker/index.js";

export { VERSION, PACKAGE_NAME } from "./version.js";

// JSON config file used by `bin.ts` at startup. Exported so a programmatic
// embedder can re-use the same loader against a custom path.
export { loadBrokerConfig, DEFAULT_CONFIG_FILENAME } from "./config.js";
export type { BrokerConfig } from "./config.js";
