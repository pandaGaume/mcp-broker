import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as nodePath from "path";
import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { IMessageTransport, IMcpServer } from "@cyanmycelium/mcp-core";
import { StdioUpstream, type StdioUpstreamConfig } from "./stdio.upstream.js";
import { RemoteUpstream, type RemoteUpstreamConfig } from "./remote.upstream.js";
import type { Upstream } from "./upstream.js";
import { startBrokerServer, BROKER_PROVIDER_NAME } from "./broker/index.js";
import type { BrokerContext, BrokerLocaleResolver, BrokerProviderInfo, BrokerProviderTransport, BrokerUserAgentResolver } from "./broker/index.js";
import { AggregateServer } from "./broker/aggregate/aggregate.server.js";
import { VERSION, PACKAGE_NAME } from "./version.js";

// ---------------------------------------------------------------------------
// Static-file helpers
// ---------------------------------------------------------------------------

/** Maps file extensions to their HTTP Content-Type values. */
const MIME: Readonly<Record<string, string>> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Where a JSON-RPC response should be delivered.
 * Either a WebSocket socket (raw WS client), an SSE session (legacy MCP/HTTP),
 * a held-open HTTP response (Streamable HTTP transport, MCP 2025-03-26),
 * the process stdout (stdio transport for Claude Desktop), or an in-process
 * internal client (e.g. the aggregate server).
 */
type ResponseSink =
    | { type: "ws"; socket: WebSocket }
    | { type: "sse"; sessionId: string }
    | { type: "http"; res: ServerResponse }
    | { type: "stdio" }
    | { type: "internal"; client: InternalClient };

/**
 * All mutable state for one named provider slot.
 * Created lazily on first client connection; the WebSocket field is set when
 * the provider actually connects (and cleared on disconnect).
 */
interface ProviderState {
    /** The active provider WebSocket, or `null` when the provider is not connected. */
    ws: WebSocket | null;
    /** Pending JSON-RPC request ids → response sinks waiting for a reply. */
    readonly pending: Map<string | number, ResponseSink>;
    /** Active legacy SSE sessions (Claude), keyed by session id. */
    readonly sseSessions: Map<string, ServerResponse>;
    /** Active Streamable HTTP GET streams (MCP Inspector), keyed by session id. */
    readonly mcpGetSessions: Map<string, ServerResponse>;
    /** Raw WebSocket MCP clients connected to this provider. */
    readonly wsClients: Set<WebSocket>;
    /** In-process clients (e.g. the aggregate server) attached to this slot. */
    readonly internalClients: Set<InternalClient>;
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
export interface StaticMount {
    /** URL prefix that triggers this mount (e.g. `"/"` or `"/bundle"`). */
    urlPrefix: string;
    /** Absolute path to the directory to serve. */
    dir: string;
}

/**
 * In-process client handle for a provider slot — the symmetric counterpart of
 * {@link WsTunnel.registerLoopbackProvider}. Lets a component inside the broker
 * process (e.g. the aggregate server) issue MCP requests to a provider slot and
 * receive both the responses and the provider's broadcast notifications,
 * without opening a real network connection.
 */
export interface InternalClient {
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
export interface WsTunnelOptions {
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
     * Optional static-file mounts served over plain HTTP.
     * Matched by longest URL prefix; directory requests fall back to `index.html`.
     */
    staticMounts?: StaticMount[];

    /**
     * Stdio upstream providers. Each entry spawns a child process and wires its
     * stdin/stdout as an MCP transport. Clients reach the process using its `name`
     * directly.
     *
     * If a WebSocket provider connects with the same name as a stdio upstream, the
     * connection is rejected and a warning is logged — stdio takes priority.
     * @default undefined — no stdio providers
     */
    stdioUpstreams?: StdioUpstreamConfig[];

    /** Remote MCP servers reached by URL, exposed as provider slots. */
    remoteUpstreams?: RemoteUpstreamConfig[];

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
     * @default undefined — stdio client transport disabled
     */
    stdioClient?: { providerName: string };

    /**
     * TLS configuration. When provided, the server uses HTTPS and WSS instead of HTTP and WS.
     * Both `cert` and `key` must be PEM-encoded strings (file contents, not file paths).
     * Use {@link WsTunnelBuilder.withTlsFiles} to load from disk paths.
     * @default undefined — plain HTTP/WS
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
     * When `true` (default), the broker exposes the reserved slot `_all` — an
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
     * @default PACKAGE_NAME — `@cyanmycelium/mcp-broker`
     */
    brokerName?: string;

    /**
     * Custom resolver picking the grammar locale for the embedded broker
     * server. Defaults to `defaultBrokerLocaleResolver` (keeps the ISO 639-1
     * prefix of a BCP-47 tag read from `MCP_BROKER_LOCALE`).
     */
    brokerLocaleResolver?: BrokerLocaleResolver;

    /**
     * Custom resolver mapping a connecting client's identity to a user-agent
     * family. Defaults to `defaultBrokerUserAgentResolver` (substring match on
     * `clientInfo.name` against known LLM families).
     */
    brokerUserAgentResolver?: BrokerUserAgentResolver;

    /**
     * Custom source of the raw locale string fed to the locale resolver.
     * Defaults to `() => process.env.MCP_BROKER_LOCALE`. Override when the
     * locale should come from a config file, HTTP header, etc.
     */
    brokerLocaleSource?: () => string | undefined;

