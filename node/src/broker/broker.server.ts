import { McpServerBuilder, LoopbackTransport } from "@cyanmycelium/mcp-core";
import type { GrammarResolverOptions, IMcpServer, IMessageTransport } from "@cyanmycelium/mcp-core";
import { BrokerInfoBehavior } from "./behaviors/broker.behavior.info.js";
import { BrokerProvidersBehavior } from "./behaviors/broker.behavior.providers.js";
import { iterAvailableBrokerGrammars, iterBrokerGrammarsFrom } from "./broker.grammars.js";
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
     * Overrides for the built-in grammar resolver from `@cyanmycelium/mcp-core`.
     *
     * The broker installs sensible defaults: `localeSource` reads
     * `process.env.MCP_BROKER_LOCALE`, the `agents` map uses the mcp-core
     * defaults (`claude`, `gpt`, `mistral`, `copilot`, `default`), the
     * narrowing chain is BCP-47-style, and `fallbackKey` is `default:en`
     * so the baseline grammar always matches as last resort.
     *
     * Pass partial overrides here to inject a custom `localeSource` (e.g.
     * pull from an HTTP header proxied by your transport), enable the
     * `versionFrom` dimension, or extend the `agents` map with additional
     * LLM families. Anything you omit keeps the broker default.
     */
    grammarResolverOptions?: Partial<GrammarResolverOptions>;

    /**
     * Path to a user-supplied grammars directory whose `<userAgent>/<locale>.json`
     * files are registered **in addition to** the packaged grammars.
     *
     * Both packaged and local entries are registered raw against the server
     * via `withGrammar(brokerGrammarKey(ua, locale), grammar)`. The
     * candidate-chain resolution implemented by `McpServer.initialize` in
     * mcp-core@0.3.0 then walks the chain and merges the four layers
     * (behavior, adapter, static, store) for the first matching key —
     * the old hand-rolled pre-merge cascade is no longer needed.
     *
     * When `undefined` (default), only the packaged grammars are loaded.
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

    // Register every `(userAgent, locale)` JSON found on disk as a raw
    // grammar layer. The candidate-chain resolution in
    // McpServer.initialize (mcp-core@0.3.0) walks the resolver's chain
    // and merges all matching layers — so partial user-agent files no
    // longer need to be pre-merged with the default-locale baseline at
    // boot. Local overrides come after packaged entries; identical keys
    // get overlaid via the registry's last-write-wins.
    for (const entry of iterAvailableBrokerGrammars()) {
        builder.withGrammar(entry.key, entry.grammar);
    }
    if (options.localGrammarsDir) {
        for (const entry of iterBrokerGrammarsFrom(options.localGrammarsDir)) {
            builder.withGrammar(entry.key, entry.grammar);
        }
    }

    // Wire the resolver via mcp-core's declarative helper. The broker
    // ships sensible defaults (locale from MCP_BROKER_LOCALE env, agents
    // from mcp-core's catalogue, BCP-47 narrowing, default:en fallback);
    // anything the host application sets via `grammarResolverOptions`
    // takes precedence.
    builder.withGrammarResolver({
        localeSource: () => process.env["MCP_BROKER_LOCALE"],
        ...(options.grammarResolverOptions ?? {}),
    });

    // No reconnect policy → the McpServer does not attempt to reopen the loopback
    // when WsTunnel.stop() closes it. Clean shutdown.
    const server = builder.build();

    await server.start();

    return { server, clientTransport: clientEnd };
}
