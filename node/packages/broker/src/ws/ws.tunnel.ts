import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as nodePath from "path";
import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { WebSocket, WebSocketServer, type VerifyClientCallbackAsync } from "ws";
import type { IMessageTransport, IMcpServer } from "@cyanmycelium/mcp-core";
import { StdioTransport } from "@cyanmycelium/mcp-core/node";
// The broker is itself a provider — it publishes its own `_broker` and `_all`
// slots — so sharing the provider package's wire contract is the natural way to
// keep one definition of the envelope rather than two that drift.
import { decodeEnvelope, encodeEnvelope, encodeErrorEnvelope, envelopeFrame, TunnelErrorCodes } from "@cyanmycelium/mcp-broker-provider/protocol";
import { StdioUpstream } from "../stdio.upstream";
import { RemoteUpstream } from "../remote.upstream";
import type { IUpstream } from "../upstream";
import { startBrokerServer, BROKER_PROVIDER_NAME } from "../broker/index";
import type { IBrokerContext, IBrokerProviderInfo, BrokerProviderTransport } from "../broker/index";
import { AggregateServer } from "../broker/aggregate/aggregate.server";
import {
    HttpAuthGuard,
    AuthError,
    normalizeProviderAuthentication,
    providerMayPublish,
    type IProviderAuthenticator,
    type IPrincipal,
    type IProviderPrincipal,
} from "../auth/index";
import {
    DefaultSlotResourceResolver,
    SubjectMappingError,
    makeAuthorizationAuditEvent,
    writeAuthorizationAuditEvent,
    type IAuthorizationDecision,
    type IAuthorizationSubject,
    type IPolicyAuthorization,
    type ResourcePath,
    type ISlotResourceResolver,
} from "../authorization/index";
import { VERSION, PACKAGE_NAME } from "../version";
import type { IInternalClient, IProviderState, IWsTunnelOptions, McpEndpointKind } from "./ws.interfaces";

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
export class WsTunnel implements IBrokerContext {
    private readonly _options: IWsTunnelOptions;
    private _httpServer: http.Server | https.Server | null = null;
    private _wss: WebSocketServer | null = null;

    /**
     * Per-provider state, keyed by provider name.
     * Created lazily: a slot is allocated the first time any client references
     * a provider name, even before the provider WebSocket connects.
     */
    private readonly _providers = new Map<string, IProviderState>();

    /** Maps a multiplexed WebSocket to the set of provider names it feeds. */
    private readonly _multiplexSockets = new Map<WebSocket, Set<string>>();

    /** Upstream providers (stdio child processes and remote URL servers), keyed by name. */
    private readonly _upstreams = new Map<string, IUpstream>();

    /**
     * In-process loopback transports registered as provider slots.
     * Used by the embedded broker server (`_broker`) and any other component
     * that wants to expose itself as a provider without going through a network.
     */
    private readonly _loopbackProviders = new Map<string, IMessageTransport>();

    /** The embedded broker MCP server, when {@link IWsTunnelOptions.enableBrokerProvider} is on. */
    private _brokerServer: IMcpServer | null = null;

    /** The aggregate MCP server (`_all` slot), when {@link IWsTunnelOptions.enableAggregateProvider} is on. */
    private _aggregateServer: AggregateServer | null = null;

    /** Provider name that the stdio client transport is bridged to, or null when disabled. */
    private _stdioClientProvider: string | null = null;

    /** mcp-core transport connected to the broker process stdin/stdout. */
    private _stdioClientTransport: StdioTransport | null = null;

    /** Timestamp of the most recent successful `start()`. */
    private _startedAt: Date | null = null;

    /** HTTP resource-server enforcement point, or `null` when auth is disabled. */
    private readonly _authGuard: HttpAuthGuard | null;

    /** Provider (engine) authenticator, or `null` when provider auth is disabled. */
    private readonly _providerAuth: IProviderAuthenticator | null;

    /** Compiled hierarchical authorization, or `null` for legacy behavior. */
    private readonly _authorization: IPolicyAuthorization | null;

    /** Stable technical-slot to hierarchical-resource mapping. */
    private readonly _slotResourceResolver: ISlotResourceResolver;