    /**
     * Path to a user-supplied grammars directory whose `<userAgent>/<locale>.json`
     * files are merged **on top of** the packaged grammars used by the embedded
     * broker server. Typically pointed at `.mcp-broker/grammars/`.
     */
    brokerLocalGrammarsDir?: string;
}

// ---------------------------------------------------------------------------
// WsTunnel
// ---------------------------------------------------------------------------

/**
 * A multi-provider relay that bridges any number of MCP server instances
 * (the **providers**) with their respective MCP clients.
 *
 * ## Transport overview
 * ```
 * Provider "<name>"
 *   ws://host/provider/<name>           ← WebSocket registration
 *
 * MCP Inspector (Streamable HTTP, 2025-03-26)
 *   GET  http://host/<name>/mcp         ← persistent SSE notification stream
 *   POST http://host/<name>/mcp         → JSON-RPC requests
 *
 * Claude (legacy SSE transport)
 *   GET  http://host/<name>/sse              ← SSE notification stream
 *   POST http://host/<name>/messages         → JSON-RPC requests
 * ```
 *
 * Each provider gets its own isolated set of sessions, pending requests, and
 * notification streams. Multiple providers can be connected simultaneously.
 */
export class WsTunnel implements BrokerContext {
    private readonly _options: WsTunnelOptions;
    private _httpServer: http.Server | https.Server | null = null;
    private _wss: WebSocketServer | null = null;

    /**
     * Per-provider state, keyed by provider name.
     * Created lazily: a slot is allocated the first time any client references
     * a provider name, even before the provider WebSocket connects.
     */
    private readonly _providers = new Map<string, ProviderState>();

    /** Maps a multiplexed WebSocket to the set of provider names it feeds. */
    private readonly _multiplexSockets = new Map<WebSocket, Set<string>>();

    /** Upstream providers (stdio child processes and remote URL servers), keyed by name. */
    private readonly _upstreams = new Map<string, Upstream>();

    /**
     * In-process loopback transports registered as provider slots.
     * Used by the embedded broker server (`_broker`) and any other component
     * that wants to expose itself as a provider without going through a network.
     */
    private readonly _loopbackProviders = new Map<string, IMessageTransport>();

    /** The embedded broker MCP server, when {@link WsTunnelOptions.enableBrokerProvider} is on. */
    private _brokerServer: IMcpServer | null = null;

    /** The aggregate MCP server (`_all` slot), when {@link WsTunnelOptions.enableAggregateProvider} is on. */
    private _aggregateServer: AggregateServer | null = null;

    /** Provider name that the stdio client transport is bridged to, or null when disabled. */
    private _stdioClientProvider: string | null = null;

    /** Buffered partial line from stdin (stdio client transport). */
    private _stdioClientBuffer = "";

    /** Timestamp of the most recent successful `start()`. */
    private _startedAt: Date | null = null;

    constructor(options: WsTunnelOptions) {
        this._options = options;
    }

    // -------------------------------------------------------------------------
    // BrokerContext implementation
    // -------------------------------------------------------------------------

    get version(): string {
        return VERSION;
    }

    get name(): string {
        return this._options.brokerName ?? PACKAGE_NAME;
    }

    get startedAt(): Date | null {
        return this._startedAt;
    }

    get uptimeSeconds(): number {
        if (!this._startedAt) return 0;
        return Math.floor((Date.now() - this._startedAt.getTime()) / 1000);
    }

    get host(): string | undefined {
        return this._options.host;
    }

    get port(): number {
        return this._options.port;
    }

    get tls(): boolean {
        return !!this._options.tls;
    }

    get paths(): BrokerContext["paths"] {
        const o = this._options;
        return {
            provider: o.providerPath ?? "/provider",
            providers: o.providersPath ?? "/providers",
            client: o.clientPath ?? "/",
            mcp: o.mcpPath ?? "/mcp",
            sse: o.ssePath ?? "/sse",
            messages: o.messagesPath ?? "/messages",
        };
    }

    public getProvidersInfo(): BrokerProviderInfo[] {
        const out: BrokerProviderInfo[] = [];
        for (const [name, state] of this._providers) {
            out.push(this._buildProviderInfo(name, state));
        }
        return out;
    }

    public getProviderInfo(name: string): BrokerProviderInfo | undefined {
        const state = this._providers.get(name);
        if (!state) return undefined;
        return this._buildProviderInfo(name, state);
    }

    private _buildProviderInfo(name: string, state: ProviderState): BrokerProviderInfo {
        let transport: BrokerProviderTransport;
        let connected: boolean;

        if (this._loopbackProviders.get(name)?.isOpen) {
            transport = "loopback";
            connected = true;
        } else if (this._upstreams.get(name)?.isOpen) {
            transport = "stdio";
            connected = true;
        } else if (state.ws?.readyState === WebSocket.OPEN) {
            transport = this._multiplexSockets.has(state.ws) ? "ws-multiplex" : "ws";
            connected = true;
        } else {
            transport = "none";
            connected = false;
        }

        return {
            name,
            transport,
            connected,
            clientCount: state.wsClients.size,
            sessionCount: state.sseSessions.size + state.mcpGetSessions.size,
            pendingCount: state.pending.size,
        };
    }

