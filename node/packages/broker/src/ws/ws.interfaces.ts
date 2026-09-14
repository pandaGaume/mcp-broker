import type { ServerResponse } from "http";
import type { WebSocket } from "ws";
import type { GrammarResolverOptions, IMessageTransport } from "@cyanmycelium/mcp-core";
import type { StreamableHttpEndpoint } from "@cyanmycelium/mcp-core/node";
import type { IStdioUpstreamConfig } from "../stdio.upstream";
import type { IRemoteUpstreamConfig } from "../remote.upstream";
import type { IResolvedAuth, IProviderAuthenticator, IPrincipal } from "../auth/index";
import type { IPolicyAuthorization, ISlotResourceResolver } from "../authorization/index";

/**
 * Every type the WebSocket tunnel exchanges or is configured with.
 *
 * Split out of `ws.tunnel.ts` so the contract can be read without wading
 * through the implementation: the options an operator sets, the handles the
 * broker hands to in-process components, and the per-slot state the relay
 * keeps. The internal ones are exported for the tunnel's own modules and are
 * deliberately absent from the package entry point.
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Where a JSON-RPC response should be delivered.
 * Either a WebSocket socket (raw WS client), a legacy SSE session, a Streamable
 * HTTP session, the process stdout (stdio transport for Claude Desktop), or an
 * in-process internal client (e.g. the aggregate server).
 *
 * The Streamable HTTP sink names a **session**, not a held-open response: which
 * HTTP exchange a frame answers is worked out by `HttpSessionTransport`, from
 * the JSON-RPC id. The broker only has to know which session asked.
 */
export type ResponseSink =
    | { type: "ws"; socket: WebSocket }
    | { type: "sse"; sessionId: string }
    | { type: "http-session"; sessionId: string }
    | { type: "stdio" }
    | { type: "internal"; client: IInternalClient };

/**
 * The client-transport handlers a provider route can resolve to.
 *
 * `mcp` covers GET, POST and DELETE at once, because the whole Streamable HTTP
 * state machine is delegated to `StreamableHttpEndpoint`: the broker routes to
 * it and no longer decides per method what to do.
 */
export type McpEndpointKind = "mcp" | "sse-connect" | "sse-message";

/**
 * The role the WebSocket router assigned to one accepted upgrade.
 *
 * Named rather than inlined because it is what the connect log line reports,
 * and that line is the only place anyone can see that a path such as
 * `/providers/foo` was taken as a **client** slot rather than as a provider
 * endpoint: the router's last branch accepts every unmatched path, so a
 * mistyped provider URL connects successfully and then never exchanges a
 * frame with anybody.
 *
 * - `multiplex-provider`: the shared `/providers` socket, envelope framing,
 *   slots announced per frame.
 * - `dedicated-provider`: `/provider/<name>`, plain JSON-RPC framing, one slot
 *   fixed by the URL.
 * - `client`: an MCP client asking to be relayed to `/<slot>`.
 */
export type WsConnectRole = "multiplex-provider" | "dedicated-provider" | "client";

/**
 * What the router decided about one WebSocket upgrade, before it is accepted.
 *
 * The same classification runs twice, in `verifyClient` (which can still refuse
 * the HTTP upgrade with a status line a Node client can read) and in the
 * connection handler (which knows the socket). Deriving both from one function
 * is the point: they used to be two nearly-identical `startsWith` chains that
 * could disagree, and a disagreement means a socket authenticated as one role
 * and then served as another.
 *
 * `reject` names a path that cannot work by construction, never one that merely
 * has no provider behind it: claiming a free slot by connecting to it is how a
 * provider registers, so an unknown slot name is normal and must stay accepted.
 */