    /** Principal captured at a client's WS upgrade, keyed by the upgrade request. */
    private readonly _pendingClientPrincipals = new WeakMap<IncomingMessage, IPrincipal>();

    /** Authenticated principal per raw WS client socket, for `_all` scope filtering. */
    private readonly _clientPrincipals = new WeakMap<WebSocket, IPrincipal>();

    /** Authenticated principal attached to long-lived HTTP/SSE streams. */
    private readonly _streamPrincipals = new WeakMap<ServerResponse, IPrincipal>();

    /** Provider principals captured during successful WebSocket upgrades. */
    private readonly _pendingProviderPrincipals = new WeakMap<IncomingMessage, IProviderPrincipal>();
    private readonly _providerPrincipals = new WeakMap<WebSocket, IProviderPrincipal>();

    constructor(options: IWsTunnelOptions) {
        this._options = options;
        this._authGuard = options.auth ? new HttpAuthGuard(options.auth, options.mcpPath ?? "/mcp") : null;
        this._providerAuth = options.providerAuth ?? null;
        this._authorization = options.authorization ?? options.auth?.authorization ?? null;
        this._slotResourceResolver =
            options.slotResourceResolver ?? this._authorization?.slotResourceResolver ?? options.auth?.slotResourceResolver ?? new DefaultSlotResourceResolver();
    }

    // -------------------------------------------------------------------------
    // IBrokerContext implementation
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