    // -------------------------------------------------------------------------
    // Loopback provider registration (in-process transports)
    // -------------------------------------------------------------------------

    /**
     * Registers an in-process transport as a provider slot. Used by the embedded
     * broker server and may be used by application code that wants to host an
     * MCP server inside the same process without opening a real WebSocket.
     *
     * @throws if the name is already used by a stdio upstream or another loopback.
     */
    public registerLoopbackProvider(name: string, transport: IMessageTransport): void {
        if (this._loopbackProviders.has(name)) {
            throw new Error(`Loopback provider "${name}" is already registered.`);
        }
        if (this._upstreams.has(name)) {
            throw new Error(`Cannot register loopback "${name}": a stdio upstream with the same name already exists.`);
        }

        const state = this._getOrCreateProviderState(name);
        this._loopbackProviders.set(name, transport);

        transport.onMessage = (data: string) => this._routeFromProvider(state, data);
        transport.onClose = () => {
            this._loopbackProviders.delete(name);
            this._failProviderDisconnected(state, name);
        };
    }

    /**
     * Opens an in-process client to a provider slot. The returned handle can
     * issue MCP requests and receives both the responses and the provider's
     * broadcast notifications. Used by the aggregate server to fan a single
     * in-process client out to every aggregated provider.
     *
     * The slot does not need a provider attached yet — `send` returns a
     * JSON-RPC error while the provider is disconnected.
     */
    public openInternalClient(providerName: string): InternalClient {
        const state = this._getOrCreateProviderState(providerName);
        let closed = false;

        const client: InternalClient = {
            onMessage: null,
            onClose: null,
            send: (message: string): void => {
                if (closed) return;
                let id: string | number | null = null;
                try {
                    const parsed = JSON.parse(message) as { id?: string | number };
                    if (parsed?.id != null) id = parsed.id;
                } catch {
                    /* forward as-is */
                }
                if (this._isProviderConnected(providerName, state)) {
                    if (id != null) state.pending.set(id, { type: "internal", client });
                    this._sendToProvider(state, providerName, message);
                } else if (id != null) {
                    client.onMessage?.(
                        JSON.stringify({
                            jsonrpc: "2.0",
                            id,
                            error: { code: -32000, message: `Provider "${providerName}" not connected` },
                        })
                    );
                }
            },
            close: (): void => {
                if (closed) return;
                closed = true;
                state.internalClients.delete(client);
                for (const [id, sink] of state.pending) {
                    if (sink.type === "internal" && sink.client === client) state.pending.delete(id);
                }
            },
        };

        state.internalClients.add(client);
        return client;
    }

    // -------------------------------------------------------------------------
    // Public state
    // -------------------------------------------------------------------------

    get isListening(): boolean {
        return this._httpServer?.listening ?? false;
    }

    /** Total number of connected MCP clients across all providers. */
    get clientCount(): number {
        let n = 0;
        for (const s of this._providers.values()) {
            n += s.wsClients.size + s.sseSessions.size + s.mcpGetSessions.size;
        }
        return n;
    }

    /** Names of all providers that currently have an active connection. */
    get providerNames(): readonly string[] {
        return [...this._providers.entries()].filter(([name, s]) => this._isProviderConnected(name, s)).map(([name]) => name);
    }