export type WsRouteClassification =
    | { readonly role: "multiplex-provider" }
    | { readonly role: "dedicated-provider"; readonly slot: string }
    | { readonly role: "client"; readonly slot: string }
    | {
          readonly role: "reject";
          /** Full diagnosis, sent as the HTTP body of the refused upgrade and logged. */
          readonly detail: string;
          /**
           * The same refusal in at most 123 bytes, the hard limit RFC 6455 puts
           * on a close reason. Anything longer makes `ws.close()` throw.
           */
          readonly closeReason: string;
      };

/**
 * What the broker does when a provider connects to a slot another socket
 * already holds.
 *
 * - `reject`: refuse the newcomer whenever the incumbent socket is OPEN. The
 *   pre-1.3 behavior, and the only mode that never disconnects a live provider,
 *   at the cost of a slot wedged by a half-open socket until the OS gives up on
 *   it (roughly two hours).
 * - `liveness` (default): refuse only while the incumbent still answers the
 *   heartbeat. A socket that missed its last ping is terminated and the
 *   newcomer takes the slot.
 * - `always`: the newcomer always wins. Honored **only** when
 *   {@link IWsTunnelOptions.providerAuth} is configured and the newcomer
 *   authenticated as the same principal as the incumbent; otherwise the broker
 *   falls back to `liveness` and says so, because with provider auth off anyone
 *   who can reach the URL could evict the real provider at will.
 */
export type ProviderTakeoverMode = "reject" | "liveness" | "always";

/**
 * How `/<slot>/mcp` decides whether a browser origin may reach it.
 *
 * - a list of origins, matched exactly against the whole `Origin` header
 * - a `RegExp`, tested against the whole header
 * - a predicate, when the decision needs more than the string
 */
export type AllowedOrigins = readonly string[] | RegExp | ((origin: string) => boolean);

/** One Streamable HTTP session attached to a provider slot. */
export interface IHttpSession {
    /** The session's server-side transport, as handed over by the endpoint. */
    readonly transport: IMessageTransport;

    /**
     * The caller behind the most recent request on this session.
     *
     * Refreshed per request rather than fixed at creation: the frame-level
     * policy check needs the identity that presented the current token, and a
     * session outlives the token it started with.
     */
    principal: IPrincipal | null;
}

/** One request the broker sent to a provider and is still waiting on. */
export interface IPendingRequest {
    /** Where the answer goes when it arrives. */
    readonly sink: ResponseSink;

    /**
     * The id the **client** used, restored on the way back.
     *
     * The map is keyed by a broker-assigned id instead, because the client's id
     * is not unique on a slot: two MCP clients that both number their requests
     * from 1 (MCP Inspector and Claude on the same slot, the documented
     * scenario) would otherwise overwrite each other's entry, and one of them
     * receives the other's result while its own request hangs forever.
     */
    readonly clientId: string | number;

    /**
     * Epoch milliseconds after which the request is failed with a timeout, or
     * `0` when {@link IWsTunnelOptions.providerRequestTimeoutMs} is disabled and
     * the entry may wait indefinitely.
     */
    readonly expiresAt: number;
}

/**
 * All mutable state for one named provider slot.
 * Created lazily on first client connection; the WebSocket field is set when
 * the provider actually connects (and cleared on disconnect).
 */