    get paths(): IBrokerContext["paths"] {
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

    public getProvidersInfo(): IBrokerProviderInfo[] {
        const out: IBrokerProviderInfo[] = [];
        for (const [name, state] of this._providers) {
            out.push(this._buildProviderInfo(name, state));
        }
        return out;
    }

    public getProviderInfo(name: string): IBrokerProviderInfo | undefined {
        const state = this._providers.get(name);
        if (!state) return undefined;
        return this._buildProviderInfo(name, state);
    }

    private _buildProviderInfo(name: string, state: IProviderState): IBrokerProviderInfo {
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

        transport.onMessage = (data: string) => this._routeFromProvider(state, name, data);
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
    public openInternalClient(providerName: string): IInternalClient {
        const state = this._getOrCreateProviderState(providerName);
        let closed = false;

        const client: IInternalClient = {
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
            this._wss = new WebSocketServer({ server: this._httpServer, perMessageDeflate: false, verifyClient: this._makeVerifyClient() });

            this._wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
                const url = req.url ?? "/";
                const providerPath = this._options.providerPath ?? "/provider";
                const providersPath = this._options.providersPath ?? "/providers";

                if (url === providersPath || url.startsWith(providersPath + "?")) {
                    // Multiplexed provider: one WebSocket carries N providers via envelopes.
                    this._onMultiplexProviderConnect(ws, req);
                } else if (url.startsWith(providerPath + "/") || url === providerPath) {
                    // Extract name: everything after "<providerPath>/"
                    const raw = url.slice(providerPath.length).replace(/^\//, "");
                    const name = decodeURIComponent(raw.split("?")[0]) || "(unnamed)";
                    this._onProviderConnect(ws, name, req);
                } else {
                    // Raw WS MCP client: URL is "/<providerName>" or "/"
                    const raw = url.replace(/^\//, "").split("?")[0];
                    const name = decodeURIComponent(raw) || "";
                    this._onClientConnect(ws, name, req);
                }
            });

            this._httpServer.listen(this._options.port, this._options.host ?? "0.0.0.0", () => {
                // Bring the aggregate `_all` slot up before any upstream connects
                // (a Streamable HTTP upstream opens synchronously on connect()).
                this._maybeStartAggregateServer();

                // Attach configured upstreams (stdio child processes + remote URL
                // servers). Both implement the Upstream contract, so the wiring
                // into a provider slot is identical.
                const wireUpstream = (cfg: { name: string; aggregate?: boolean }, upstream: IUpstream): void => {
                    upstream.onMessage = (data) => {
                        const state = this._getOrCreateProviderState(cfg.name);
                        this._routeFromProvider(state, cfg.name, data);
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
                    const transport = new StdioTransport();
                    this._stdioClientTransport = transport;
                    transport.onMessage = (data: string): void => {
                        const state = this._getOrCreateProviderState(this._stdioClientProvider!);
                        this._routeFromStdioClient(state, data);
                    };
                    transport.onError = (err: Error): void => {
                        console.error(`[broker] stdio client transport: ${err.message}`);
                    };
                    transport.onClose = (): void => {
                        // Client disconnected — nothing to clean up; pending sinks will time out.
                    };
                    transport.connect();
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
     * provider slot `_broker`. No-op when {@link IWsTunnelOptions.enableBrokerProvider}
     * is `false`.
     */
    private async _maybeStartBrokerServer(): Promise<void> {
        if (this._options.enableBrokerProvider === false) return;
        const { server, clientTransport } = await startBrokerServer(this, {
            grammarResolverOptions: this._options.brokerGrammarResolverOptions,
            localGrammarsDir: this._options.brokerLocalGrammarsDir,
        });
        this._brokerServer = server;
        this.registerLoopbackProvider(BROKER_PROVIDER_NAME, clientTransport);

        // Aggregate the broker's own introspection tools into `_all`, so a stdio
        // host pinned to `_all` still reaches broker_info / providers_list /
        // provider_status alongside the other aggregated providers.
        void this._aggregateServer?.addProvider(BROKER_PROVIDER_NAME);
    }

    /**
     * Starts the aggregate MCP server and registers it on the reserved `_all`
     * slot. No-op when {@link IWsTunnelOptions.enableAggregateProvider} is `false`.
     */
    private _maybeStartAggregateServer(): void {
        if (this._options.enableAggregateProvider === false) return;
        try {
            const server = new AggregateServer((providerName) => this.openInternalClient(providerName));
            server.setScopeFilter(this._options.auth?.aggregateScopeFilter ?? null);
            server.setPolicyAuthorization(this._authorization);
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

        this._stdioClientTransport?.close();
        this._stdioClientTransport = null;
        this._stdioClientProvider = null;

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

    private _authorizationSubject(principal: IPrincipal | null): IAuthorizationSubject {
        if (principal?.subject) return principal.subject;
        if (!principal) return { ids: [] };
        try {
            return (
                this._authorization?.subjectMapper.map(principal.claims) ?? {
                    ids: [],
                    claims: principal.claims,
                }
            );
        } catch (error) {
            if (!(error instanceof SubjectMappingError)) {
                console.error("[broker] authorization subject mapping failed.");
            }
            return { ids: [], claims: principal.claims };
        }
    }

    private _auditDecision(
        subject: IAuthorizationSubject,
        slot: string,
        resource: ResourcePath | undefined,
        capability: string | undefined,
        tool: string | undefined,
        decision: IAuthorizationDecision
    ): void {
        const authorization = this._authorization;
        if (!authorization || (decision.allowed && !authorization.audit.logAllowed)) return;
        writeAuthorizationAuditEvent(
            makeAuthorizationAuditEvent(
                {
                    subject,
                    slot,
                    resource,
                    capability,
                    provider: slot,
                    tool,
                },
                decision
            )
        );
    }

    /**
     * Applies hierarchical policy to the MCP operations carried in one
     * JSON-RPC frame. `_all` performs provider-specific checks internally.
     */
    private _authorizeMcpFrame(providerName: string, data: string, principal: IPrincipal | null): boolean {
        const authorization = this._authorization;
        if (!authorization || providerName === AggregateServer.SLOT) return true;

        const subject = this._authorizationSubject(principal);
        const resource = this._slotResourceResolver.resolve(providerName);
        if (!resource) {
            const decision: IAuthorizationDecision = { allowed: false, reason: "unknown-resource" };
            this._auditDecision(subject, providerName, undefined, undefined, undefined, decision);
            return false;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(data) as unknown;
        } catch {
            return true;
        }
        const operations = Array.isArray(parsed) ? parsed : [parsed];
        for (const value of operations) {
            if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
            const operation = value as Readonly<{ method?: string; params?: unknown }>;
            try {
                const classified = authorization.capabilityClassifier.classify(operation, resource, providerName);
                if (!classified) continue;
                const decision = authorization.engine.authorize({
                    subject,
                    capability: classified.capability,
                    resource,
                    provider: providerName,
                    tool: classified.tool,
                });
                this._auditDecision(subject, providerName, resource, classified.capability, classified.tool, decision);
                if (!decision.allowed) return false;
            } catch {
                console.error("[broker] policy evaluation failed.");
                const decision: IAuthorizationDecision = { allowed: false, reason: "no-matching-grant" };
                this._auditDecision(subject, providerName, resource, undefined, undefined, decision);
                return false;
            }
        }
        return true;
    }

    private _policyDeniedPayload(data: string): string {
        let id: string | number | null = null;
        try {
            const parsed = JSON.parse(data) as { id?: unknown };
            if (typeof parsed.id === "string" || typeof parsed.id === "number" || parsed.id === null) {
                id = parsed.id;
            }
        } catch {
            // A malformed frame has no usable request id.
        }
        return JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32001, message: "Forbidden" },
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

        // Protected Resource Metadata (RFC 9728) — public discovery data, served
        // unauthenticated so a client can find the authorization server after a 401.
        if (this._authGuard && method === "GET") {
            const metaSlot = this._authGuard.matchMetadataRequest(rawUrl);
            if (metaSlot) {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(this._authGuard.metadataFor(metaSlot)));
                return;
            }
        }

        // Route /<providerName>/<endpoint>
        const route = this._parseProviderRoute(rawUrl);
        if (route) {
            const { providerName, endpoint } = route;
            const kind = this._mcpEndpointKind(endpoint, method);
            if (kind) {
                if (this._authGuard) {
                    // Gate on a valid bearer token issued for this slot before touching
                    // the provider. On failure, emit an RFC 9728 challenge / 500.
                    const guard = this._authGuard;
                    void guard.authorize(req, providerName).then(
                        (principal) => this._dispatchMcpEndpoint(kind, req, res, providerName, principal),
                        (err: unknown) => this._handleAuthFailure(guard, res, providerName, err)
                    );
                } else {
                    this._dispatchMcpEndpoint(kind, req, res, providerName, null);
                }
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

    /**
     * Classifies a `(endpoint, method)` pair as one of the four MCP/SSE client
     * handlers, or `null` when it is not a client transport request (the caller
     * then falls through to static-file serving, preserving prior behavior).
     */
    private _mcpEndpointKind(endpoint: string, method: string): McpEndpointKind | null {
        const mcpSuffix = (this._options.mcpPath ?? "/mcp").replace(/^\//, "");
        const sseSuffix = (this._options.ssePath ?? "/sse").replace(/^\//, "");
        const messagesSuffix = (this._options.messagesPath ?? "/messages").replace(/^\//, "");
        if (endpoint === mcpSuffix && method === "GET") return "mcp-get";
        if (endpoint === mcpSuffix && method === "POST") return "mcp-post";
        if (endpoint === sseSuffix && method === "GET") return "sse-connect";
        if (endpoint === messagesSuffix && method === "POST") return "sse-message";
        return null;
    }

    /** Routes an already-authorized (or auth-disabled) request to its handler. */
    private _dispatchMcpEndpoint(kind: McpEndpointKind, req: IncomingMessage, res: ServerResponse, providerName: string, principal: IPrincipal | null): void {
        switch (kind) {
            case "mcp-get":
                this._handleMcpGetStream(req, res, providerName, principal);
                return;
            case "mcp-post":
                this._handleMcpPost(req, res, providerName, principal);
                return;
            case "sse-connect":
                this._handleSseConnect(req, res, providerName, principal);
                return;
            case "sse-message":
                this._handleSseMessage(req, res, providerName, principal);
                return;
        }
    }

    /** Turns a rejected {@link HttpAuthGuard.authorize} into an HTTP response. */
    private _handleAuthFailure(guard: HttpAuthGuard, res: ServerResponse, providerName: string, err: unknown): void {
        if (err instanceof AuthError) {
            guard.writeChallenge(res, providerName, err);
            return;
        }
        // Not a token failure (e.g. the JWKS endpoint is unreachable) — surface a
        // 500 rather than a misleading 401.
        console.error(`[broker] token validation error for "${providerName}":`, err);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "server_error" }));
    }

    /**
     * Builds the `ws` verifyClient hook that authenticates every WebSocket
     * upgrade before the connection is accepted, returning a real `401`/`403`
     * during the handshake rather than a post-handshake close:
     *
     * - **Raw MCP clients** (`/<slot>`) are gated by the OAuth 2.1 resource
     *   server ({@link _authGuard}) with the RFC 9728 `WWW-Authenticate` challenge.
     * - **Providers** (`/provider/<slot>`, `/providers`) are gated by the
     *   {@link _providerAuth} shared-secret / custom authenticator.
     *
     * Each side is independent: a branch with no authenticator configured is let
     * through unchanged. Returns `undefined` (no hook) when neither is set.
     */
    private _makeVerifyClient(): VerifyClientCallbackAsync | undefined {
        const guard = this._authGuard;
        const providerAuth = this._providerAuth;
        if (!guard && !providerAuth) return undefined;

        const providerPath = this._options.providerPath ?? "/provider";
        const providersPath = this._options.providersPath ?? "/providers";

        return (info, cb) => {
            const url = info.req.url ?? "/";
            const isMultiplex = url === providersPath || url.startsWith(providersPath + "?");
            const isDedicated = url.startsWith(providerPath + "/") || url === providerPath;

            if (isMultiplex || isDedicated) {
                // Provider (engine) upgrade — shared-secret / custom authenticator.
                if (!providerAuth) {
                    cb(true);
                    return;
                }
                const slot = isDedicated ? decodeURIComponent(url.slice(providerPath.length).replace(/^\//, "").split("?")[0]) || undefined : undefined;
                Promise.resolve(providerAuth.authenticate(info.req, slot)).then(
                    (rawResult) => {
                        const result = normalizeProviderAuthentication(rawResult);
                        if (!result.authenticated) {
                            cb(false, 401, "Unauthorized", { "WWW-Authenticate": 'Bearer realm="provider"' });
                            return;
                        }
                        if (slot !== undefined) {
                            const resource = this._slotResourceResolver.resolve(slot);
                            if (!resource || !providerMayPublish(result.principal, resource)) {
                                this._logProviderRegistration(result.principal, slot, resource, false);
                                cb(false, 403, "Forbidden");
                                return;
                            }
                        }
                        this._pendingProviderPrincipals.set(info.req, result.principal);
                        cb(true);
                    },
                    () => {
                        console.error(`[broker] provider authentication error for "${slot ?? "(multiplex)"}".`);
                        cb(false, 500, "server_error");
                    }
                );
                return;
            }

            // Raw WS MCP client upgrade — OAuth 2.1 resource server.
            if (!guard) {
                cb(true);
                return;
            }
            const slot = decodeURIComponent(url.replace(/^\//, "").split("?")[0]);
            void guard.authorize(info.req, slot).then(
                (principal) => {
                    // Stash the principal so _onClientConnect can bind it to the socket.
                    this._pendingClientPrincipals.set(info.req, principal);
                    cb(true);
                },
                (err: unknown) => {
                    if (err instanceof AuthError) {
                        cb(false, err.status, err.code, { "WWW-Authenticate": guard.challengeHeader(slot, err) });
                    } else {
                        console.error(`[broker] token validation error for WS client "${slot}":`, err);
                        cb(false, 500, "server_error");
                    }
                }
            );
        };
    }

    // -------------------------------------------------------------------------
    // MCP / SSE transport (per provider)
    // -------------------------------------------------------------------------

    /**
     * Handles `GET /<providerName>/sse` — opens a long-lived SSE stream for Claude.
     * Sends an `endpoint` event so Claude knows where to POST its requests.
     */
    private _handleSseConnect(req: IncomingMessage, res: ServerResponse, providerName: string, principal: IPrincipal | null): void {
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
        if (principal) this._streamPrincipals.set(res, principal);

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
    private _handleSseMessage(req: IncomingMessage, res: ServerResponse, providerName: string, principal: IPrincipal | null): void {
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
            if (!this._authorizeMcpFrame(providerName, body, principal)) {
                res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                res.end(this._policyDeniedPayload(body));
                return;
            }
            try {
                const msg = JSON.parse(body) as { id?: string | number };
                if (msg.id != null) state.pending.set(msg.id, { type: "sse", sessionId });
            } catch {
                /* malformed — forward anyway */
            }

            if (this._isProviderConnected(providerName, state)) {
                this._sendToProvider(state, providerName, body, principal);
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
    private _handleMcpPost(req: IncomingMessage, res: ServerResponse, providerName: string, principal: IPrincipal | null): void {
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

            if (!this._authorizeMcpFrame(providerName, body, principal)) {
                res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                res.end(this._policyDeniedPayload(body));
                return;
            }

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

            this._sendToProvider(state, providerName, body, principal);
        });
    }

    /**
     * Handles `GET /<providerName>/mcp` — opens a persistent SSE stream per MCP 2025-03-26.
     * Streamable HTTP clients (e.g. MCP Inspector) use this to receive
     * server-initiated notifications without re-polling.
     */
    private _handleMcpGetStream(req: IncomingMessage, res: ServerResponse, providerName: string, principal: IPrincipal | null): void {
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
        if (principal) this._streamPrincipals.set(res, principal);

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

    private _logProviderRegistration(principal: IProviderPrincipal, slot: string, resource: ResourcePath | undefined, allowed: boolean): void {
        const event = {
            timestamp: new Date().toISOString(),
            providerId: principal.id,
            slot,
            resource: resource?.value,
            allowed,
        };
        const line = `[broker] provider-registration ${JSON.stringify(event)}`;
        if (allowed) console.info(line);
        else console.warn(line);
    }

    private _onProviderConnect(ws: WebSocket, name: string, req: IncomingMessage): void {
        const providerPrincipal = this._pendingProviderPrincipals.get(req);
        if (providerPrincipal) {
            this._pendingProviderPrincipals.delete(req);
            this._providerPrincipals.set(ws, providerPrincipal);
        }
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
        if (providerPrincipal) {
            this._logProviderRegistration(providerPrincipal, name, this._slotResourceResolver.resolve(name), true);
        }

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
            this._routeFromProvider(state, name, text);
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

    private _onClientConnect(ws: WebSocket, providerName: string, req: IncomingMessage): void {
        const state = this._getOrCreateProviderState(providerName);
        state.wsClients.add(ws);

        // Carry the principal captured at the upgrade onto the socket, so requests
        // this client makes to `_all` can be scope-filtered.
        const principal = this._pendingClientPrincipals.get(req);
        if (principal) {
            this._clientPrincipals.set(ws, principal);
            this._pendingClientPrincipals.delete(req);
        }

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
    private _onMultiplexProviderConnect(ws: WebSocket, req: IncomingMessage): void {
        const providerNames = new Set<string>();
        this._multiplexSockets.set(ws, providerNames);
        const providerPrincipal = this._pendingProviderPrincipals.get(req);
        if (providerPrincipal) {
            this._pendingProviderPrincipals.delete(req);
            this._providerPrincipals.set(ws, providerPrincipal);
        }

        ws.on("message", (data: Buffer) => {
            const envelope = decodeEnvelope(data.toString());
            if (!envelope) return; // malformed — drop

            const name = envelope.provider;

            // Register provider name lazily on first encounter.
            if (!providerNames.has(name)) {
                if (providerPrincipal) {
                    const resource = this._slotResourceResolver.resolve(name);
                    if (!resource || !providerMayPublish(providerPrincipal, resource)) {
                        this._logProviderRegistration(providerPrincipal, name, resource, false);
                        ws.send(encodeErrorEnvelope(name, TunnelErrorCodes.RegistrationForbidden, "Provider registration forbidden"));
                        return;
                    }
                }
                if (this._upstreams.has(name)) {
                    console.warn(
                        `[broker] WARNING: Multiplexed WebSocket provider "${name}" rejected — a stdio upstream with the same name is already configured. ` +
                            `Rename one of them to avoid the conflict.`
                    );
                    ws.send(encodeErrorEnvelope(name, TunnelErrorCodes.ProviderUnavailable, `Provider "${name}" is managed by a stdio upstream`));
                    return;
                }

                if (this._loopbackProviders.has(name)) {
                    ws.send(encodeErrorEnvelope(name, TunnelErrorCodes.ProviderUnavailable, `Provider "${name}" is reserved by the broker`));
                    return;
                }

                const existing = this._providers.get(name);
                if (existing?.ws?.readyState === WebSocket.OPEN) {
                    // Provider already connected via another socket — reject this name.
                    ws.send(encodeErrorEnvelope(name, TunnelErrorCodes.ProviderUnavailable, `Provider "${name}" is already connected`));
                    return;
                }
                providerNames.add(name);
                const state = this._getOrCreateProviderState(name);
                state.ws = ws;
                if (providerPrincipal) {
                    this._logProviderRegistration(providerPrincipal, name, this._slotResourceResolver.resolve(name), true);
                }
            }

            const state = this._providers.get(name)!;
            this._routeFromProvider(state, name, envelopeFrame(envelope));
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
    private _sendToProvider(state: IProviderState, providerName: string, data: string, principal: IPrincipal | null = null): void {
        // The `_all` aggregate is a loopback, but it needs the caller's principal
        // to scope its catalog/routing — hand it off directly rather than through
        // the generic transport, which would drop the context.
        if (providerName === AggregateServer.SLOT && this._aggregateServer) {
            this._aggregateServer.sendAs(data, principal);
            return;
        }

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
            state.ws.send(encodeEnvelope(providerName, data));
        } else {
            state.ws.send(data);
        }
    }

    private _routeFromStdioClient(state: IProviderState, data: string): void {
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
                this._stdioClientTransport?.send(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: errId,
                        error: { code: -32000, message: `Provider "${this._stdioClientProvider}" not connected` },
                    })
                );
            }
        }
    }

    private _routeFromClient(client: WebSocket, state: IProviderState, providerName: string, data: string): void {
        const principal = this._clientPrincipals.get(client) ?? null;
        if (!this._authorizeMcpFrame(providerName, data, principal)) {
            client.send(this._policyDeniedPayload(data));
            return;
        }

        try {
            const msg = JSON.parse(data) as { id?: string | number };
            if (msg?.id != null) state.pending.set(msg.id, { type: "ws", socket: client });
        } catch {
            /* forward as-is */
        }

        if (this._isProviderConnected(providerName, state)) {
            this._sendToProvider(state, providerName, data, principal);
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

    private _routeFromProvider(state: IProviderState, providerName: string, data: string): void {
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
                    this._stdioClientTransport?.send(data);
                } else if (sink?.type === "internal") {
                    sink.client.onMessage?.(data);
                }
                state.pending.delete(msg.id);
            } else {
                // Notification (no id): broadcast to all clients of this provider.
                this._broadcast(state, providerName, data);
            }
        } catch {
            this._broadcast(state, providerName, data);
        }
    }

    /** Sends a message to all clients connected to one provider. */
    private _broadcast(state: IProviderState, providerName: string, data: string): void {
        for (const client of state.wsClients) {
            const principal = this._clientPrincipals.get(client) ?? null;
            if (client.readyState === WebSocket.OPEN && this._authorizeMcpFrame(providerName, data, principal)) {
                client.send(data);
            }
        }
        for (const sseRes of state.sseSessions.values()) {
            const principal = this._streamPrincipals.get(sseRes) ?? null;
            if (this._authorizeMcpFrame(providerName, data, principal)) {
                this._sendSseEvent(sseRes, data);
            }
        }
        for (const mcpRes of state.mcpGetSessions.values()) {
            const principal = this._streamPrincipals.get(mcpRes) ?? null;
            if (this._authorizeMcpFrame(providerName, data, principal)) {
                this._sendSseEvent(mcpRes, data);
            }
        }
        for (const ic of state.internalClients) {
            ic.onMessage?.(data);
        }
        // Forward notifications to the stdio client if it is watching this provider.
        if (this._stdioClientProvider && this._providers.get(this._stdioClientProvider) === state) {
            this._stdioClientTransport?.send(data);
        }
    }

    /**
     * Notifies every pending sink and internal client that the provider slot
     * has disconnected, then clears the pending map. Shared by all provider
     * close handlers (dedicated WS, multiplexed WS, loopback).
     */
    private _failProviderDisconnected(state: IProviderState, name: string): void {
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
            } else if (sink.type === "stdio") {
                this._stdioClientTransport?.send(error);
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
    private _isProviderConnected(providerName: string, state: IProviderState): boolean {
        if (this._upstreams.get(providerName)?.isOpen) return true;
        if (this._loopbackProviders.get(providerName)?.isOpen) return true;
        if (state.ws?.readyState === WebSocket.OPEN) return true;
        return false;
    }

    /** Returns the state for `name`, creating it lazily if it doesn't exist yet. */
    private _getOrCreateProviderState(name: string): IProviderState {
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