    /** @deprecated Check `providerNames.length > 0` instead. */
    get hasProvider(): boolean {
        return this.providerNames.length > 0;
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /**
     * Starts the broker. Resolves once the HTTP server is listening.
     */
    start(): Promise<void> {
        return new Promise((resolve) => {
            const handler = (req: IncomingMessage, res: ServerResponse) => this._handleHttp(req, res);
            this._httpServer = this._options.tls ? https.createServer({ cert: this._options.tls.cert, key: this._options.tls.key }, handler) : http.createServer(handler);
            // Disable perMessageDeflate: payloads may be large base64-encoded blobs
            // (snapshots, images) that are already compressed. Deflating them wastes
            // CPU without reducing size, and caused multi-second stalls in practice.
            this._wss = new WebSocketServer({ server: this._httpServer, perMessageDeflate: false });

            this._wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
                const url = req.url ?? "/";
                const providerPath = this._options.providerPath ?? "/provider";
                const providersPath = this._options.providersPath ?? "/providers";

                if (url === providersPath || url.startsWith(providersPath + "?")) {
                    // Multiplexed provider: one WebSocket carries N providers via envelopes.
                    this._onMultiplexProviderConnect(ws);
                } else if (url.startsWith(providerPath + "/") || url === providerPath) {
                    // Extract name: everything after "<providerPath>/"
                    const raw = url.slice(providerPath.length).replace(/^\//, "");
                    const name = decodeURIComponent(raw.split("?")[0]) || "(unnamed)";
                    this._onProviderConnect(ws, name);
                } else {
                    // Raw WS MCP client: URL is "/<providerName>" or "/"
                    const raw = url.replace(/^\//, "").split("?")[0];
                    const name = decodeURIComponent(raw) || "";
                    this._onClientConnect(ws, name);
                }
            });

            this._httpServer.listen(this._options.port, this._options.host ?? "0.0.0.0", () => {
                // Bring the aggregate `_all` slot up before any upstream connects
                // (a Streamable HTTP upstream opens synchronously on connect()).
                this._maybeStartAggregateServer();

                // Attach configured upstreams (stdio child processes + remote URL
                // servers). Both implement the Upstream contract, so the wiring
                // into a provider slot is identical.
                const wireUpstream = (cfg: { name: string; aggregate?: boolean }, upstream: Upstream): void => {
                    upstream.onMessage = (data) => {
                        const state = this._getOrCreateProviderState(cfg.name);
                        this._routeFromProvider(state, data);
                    };
                    upstream.onError = (err) => {
                        console.error(`[broker] ${err.message}`);
                    };
                    upstream.onClose = () => {
                        const state = this._providers.get(cfg.name);
                        if (state) this._failProviderDisconnected(state, cfg.name);
                    };
                    if (cfg.aggregate) {
                        upstream.onOpen = () => void this._aggregateServer?.addProvider(cfg.name);
                    }
                    this._upstreams.set(cfg.name, upstream);
                    upstream.connect();
                };
                for (const cfg of this._options.stdioUpstreams ?? []) wireUpstream(cfg, new StdioUpstream(cfg));
                for (const cfg of this._options.remoteUpstreams ?? []) wireUpstream(cfg, new RemoteUpstream(cfg));

                // Attach stdio client transport if configured.
                // stdin carries Claude Desktop's JSON-RPC requests; stdout carries responses.
                if (this._options.stdioClient) {
                    this._stdioClientProvider = this._options.stdioClient.providerName;
                    process.stdin.setEncoding("utf8");
                    process.stdin.on("data", (chunk: string) => {
                        this._stdioClientBuffer += chunk;
                        let nl: number;
                        while ((nl = this._stdioClientBuffer.indexOf("\n")) !== -1) {
                            const line = this._stdioClientBuffer.slice(0, nl).trim();
                            this._stdioClientBuffer = this._stdioClientBuffer.slice(nl + 1);
                            if (line) {
                                const state = this._getOrCreateProviderState(this._stdioClientProvider!);
                                this._routeFromStdioClient(state, line);
                            }
                        }
                    });
                    process.stdin.on("end", () => {
                        // Client disconnected — nothing to clean up; pending sinks will time out.
                    });
                }

                this._startedAt = new Date();

                // Spawn the embedded broker server last so it can already report
                // accurate state in its first `broker_info` call.
                void this._maybeStartBrokerServer().then(
                    () => resolve(),
                    (err: unknown) => {
                        console.error("[broker] embedded broker server failed to start:", err);
                        // Keep the tunnel up even if the introspection server fails.
                        resolve();
                    }
                );
            });
        });
    }

    /**
     * Starts the in-process MCP server that exposes the broker's own behaviors
     * (`broker_info`, `providers_list`, `provider_status`) under the reserved
     * provider slot `_broker`. No-op when {@link WsTunnelOptions.enableBrokerProvider}
     * is `false`.
     */
    private async _maybeStartBrokerServer(): Promise<void> {
        if (this._options.enableBrokerProvider === false) return;
        const { server, clientTransport } = await startBrokerServer(this, {
            localeResolver: this._options.brokerLocaleResolver,
            userAgentResolver: this._options.brokerUserAgentResolver,
            localeSource: this._options.brokerLocaleSource,
            localGrammarsDir: this._options.brokerLocalGrammarsDir,
        });
        this._brokerServer = server;
        this.registerLoopbackProvider(BROKER_PROVIDER_NAME, clientTransport);
    }

    /**
     * Starts the aggregate MCP server and registers it on the reserved `_all`
     * slot. No-op when {@link WsTunnelOptions.enableAggregateProvider} is `false`.
     */
    private _maybeStartAggregateServer(): void {
        if (this._options.enableAggregateProvider === false) return;
        try {
            const server = new AggregateServer((providerName) => this.openInternalClient(providerName));
            server.start();
            this.registerLoopbackProvider(AggregateServer.SLOT, server);
            this._aggregateServer = server;
        } catch (err) {
            console.error(`[broker] aggregate server failed to start: ${(err as Error).message}`);
        }
    }

    /**
     * Gracefully closes all connections and stops the HTTP server.
     */
    async stop(): Promise<void> {
        // Stop the embedded broker first so it does not see its loopback close
        // as an unexpected disconnect (and to flush any pending broker responses).
        const brokerServer = this._brokerServer;
        this._brokerServer = null;
        if (brokerServer) {
            try {
                await brokerServer.stop();
            } catch {
                /* best-effort; continue tearing down */
            }
        }

        // Close the aggregate server so its provider sessions and internal
        // clients detach before the provider slots are torn down.
        const aggregateServer = this._aggregateServer;
        this._aggregateServer = null;
        if (aggregateServer) {
            try {
                aggregateServer.close();
            } catch {
                /* best-effort; continue tearing down */
            }
        }

        return new Promise((resolve, reject) => {
            for (const state of this._providers.values()) {
                for (const res of state.sseSessions.values()) res.end();
                state.sseSessions.clear();
                for (const res of state.mcpGetSessions.values()) res.end();
                state.mcpGetSessions.clear();
                for (const client of state.wsClients) client.close();
                state.wsClients.clear();
                state.ws?.close();
            }
            this._providers.clear();
            this._multiplexSockets.clear();
            for (const upstream of this._upstreams.values()) upstream.close();
            this._upstreams.clear();
            for (const loopback of this._loopbackProviders.values()) loopback.close();
            this._loopbackProviders.clear();
            this._startedAt = null;
            this._wss?.close();
            this._httpServer?.close((err) => (err ? reject(err) : resolve()));
        });
    }

    // -------------------------------------------------------------------------
    // HTTP dispatcher
    // -------------------------------------------------------------------------

    private _handleHttp(req: IncomingMessage, res: ServerResponse): void {
        const method = req.method ?? "GET";
        const rawUrl = (req.url ?? "/").split("?")[0];

        // CORS
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "Content-Type, Accept, Mcp-Session-Id");
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

        if (method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        // Samples index (no provider prefix)
        const samplesIndexPath = this._options.samplesIndexPath ?? "/__samples_index__";
        if (method === "GET" && rawUrl === samplesIndexPath) {
            this._handleSamplesIndex(res);
            return;
        }

        // Route /<providerName>/<endpoint>
        const route = this._parseProviderRoute(rawUrl);
        if (route) {
            const { providerName, endpoint } = route;
            const mcpSuffix = (this._options.mcpPath ?? "/mcp").replace(/^\//, "");
            const sseSuffix = (this._options.ssePath ?? "/sse").replace(/^\//, "");
            const messagesSuffix = (this._options.messagesPath ?? "/messages").replace(/^\//, "");

            if (endpoint === mcpSuffix) {
                if (method === "GET") {
                    this._handleMcpGetStream(req, res, providerName);
                    return;
                }
                if (method === "POST") {
                    this._handleMcpPost(req, res, providerName);
                    return;
                }
            }
            if (endpoint === sseSuffix && method === "GET") {
                this._handleSseConnect(req, res, providerName);
                return;
            }
            if (endpoint === messagesSuffix && method === "POST") {
                this._handleSseMessage(req, res, providerName);
                return;
            }
        }

        // Static files
        if (this._options.staticMounts?.length) {
            this._serveStatic(req, res);
        } else {
            res.writeHead(404);
            res.end();
        }
    }

    /**
     * Parses `/<providerName>/<endpoint>` from a URL path.
     * Returns `null` if the URL does not match this two-segment pattern.
     */
    private _parseProviderRoute(rawUrl: string): { providerName: string; endpoint: string } | null {
        const parts = rawUrl.split("/").filter(Boolean);
        if (parts.length !== 2) return null;
        const providerName = decodeURIComponent(parts[0]);
        const endpoint = decodeURIComponent(parts[1]);
        if (!providerName || !endpoint) return null;
        return { providerName, endpoint };
    }

    // -------------------------------------------------------------------------
    // MCP / SSE transport (per provider)
    // -------------------------------------------------------------------------

    /**
     * Handles `GET /<providerName>/sse` — opens a long-lived SSE stream for Claude.
     * Sends an `endpoint` event so Claude knows where to POST its requests.
     */
    private _handleSseConnect(req: IncomingMessage, res: ServerResponse, providerName: string): void {
        const sessionId = randomUUID();
        const messagesSuffix = (this._options.messagesPath ?? "/messages").replace(/^\//, "");
        const messagesUrl = `/${encodeURIComponent(providerName)}/${messagesSuffix}`;

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
        });
        res.write(`event: endpoint\ndata: ${messagesUrl}?sessionId=${sessionId}\n\n`);

        const state = this._getOrCreateProviderState(providerName);
        state.sseSessions.set(sessionId, res);

        req.on("close", () => {
            state.sseSessions.delete(sessionId);
            for (const [id, sink] of state.pending) {
                if (sink.type === "sse" && sink.sessionId === sessionId) state.pending.delete(id);
            }
        });
    }

    /**
     * Handles `POST /<providerName>/messages?sessionId=…` — receives a JSON-RPC
     * request from Claude and forwards it to the provider.
     * Always responds 202 Accepted; the real response arrives over SSE.
     */
    private _handleSseMessage(req: IncomingMessage, res: ServerResponse, providerName: string): void {
        const params = new URL(req.url ?? "", "http://localhost").searchParams;
        const sessionId = params.get("sessionId") ?? "";
        const state = this._getOrCreateProviderState(providerName);

        if (!state.sseSessions.has(sessionId)) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Unknown or expired session");
            return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            try {
                const msg = JSON.parse(body) as { id?: string | number };
                if (msg.id != null) state.pending.set(msg.id, { type: "sse", sessionId });
            } catch {
                /* malformed — forward anyway */
            }

            if (this._isProviderConnected(providerName, state)) {
                this._sendToProvider(state, providerName, body);
            } else {
                const sseRes = state.sseSessions.get(sessionId);
                if (sseRes) {
                    let errId: string | number | null = null;
                    try {
                        errId = (JSON.parse(body) as { id?: string | number }).id ?? null;
                    } catch {
                        /* */
                    }
                    this._sendSseEvent(
                        sseRes,
                        JSON.stringify({
                            jsonrpc: "2.0",
                            id: errId,
                            error: { code: -32000, message: `Provider "${providerName}" not connected` },
                        })
                    );
                }
            }

            res.writeHead(202);
            res.end();
        });
    }

    /**
     * Handles `POST /<providerName>/mcp` — Streamable HTTP transport (MCP 2025-03-26).
     * Forwards the JSON-RPC request to the provider and holds the HTTP response
     * open until the reply arrives, then writes it as `application/json`.
     */
    private _handleMcpPost(req: IncomingMessage, res: ServerResponse, providerName: string): void {
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            let msg: { id?: string | number } = {};
            try {
                msg = JSON.parse(body) as { id?: string | number };
            } catch {
                res.writeHead(400, { "Content-Type": "text/plain" });
                res.end("Invalid JSON");
                return;
            }

            const state = this._getOrCreateProviderState(providerName);

            if (!this._isProviderConnected(providerName, state)) {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: msg.id ?? null,
                        error: { code: -32000, message: `Provider "${providerName}" not connected` },
                    })
                );
                return;
            }