export interface IProviderState {
    /** The active provider WebSocket, or `null` when the provider is not connected. */
    ws: WebSocket | null;
    /**
     * `Date.now()` when the provider currently serving the slot attached
     * (socket, upstream or loopback), `null` while nothing serves it. What
     * `providers_list` reports as `connectedSince`.
     */
    connectedSinceMs: number | null;
    /**
     * In-flight requests, keyed by the **broker-assigned** id that was written
     * into the frame sent to the provider. See {@link IPendingRequest.clientId}
     * for why the client's own id cannot be the key.
     */
    readonly pending: Map<string | number, IPendingRequest>;
    /** Active legacy SSE sessions (Claude), keyed by session id. */
    readonly sseSessions: Map<string, ServerResponse>;
    /** Active Streamable HTTP sessions, keyed by `Mcp-Session-Id`. */
    readonly httpSessions: Map<string, IHttpSession>;
    /** Raw WebSocket MCP clients connected to this provider. */
    readonly wsClients: Set<WebSocket>;
    /** In-process clients (e.g. the aggregate server) attached to this slot. */
    readonly internalClients: Set<IInternalClient>;
    /** Lazily built Streamable HTTP endpoint serving this slot. */
    httpEndpoint: StreamableHttpEndpoint | null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single static-file mount: serves the contents of `dir` under `urlPrefix`.
 *
 * @example
 * { urlPrefix: "/",       dir: "/absolute/path/to/www" }
 * { urlPrefix: "/bundle", dir: "/absolute/path/to/bundle" }
 */
export interface IStaticMount {
    /** URL prefix that triggers this mount (e.g. `"/"` or `"/bundle"`). */
    urlPrefix: string;
    /** Absolute path to the directory to serve. */
    dir: string;
}

/**
 * In-process client handle for a provider slot: the symmetric counterpart of
 * {@link WsTunnel.registerLoopbackProvider}. Lets a component inside the broker
 * process (e.g. the aggregate server) issue MCP requests to a provider slot and
 * receive both the responses and the provider's broadcast notifications,
 * without opening a real network connection.
 */
export interface IInternalClient {
    /**
     * Sends a JSON-RPC message to the provider slot. When the message carries an
     * `id`, the matching response is delivered to {@link onMessage}. When the
     * provider is not connected, a JSON-RPC error is delivered synchronously.
     */
    send(message: string): void;
    /** Receives responses to this client's requests and the provider's notifications. */
    onMessage: ((data: string) => void) | null;
    /** Fires when the provider slot loses its connection. */
    onClose: (() => void) | null;
    /** Detaches this internal client; pending requests are dropped. */
    close(): void;
}

/**
 * Configuration options for a {@link WsTunnel} instance.
 */
export interface IWsTunnelOptions {
    /** TCP port to listen on. */
    port: number;

    /**
     * Host/interface to bind to.
     * @default "0.0.0.0"
     */
    host?: string;

    /**
     * URL path **prefix** the MCP provider connects to via WebSocket.
     * Each provider appends its name: `<providerPath>/<encodedName>`.
     * @default "/provider"
     */
    providerPath?: string;

    /**
     * URL path for **multiplexed** provider connections.
     * A single WebSocket carries traffic for multiple providers using the
     * envelope protocol `{ provider: string, payload: object }`.
     * @default "/providers"
     */
    providersPath?: string;

    /**
     * URL path raw WebSocket MCP clients connect to.
     * @default "/"
     */
    clientPath?: string;

    /**
     * **Suffix** appended to a provider name for the SSE endpoint.
     * Full URL: `/<providerName>/sse`
     * @default "/sse"
     */
    ssePath?: string;

    /**
     * **Suffix** appended to a provider name for the legacy SSE POST endpoint.
     * Full URL: `/<providerName>/messages`
     * @default "/messages"
     */
    messagesPath?: string;

    /**
     * **Suffix** appended to a provider name for the Streamable HTTP endpoint (MCP 2025-03-26).
     * Full URL: `/<providerName>/mcp`
     * MCP Inspector connects here.
     * @default "/mcp"
     */
    mcpPath?: string;

    /**
     * URL path that returns a `{ files: string[] }` JSON listing of every file
     * inside the `samples/` subdirectory of the root static mount.
     * @default "/__samples_index__"
     */
    samplesIndexPath?: string;

    /**
     * Browser origins allowed to reach a slot's client endpoints: `/<slot>/mcp`
     * (Streamable HTTP) and the legacy SSE pair `/<slot>/sse` + `/<slot>/messages`.
     *
     * The MCP specification requires the `Origin` header to be validated,
     * because without it any web page the operator's browser happens to load
     * can drive a broker that machine can reach. A request carrying **no**
     * `Origin` is always allowed: that covers every non-browser client, which
     * is what Claude Desktop, MCP Inspector and the server-side SDKs are.
     *
     * Omit this and every browser origin is refused with `403`. The default is
     * deliberately closed; opening it is an operator decision.
     *
     * @default undefined, no browser origin is allowed
     */
    allowedOrigins?: AllowedOrigins;

