import { McpGrammar, McpServerBuilder, LoopbackTransport } from "@cyanmycelium/mcp-core";
import type { IMcpServer, IMessageTransport } from "@cyanmycelium/mcp-core";
import { BrokerInfoBehavior } from "./behaviors/broker.behavior.info.js";
import { BrokerProvidersBehavior } from "./behaviors/broker.behavior.providers.js";
import { brokerGrammarKey, defaultBrokerLocaleResolver, defaultBrokerUserAgentResolver, iterAvailableBrokerGrammars, iterBrokerGrammarsFrom } from "./broker.grammars.js";
import type { BrokerLocaleResolver, BrokerUserAgent, BrokerUserAgentResolver } from "./broker.grammars.js";
import type { BrokerContext } from "./broker.context.js";

/**
 * Reserved provider slot name under which the broker exposes itself as an MCP
 * server. Clients reach it via `<host>/_broker/mcp` (or any other client transport).
 *
 * Prefixed with `_` to make it unambiguously a system slot, and to reduce the
 * chance of collision with user-supplied provider names.
 */
export const BROKER_PROVIDER_NAME = "_broker";

/**
 * Optional knobs passed to {@link startBrokerServer}. Lets the embedder
 * replace either resolver with custom logic without touching mcp-broker
 * internals.
 */
export interface StartBrokerServerOptions {
    /**
     * Picks a locale (BCP-47 base language, by convention) for the current
     * session. Defaults to {@link defaultBrokerLocaleResolver} which reads
     * `MCP_BROKER_LOCALE` and keeps the ISO 639-1 prefix.
     */
    localeResolver?: BrokerLocaleResolver;

    /**
     * Picks a user-agent family for the connecting client. Defaults to
     * {@link defaultBrokerUserAgentResolver} which substring-matches
     * `clientInfo.name` against known LLM families.
     */
    userAgentResolver?: BrokerUserAgentResolver;

    /**
     * Source of the raw locale string fed to the locale resolver. Defaults
     * to `process.env.MCP_BROKER_LOCALE`. Override when the locale lives
     * somewhere else (config file, session metadata, HTTP header proxy, ...).
     */
    localeSource?: () => string | undefined;

    /**
     * Path to a user-supplied grammars directory whose `<userAgent>/<locale>.json`
     * files are merged **on top of** the packaged grammars. Local entries win
     * on conflicts; missing entries fall through to the packaged values.
     *
     * When `undefined` (default), only the packaged grammars are used.
     */
    localGrammarsDir?: string;
}

/**
 * Constructs the broker's own MCP server (the Tier-1 introspection behaviors)
 * and returns the running server plus the loopback transport that must be
 * registered against the {@link WsTunnel} as the `_broker` provider slot.
 *
 * Usage from {@link WsTunnel.start}:
 * ```ts
 * const { server, clientTransport } = await startBrokerServer(this, { ... });
 * this._registerLoopbackProvider(BROKER_PROVIDER_NAME, clientTransport);
 * ```
 *
 * @param context  Read-only view of the broker's state.
 * @param options  Optional resolver overrides.
 * @returns The running {@link IMcpServer} (call `.stop()` on shutdown) and the
 *          loopback transport to attach to the tunnel.
 */