            if (msg.id != null) {
                // Request: hold the response open; reply arrives in _routeFromProvider.
                state.pending.set(msg.id, { type: "http", res });
            } else {
                // Notification: forward and acknowledge immediately.
                res.writeHead(202);
                res.end();
            }

            this._sendToProvider(state, providerName, body);
        });
    }

    /**
     * Handles `GET /<providerName>/mcp` — opens a persistent SSE stream per MCP 2025-03-26.
     * Streamable HTTP clients (e.g. MCP Inspector) use this to receive
     * server-initiated notifications without re-polling.
     */
    private _handleMcpGetStream(req: IncomingMessage, res: ServerResponse, providerName: string): void {
        const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? randomUUID();

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Mcp-Session-Id": sessionId,
        });
        res.write(": stream open\n\n");

        const state = this._getOrCreateProviderState(providerName);
        state.mcpGetSessions.set(sessionId, res);

        req.on("close", () => {
            state.mcpGetSessions.delete(sessionId);
        });
    }

    /** Writes one JSON-RPC message as an SSE `message` event. */
    private _sendSseEvent(res: ServerResponse, data: string): void {
        // data is already a compact JSON string — no need to parse+re-serialize.
        res.write(`event: message\ndata: ${data}\n\n`);
    }

    // -------------------------------------------------------------------------
    // WebSocket connection handlers
    // -------------------------------------------------------------------------

    private _onProviderConnect(ws: WebSocket, name: string): void {
        if (this._upstreams.has(name)) {
            console.warn(
                `[broker] WARNING: WebSocket provider "${name}" rejected — a stdio upstream with the same name is already configured. ` +
                    `Rename one of them to avoid the conflict.`
            );
            ws.close(1008, `Provider "${name}" is managed by a stdio upstream`);
            return;
        }

        if (this._loopbackProviders.has(name)) {
            console.warn(`[broker] WARNING: WebSocket provider "${name}" rejected — the slot is held by an in-process loopback (reserved system slot).`);
            ws.close(1008, `Provider "${name}" is reserved by the broker`);
            return;
        }

        const existing = this._providers.get(name);
        if (existing?.ws?.readyState === WebSocket.OPEN) {
            ws.close(1008, `Provider "${name}" is already connected`);
            return;
        }

        const state = this._getOrCreateProviderState(name);
        state.ws = ws;

        // A provider MAY send a registration control frame as its very first
        // message (see _tryHandleRegistration). Any other first message —
        // including a normal MCP frame — is routed and leaves the provider
        // non-aggregated, so every pre-existing provider keeps working.
        let registrationChecked = false;
        ws.on("message", (data: Buffer) => {
            const text = data.toString();
            if (!registrationChecked) {
                registrationChecked = true;
                if (this._tryHandleRegistration(name, text)) return;
            }
            this._routeFromProvider(state, text);
        });

        ws.on("close", () => {
            state.ws = null;
            this._failProviderDisconnected(state, name);
        });
    }

    /**
     * Inspects a provider's first WebSocket message for an optional registration
     * control frame `{ "type": "register", "aggregate": boolean }`. Returns
     * `true` when the message was a registration frame — and thus consumed, not
     * routed as MCP traffic. A normal MCP frame always carries `jsonrpc`, so it
     * returns `false` and the provider stays non-aggregated.
     */
    private _tryHandleRegistration(name: string, text: string): boolean {
        let frame: { type?: unknown; jsonrpc?: unknown; aggregate?: unknown };
        try {
            frame = JSON.parse(text) as typeof frame;
        } catch {
            return false;
        }
        if (frame.jsonrpc !== undefined || frame.type !== "register") return false;
        if (frame.aggregate === true) {
            void this._aggregateServer?.addProvider(name);
        }
        return true;
    }

    private _onClientConnect(ws: WebSocket, providerName: string): void {
        const state = this._getOrCreateProviderState(providerName);
        state.wsClients.add(ws);

        ws.on("message", (data: Buffer) => this._routeFromClient(ws, state, providerName, data.toString()));

        ws.on("close", () => {
            state.wsClients.delete(ws);
            for (const [id, sink] of state.pending) {
                if (sink.type === "ws" && sink.socket === ws) state.pending.delete(id);
            }
        });
    }

    /**
     * Handles a multiplexed provider WebSocket (`/providers`).
     * A single socket carries traffic for multiple providers using the
     * envelope format `{ provider: string, payload: object }`.
     * Provider names are registered lazily on first message.
     */
    private _onMultiplexProviderConnect(ws: WebSocket): void {
        const providerNames = new Set<string>();
        this._multiplexSockets.set(ws, providerNames);

        ws.on("message", (data: Buffer) => {
            let envelope: { provider?: string; payload?: unknown };
            try {
                envelope = JSON.parse(data.toString()) as { provider?: string; payload?: unknown };
            } catch {
                return; // malformed — drop
            }

            const name = envelope.provider;
            if (!name || envelope.payload === undefined) return;

            // Register provider name lazily on first encounter.
            if (!providerNames.has(name)) {
                if (this._upstreams.has(name)) {
                    console.warn(
                        `[broker] WARNING: Multiplexed WebSocket provider "${name}" rejected — a stdio upstream with the same name is already configured. ` +
                            `Rename one of them to avoid the conflict.`
                    );
                    ws.send(
                        JSON.stringify({
                            provider: name,
                            payload: {
                                jsonrpc: "2.0",
                                id: null,
                                error: { code: -32000, message: `Provider "${name}" is managed by a stdio upstream` },
                            },
                        })
                    );
                    return;
                }

                if (this._loopbackProviders.has(name)) {
                    ws.send(
                        JSON.stringify({
                            provider: name,
                            payload: {
                                jsonrpc: "2.0",
                                id: null,
                                error: { code: -32000, message: `Provider "${name}" is reserved by the broker` },
                            },
                        })
                    );
                    return;
                }

                const existing = this._providers.get(name);
                if (existing?.ws?.readyState === WebSocket.OPEN) {
                    // Provider already connected via another socket — reject this name.
                    ws.send(
                        JSON.stringify({
                            provider: name,
                            payload: {
                                jsonrpc: "2.0",
                                id: null,
                                error: { code: -32000, message: `Provider "${name}" is already connected` },
                            },
                        })
                    );
                    return;
                }
                providerNames.add(name);
                const state = this._getOrCreateProviderState(name);
                state.ws = ws;
            }

            const state = this._providers.get(name)!;
            this._routeFromProvider(state, JSON.stringify(envelope.payload));
        });

        ws.on("close", () => {
            for (const name of providerNames) {
                const state = this._providers.get(name);
                if (state && state.ws === ws) {
                    state.ws = null;
                    this._failProviderDisconnected(state, name);
                }
            }
            this._multiplexSockets.delete(ws);
        });
    }

    // -------------------------------------------------------------------------
    // Message routing
    // -------------------------------------------------------------------------

    /**
     * Sends a raw JSON-RPC message to a provider, wrapping it in a multiplex
     * envelope when the provider's WebSocket is a multiplexed connection.
     */
    private _sendToProvider(state: ProviderState, providerName: string, data: string): void {
        // Upstreams (stdio child processes and remote URL servers) take priority.
        const upstream = this._upstreams.get(providerName);
        if (upstream?.isOpen) {
            upstream.send(data);
            return;
        }

        // In-process loopback (e.g. the embedded `_broker`) takes the same priority.
        const loopback = this._loopbackProviders.get(providerName);
        if (loopback?.isOpen) {
            loopback.send(data);
            return;
        }

        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

        if (this._multiplexSockets.has(state.ws)) {
            // Wrap in envelope for the multiplexed socket.
            const payload = JSON.parse(data) as unknown;
            state.ws.send(JSON.stringify({ provider: providerName, payload }));
        } else {
            state.ws.send(data);
        }
    }

    private _routeFromStdioClient(state: ProviderState, data: string): void {
        try {
            const msg = JSON.parse(data) as { id?: string | number };
            if (msg?.id != null) state.pending.set(msg.id, { type: "stdio" });
        } catch {
            /* forward as-is */
        }

        if (this._isProviderConnected(this._stdioClientProvider!, state)) {
            this._sendToProvider(state, this._stdioClientProvider!, data);
        } else {
            let errId: string | number | null = null;
            try {
                errId = (JSON.parse(data) as { id?: string | number }).id ?? null;
            } catch {
                /* */
            }
            if (errId != null) {
                process.stdout.write(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: errId,
                        error: { code: -32000, message: `Provider "${this._stdioClientProvider}" not connected` },
                    }) + "\n"
                );
            }
        }
    }

    private _routeFromClient(client: WebSocket, state: ProviderState, providerName: string, data: string): void {
        try {
            const msg = JSON.parse(data) as { id?: string | number };
            if (msg?.id != null) state.pending.set(msg.id, { type: "ws", socket: client });
        } catch {
            /* forward as-is */
        }

        if (this._isProviderConnected(providerName, state)) {
            this._sendToProvider(state, providerName, data);
        } else {
            client.send(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: null,
                    error: { code: -32000, message: "No provider connected" },
                })
            );
        }
    }

    private _routeFromProvider(state: ProviderState, data: string): void {
        try {
            const msg = JSON.parse(data) as { id?: string | number };

            if (msg.id != null) {
                // Response: route to the specific sink that made the request.
                const sink = state.pending.get(msg.id);
                if (sink?.type === "ws" && sink.socket.readyState === WebSocket.OPEN) {
                    sink.socket.send(data);
                } else if (sink?.type === "sse") {
                    const sseRes = state.sseSessions.get(sink.sessionId);
                    if (sseRes) this._sendSseEvent(sseRes, data);
                } else if (sink?.type === "http") {
                    sink.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                    sink.res.end(data);
                } else if (sink?.type === "stdio") {
                    process.stdout.write(data + "\n");
                } else if (sink?.type === "internal") {
                    sink.client.onMessage?.(data);
                }
                state.pending.delete(msg.id);
            } else {
                // Notification (no id): broadcast to all clients of this provider.
                this._broadcast(state, data);
            }
        } catch {
            this._broadcast(state, data);
        }
    }

    /** Sends a message to all clients connected to one provider. */
    private _broadcast(state: ProviderState, data: string): void {
        for (const client of state.wsClients) {
            if (client.readyState === WebSocket.OPEN) client.send(data);
        }
        for (const sseRes of state.sseSessions.values()) {
            this._sendSseEvent(sseRes, data);
        }
        for (const mcpRes of state.mcpGetSessions.values()) {
            this._sendSseEvent(mcpRes, data);
        }
        for (const ic of state.internalClients) {
            ic.onMessage?.(data);
        }
        // Forward notifications to the stdio client if it is watching this provider.
        if (this._stdioClientProvider && this._providers.get(this._stdioClientProvider) === state) {
            process.stdout.write(data + "\n");
        }
    }

    /**
     * Notifies every pending sink and internal client that the provider slot
     * has disconnected, then clears the pending map. Shared by all provider
     * close handlers (dedicated WS, multiplexed WS, loopback).
     */
    private _failProviderDisconnected(state: ProviderState, name: string): void {
        const error = JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: `Provider "${name}" disconnected` },
        });
        for (const sink of state.pending.values()) {
            if (sink.type === "ws" && sink.socket.readyState === WebSocket.OPEN) {
                sink.socket.send(error);
            } else if (sink.type === "sse") {
                const sseRes = state.sseSessions.get(sink.sessionId);
                if (sseRes) this._sendSseEvent(sseRes, error);
            } else if (sink.type === "http") {
                sink.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                sink.res.end(error);
            } else if (sink.type === "internal") {
                sink.client.onMessage?.(error);
            }
        }
        state.pending.clear();
        for (const ic of state.internalClients) ic.onClose?.();
    }

    // -------------------------------------------------------------------------
    // Provider state helpers
    // -------------------------------------------------------------------------

    /**
     * Returns `true` if the provider is reachable — via a WebSocket connection,
     * a stdio upstream, or an in-process loopback transport.
     */
    private _isProviderConnected(providerName: string, state: ProviderState): boolean {
        if (this._upstreams.get(providerName)?.isOpen) return true;
        if (this._loopbackProviders.get(providerName)?.isOpen) return true;
        if (state.ws?.readyState === WebSocket.OPEN) return true;
        return false;
    }

    /** Returns the state for `name`, creating it lazily if it doesn't exist yet. */
    private _getOrCreateProviderState(name: string): ProviderState {
        let state = this._providers.get(name);
        if (!state) {
            state = {
                ws: null,
                pending: new Map(),
                sseSessions: new Map(),
                mcpGetSessions: new Map(),
                wsClients: new Set(),
                internalClients: new Set(),
            };
            this._providers.set(name, state);
        }
        return state;
    }

    // -------------------------------------------------------------------------
    // Samples index
    // -------------------------------------------------------------------------

    private _handleSamplesIndex(res: ServerResponse): void {
        const rootMount = (this._options.staticMounts ?? []).find((m) => m.urlPrefix === "/");

        let files: string[] = [];
        if (rootMount) {
            const samplesDir = nodePath.join(rootMount.dir, "samples");
            try {
                if (fs.existsSync(samplesDir) && fs.statSync(samplesDir).isDirectory()) {
                    files = fs.readdirSync(samplesDir).filter((name) => fs.statSync(nodePath.join(samplesDir, name)).isFile());
                }
            } catch {
                /* return empty list on any I/O error */
            }
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ files }));
    }

    // -------------------------------------------------------------------------
    // Static file serving
    // -------------------------------------------------------------------------

    private _serveStatic(req: IncomingMessage, res: ServerResponse): void {
        const rawUrl = (req.url ?? "/").split("?")[0].split("#")[0];
        const mounts = this._options.staticMounts ?? [];

        const mount = [...mounts]
            .filter((m) => {
                const prefix = m.urlPrefix.endsWith("/") ? m.urlPrefix : m.urlPrefix + "/";
                return rawUrl === m.urlPrefix || rawUrl.startsWith(prefix);
            })
            .sort((a, b) => b.urlPrefix.length - a.urlPrefix.length)[0];

        if (!mount) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found");
            return;
        }

        const relative = rawUrl.slice(mount.urlPrefix.length) || "/";
        const normalized = nodePath.normalize(relative);

        if (normalized.startsWith("..")) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }

        const mountAbs = nodePath.resolve(mount.dir);
        let filePath = nodePath.join(mountAbs, normalized);

        if (!filePath.startsWith(mountAbs + nodePath.sep) && filePath !== mountAbs) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }

        try {
            if (fs.statSync(filePath).isDirectory()) filePath = nodePath.join(filePath, "index.html");
        } catch {
            res.writeHead(404);
            res.end("Not found");
            return;
        }

        if (!fs.existsSync(filePath)) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }

        const ext = nodePath.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
    }
}