    /**
     * How often, in milliseconds, the broker pings every connected provider
     * socket to check it is still there. `0` disables the heartbeat entirely.
     *
     * A provider that does not answer within one full interval is terminated,
     * which frees its slot for the reconnect that is usually already being
     * refused. Without this the only evidence of occupancy is the socket's
     * `readyState`, and a half-open socket (a killed browser tab, a laptop that
     * slept, a severed VPN) stays `OPEN` until the OS gives up on the TCP
     * connection, roughly two hours, during which the broker cheerfully reports
     * the zombie as connected, routes client frames into it, and refuses every
     * reconnect attempt with a `1008`.
     *
     * **What a pong actually proves.** An RFC 6455 pong is answered by the
     * peer's network stack, which in a browser is not the page's JavaScript
     * thread. So this detects a dead process, a dead machine and a dead network
     * path; it does **not** detect a page whose event loop is blocked or whose
     * MCP server stopped serving. For that failure use
     * {@link providerRequestTimeoutMs}, which measures the answer rather than
     * the socket.
     *
     * @default 30000
     */
    providerHeartbeatIntervalMs?: number;

    /**
     * What happens when a provider connects to a slot another socket holds.
     *
     * @default "liveness", the incumbent keeps the slot only while it still
     *          answers the heartbeat
     */
    providerTakeover?: ProviderTakeoverMode;

    /**
     * How long, in milliseconds, the broker waits for a provider to answer one
     * request before failing it. `0` disables the timeout.
     *
     * On expiry the waiting client receives a JSON-RPC error naming the slot and
     * the elapsed time, addressed to the id it used. Without it, a provider that
     * simply never answers (a browser tab throttled in the background is the
     * normal case, not the exotic one) leaves the client's request open forever
     * with nothing to release it and no diagnostic anywhere.
     *
     * Raise it if you host genuinely long-running tools; a slow answer is worth
     * waiting for, but a hang with no error is not.
     *
     * @default 60000
     */
    providerRequestTimeoutMs?: number;

    /**
     * Optional static-file mounts served over plain HTTP.
     * Matched by longest URL prefix; directory requests fall back to `index.html`.
     */
    staticMounts?: IStaticMount[];

    /**
     * Stdio upstream providers. Each entry spawns a child process and wires its
     * stdin/stdout as an MCP transport. Clients reach the process using its `name`
     * directly.
     *
     * If a WebSocket provider connects with the same name as a stdio upstream, the
     * connection is rejected and a warning is logged, stdio takes priority.
     * @default undefined: no stdio providers
     */
    stdioUpstreams?: IStdioUpstreamConfig[];

    /** Remote MCP servers reached by URL, exposed as provider slots. */
    remoteUpstreams?: IRemoteUpstreamConfig[];

    /**
     * Stdio client transport. When set, the broker reads JSON-RPC from
     * `process.stdin` and writes responses to `process.stdout`, bridging an
     * external MCP client (e.g. Claude Desktop) to the named provider.
     *
     * In this mode ALL logging is redirected to stderr so stdout stays clean
     * for the JSON-RPC stream.
     *
     * Claude Desktop config example:
     * ```json
     * {
     *   "command": "npx",
     *   "args": ["-y", "@cyanmycelium/mcp-broker"],
     *   "env": { "MCP_BROKER_STDIO_PROVIDER": "my-provider" }
     * }
     * ```
     * @default undefined, stdio client transport disabled
     */
    stdioClient?: { providerName: string };