export async function startBrokerServer(
    context: BrokerContext,
    options: StartBrokerServerOptions = {}
): Promise<{
    server: IMcpServer;
    clientTransport: IMessageTransport;
}> {
    const localeResolver = options.localeResolver ?? defaultBrokerLocaleResolver;
    const userAgentResolver = options.userAgentResolver ?? defaultBrokerUserAgentResolver;
    const localeSource = options.localeSource ?? (() => process.env["MCP_BROKER_LOCALE"]);

    const [serverEnd, clientEnd] = LoopbackTransport.createPair();

    // Without an initializer, McpServerBuilder reports `version: "0.0.0"` in the
    // `initialize` handshake. Supply the real package version from the context.
    const builder = new McpServerBuilder()
        .withName(BROKER_PROVIDER_NAME)
        .withTransport(serverEnd)
        .withInitializer({
            initialize: () => ({
                protocolVersion: "2024-11-05",
                serverInfo: { name: BROKER_PROVIDER_NAME, version: context.version },
            }),
        })
        .register(new BrokerInfoBehavior(context), new BrokerProvidersBehavior(context));

    // Discover every grammar by scanning two directories:
    //   1. The packaged grammars shipped with the broker.
    //   2. Optionally, a user-supplied directory whose entries are merged
    //      ON TOP of the packaged ones (local wins on conflicts).
    //
    // Then build the (userAgent × locale) matrix. Within each user-agent,
    // the grammar cascades on top of "default:<locale>" so per-user-agent
    // files can stay partial.
    const defaults = new Map<string, McpGrammar>(); // locale → grammar
    const overrides = new Map<BrokerUserAgent, Map<string, McpGrammar>>(); // userAgent → locale → grammar

    function ingest(entry: { userAgent: BrokerUserAgent; locale: string; grammar: McpGrammar }, isOverride: boolean): void {
        if (entry.userAgent === "default") {
            const existing = defaults.get(entry.locale);
            const merged = existing && isOverride ? McpGrammar.merge(existing, entry.grammar) : entry.grammar;
            defaults.set(entry.locale, merged);
        } else {
            let byLocale = overrides.get(entry.userAgent);
            if (!byLocale) {
                byLocale = new Map();
                overrides.set(entry.userAgent, byLocale);
            }
            const existing = byLocale.get(entry.locale);
            const merged = existing && isOverride ? McpGrammar.merge(existing, entry.grammar) : entry.grammar;
            byLocale.set(entry.locale, merged);
        }
    }

    for (const entry of iterAvailableBrokerGrammars()) ingest(entry, false);
    if (options.localGrammarsDir) {
        for (const entry of iterBrokerGrammarsFrom(options.localGrammarsDir)) ingest(entry, true);
    }

    const availableKeys = new Set<string>();

    // Register every "default:<locale>" as-is.
    for (const [locale, grammar] of defaults) {
        const key = brokerGrammarKey("default", locale);
        builder.withGrammar(key, grammar);
        availableKeys.add(key);
    }

    // Register every "<userAgent>:<locale>" as merge(default:<locale>, ua:<locale>).
    // The user-agent grammar wins per entry; missing entries cascade from default.
    for (const [agent, byLocale] of overrides) {
        for (const [locale, uaGrammar] of byLocale) {
            const baseline = defaults.get(locale);
            const merged = baseline ? McpGrammar.merge(baseline, uaGrammar) : uaGrammar;
            const key = brokerGrammarKey(agent, locale);
            builder.withGrammar(key, merged);
            availableKeys.add(key);
        }
    }

    builder.withGrammarResolver((clientInfo) => {
        // localeResolver returns the full fallback chain (most specific first),
        // ending with the universal "en". The user-agent axis is the broker's
        // own concern: per locale, prefer the user-agent-specific grammar, then
        // fall back to the "default" agent.
        const locales = localeResolver(localeSource());
        const userAgent = userAgentResolver(clientInfo);
        const userAgents = userAgent === "default" ? ["default"] : [userAgent, "default"];

        for (const locale of locales) {
            for (const ua of userAgents) {
                const key = brokerGrammarKey(ua, locale);
                if (availableKeys.has(key)) return key;
            }
        }

        // None of the candidates is on disk → return an empty key. McpServer
        // then falls back to the behavior's baseline descriptions (English).
        return "";
    });

    // No reconnect policy → the McpServer does not attempt to reopen the loopback
    // when WsTunnel.stop() closes it. Clean shutdown.
    const server = builder.build();

    await server.start();

    return { server, clientTransport: clientEnd };
}