    /**
     * TLS configuration. When provided, the server uses HTTPS and WSS instead of HTTP and WS.
     * Both `cert` and `key` must be PEM-encoded strings (file contents, not file paths).
     * Use {@link WsTunnelBuilder.withTlsFiles} to load from disk paths.
     * @default undefined, plain HTTP/WS
     */
    tls?: {
        /** PEM-encoded TLS certificate. */
        cert: string;
        /** PEM-encoded private key. */
        key: string;
    };

    /**
     * When `true` (default), the broker exposes itself as an MCP server under the
     * reserved slot `_broker`. Tier-1 behaviors (`broker_info`, `providers_list`,
     * `provider_status`) become callable at `<host>/_broker/mcp`.
     *
     * Set to `false` to keep the broker invisible to MCP clients.
     * @default true
     */
    enableBrokerProvider?: boolean;

    /**
     * When `true` (default), the broker exposes the reserved slot `_all`: an
     * aggregate MCP server that unions the tools and prompts of every provider
     * that opted in via the registration handshake. Reachable like any other
     * slot (`<host>/_all/mcp`, etc.).
     *
     * Set to `false` to disable aggregation entirely.
     * @default true
     */
    enableAggregateProvider?: boolean;

    /**
     * Logical name reported by `broker_info`. Useful when running multiple
     * broker instances and you want to tell them apart from the agent side
     * (e.g. `"broker-eu-west"`).
     * @default PACKAGE_NAME, `@cyanmycelium/mcp-broker`
     */
    brokerName?: string;

    /**
     * Overrides for the embedded broker server's grammar resolver, passed
     * straight through to `mcp-core`'s `grammarResolverFromOptions`. The
     * broker installs its own default `localeSource` (reads
     * `process.env.MCP_BROKER_LOCALE`); anything you set here wins.
     *
     * Use this to inject a custom `localeSource` (e.g. read from an HTTP
     * header proxied by your transport), enable the optional `versionFrom`
     * dimension, or extend the `agents` map with additional LLM families.
     */
    brokerGrammarResolverOptions?: Partial<GrammarResolverOptions>;

    /**
     * Path to a user-supplied grammars directory whose `<userAgent>/<locale>.json`
     * files are registered alongside the packaged grammars used by the
     * embedded broker server. Typically pointed at `.mcp-broker/grammars/`.
     *
     * The candidate-chain resolution in `McpServer.initialize`
     * (mcp-core@0.3.0) handles cascade across user-agent and locale
     * dimensions, so partial files no longer need to be pre-merged with a
     * baseline.
     */
    brokerLocalGrammarsDir?: string;

    /**
     * OAuth 2.1 resource-server authorization. When set, every HTTP client
     * request to a slot (`/<slot>/mcp`, `/<slot>/sse`, `/<slot>/messages`) must
     * carry a valid `Authorization: Bearer` token issued for that slot, and the
     * broker publishes Protected Resource Metadata (RFC 9728) under
     * `/.well-known/oauth-protected-resource/<slot>/<mcp>`.
     *
     * When `undefined` (default), the broker performs **no** authentication ,
     * appropriate only behind a trusted network boundary.
     */
    auth?: IResolvedAuth;

    /**
     * Authenticates **providers** (engines) connecting to `/provider/<slot>` and
     * the multiplexed `/providers` socket. Independent of {@link auth} (which
     * guards clients): set this to stop strangers from occupying a free slot and
     * impersonating the real engine.
     *
     * When `undefined` (default), provider connections are **not** authenticated.
     */
    providerAuth?: IProviderAuthenticator;

    /** Hierarchical policy runtime. Absent preserves legacy OAuth behavior. */
    authorization?: IPolicyAuthorization;

    /** Slot-to-resource resolver also used for provider namespace restrictions. */
    slotResourceResolver?: ISlotResourceResolver;
}

/** @deprecated Use {@link IStaticMount}. */
export type StaticMount = IStaticMount;

/** @deprecated Use {@link IInternalClient}. */
export type InternalClient = IInternalClient;

/** @deprecated Use {@link IWsTunnelOptions}. */
export type WsTunnelOptions = IWsTunnelOptions;
