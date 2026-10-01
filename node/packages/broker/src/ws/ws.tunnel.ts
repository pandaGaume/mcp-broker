import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as nodePath from "path";
import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { WebSocket, WebSocketServer, type VerifyClientCallbackAsync } from "ws";
import { createEventEmitter } from "@cyanmycelium/mcp-core";
import type { IEventEmitter, IEventSource, IMessageTransport, IMcpServer } from "@cyanmycelium/mcp-core";
import { StdioTransport, StreamableHttpEndpoint } from "@cyanmycelium/mcp-core/node";
// The broker is itself a provider: it publishes its own `_broker` and `_all`
// slots: so sharing the provider package's wire contract is the natural way to
// keep one definition of the envelope rather than two that drift.
import { decodeEnvelope, encodeEnvelope, encodeErrorEnvelope, envelopeFrame, TUNNEL_REGISTER_METHOD, TunnelErrorCodes } from "@cyanmycelium/mcp-broker-provider/protocol";
import { StdioUpstream } from "../stdio.upstream";
import { RemoteUpstream } from "../remote.upstream";
import type { IUpstream } from "../upstream";
import { startBrokerServer, BROKER_PROVIDER_NAME } from "../broker/index";
import type { IBrokerContext, IBrokerProviderInfo, BrokerProviderTransport } from "../broker/index";
// Imported from the defining module rather than the barrel: these two are the
// optional `IBrokerContext` extensions `broker_diagnose` reads, and the barrel
// does not re-export them yet.
import type { IBrokerAggregateInfo, IBrokerSecurityInfo } from "../broker/broker.context";
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
import {
    BrokerAuthority,
    BROKER_AUTHORIZE_METHOD,
    BROKER_DECLARE_METHOD,
    BROKER_METHOD_PREFIX,
    CALLER_META_KEY,
    type BrokerMethodOutcome,
    type IBrokerAuthorityInfo,
} from "../authority/broker.authority";
import { ResourceSubscriptionRegistry, type ClientKey, type SubscriptionOutcome } from "../subscriptions/resource.subscription.registry";
import type {
    AllowedOrigins,
    IHttpSession,
    IInternalClient,
    ILoopbackProviderHandle,
    IProviderState,
    IWsTunnelOptions,
    McpEndpointKind,
    ProviderTakeoverMode,
    ResponseSink,
    WsConnectRole,
    WsRouteClassification,
} from "./ws.interfaces";

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
// JSON-RPC helpers
// ---------------------------------------------------------------------------

/**
 * The JSON-RPC id a frame is waiting on, or `undefined` when nothing will come
 * back for it: a notification, or something that did not parse.
 *
 * `null` is a legal id in an error response, so absence cannot be signalled
 * with it, hence `undefined`.
 */
function requestIdOf(frame: string): string | number | undefined {
    try {
        const parsed = JSON.parse(frame) as { id?: unknown };
        if (typeof parsed?.id === "string" || typeof parsed?.id === "number") return parsed.id;
    } catch {
        /* not JSON: nothing to route by */
    }
    return undefined;
}

/**
 * Prefix of every broker-assigned JSON-RPC id.
 *
 * Requests are re-numbered on their way to a provider so two clients on one
 * slot cannot collide (see {@link WsTunnel._trackRequest}). The prefix is
 * cosmetic but deliberate: it makes a stray id recognizable as the broker's in
 * a provider's own logs, instead of looking like a client's.
 */
const BROKER_REQUEST_ID_PREFIX = "brk-";

/** The {@link ClientKey} of the stdio bridge: there is at most one per broker. */
const STDIO_CLIENT_KEY: ClientKey = "stdio";

/** Default heartbeat period, in ms, for `providerHeartbeatIntervalMs`. */
const DEFAULT_PROVIDER_HEARTBEAT_MS = 30_000;

/**
 * Longest a caller reference lives when requests have no deadline
 * (`providerRequestTimeoutMs: 0`): a request a client gave up on must not
 * leave a usable reference behind forever.
 */
const DEFAULT_CALLER_REF_MAX_AGE_MS = 10 * 60_000;

/** Default per-request deadline, in ms, for `providerRequestTimeoutMs`. */
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 60_000;

/**
 * RFC 6455 caps a close reason at 123 bytes and `ws` throws a `RangeError`
 * rather than truncating, which would turn a diagnostic into a crash inside a
 * connection handler. Every close reason goes through {@link truncateReason}.
 */
const MAX_CLOSE_REASON_BYTES = 123;

/** Shortens a close reason to what RFC 6455 allows, without splitting a character. */
function truncateReason(reason: string): string {
    if (Buffer.byteLength(reason, "utf8") <= MAX_CLOSE_REASON_BYTES) return reason;
    let cut = reason;
    while (Buffer.byteLength(cut + "...", "utf8") > MAX_CLOSE_REASON_BYTES) {
        cut = cut.slice(0, -1);
    }
    return cut + "...";
}

/**
 * `decodeURIComponent` that returns its input instead of throwing.
 *
 * A slot name arrives from a URL, so it is attacker-controlled: `%zz` throws a
 * `URIError`, and both call sites here run inside a WebSocket connection
 * handler, where an exception is an uncaught one.
 */
function safeDecode(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

/** Parses a frame into a plain JSON object, or `undefined` for anything else. */
function parseObjectFrame(text: string): Record<string, unknown> | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
}

/**
 * Removes the broker's caller reference from one client message, wherever it
 * came from. Returns `true` when something was removed.
 *
 * Only the broker writes `params._meta["io.cyanmycelium/caller"]`. A client
 * that sends one is trying to make a provider act on another caller's
 * behalf, so the key goes before anything else looks at the frame, on every
 * slot, declared or not.
 */
function stripCallerMeta(message: unknown): boolean {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
    const params = (message as { params?: unknown }).params;
    if (typeof params !== "object" || params === null || Array.isArray(params)) return false;
    const meta = (params as { _meta?: unknown })._meta;
    if (typeof meta !== "object" || meta === null || Array.isArray(meta) || !Object.prototype.hasOwnProperty.call(meta, CALLER_META_KEY)) return false;
    delete (meta as Record<string, unknown>)[CALLER_META_KEY];
    if (Object.keys(meta).length === 0) delete (params as { _meta?: unknown })._meta;
    return true;
}

/** Writes the caller reference into a request's `params._meta`. A request with positional params gets none. */
function injectCallerMeta(message: Record<string, unknown>, caller: { readonly ref: string; readonly correlationId: string }): void {
    if (message.params === undefined) message.params = {};
    const params = message.params;
    if (typeof params !== "object" || params === null || Array.isArray(params)) return;
    const record = params as Record<string, unknown>;
    const meta = typeof record._meta === "object" && record._meta !== null && !Array.isArray(record._meta) ? (record._meta as Record<string, unknown>) : {};
    record._meta = { ...meta, [CALLER_META_KEY]: { ref: caller.ref, correlationId: caller.correlationId } };
}

/**
 * Where a provider frame came from: who sent it, and how to answer that
 * sender. A `broker/*` request is attributed to, and answered on, the channel
 * it arrived on, never to whoever holds the slot at that moment, which may be
 * someone else (a stale socket still open, a loopback registered over it).
 */
interface IProviderFrameOrigin {
    readonly kind: "ws" | "loopback" | "upstream";
    readonly principal: IProviderPrincipal | null;
    reply(frame: string): void;
}

/** Identifies the caller behind a validated token: issuer and subject. */
function principalKey(principal: IPrincipal): string {
    const claims = principal.claims as { iss?: unknown; sub?: unknown; client_id?: unknown };
    return JSON.stringify([claims.iss ?? null, claims.sub ?? null, claims.sub === undefined ? (claims.client_id ?? null) : null]);
}

/** Slots the broker owns and that no configuration may protect. */
const RESERVED_SLOTS: ReadonlySet<string> = new Set(["_broker", "_all"]);

/**
 * `true` when the frame is the tunnel registration notification asking to join
 * the `_all` aggregate slot, in either of the two shapes the broker accepts.
 *
 * Both are notifications a peer that does not know them ignores, which is why
 * the opt-in could be added without a protocol version: the JSON-RPC form
 * `{"jsonrpc":"2.0","method":"notifications/register","params":{"aggregate":true}}`
 * is what the provider SDK sends on both paths, and the legacy control frame
 * `{"type":"register","aggregate":true}` is what hand-written providers send on
 * the slot-scoped path.
 */
function registrationAsksForAggregate(payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
    const frame = payload as { jsonrpc?: unknown; method?: unknown; params?: unknown; type?: unknown; aggregate?: unknown };
    if (frame.jsonrpc !== undefined) {
        if (frame.method !== TUNNEL_REGISTER_METHOD) return false;
        const params = frame.params;
        if (typeof params !== "object" || params === null) return false;
        return (params as { aggregate?: unknown }).aggregate === true;
    }
    return frame.type === "register" && frame.aggregate === true;
}

/**
 * Turns the three shapes an operator may configure into the single predicate
 * the Streamable HTTP endpoint expects.
 *
 * Absent means closed, not open: a browser origin is refused unless it was
 * named. A `RegExp` is reset before each test, because one carrying the `g`
 * flag keeps `lastIndex` between calls and would otherwise accept and refuse
 * the same origin in turn.
 */
function originPredicate(allowed: AllowedOrigins | undefined): (origin: string) => boolean {
    if (!allowed) return () => false;
    if (typeof allowed === "function") return allowed;
    if (allowed instanceof RegExp) {
        return (origin) => {
            allowed.lastIndex = 0;
            return allowed.test(origin);
        };
    }
    const exact = new Set(allowed);
    return (origin) => exact.has(origin);
}

/**
 * Opens a transport that was handed over closed.
 *
 * `connect` is not part of `IMessageTransport`, because some transports arrive
 * already open, so it is probed for rather than required. This is the same
 * check `McpServer` makes on the transport it is given, and for the same
 * reason: testing for a concrete class would tie the caller to one
 * implementation.
 */
function openTransport(transport: IMessageTransport): void {
    if ("connect" in transport && typeof (transport as { connect: unknown }).connect === "function") {
        (transport as { connect(): void }).connect();
    }
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

    /**
     * Every inbound provider socket the heartbeat watches, dedicated and
     * multiplexed alike.
     *
     * An explicit collection is needed because there was none: `_providers`
     * holds only the socket that currently owns a slot (so it misses a
     * multiplex socket that has not announced a name yet), and
     * `_providerPrincipals` only has entries when provider auth is configured.
     */
    private readonly _providerSockets = new Set<WebSocket>();

    /**
     * Liveness of each provider socket: `true` when it answered the last ping,
     * `false` while a ping is outstanding.
     *
     * A `WeakMap` so a terminated socket needs no cleanup here, and so a socket
     * the heartbeat never saw (heartbeat disabled) reads back `undefined`,
     * which the admission check treats as "no evidence either way" and refuses
     * the takeover.
     */
    private readonly _alive = new WeakMap<WebSocket, boolean>();

    /** Heartbeat sweep timer; `null` while stopped or disabled. */
    private _heartbeatTimer: NodeJS.Timeout | null = null;

    /** Pending-request deadline sweep timer; `null` while stopped or disabled. */
    private _requestTimeoutTimer: NodeJS.Timeout | null = null;

    /**
     * Counter behind every broker-assigned request id. Monotonic per process,
     * which is all the uniqueness the pending maps need.
     */
    private _nextRequestId = 1;

    /**
     * Slots already warned about for answering with an id the broker never
     * issued, so a provider that does this on every frame warns once.
     */
    private readonly _unmatchedIdWarnedProviders = new Set<string>();

    /**
     * Slots already warned about for opening requests of their own, so a
     * provider that keeps asking warns once.
     */
    private readonly _providerRequestWarnedProviders = new Set<string>();

    /** Slots already warned about for a `broker/*` notification the broker does not handle. */
    private readonly _brokerNotificationWarnedProviders = new Set<string>();

    /**
     * Slots already warned about for emitting a frame that is not JSON-RPC.
     * A provider that speaks a non-JSON dialect emits one on every message, so
     * the warning fires once per slot instead of flooding the log.
     */
    private readonly _nonJsonWarnedProviders = new Set<string>();

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

    /** Origin check applied by every slot's Streamable HTTP endpoint. */
    private readonly _allowedOrigins: (origin: string) => boolean;

    /** Principal captured at a client's WS upgrade, keyed by the upgrade request. */
    private readonly _pendingClientPrincipals = new WeakMap<IncomingMessage, IPrincipal>();

    /** Authenticated principal per raw WS client socket, for `_all` scope filtering. */
    private readonly _clientPrincipals = new WeakMap<WebSocket, IPrincipal>();

    /** Authenticated principal attached to long-lived HTTP/SSE streams. */
    private readonly _streamPrincipals = new WeakMap<ServerResponse, IPrincipal>();

    /** Provider principals captured during successful WebSocket upgrades. */
    private readonly _pendingProviderPrincipals = new WeakMap<IncomingMessage, IProviderPrincipal>();
    private readonly _providerPrincipals = new WeakMap<WebSocket, IProviderPrincipal>();

    /**
     * `resources/subscribe` bookkeeping for every slot: who is subscribed to
     * what, and the one upstream subscription per URI that stands for them.
     */
    private readonly _subscriptions: ResourceSubscriptionRegistry<ResponseSink>;

    /** Stable id per raw WS client socket, the WS part of a {@link ClientKey}. */
    private readonly _wsClientIds = new WeakMap<WebSocket, number>();
    private _nextWsClientId = 1;

    /** Stable id per in-process client, the internal part of a {@link ClientKey}. */
    private readonly _internalClientIds = new WeakMap<IInternalClient, number>();
    private _nextInternalClientId = 1;

    /** Emitter behind {@link onProvidersChanged}. */
    private readonly _providersChanged: IEventEmitter<readonly string[]> = createEventEmitter<readonly string[]>();

    /** Slots changed since the last {@link _providersChanged} batch went out. */
    private readonly _changedSlots = new Set<string>();
    private _changedSlotsTimer: NodeJS.Timeout | null = null;

    /** Slots already warned about for a malformed `notifications/resources/updated`. */
    private readonly _invalidUpdateWarnedProviders = new Set<string>();

    /** Declarations, caller references and protected slots: the broker as decision point. */
    private readonly _authority: BrokerAuthority;

    /** Provider principal of each in-process loopback provider that was given one. */
    private readonly _loopbackPrincipals = new Map<string, IProviderPrincipal>();

    /** Periodic cleanup of caller references whose request went away without an answer. */
    private _callerRefSweepTimer: NodeJS.Timeout | null = null;

    constructor(options: IWsTunnelOptions) {
        this._options = options;
        this._authGuard = options.auth ? new HttpAuthGuard(options.auth, options.mcpPath ?? "/mcp") : null;
        this._providerAuth = options.providerAuth ?? null;
        this._allowedOrigins = originPredicate(options.allowedOrigins);
        this._authorization = options.authorization ?? options.auth?.authorization ?? null;
        this._slotResourceResolver =
            options.slotResourceResolver ?? this._authorization?.slotResourceResolver ?? options.auth?.slotResourceResolver ?? new DefaultSlotResourceResolver();
        this._subscriptions = new ResourceSubscriptionRegistry<ResponseSink>(
            {
                request: (slot, method, uri) => this._subscriptionRequest(slot, method, uri),
                isConnected: (slot) => {
                    const state = this._providers.get(slot);
                    return state !== undefined && this._isProviderConnected(slot, state);
                },
            },
            options.resourceSubscriptions
        );
        this._validateProtectedSlots();
        this._authority = new BrokerAuthority({
            protectedSlots: options.protectedSlots,
            slotResources: this._slotResourceResolver,
            authorization: this._authorization,
            securityVersion: options.securityVersion,
            authorizeBatchLimit: options.authorizeBatchLimit,
            knownPrincipals: options.knownProviderPrincipals,
            callerRefMaxAgeMs: (options.providerRequestTimeoutMs ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS) || DEFAULT_CALLER_REF_MAX_AGE_MS,
        });
    }

    /**
     * Refuses, at construction, a protected-slot configuration that could not
     * be enforced. Each of these would otherwise start a broker that looks
     * protected and is not.
     */
    private _validateProtectedSlots(): void {
        const slots = this._options.protectedSlots ?? {};
        const names = Object.keys(slots);
        if (names.length === 0) return;
        const problems: string[] = [];
        if (!this._options.providerAuth) {
            problems.push(
                "provider authentication is off, so the broker cannot tell which provider is publishing or declaring. Configure the providers table (or withProviderAuth)"
            );
        }
        const upstreams = new Set([...(this._options.stdioUpstreams ?? []), ...(this._options.remoteUpstreams ?? [])].map((u) => u.name));
        // Checked only when the identities come from a table; a custom
        // authenticator may mint principals no configuration lists.
        const known = this._options.knownProviderPrincipals ? new Set(this._options.knownProviderPrincipals.map((p) => p.id)) : null;
        for (const name of names) {
            const entry = slots[name];
            if (!name) problems.push("a protected slot has an empty name");
            if (RESERVED_SLOTS.has(name)) problems.push(`"${name}" is reserved by the broker and cannot be protected`);
            if (upstreams.has(name)) problems.push(`"${name}" is served by a configured upstream, which has no provider identity to match publishedBy`);
            if (typeof entry?.declaredBy !== "string" || entry.declaredBy.length === 0) problems.push(`"${name}": declaredBy must name a provider principal`);
            if (typeof entry?.publishedBy !== "string" || entry.publishedBy.length === 0) problems.push(`"${name}": publishedBy must name a provider principal`);
            for (const role of ["declaredBy", "publishedBy"] as const) {
                const id = entry?.[role];
                if (id === "shared-secret") problems.push(`"${name}": ${role} cannot be "shared-secret", which every holder of the legacy secret shares`);
                else if (typeof id === "string" && known && !known.has(id)) problems.push(`"${name}": ${role} "${id}" is not in the providers table`);
            }
        }
        if (problems.length > 0) throw new Error(`protectedSlots cannot be enforced: ${problems.join("; ")}.`);
    }

    /** The authorization state providers declared, for `broker_diagnose`. */
    public getAuthorityInfo(): IBrokerAuthorityInfo {
        return this._authority.info(this._authorization?.capabilities);
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

    /**
     * What the broker enforces on its listening surface right now, for
     * `broker_diagnose`.
     *
     * The rule it feeds is the one that catches a page the broker serves itself
     * being refused by its own origin check: static files mounted, no browser
     * origin allowed. That combination now costs more than it did, because the
     * check reaches the legacy SSE endpoints too.
     */
    public getSecurityInfo(): IBrokerSecurityInfo {
        return {
            allowedOriginsConfigured: this._options.allowedOrigins !== undefined,
            clientAuthEnabled: this._authGuard !== null,
            providerAuthEnabled: this._providerAuth !== null,
            staticMountPrefixes: (this._options.staticMounts ?? []).map((m) => m.urlPrefix),
        };
    }

    /** Slot the stdio bridge is pinned to, or `null` when there is no bridge. */
    public getStdioBridgeTarget(): string | null {
        return this._options.stdioClient?.providerName ?? null;
    }

    /**
     * Membership of the `_all` aggregate, for `broker_diagnose`.
     *
     * Before `start()` the aggregate server does not exist yet, so an enabled
     * aggregate reports no provider rather than `undefined`: "cannot be read"
     * is for a host that has no aggregate at all, not for one that has not
     * started. Without this accessor the CLI's own broker skipped the
     * `aggregate-empty` check and told the operator to call tools/list on
     * `_all` by hand.
     */
    public getAggregateInfo(): IBrokerAggregateInfo {
        return {
            enabled: this._options.enableAggregateProvider !== false,
            providers: this._aggregateServer?.providerNames ?? [],
        };
    }

    /** See {@link IBrokerContext.onProvidersChanged}. */
    get onProvidersChanged(): IEventSource<readonly string[]> {
        return this._providersChanged;
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

        // `connected` is decided above from what is actually open; the
        // timestamp only says since when, and is withheld when they disagree
        // (an upstream that opened once and is now closed keeps no date).
        const since = connected ? state.connectedSinceMs : null;
        return {
            name,
            transport,
            connected,
            aggregate: this._aggregateServer?.providerNames.includes(name) ?? false,
            connectedSince: since !== null ? new Date(since).toISOString() : null,
            connectedForMs: since !== null ? Math.max(0, Date.now() - since) : null,
            clientCount: state.wsClients.size,
            sessionCount: state.sseSessions.size + state.httpSessions.size,
            pendingCount: state.pending.size,
            resourceSubscriptionCount: this._subscriptions.countFor(name),
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
     * `options.principal` gives the provider an identity, which is what lets it
     * declare an authorization domain and publish into a protected slot. The
     * returned handle exposes the `broker/*` methods in process; the same
     * methods also work as frames on the transport.
     *
     * @throws if the name is already used by a stdio upstream or another
     * loopback, or if the slot is protected and the principal is not the one
     * allowed to publish into it.
     */
    public registerLoopbackProvider(name: string, transport: IMessageTransport, options: { readonly principal?: IProviderPrincipal } = {}): ILoopbackProviderHandle {
        if (this._loopbackProviders.has(name)) {
            throw new Error(`Loopback provider "${name}" is already registered.`);
        }
        if (this._upstreams.has(name)) {
            throw new Error(`Cannot register loopback "${name}": a stdio upstream with the same name already exists.`);
        }
        if (this._providers.get(name)?.ws?.readyState === WebSocket.OPEN) {
            throw new Error(`Cannot register loopback "${name}": a WebSocket provider currently holds the slot.`);
        }
        const principal = options.principal ?? null;
        if (!this._authority.mayPublish(name, principal)) {
            throw new Error(
                `Cannot register loopback "${name}": the slot is protected and only principal "${this._authority.protectionOf(name)?.publishedBy}" may publish into it.`
            );
        }

        const state = this._getOrCreateProviderState(name);
        this._loopbackProviders.set(name, transport);
        if (principal) {
            this._loopbackPrincipals.set(name, principal);
            this._authority.notePrincipal(principal);
        }
        state.connectedSinceMs = Date.now();
        this._onProviderAttached(name);

        const origin: IProviderFrameOrigin = { kind: "loopback", principal, reply: (frame) => transport.send(frame) };
        transport.onMessage = (data: string) => this._routeFromProvider(state, name, data, origin);
        transport.onClose = () => {
            this._loopbackProviders.delete(name);
            this._loopbackPrincipals.delete(name);
            this._failProviderDisconnected(state, name);
        };

        // The handle speaks for this registration only: once the slot was
        // released, or taken by another loopback, it has nobody to speak for.
        const call = (method: string, params: unknown): Promise<BrokerMethodOutcome> =>
            Promise.resolve(
                this._loopbackProviders.get(name) === transport
                    ? this._brokerMethod(state, name, method, params, principal)
                    : { error: { code: -32000, message: `Loopback provider "${name}" is no longer registered.` } }
            );
        return {
            declare: (params: unknown) => call(BROKER_DECLARE_METHOD, params),
            authorize: (params: unknown) => call(BROKER_AUTHORIZE_METHOD, params),
        };
    }

    /**
     * Opens an in-process client to a provider slot. The returned handle can
     * issue MCP requests and receives both the responses and the provider's
     * broadcast notifications. Used by the aggregate server to fan a single
     * in-process client out to every aggregated provider.
     *
     * The slot does not need a provider attached yet, `send` returns a
     * JSON-RPC error while the provider is disconnected.
     */
    public openInternalClient(providerName: string): IInternalClient {
        const state = this._getOrCreateProviderState(providerName);
        let closed = false;

        const client: IInternalClient = {
            onMessage: null,
            onClose: null,
            send: (message: string, principal: IPrincipal | null = null): void => {
                if (closed) return;
                // Same subscription bookkeeping as every other client: without
                // it the subscribe reached the provider, and the updates it
                // produced had no registered recipient to go to.
                if (this._interceptClientFrame(state, providerName, message, { type: "internal", client })) return;
                if (this._isProviderConnected(providerName, state)) {
                    this._sendToProvider(state, providerName, this._trackRequest(state, providerName, message, { type: "internal", client }, principal));
                } else if (requestIdOf(message) !== undefined) {
                    client.onMessage?.(this._notConnectedPayload(providerName, message));
                }
            },
            close: (): void => {
                if (closed) return;
                closed = true;
                state.internalClients.delete(client);
                for (const [brokerId, entry] of state.pending) {
                    if (entry.sink.type === "internal" && entry.sink.client === client) state.pending.delete(brokerId);
                }
                void this._subscriptions.removeClient(this._internalClientKey(client));
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
            n += s.wsClients.size + s.sseSessions.size + s.httpSessions.size;
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
     * Starts the broker. Resolves once the HTTP server is listening, and
     * **rejects** when the listen fails.
     *
     * The rejection is the point: until the port is bound, a listen failure has
     * nowhere else to go. `ws` mirrors the HTTP server's `'error'` onto the
     * `WebSocketServer` from a listener it installs inside its own constructor,
     * so an unhandled one is rethrown by Node as an uncaught exception, outside
     * any caller's `await` and outside any `catch` the caller wrote.
     */
    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const handler = (req: IncomingMessage, res: ServerResponse) => this._handleHttp(req, res);
            this._httpServer = this._options.tls ? https.createServer({ cert: this._options.tls.cert, key: this._options.tls.key }, handler) : http.createServer(handler);
            // Disable perMessageDeflate: payloads may be large base64-encoded blobs
            // (snapshots, images) that are already compressed. Deflating them wastes
            // CPU without reducing size, and caused multi-second stalls in practice.
            this._wss = new WebSocketServer({ server: this._httpServer, perMessageDeflate: false, verifyClient: this._makeVerifyClient() });

            // Server-level errors, of which the one that actually happens is
            // `EADDRINUSE` on the very first bind.
            //
            // `settled` guards the reject: once the server is listening the
            // promise is spoken for, and a later error (a socket reset during an
            // upgrade, say) must be logged instead, or it lands as a rejection on
            // an already-resolved promise, which Node reports as unhandled.
            //
            // The same handler goes on BOTH emitters deliberately. `ws` forwards
            // the HTTP server's `'error'` to the `WebSocketServer` from a listener
            // registered inside `new WebSocketServer({ server })`; being first, it
            // rethrows an unhandled event before any listener added here to
            // `_httpServer` could run. The `_httpServer` listener is still needed
            // for the errors `ws` does not forward. `lastError` is what stops the
            // doubly delivered listen failure from being reported twice.
            let settled = false;
            let lastError: unknown = null;
            const onServerError = (err: Error): void => {
                if (err === lastError) return;
                lastError = err;
                if (settled) {
                    console.error(`[broker] http/websocket server error: ${err.message}`);
                    return;
                }
                settled = true;
                reject(this._listenError(err));
            };
            this._wss.on("error", onServerError);
            this._httpServer.on("error", onServerError);

            this._wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
                const url = req.url ?? "/";
                const route = this._classifyWsRoute(url);

                switch (route.role) {
                    case "reject":
                        // Defence in depth. `verifyClient` refuses these before the
                        // handshake completes, with the full diagnosis in the HTTP
                        // body, so this branch should be unreachable: it exists so
                        // the invariant "a rejected path never reaches a handler"
                        // holds even if the hook is ever changed.
                        console.warn(`[broker] ws connect path="${url}" REFUSED after handshake: ${route.detail}`);
                        this._closeWs(ws, 1008, route.closeReason);
                        return;
                    case "multiplex-provider":
                        // Multiplexed provider: one WebSocket carries N providers via envelopes.
                        this._logWsConnection(url, "multiplex-provider", "(announced per envelope)");
                        this._onMultiplexProviderConnect(ws, req);
                        return;
                    case "dedicated-provider":
                        this._logWsConnection(url, "dedicated-provider", route.slot);
                        this._onProviderConnect(ws, route.slot, req);
                        return;
                    case "client":
                        this._logWsConnection(url, "client", route.slot);
                        this._onClientConnect(ws, route.slot, req);
                        return;
                }
            });

            this._httpServer.listen(this._options.port, this._options.host ?? "0.0.0.0", () => {
                // Listening: from here on `onServerError` logs instead of rejecting.
                settled = true;

                // Both sweeps run on `unref`'d timers cleared by `stop()`, so an
                // embedder (or a test file) that starts a tunnel is never held
                // alive by them.
                this._startHeartbeat();
                this._startRequestTimeoutSweep();
                this._startCallerRefSweep();

                // Bring the aggregate `_all` slot up before any upstream connects
                // (a Streamable HTTP upstream opens synchronously on connect()).
                this._maybeStartAggregateServer();

                // Attach configured upstreams (stdio child processes + remote URL
                // servers). Both implement the Upstream contract, so the wiring
                // into a provider slot is identical.
                const wireUpstream = (cfg: { name: string; aggregate?: boolean }, upstream: IUpstream): void => {
                    const origin: IProviderFrameOrigin = { kind: "upstream", principal: null, reply: (frame) => upstream.send(frame) };
                    upstream.onMessage = (data) => {
                        const state = this._getOrCreateProviderState(cfg.name);
                        this._routeFromProvider(state, cfg.name, data, origin);
                    };
                    upstream.onError = (err) => {
                        console.error(`[broker] ${err.message}`);
                    };
                    upstream.onClose = () => {
                        const state = this._providers.get(cfg.name);
                        if (state) this._failProviderDisconnected(state, cfg.name);
                    };
                    upstream.onOpen = () => {
                        this._getOrCreateProviderState(cfg.name).connectedSinceMs = Date.now();
                        this._onProviderAttached(cfg.name);
                        if (cfg.aggregate) void this._aggregateServer?.addProvider(cfg.name);
                    };
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
                        // Client disconnected: pending sinks will time out, but its
                        // subscriptions are released now, so the provider stops
                        // producing updates nobody reads.
                        void this._subscriptions.removeClient(STDIO_CLIENT_KEY);
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
     * Turns a listen failure into an error whose message says what to do next.
     *
     * `EADDRINUSE` is the one that happens in practice, and the reflex it
     * triggers is usually the wrong one: another broker gets spawned on another
     * port. Two brokers do not share anything, a slot is held by exactly one
     * process, so the second instance's providers are invisible to the first
     * instance's clients. Hence the message points at attaching to the running
     * broker first, and only then at changing the port.
     */
    private _listenError(err: Error): Error {
        const host = this._options.host ?? "0.0.0.0";
        const port = this._options.port;
        const code = (err as NodeJS.ErrnoException).code;

        if (code === "EADDRINUSE") {
            const scheme = this._options.tls ? "https" : "http";
            // A wildcard bind is not a reachable authority; name one that is.
            const reachable = host === "0.0.0.0" || host === "::" ? "localhost" : host;
            return new Error(
                `Cannot listen on ${host}:${port}: the address is already in use. Another broker (or another process) already holds that port. ` +
                    `If it is a broker, use it: attach clients to ${scheme}://${reachable}:${port}/<slot>/mcp and inspect it at ${scheme}://${reachable}:${port}/_broker/mcp, ` +
                    `rather than starting a second instance, which would share no provider slot with the first. ` +
                    `To run a second one anyway, give it a free port (MCP_BROKER_PORT, or the \`port\` option).`,
                { cause: err }
            );
        }

        if (code === "EACCES") {
            return new Error(
                `Cannot listen on ${host}:${port}: permission denied. Ports below 1024 require elevated privileges; ` +
                    `pick a port above 1024 (MCP_BROKER_PORT, or the \`port\` option), or put a reverse proxy in front.`,
                { cause: err }
            );
        }

        if (code === "EADDRNOTAVAIL") {
            return new Error(
                `Cannot listen on ${host}:${port}: the host address is not available on this machine. ` +
                    `Bind to "0.0.0.0" (every interface) or "127.0.0.1" (local only) via MCP_BROKER_HOST, or the \`host\` option.`,
                { cause: err }
            );
        }

        return new Error(`Cannot listen on ${host}:${port}: ${err.message}`, { cause: err });
    }

    /**
     * Starts the in-process MCP server that exposes the broker's own behaviors
     * (`broker_info`, `providers_list`, `provider_status`, `broker_guide`,
     * `broker_diagnose`) under the reserved provider slot `_broker`. No-op when
     * {@link IWsTunnelOptions.enableBrokerProvider} is `false`.
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
            server.onMembershipChanged = (name) => this._emitProviderChanged(name);
            server.membershipGuard = (name) => !this._authority.protectionOf(name);
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
        // First thing, before any `await`: a live interval keeps the event loop
        // busy, and both of these fire on sockets that are about to be torn
        // down. They are `unref`'d, so they cannot by themselves hold a process
        // open, but a test runner that checks for leaked handles counts them.
        this._stopHeartbeat();
        this._stopRequestTimeoutSweep();
        this._stopCallerRefSweep();
        this._providerSockets.clear();

        // Forgotten without an upstream unsubscribe each: every provider is
        // about to be disconnected, which drops its subscriptions anyway, and
        // the closes below must not queue requests to sockets being torn down.
        this._subscriptions.clear();
        if (this._changedSlotsTimer) clearTimeout(this._changedSlotsTimer);
        this._changedSlotsTimer = null;
        this._changedSlots.clear();

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

        // Streamable HTTP sessions are torn down by the endpoint that owns them,
        // not by ending their responses here: `closeAll` runs each session's
        // `stop`, which is what empties `httpSessions`.
        await Promise.all([...this._providers.values()].map((state) => state.httpEndpoint?.closeAll() ?? Promise.resolve()));

        return new Promise((resolve, reject) => {
            for (const state of this._providers.values()) {
                for (const res of state.sseSessions.values()) res.end();
                state.sseSessions.clear();
                state.httpSessions.clear();
                state.httpEndpoint = null;
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

            const httpServer = this._httpServer;
            if (!httpServer) {
                // Never started: there is no close callback coming, and waiting
                // for one would hang the caller's teardown.
                resolve();
                return;
            }
            httpServer.close((err) => {
                // A tunnel whose `start()` rejected (the port was already taken)
                // has a server object that never listened, and closing that one
                // answers `ERR_SERVER_NOT_RUNNING`. Failing the teardown on it
                // would replace the real diagnosis with a meaningless one, in the
                // `finally` where the caller is trying to clean up after the first.
                if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(err);
                else resolve();
            });
        });
    }

    // -------------------------------------------------------------------------
    // Provider liveness (heartbeat) and slot takeover
    // -------------------------------------------------------------------------

    /** Effective heartbeat period in ms; `0` means the heartbeat is off. */
    private _heartbeatIntervalMs(): number {
        const configured = this._options.providerHeartbeatIntervalMs;
        return Math.max(0, configured ?? DEFAULT_PROVIDER_HEARTBEAT_MS);
    }

    /** Effective per-request deadline in ms; `0` means requests never expire. */
    private _requestTimeoutMs(): number {
        const configured = this._options.providerRequestTimeoutMs;
        return Math.max(0, configured ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
    }

    /**
     * Starts watching every provider socket for a missed pong.
     *
     * `unref()` is not cosmetic: without it this interval alone keeps the Node
     * event loop alive, so every test file that starts a tunnel would hang on
     * teardown, and an embedder's process would refuse to exit.
     */
    private _startHeartbeat(): void {
        const interval = this._heartbeatIntervalMs();
        if (interval === 0) return;
        this._heartbeatTimer = setInterval(() => this._sweepHeartbeats(), interval);
        this._heartbeatTimer.unref?.();
    }

    private _stopHeartbeat(): void {
        if (!this._heartbeatTimer) return;
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
    }

    /**
     * One heartbeat round: terminate whoever did not answer the previous ping,
     * then ping everybody still standing.
     *
     * The two-phase shape is what gives a provider a full interval to reply,
     * and it is why {@link _alive} means "answered since the last sweep" rather
     * than "is connected".
     */
    private _sweepHeartbeats(): void {
        const interval = this._heartbeatIntervalMs();
        for (const ws of [...this._providerSockets]) {
            if (ws.readyState !== WebSocket.OPEN) {
                this._providerSockets.delete(ws);
                continue;
            }
            if (this._alive.get(ws) === false) {
                const slots = this._slotsOfSocket(ws);
                console.warn(
                    `[broker] provider socket for ${slots} did not answer a WebSocket ping within ${interval}ms; terminating it and freeing the slot. ` +
                        `The provider process, tab or network path is gone. It may reconnect immediately. ` +
                        `If this provider is alive but slow, raise providerHeartbeatIntervalMs (or set it to 0 to disable the heartbeat).`
                );
                this._providerSockets.delete(ws);
                ws.terminate();
                continue;
            }
            this._alive.set(ws, false);
            try {
                ws.ping();
            } catch (err) {
                // A socket that died between the readyState check and the ping.
                // Nothing to diagnose: the close handler is already on its way.
                this._providerSockets.delete(ws);
                void err;
            }
        }
    }

    /**
     * Puts one accepted provider socket under the heartbeat.
     *
     * No-op when the heartbeat is disabled, which is what keeps
     * {@link _alive} empty and makes the admission check fall back to refusing
     * every takeover: with no liveness evidence, evicting the incumbent would
     * be a guess.
     */
    private _watchProviderSocket(ws: WebSocket): void {
        if (this._heartbeatIntervalMs() === 0) return;
        this._alive.set(ws, true);
        this._providerSockets.add(ws);
        ws.on("pong", () => this._alive.set(ws, true));
        ws.on("close", () => this._providerSockets.delete(ws));
    }

    /** Human-readable list of the slots one provider socket currently serves. */
    private _slotsOfSocket(ws: WebSocket): string {
        const announced = this._multiplexSockets.get(ws);
        if (announced) return announced.size > 0 ? `multiplexed slots [${[...announced].join(", ")}]` : "a multiplexed socket that announced no slot";
        const owned = [...this._providers.entries()].filter(([, state]) => state.ws === ws).map(([name]) => name);
        return owned.length > 0 ? `slot "${owned.join('", "')}"` : "a slot it no longer owns";
    }

    /**
     * Decides whether a newly connected provider socket may take the slot
     * `name`, evicting the incumbent when it is allowed to.
     *
     * Returns `null` when the newcomer is admitted, or the refusal otherwise:
     * `detail` is the full diagnosis for the log and for the envelope the
     * multiplexed path can carry, `closeReason` the same thing squeezed into the
     * 123 bytes RFC 6455 allows on a close frame, with the actionable part
     * first so truncation eats the slot name (which the peer already knows)
     * rather than the instruction.
     *
     * See {@link ProviderTakeoverMode} for what each mode means and why
     * `"always"` is gated on provider authentication.
     */
    private _claimSlot(name: string, ws: WebSocket): { detail: string; closeReason: string } | null {
        const incumbent = this._providers.get(name)?.ws ?? null;
        if (!incumbent || incumbent === ws || incumbent.readyState !== WebSocket.OPEN) return null;

        const mode: ProviderTakeoverMode = this._options.providerTakeover ?? "liveness";

        if (mode === "always") {
            if (this._sameProviderPrincipal(incumbent, ws)) {
                console.warn(`[broker] provider "${name}": takeover mode "always", the incumbent socket is being terminated in favor of the new one from the same principal.`);
                incumbent.terminate();
                return null;
            }
            // Not a refusal on its own: fall through to the liveness rule. Saying
            // so out loud matters, because the operator asked for "always" and is
            // entitled to know why they did not get it.
            console.warn(
                `[broker] provider "${name}": takeover mode "always" is not honored here and the broker fell back to "liveness". ` +
                    `Unconditional takeover is only safe when providerAuth is configured AND the new socket authenticated as the same principal as the incumbent; ` +
                    `otherwise anyone able to reach the provider URL could evict the real provider at will. Configure providerAuth (withProviderSecret) to enable it.`
            );
        }

        if (mode !== "reject" && this._alive.get(incumbent) === false) {
            console.warn(`[broker] provider "${name}": the incumbent socket missed its last heartbeat, so it is terminated and the new connection takes the slot.`);
            incumbent.terminate();
            return null;
        }

        const heartbeat = this._heartbeatIntervalMs();
        const why =
            mode === "reject"
                ? `providerTakeover is "reject", so a live slot is never handed over.`
                : heartbeat === 0
                  ? `The heartbeat is disabled (providerHeartbeatIntervalMs: 0), so the broker has no evidence the incumbent is dead and will not evict it.`
                  : `The incumbent answered the last heartbeat, so it is treated as alive.`;
        const recovery =
            heartbeat === 0
                ? `Enable the heartbeat (providerHeartbeatIntervalMs) so a dead socket frees its slot on its own`
                : `wait up to ${heartbeat}ms for the heartbeat to notice a dead socket and reconnect`;
        return {
            detail:
                `Provider "${name}" is already connected. ${why} ` +
                `If the previous instance really is gone, ${recovery}, close the old socket cleanly from the provider side, or publish on a different slot name. ` +
                `Call provider_status on the _broker slot to see which socket holds it.`,
            closeReason: `Slot already held by a live provider; call provider_status on _broker. Slot: "${name}"`,
        };
    }

    /**
     * `true` when two provider sockets authenticated as the same principal.
     *
     * Deliberately `false` when provider auth is off: with no authenticator
     * there are no principals to compare, and treating "both anonymous" as
     * "the same provider" is exactly the spoofing primitive the gate exists to
     * prevent.
     */
    private _sameProviderPrincipal(a: WebSocket, b: WebSocket): boolean {
        if (!this._providerAuth) return false;
        const left = this._providerPrincipals.get(a);
        const right = this._providerPrincipals.get(b);
        return left !== undefined && right !== undefined && left.id === right.id;
    }

    /** Closes a socket with a reason RFC 6455 actually allows on the wire. */
    private _closeWs(ws: WebSocket, code: number, reason: string): void {
        ws.close(code, truncateReason(reason));
    }

    // -------------------------------------------------------------------------
    // Pending requests: correlation and deadlines
    // -------------------------------------------------------------------------

    /**
     * Registers one outbound request against a slot and returns the frame to
     * put on the wire, with the client's JSON-RPC id replaced by a
     * broker-assigned one.
     *
     * The rewrite is the fix for a cross-client response leak. `state.pending`
     * is one map per **slot**, written from five different ingresses (raw WS,
     * legacy SSE, Streamable HTTP, the stdio bridge, in-process clients), and
     * it used to be keyed by the id the client chose. Two clients on one slot
     * that both start numbering at 1 (MCP Inspector plus Claude, the pairing
     * the architecture doc explicitly advertises) therefore shared one entry:
     * the second write replaced the first, one client received the other's
     * result, and the overwritten request hung forever with no error. Rewriting
     * also stops the provider from seeing two concurrent requests with the same
     * id, which it has no way to answer correctly either.
     *
     * Invisible to conforming clients: {@link _routeFromProvider} restores the
     * original id before the answer is delivered.
     *
     * Frames with no usable id (notifications) and JSON-RPC batches (an array,
     * which has no top-level id) are returned untouched and untracked, exactly
     * as before.
     */
    private _trackRequest(state: IProviderState, providerName: string, frame: string, sink: ResponseSink, principal: IPrincipal | null = null): string {
        let parsed: unknown;
        try {
            parsed = JSON.parse(frame);
        } catch {
            return frame;
        }

        // A client never gets to speak for the broker: its caller reference
        // goes first, from every frame, batches and notifications included.
        //
        // Always re-serialized, never forwarded byte for byte: JSON.parse keeps
        // the LAST of two duplicate keys, a C or C++ provider may keep the FIRST,
        // so a frame with two `_meta` keys could hide a caller reference from
        // the strip and show it to the provider. Re-serializing leaves exactly
        // what the broker checked.
        if (Array.isArray(parsed)) {
            // A batch item without `method` is response-shaped. A client has
            // nothing to answer (the broker relays no provider request), and an
            // item like that is never renumbered, so it could pass for the
            // broker's answer to one of the provider's own `broker/*` requests.
            const kept = parsed.filter((item) => typeof item === "object" && item !== null && typeof (item as { method?: unknown }).method === "string");
            for (const item of kept) stripCallerMeta(item);
            return JSON.stringify(kept);
        }
        if (typeof parsed !== "object" || parsed === null) return frame;
        const message = parsed as Record<string, unknown>;
        stripCallerMeta(message);

        const clientId = message.id;
        if (typeof clientId !== "string" && typeof clientId !== "number") return JSON.stringify(message);

        const brokerId = `${BROKER_REQUEST_ID_PREFIX}${this._nextRequestId++}`;
        const timeout = this._requestTimeoutMs();

        // A provider that declared an authorization domain gets, with each
        // request, a reference to whoever sent it: valid on this slot, for as
        // long as this request is pending, and good for nothing else.
        let callerRef: string | undefined;
        if (sink.type !== "broker") {
            const providerPrincipal = this._providerPrincipalOfSlot(providerName, state);
            if (providerPrincipal && this._authority.declarationOf(providerPrincipal.id)) {
                const issued = this._authority.issueRef(providerName, brokerId, providerPrincipal.id, this._authorizationSubject(principal));
                injectCallerMeta(message, issued);
                callerRef = issued.ref;
            }
        }

        state.pending.set(brokerId, { sink, clientId, expiresAt: timeout > 0 ? Date.now() + timeout : 0, ...(callerRef ? { callerRef } : {}) });
        message.id = brokerId;
        return JSON.stringify(message);
    }

    /**
     * The identity of the provider currently serving `name`, in the order
     * {@link _sendToProvider} picks a channel. `null` for an upstream (it has
     * none) and for an anonymous socket.
     */
    private _providerPrincipalOfSlot(name: string, state: IProviderState): IProviderPrincipal | null {
        if (this._upstreams.get(name)?.isOpen) return null;
        if (this._loopbackProviders.get(name)?.isOpen) return this._loopbackPrincipals.get(name) ?? null;
        if (state.ws && state.ws.readyState === WebSocket.OPEN) return this._providerPrincipals.get(state.ws) ?? null;
        return null;
    }

    /** Delivers one already-addressed frame to the sink that is waiting for it. */
    private _deliverToSink(state: IProviderState, sink: ResponseSink, data: string): void {
        switch (sink.type) {
            case "ws":
                if (sink.socket.readyState === WebSocket.OPEN) sink.socket.send(data);
                return;
            case "sse": {
                const sseRes = state.sseSessions.get(sink.sessionId);
                if (sseRes) this._sendSseEvent(sseRes, data);
                return;
            }
            case "http-session":
                // The session transport decides whether this answers a held-open
                // POST or travels on the GET stream: it correlates by id.
                state.httpSessions.get(sink.sessionId)?.transport.send(data);
                return;
            case "stdio":
                this._stdioClientTransport?.send(data);
                return;
            case "internal":
                sink.client.onMessage?.(data);
                return;
            case "broker":
                sink.resolve(data);
                return;
        }
    }

    /**
     * Starts the sweep that fails requests a provider never answered.
     *
     * Same `unref()` requirement as the heartbeat. The period is derived from
     * the deadline rather than fixed, so a short timeout (a test, or a
     * latency-sensitive deployment) is still honored roughly on time instead of
     * being rounded up to the next sweep minutes later.
     */
    private _startRequestTimeoutSweep(): void {
        const timeout = this._requestTimeoutMs();
        if (timeout === 0) return;
        const period = Math.max(250, Math.min(5_000, Math.floor(timeout / 2)));
        this._requestTimeoutTimer = setInterval(() => this._sweepPendingTimeouts(), period);
        this._requestTimeoutTimer.unref?.();
    }

    private _stopRequestTimeoutSweep(): void {
        if (!this._requestTimeoutTimer) return;
        clearInterval(this._requestTimeoutTimer);
        this._requestTimeoutTimer = null;
    }

    /**
     * Forgets caller references whose request left the pending map without an
     * answer (client gone, timeout, provider disconnect). They are already
     * useless, since `broker/authorize` checks the request is still pending;
     * this only bounds the memory they hold. Runs whether or not requests
     * have a deadline.
     */
    private _startCallerRefSweep(): void {
        this._callerRefSweepTimer = setInterval(() => this._authority.sweepRefs((slot, brokerId) => this._providers.get(slot)?.pending.has(brokerId) ?? false), 10_000);
        this._callerRefSweepTimer.unref?.();
    }

    private _stopCallerRefSweep(): void {
        if (!this._callerRefSweepTimer) return;
        clearInterval(this._callerRefSweepTimer);
        this._callerRefSweepTimer = null;
    }

    /**
     * Fails every request whose deadline has passed.
     *
     * Until this existed a pending entry was released only by a matching
     * response, a provider disconnect, or the client's own close, so a provider
     * that stayed connected and simply never answered (a browser tab throttled
     * in the background is the ordinary case) left the caller waiting with
     * nothing to release it and no trace anywhere. A named error is strictly
     * better than a hang.
     */
    private _sweepPendingTimeouts(): void {
        const timeout = this._requestTimeoutMs();
        if (timeout === 0) return;
        const now = Date.now();

        for (const [name, state] of this._providers) {
            for (const [brokerId, entry] of state.pending) {
                if (entry.expiresAt === 0 || entry.expiresAt > now) continue;
                state.pending.delete(brokerId);
                console.warn(
                    `[broker] provider "${name}" did not answer a request within ${timeout}ms; the caller was sent a timeout error. ` +
                        `The socket is still connected, so this is the provider not replying rather than a disconnect: check that its MCP message handler was installed BEFORE the transport connected, ` +
                        `that it echoes the JSON-RPC id it was given, and that the page hosting it is not throttled in a background tab. ` +
                        `Raise providerRequestTimeoutMs for genuinely long-running tools.`
                );
                this._deliverToSink(
                    state,
                    entry.sink,
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: entry.clientId,
                        error: {
                            code: -32000,
                            message:
                                `Provider "${name}" did not respond within ${timeout}ms. The provider socket is still connected but sent no answer for this request. ` +
                                `Call broker_diagnose on the _broker slot for the live state of this slot.`,
                        },
                    })
                );
            }
        }
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
            // Both branches are logged, deliberately. A `SubjectMappingError` used
            // to be swallowed here, which made the single most likely
            // misconfiguration the one case that produced no output at all, while
            // the empty subject returned below makes the policy engine deny every
            // request from this caller. It is a configuration fault, not attacker
            // noise, and the HTTP path already diagnoses it out loud (a 403 saying
            // "Malformed configured JWT subject claim", see `auth/http.auth.ts`).
            const kind = error instanceof SubjectMappingError ? "malformed configured JWT subject claim" : "subject mapping failed";
            console.error(
                `[broker] authorization ${kind}: ${(error as Error).message}` +
                    ` -- every request from this caller is denied while this stands. Check authorization.subjectMapping against the claims the token actually carries.`
            );
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
            // Hoisted out of the `try` so the failure path can still name the
            // capability when the throw came from the engine rather than from the
            // classifier.
            let capability: string | undefined;
            try {
                const classified = authorization.capabilityClassifier.classify(operation, resource, providerName);
                if (!classified) continue;
                capability = classified.capability;
                const decision = authorization.engine.authorize({
                    subject,
                    capability: classified.capability,
                    resource,
                    provider: providerName,
                    tool: classified.tool,
                });
                this._auditDecision(subject, providerName, resource, classified.capability, classified.tool, decision);
                if (!decision.allowed) return false;
            } catch (error) {
                // The evaluation itself threw: a classifier or engine fault, not a
                // policy miss. The two call for opposite fixes, and the audit event
                // used to claim "no-matching-grant", which sends the operator off
                // to write grants that can never help. So say what actually
                // happened, with everything needed to reproduce it.
                console.error(
                    `[broker] policy evaluation error on slot "${providerName}": ${(error as Error).message}` +
                        ` -- subject=[${subject.ids.join(", ") || "(none)"}] resource="${resource.value}" capability="${capability ?? "(unclassified)"}" method="${operation.method ?? "(none)"}".` +
                        ` The request is denied. This is a fault in the authorization configuration or in the frame, not a missing grant.`
                );
                // "evaluation-error", not "no-matching-grant": nothing was
                // decided here, the request is denied because that is the safe
                // answer to a fault.
                const decision: IAuthorizationDecision = { allowed: false, reason: "evaluation-error" };
                this._auditDecision(subject, providerName, resource, capability, undefined, decision);
                return false;
            }
        }
        return true;
    }

    /**
     * Whether a client may reach `slot` at all: always for an ordinary slot,
     * only for the declaring provider's own client identity on a protected one.
     */
    private _clientMayReach(slot: string, principal: IPrincipal | null): boolean {
        if (!this._authority.protectionOf(slot)) return true;
        return this._authority.clientMayReach(slot, this._authorizationSubject(principal));
    }

    /** Answers an HTTP request for a protected slot this caller may not reach. */
    private _refuseProtectedSlot(res: ServerResponse, slot: string): void {
        console.warn(`[broker] refused a client on protected slot "${slot}": its subjects are not those of the declaring provider.`);
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "forbidden", error_description: `Slot "${slot}" is protected: only its declaring provider may call it.` }));
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

    /** The JSON-RPC error returned when the slot has nobody behind it. */
    private _notConnectedPayload(providerName: string, frame: string): string {
        return JSON.stringify({
            jsonrpc: "2.0",
            id: requestIdOf(frame) ?? null,
            error: { code: -32000, message: `Provider "${providerName}" not connected` },
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

        // Protected Resource Metadata (RFC 9728), public discovery data, served
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
                // The `mcp` kind is left out on purpose: `StreamableHttpEndpoint`
                // already runs the identical check, with the same predicate.
                if ((kind === "sse-connect" || kind === "sse-message") && !this._sseOriginAllowed(req, res, providerName, kind)) return;

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
     * Applies the browser-origin check to the legacy SSE pair, answering `403`
     * and returning `false` when the origin is refused.
     *
     * This closes a hole, and it is the one behavior change in this release a
     * browser page can notice. `allowedOrigins` reached exactly one place, the
     * Streamable HTTP endpoint, so `/<slot>/sse` and `/<slot>/messages` were
     * open to every page on the machine: `Access-Control-Allow-Origin: *` is
     * set unconditionally a few lines above, and a POST of JSON to
     * `/<slot>/messages` is a CORS *simple* request, so any page could open an
     * `EventSource`, read the session id off the `endpoint` event, and drive the
     * broker. That is verbatim the attack the origin check exists to stop.
     *
     * The contract of the check is preserved exactly: a request carrying **no**
     * `Origin` always passes, which is every non-browser client (Claude Desktop,
     * Inspector, the server-side SDKs), and an `Origin` passes only if
     * `allowedOrigins` names it. The same predicate object is used as for
     * `/<slot>/mcp`, so the two endpoints cannot drift apart.
     */
    private _sseOriginAllowed(req: IncomingMessage, res: ServerResponse, providerName: string, kind: McpEndpointKind): boolean {
        const origin = req.headers.origin;
        // A request with no Origin cannot come from a browser, so it is not this
        // check's business and passes straight through.
        if (typeof origin !== "string" || origin.length === 0) return true;
        if (this._allowedOrigins(origin)) return true;

        const endpoint = kind === "sse-connect" ? `/${providerName}${this._options.ssePath ?? "/sse"}` : `/${providerName}${this._options.messagesPath ?? "/messages"}`;
        const configured = this._options.allowedOrigins !== undefined;
        const description = configured
            ? `Origin "${origin}" is not allowed to reach "${endpoint}". It is compared verbatim against the configured allowedOrigins, so a different scheme, port or a trailing slash does not match. ` +
              `Add the exact origin the browser sends (MCP_BROKER_ALLOWED_ORIGINS, the \`allowedOrigins\` config key, or WsTunnelBuilder.withAllowedOrigins).`
            : `Origin "${origin}" is refused because no browser origin is allowed: \`allowedOrigins\` is unset, and the default is closed. ` +
              `A page served by this broker is not exempt, its origin has to be listed too. ` +
              `Set MCP_BROKER_ALLOWED_ORIGINS (the \`allowedOrigins\` config key, or WsTunnelBuilder.withAllowedOrigins) to "${origin}" to open it, and only then.`;

        console.warn(`[broker] refused SSE request on "${endpoint}": ${description}`);
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid_origin", error_description: description }));
        return false;
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
        // GET, POST and DELETE all belong to the Streamable HTTP state machine.
        if (endpoint === mcpSuffix) return "mcp";
        if (endpoint === sseSuffix && method === "GET") return "sse-connect";
        if (endpoint === messagesSuffix && method === "POST") return "sse-message";
        return null;
    }

    /** Routes an already-authorized (or auth-disabled) request to its handler. */
    private _dispatchMcpEndpoint(kind: McpEndpointKind, req: IncomingMessage, res: ServerResponse, providerName: string, principal: IPrincipal | null): void {
        switch (kind) {
            case "mcp":
                this._handleStreamableHttp(req, res, providerName, principal);
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
        // Not a token failure (e.g. the JWKS endpoint is unreachable), surface a
        // 500 rather than a misleading 401.
        console.error(`[broker] token validation error for "${providerName}":`, err);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "server_error" }));
    }

    /**
     * Decides, from the URL alone, what one WebSocket upgrade is asking for.
     *
     * One function rather than the two `startsWith` chains this used to be, one
     * in the connection handler and one in `verifyClient`. They agreed by
     * coincidence, and a disagreement would mean a socket authenticated as one
     * role and then served as another.
     *
     * The three refusals are paths that cannot work whatever is behind them:
     * a provider URL with no slot name (which used to mint a slot literally
     * named `(unnamed)` that nothing could ever address) and a slot-scoped
     * provider URL with more than one segment (`/provider/a/b`, which aliases
     * the `%2F`-encoded spelling of the same slot, so refusing it removes
     * nothing and forces one spelling).
     *
     * What is deliberately **not** refused: a slot name that matches nothing
     * configured. Claiming a free slot by connecting to it is how a provider
     * registers, so an unknown name is the normal case, not an error.
     */
    private _classifyWsRoute(url: string): WsRouteClassification {
        const providerPath = this._options.providerPath ?? "/provider";
        const providersPath = this._options.providersPath ?? "/providers";

        // Exact match plus query string: the multiplex endpoint takes its slot
        // names from the envelopes, never from the path.
        if (url === providersPath || url.startsWith(providersPath + "?")) return { role: "multiplex-provider" };

        // `${providerPath}?x=1` is deliberately absent from this test: it has
        // always been served as a client on a slot named after the path, and
        // narrowing that is not this change's business.
        if (url === providerPath) {
            return {
                role: "reject",
                detail:
                    `"${providerPath}" is the provider path PREFIX, not an endpoint. A slot-scoped provider appends its slot name: "${providerPath}/<name>". ` +
                    `If you meant the shared multiplexed socket, that is "${providersPath}" (exact path, one socket for many slots, envelope framing). ` +
                    `Connecting here used to occupy a slot literally named "(unnamed)", which no client could address.`,
                closeReason: `Missing slot name: connect to ${providerPath}/<name>, or to ${providersPath}`,
            };
        }

        if (url.startsWith(providerPath + "/")) {
            const raw = url.slice(providerPath.length + 1).split("?")[0];
            if (raw.length === 0) {
                return {
                    role: "reject",
                    detail: `"${url}" has an empty slot name. Append the slot the provider publishes: "${providerPath}/<name>".`,
                    closeReason: `Empty slot name: connect to ${providerPath}/<name>`,
                };
            }
            // Tested on the RAW segment, before decoding: hierarchical slot names
            // are legitimate and travel percent-encoded (`%2Fsite-a%2Fline-3`),
            // so decoding first would refuse exactly the shape the authorization
            // layer is built around.
            if (raw.includes("/")) {
                return {
                    role: "reject",
                    detail:
                        `"${url}" has more than one path segment after "${providerPath}/". A slot-scoped provider URL carries exactly one segment. ` +
                        `A slot name containing "/" must be percent-encoded: "${providerPath}/${encodeURIComponent(safeDecode(raw))}". ` +
                        `Both spellings resolve to the same slot, so only the encoded one is accepted.`,
                    closeReason: `Too many path segments: percent-encode the slot name after ${providerPath}/`,
                };
            }
            return { role: "dedicated-provider", slot: safeDecode(raw) };
        }

        // Raw WS MCP client: URL is "/<slot>" or "/".
        return { role: "client", slot: safeDecode(url.replace(/^\//, "").split("?")[0]) };
    }

    /**
     * Builds the `ws` verifyClient hook, which decides every WebSocket upgrade
     * before the connection is accepted, returning a real HTTP status during
     * the handshake rather than a post-handshake close:
     *
     * - Paths that cannot work are refused with `400` and the full reason as the
     *   response body (see {@link _classifyWsRoute}).
     * - **Raw MCP clients** (`/<slot>`) are gated by the OAuth 2.1 resource
     *   server ({@link _authGuard}) with the RFC 9728 `WWW-Authenticate` challenge.
     * - **Providers** (`/provider/<slot>`, `/providers`) are gated by the
     *   {@link _providerAuth} shared-secret / custom authenticator.
     *
     * Each authentication side is independent: a branch with no authenticator
     * configured is let through unchanged. The hook is always installed now,
     * because the path check applies whether or not anything is authenticated.
     */
    private _makeVerifyClient(): VerifyClientCallbackAsync {
        const guard = this._authGuard;
        const providerAuth = this._providerAuth;

        return (info, cb) => {
            const url = info.req.url ?? "/";
            const route = this._classifyWsRoute(url);

            if (route.role === "reject") {
                // `ws` writes this string as the body of the refused upgrade, so
                // a Node client reads it off `unexpected-response`. A browser
                // gets no status from script, which is why the connect log line
                // carries the same diagnosis on the server side.
                console.warn(`[broker] ws upgrade REFUSED path="${url}": ${route.detail}`);
                cb(false, 400, route.detail);
                return;
            }

            if (route.role === "multiplex-provider" || route.role === "dedicated-provider") {
                // Provider (engine) upgrade, shared-secret / custom authenticator.
                if (!providerAuth) {
                    cb(true);
                    return;
                }
                const slot = route.role === "dedicated-provider" ? route.slot : undefined;
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

            // Raw WS MCP client upgrade, OAuth 2.1 resource server.
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
     * Handles `GET /<providerName>/sse`, opens a long-lived SSE stream for Claude.
     * Sends an `endpoint` event so Claude knows where to POST its requests.
     */
    private _handleSseConnect(req: IncomingMessage, res: ServerResponse, providerName: string, principal: IPrincipal | null): void {
        if (!this._clientMayReach(providerName, principal)) {
            this._refuseProtectedSlot(res, providerName);
            return;
        }
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
            for (const [brokerId, entry] of state.pending) {
                if (entry.sink.type === "sse" && entry.sink.sessionId === sessionId) state.pending.delete(brokerId);
            }
            void this._subscriptions.removeClient(`sse:${sessionId}`);
        });
    }

    /**
     * Handles `POST /<providerName>/messages?sessionId=…`, receives a JSON-RPC
     * request from Claude and forwards it to the provider.
     * Always responds 202 Accepted; the real response arrives over SSE.
     */
    private _handleSseMessage(req: IncomingMessage, res: ServerResponse, providerName: string, principal: IPrincipal | null): void {
        if (!this._clientMayReach(providerName, principal)) {
            this._refuseProtectedSlot(res, providerName);
            return;
        }
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
            if (this._interceptClientFrame(state, providerName, body, { type: "sse", sessionId })) {
                // Answered on the SSE stream, like every other response here.
            } else if (this._isProviderConnected(providerName, state)) {
                // Tracked only once the frame is actually on its way out: an
                // entry added before the connectivity check has nothing to
                // answer it and would pin that id until the slot next
                // disconnects (the raw-WS path had the same ordering bug).
                this._sendToProvider(state, providerName, this._trackRequest(state, providerName, body, { type: "sse", sessionId }, principal), principal);
            } else {
                const sseRes = state.sseSessions.get(sessionId);
                if (sseRes) this._sendSseEvent(sseRes, this._notConnectedPayload(providerName, body));
            }

            res.writeHead(202);
            res.end();
        });
    }

    /**
     * Serves `/<providerName>/mcp` by handing the request to the slot's
     * Streamable HTTP endpoint.
     *
     * Everything protocol-shaped, sessions, `Mcp-Session-Id`, `DELETE`, the
     * `404` on a terminated session, `Origin` and `MCP-Protocol-Version`
     * validation, `202` on a notification, belongs to `mcp-core` and is no
     * longer reimplemented here. What stays is the broker's own business:
     * deciding who may speak (already done upstream by the auth guard) and
     * relaying frames to a provider that lives somewhere else entirely.
     */
    private _handleStreamableHttp(req: IncomingMessage, res: ServerResponse, providerName: string, principal: IPrincipal | null): void {
        if (!this._clientMayReach(providerName, principal)) {
            this._refuseProtectedSlot(res, providerName);
            return;
        }
        const state = this._getOrCreateProviderState(providerName);

        // The endpoint authenticates nothing: this broker has its own guard,
        // richer than the spec's (per-slot scopes, subject mapping into the
        // policy engine). So the principal is attached to the session here,
        // refreshed on every request, and read back when a frame is checked.
        const sessionId = req.headers["mcp-session-id"];
        if (typeof sessionId === "string") {
            const session = state.httpSessions.get(sessionId);
            if (session) {
                // A session belongs to the caller that first authenticated on
                // it. Another token for another subject on the same session id
                // would otherwise have its frames, and caller references,
                // attributed to whichever request set the principal last.
                if (session.principal && principal && principalKey(session.principal) !== principalKey(principal)) {
                    console.warn(
                        `[broker] refused a request on Streamable HTTP session "${sessionId}" of slot "${providerName}": it carries a token for another caller than the one the session belongs to.`
                    );
                    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ error: "forbidden", error_description: "This session belongs to another caller. Open a session of your own." }));
                    return;
                }
                session.principal = principal;
            }
        }

        void this._endpointFor(providerName, state).handleRequest(req, res);
    }

    /**
     * The slot's Streamable HTTP endpoint, built on first use.
     *
     * Its factory does not create an MCP server: the server is the provider,
     * reachable only through the tunnel. It creates a bridge instead: frames the
     * client sends go out to the provider, and frames coming back are addressed
     * to this session by id.
     */
    private _endpointFor(providerName: string, state: IProviderState): StreamableHttpEndpoint {
        if (state.httpEndpoint) return state.httpEndpoint;

        state.httpEndpoint = new StreamableHttpEndpoint({
            allowedOrigins: this._allowedOrigins,

            createServer: (transport, sessionId, _principal) => {
                const session: IHttpSession = { transport, principal: null };
                state.httpSessions.set(sessionId, session);

                transport.onMessage = (frame: string) => this._fromHttpSession(state, providerName, sessionId, session, frame);

                return {
                    // No server to launch: the one serving this session is the
                    // provider, at the far end of the tunnel. What `start` still
                    // owes is opening the transport, since a closed one drops
                    // every frame it is handed.
                    start: () => openTransport(transport),
                    stop: () => {
                        state.httpSessions.delete(sessionId);
                        void this._subscriptions.removeClient(`http:${sessionId}`);
                        // Nothing can answer the requests this session had in
                        // flight; leaving them would pin the ids forever.
                        for (const [brokerId, entry] of state.pending) {
                            if (entry.sink.type === "http-session" && entry.sink.sessionId === sessionId) state.pending.delete(brokerId);
                        }
                    },
                };
            },
        });

        return state.httpEndpoint;
    }

    /** Relays one frame from an HTTP session to the provider behind the slot. */
    private _fromHttpSession(state: IProviderState, providerName: string, sessionId: string, session: IHttpSession, frame: string): void {
        if (!this._authorizeMcpFrame(providerName, frame, session.principal)) {
            session.transport.send(this._policyDeniedPayload(frame));
            return;
        }

        if (this._interceptClientFrame(state, providerName, frame, { type: "http-session", sessionId })) return;

        if (!this._isProviderConnected(providerName, state)) {
            session.transport.send(this._notConnectedPayload(providerName, frame));
            return;
        }

        this._sendToProvider(state, providerName, this._trackRequest(state, providerName, frame, { type: "http-session", sessionId }, session.principal), session.principal);
    }

    /** Writes one JSON-RPC message as an SSE `message` event. */
    private _sendSseEvent(res: ServerResponse, data: string): void {
        // data is already a compact JSON string: no need to parse+re-serialize.
        res.write(`event: message\ndata: ${data}\n\n`);
    }

    // -------------------------------------------------------------------------
    // WebSocket connection handlers
    // -------------------------------------------------------------------------

    /**
     * Prints one line for every accepted WebSocket upgrade: the path asked for,
     * the role the router gave it, and the slot it landed on.
     *
     * Without it a successful connect produces no output whatsoever, so a
     * mistyped provider URL looks exactly like a working one until nothing ever
     * answers. The last router branch accepts **any** unmatched path as a client
     * slot, so `/providers/foo` (neither the multiplex endpoint `/providers` nor
     * a dedicated `/provider/foo`) becomes a client on a slot literally named
     * `providers/foo`; that case gets the fix spelled out in the same line.
     *
     * `console.log` is safe here: in stdio mode `bin.ts` rebinds the console to
     * stderr before the tunnel starts, so this never reaches the JSON-RPC stream.
     */
    private _logWsConnection(path: string, role: WsConnectRole, slot: string): void {
        let hint = "";
        if (role === "client") {
            const providerPath = this._options.providerPath ?? "/provider";
            const providersPath = this._options.providersPath ?? "/providers";
            const providerSlot = providerPath.replace(/^\//, "");
            const providersSlot = providersPath.replace(/^\//, "");
            // `/provider?x=1` matches neither provider branch (they test the bare
            // path and the `<path>/` prefix), and `/providers/foo` matches neither
            // the exact multiplex path nor the dedicated prefix.
            if (slot === providerSlot || slot === providersSlot || slot.startsWith(providersSlot + "/")) {
                hint =
                    ` -- this looks like a provider URL but matched no provider route, so it was accepted as a CLIENT slot and nothing will ever answer it. ` +
                    `Connect a MultiplexTransport to "${providersPath}" (exact path, slots announced per envelope), or a DirectTransport to "${providerPath}/<name>".`;
            }
        }
        console.log(`[broker] ws connect path="${path}" role=${role} slot="${slot}"${hint}`);
    }

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
            this._authority.notePrincipal(providerPrincipal);
        }
        if (this._upstreams.has(name)) {
            console.warn(
                `[broker] WARNING: WebSocket provider "${name}" rejected: a stdio upstream with the same name is already configured. ` + `Rename one of them to avoid the conflict.`
            );
            this._closeWs(ws, 1008, `Provider "${name}" is managed by a stdio upstream`);
            return;
        }

        if (this._loopbackProviders.has(name)) {
            console.warn(`[broker] WARNING: WebSocket provider "${name}" rejected: the slot is held by an in-process loopback (reserved system slot).`);
            this._closeWs(ws, 1008, `Provider "${name}" is reserved by the broker`);
            return;
        }

        if (!this._authority.mayPublish(name, providerPrincipal ?? null)) {
            console.warn(
                `[broker] WARNING: WebSocket provider "${name}" rejected: the slot is protected and only principal "${this._authority.protectionOf(name)?.publishedBy}" may publish into it ` +
                    `(this one is "${providerPrincipal?.id ?? "(anonymous)"}").`
            );
            this._closeWs(ws, 1008, `Slot "${name}" is protected: another principal publishes it`);
            return;
        }

        const refusal = this._claimSlot(name, ws);
        if (refusal) {
            console.warn(`[broker] WARNING: WebSocket provider "${name}" rejected. ${refusal.detail}`);
            this._closeWs(ws, 1008, refusal.closeReason);
            return;
        }

        const state = this._getOrCreateProviderState(name);
        state.ws = ws;
        state.connectedSinceMs = Date.now();
        this._watchProviderSocket(ws);
        this._onProviderAttached(name);
        if (providerPrincipal) {
            this._logProviderRegistration(providerPrincipal, name, this._slotResourceResolver.resolve(name), true);
        }

        // A provider MAY send a registration control frame as its very first
        // message (see _tryHandleRegistration). Any other first message ,
        // including a normal MCP frame, is routed and leaves the provider
        // non-aggregated, so every pre-existing provider keeps working.
        let registrationChecked = false;
        const origin: IProviderFrameOrigin = {
            kind: "ws",
            principal: providerPrincipal ?? null,
            reply: (frame) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(frame);
            },
        };
        ws.on("message", (data: Buffer) => {
            const text = data.toString();
            if (!registrationChecked) {
                registrationChecked = true;
                if (this._refuseEnvelopeOnSlotPath(ws, name, text)) return;
                if (this._tryHandleRegistration(name, text)) return;
            }
            this._routeFromProvider(state, name, text, origin);
        });

        ws.on("close", () => {
            // Only the socket that currently holds the slot may release it.
            //
            // A provider that reconnects while its predecessor is still CLOSING
            // is admitted (the incumbent is no longer OPEN), takes `state.ws`,
            // and would then have its own registration nulled out by the
            // predecessor's deferred close. The slot stays wedged: the socket is
            // open and answering, `provider_status` reports `connected: false`,
            // and `_failProviderDisconnected` has already evicted the slot from
            // `_all`, which the aggregate opt-in cannot restore because it is
            // checked once per socket, on the first frame. The multiplexed path
            // has always guarded this way.
            if (state.ws !== ws) return;
            state.ws = null;
            this._failProviderDisconnected(state, name);
        });

        // `ws` emits 'error' for receive-side protocol faults, an invalid UTF-8
        // text frame or a bad opcode among them, and Node rethrows an unhandled
        // 'error' event as an uncaught exception. Without this listener one
        // malformed frame from one provider takes the whole broker down and every
        // other provider with it. Log and let the socket close on its own: `ws`
        // closes it right after emitting.
        ws.on("error", (err: Error) => {
            console.error(`[broker] provider "${name}" socket error: ${err.message}. The socket is being closed; the provider should reconnect.`);
        });
    }

    /**
     * Inspects a provider's first WebSocket message for a registration frame,
     * and consumes it when that is what it is. Returns `true` when the message
     * was a registration, and thus must not be routed as MCP traffic.
     *
     * Two shapes are accepted, both notifications a peer that does not know them
     * ignores:
     *
     * - `{"jsonrpc":"2.0","method":"notifications/register","params":{"aggregate":true}}`,
     *   what `@cyanmycelium/mcp-broker-provider` sends on **both** paths. This
     *   is the shape to write new providers against: the multiplexed socket has
     *   always used it (wrapped in an envelope), so there is now one
     *   registration to learn instead of one per path.
     * - `{"type":"register","aggregate":true}`, the legacy control frame, kept
     *   working indefinitely for hand-written providers already sending it.
     *
     * `aggregate` is opt-in and stays that way. Joining `_all` publishes a
     * provider's tools and prompts to every client of the aggregate slot, which
     * is a confidentiality boundary: a provider that never asks is reachable
     * only on its own slot.
     *
     * A normal MCP frame carries `jsonrpc` with some other `method`, so it
     * returns `false` and the provider stays non-aggregated.
     */
    private _tryHandleRegistration(name: string, text: string): boolean {
        const frame = parseObjectFrame(text);
        if (!frame) return false;

        const isJsonRpcRegister = frame.jsonrpc !== undefined && frame.method === TUNNEL_REGISTER_METHOD;
        const isLegacyRegister = frame.jsonrpc === undefined && frame.type === "register";
        if (!isJsonRpcRegister && !isLegacyRegister) return false;

        if (registrationAsksForAggregate(frame)) {
            void this._aggregateServer?.addProvider(name);
        }
        return true;
    }

    /**
     * Detects a `MultiplexTransport` connected to a slot-scoped provider URL,
     * the single most reported way to wire this broker up wrong, and refuses it
     * instead of letting it look like it worked.
     *
     * What the mistake looks like without this check: the socket connects, the
     * broker registers the slot from the URL before any frame exists, so
     * `provider_status` reports the provider connected; then every frame the
     * broker sends is a plain JSON-RPC one that the peer's envelope decoder
     * drops on the floor, and every frame the peer sends is an envelope with no
     * top-level `id`, so it matches no pending request. Both sides believe they
     * are connected and no request is ever answered. Nothing is logged anywhere.
     *
     * Only an **unambiguous** envelope closes the socket: a JSON object with no
     * `jsonrpc` member that decodes as `{provider, payload}`. A malformed frame
     * is left alone and routed as before, since a provider is entitled to speak
     * a dialect the broker does not recognize. The legacy
     * `{"type":"register","aggregate":true}` frame has no `provider`/`payload`
     * pair and so is never mistaken for one.
     *
     * The diagnosis goes out three ways because each reaches a different reader:
     * the broker log, an error **envelope** (the only framing this particular
     * peer can decode), and the close reason, which the provider SDK surfaces
     * through `onError` and prints to the browser console.
     */
    private _refuseEnvelopeOnSlotPath(ws: WebSocket, name: string, text: string): boolean {
        const frame = parseObjectFrame(text);
        if (!frame || frame.jsonrpc !== undefined) return false;
        const envelope = decodeEnvelope(text);
        if (!envelope) return false;

        const providerPath = this._options.providerPath ?? "/provider";
        const providersPath = this._options.providersPath ?? "/providers";
        const detail =
            `Provider "${name}" is registered on the slot-scoped path "${providerPath}/${name}", which carries plain JSON-RPC frames, but its first frame is a multiplex envelope ` +
            `(it announced slot "${envelope.provider}"). This is a MultiplexTransport pointed at a DirectTransport URL. Two corrections, either works: ` +
            `use DirectTransport for "${providerPath}/${name}" (plain frames, one slot fixed by the URL), or keep MultiplexTransport and connect it to "${providersPath}" ` +
            `(exact path, envelope framing, slots announced per frame). The connection is being closed; it would otherwise look connected and answer nothing.`;

        console.warn(`[broker] ${detail}`);
        try {
            // Addressed to the slot the peer announced, not to the URL's: that is
            // the name its own decoder will match the envelope against.
            ws.send(encodeErrorEnvelope(envelope.provider, TunnelErrorCodes.ProviderUnavailable, detail));
        } catch {
            /* the socket may already be gone; the log and the close reason stand */
        }
        this._closeWs(ws, 1008, `Envelope frame on slot-scoped path ${providerPath}/${name}: use DirectTransport here, or connect to ${providersPath}`);
        return true;
    }

    /**
     * The mirror image: a `DirectTransport` connected to the shared multiplexed
     * base. Refuses it instead of dropping its frames one by one in silence.
     *
     * Signature of the mistake: the socket opens, the broker never learns a slot
     * name (they only arrive inside envelopes), so no slot is ever claimed and
     * every client is told the provider is not connected, while the provider
     * believes it published successfully.
     *
     * Only a frame that is unambiguously plain JSON-RPC (a JSON object carrying
     * `jsonrpc`, that did not decode as an envelope) closes the socket. Anything
     * else keeps the old behavior of dropping the frame, now with one warning.
     */
    private _refusePlainFrameOnMultiplexPath(ws: WebSocket, text: string): boolean {
        const frame = parseObjectFrame(text);
        if (!frame || frame.jsonrpc === undefined) return false;

        const providerPath = this._options.providerPath ?? "/provider";
        const providersPath = this._options.providersPath ?? "/providers";
        const detail =
            `A provider connected to the multiplexed path "${providersPath}", which carries envelope frames {"provider":"<slot>","payload":{...}}, but sent a plain JSON-RPC frame ` +
            `(method "${String(frame.method ?? "(none)")}"). This is a DirectTransport pointed at a MultiplexTransport URL. Two corrections, either works: ` +
            `use MultiplexTransport for "${providersPath}" (it wraps every frame and announces its slots), or keep DirectTransport and connect it to "${providerPath}/<name>" ` +
            `(the slot comes from the URL there). The connection is being closed; on this path the broker never learns a slot name, so every client would be told the provider is not connected.`;

        console.warn(`[broker] ${detail}`);
        try {
            // A bare JSON-RPC error, matching what this peer speaks: an envelope
            // would be dropped by a DirectTransport exactly the way its own
            // frames are being dropped here.
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: TunnelErrorCodes.ProviderUnavailable, message: detail } }));
        } catch {
            /* the socket may already be gone; the log and the close reason stand */
        }
        this._closeWs(ws, 1008, `Plain JSON-RPC on multiplex path ${providersPath}: use MultiplexTransport here, or connect to ${providerPath}/<name>`);
        return true;
    }

    private _onClientConnect(ws: WebSocket, providerName: string, req: IncomingMessage): void {
        // Carry the principal captured at the upgrade onto the socket, so requests
        // this client makes to `_all` can be scope-filtered.
        const principal = this._pendingClientPrincipals.get(req);
        if (principal) this._pendingClientPrincipals.delete(req);

        if (!this._clientMayReach(providerName, principal ?? null)) {
            this._closeWs(ws, 1008, `Slot "${providerName}" is protected: only its declaring provider may call it`);
            return;
        }

        const state = this._getOrCreateProviderState(providerName);
        state.wsClients.add(ws);
        if (principal) this._clientPrincipals.set(ws, principal);

        ws.on("message", (data: Buffer) => this._routeFromClient(ws, state, providerName, data.toString()));

        ws.on("close", () => {
            state.wsClients.delete(ws);
            for (const [brokerId, entry] of state.pending) {
                if (entry.sink.type === "ws" && entry.sink.socket === ws) state.pending.delete(brokerId);
            }
            void this._subscriptions.removeClient(this._wsClientKey(ws));
        });

        // Same reason as on the provider sockets: an unhandled 'error' event is
        // rethrown by Node, so a single client sending a malformed frame would
        // otherwise kill the broker for everybody.
        ws.on("error", (err: Error) => {
            console.error(`[broker] client socket error on slot "${providerName}": ${err.message}. The socket is being closed; the client should reconnect.`);
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
        this._watchProviderSocket(ws);
        const providerPrincipal = this._pendingProviderPrincipals.get(req);
        if (providerPrincipal) {
            this._pendingProviderPrincipals.delete(req);
            this._providerPrincipals.set(ws, providerPrincipal);
            this._authority.notePrincipal(providerPrincipal);
        }

        // Undecodable frames used to be dropped without a word. The first one is
        // where a DirectTransport on the wrong URL is caught; later ones warn
        // once, because a peer that speaks the wrong dialect speaks it on every
        // frame and must not be allowed to flood the log.
        let firstFrame = true;
        let undecodableWarned = false;

        ws.on("message", (data: Buffer) => {
            const text = data.toString();
            const envelope = decodeEnvelope(text);
            const wasFirstFrame = firstFrame;
            firstFrame = false;

            if (!envelope) {
                if (wasFirstFrame && this._refusePlainFrameOnMultiplexPath(ws, text)) return;
                if (!undecodableWarned) {
                    undecodableWarned = true;
                    const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
                    console.warn(
                        `[broker] multiplexed provider socket sent a frame that is not a tunnel envelope; it was dropped. ` +
                            `This path expects {"provider":"<slot>","payload":{ ...JSON-RPC... }} on every frame. First 200 chars: ${JSON.stringify(preview)}. ` +
                            `Further undecodable frames from this socket are not logged.`
                    );
                }
                return;
            }

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
                        `[broker] WARNING: Multiplexed WebSocket provider "${name}" rejected: a stdio upstream with the same name is already configured. ` +
                            `Rename one of them to avoid the conflict.`
                    );
                    ws.send(encodeErrorEnvelope(name, TunnelErrorCodes.ProviderUnavailable, `Provider "${name}" is managed by a stdio upstream`));
                    return;
                }

                if (this._loopbackProviders.has(name)) {
                    ws.send(encodeErrorEnvelope(name, TunnelErrorCodes.ProviderUnavailable, `Provider "${name}" is reserved by the broker`));
                    return;
                }

                if (!this._authority.mayPublish(name, providerPrincipal ?? null)) {
                    console.warn(`[broker] WARNING: multiplexed WebSocket provider "${name}" rejected: the slot is protected and another principal publishes it.`);
                    ws.send(encodeErrorEnvelope(name, TunnelErrorCodes.RegistrationForbidden, `Slot "${name}" is protected: another principal publishes it`));
                    return;
                }

                const refusal = this._claimSlot(name, ws);
                if (refusal) {
                    // Provider already connected via another socket, reject this
                    // name. The socket itself stays open on purpose: it may be
                    // carrying other slots it is legitimately serving.
                    console.warn(`[broker] WARNING: multiplexed WebSocket provider "${name}" rejected. ${refusal.detail}`);
                    // An envelope has no length limit, so the peer gets the full
                    // diagnosis here, not the close-frame abbreviation.
                    ws.send(encodeErrorEnvelope(name, TunnelErrorCodes.ProviderUnavailable, refusal.detail));
                    return;
                }
                providerNames.add(name);
                const state = this._getOrCreateProviderState(name);
                state.ws = ws;
                state.connectedSinceMs = Date.now();
                this._onProviderAttached(name);
                if (providerPrincipal) {
                    this._logProviderRegistration(providerPrincipal, name, this._slotResourceResolver.resolve(name), true);
                }

                // The multiplexed path could not aggregate at all before this:
                // it had no `addProvider` call anywhere, so the one transport the
                // provider README demonstrates was the one that could never join
                // `_all`. The opt-in rides on the `notifications/register`
                // notification the transport already sends on every open, as
                // `params.aggregate`.
                if (registrationAsksForAggregate(envelope.payload)) {
                    void this._aggregateServer?.addProvider(name);
                }
            }

            const state = this._providers.get(name)!;
            this._routeFromProvider(state, name, envelopeFrame(envelope), {
                kind: "ws",
                principal: providerPrincipal ?? null,
                reply: (frame) => {
                    if (ws.readyState === WebSocket.OPEN) ws.send(encodeEnvelope(name, frame));
                },
            });
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

        // An unhandled 'error' event is rethrown by Node. One multiplex socket
        // carries every slot it announced, so losing the process over a single
        // malformed frame is the worst of the three cases: name the slots this
        // socket was serving, since they are all about to go with it.
        ws.on("error", (err: Error) => {
            const slots = providerNames.size > 0 ? [...providerNames].join(", ") : "(none announced yet)";
            console.error(
                `[broker] multiplex provider socket error: ${err.message}. Slots carried by this socket: ${slots}. The socket is being closed; the provider should reconnect.`
            );
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
        // to scope its catalog/routing, hand it off directly rather than through
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
        if (!this._clientMayReach(this._stdioClientProvider!, null)) {
            // The stdio bridge is anonymous, so it never reaches a protected slot.
            const id = requestIdOf(data);
            if (id !== undefined) {
                this._stdioClientTransport?.send(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id,
                        error: { code: -32001, message: `Slot "${this._stdioClientProvider}" is protected: only its declaring provider may call it.` },
                    })
                );
            }
            return;
        }
        if (this._interceptClientFrame(state, this._stdioClientProvider!, data, { type: "stdio" })) return;
        if (this._isProviderConnected(this._stdioClientProvider!, state)) {
            this._sendToProvider(state, this._stdioClientProvider!, this._trackRequest(state, this._stdioClientProvider!, data, { type: "stdio" }));
        } else {
            let errId: string | number | null = null;
            try {
                errId = (JSON.parse(data) as { id?: string | number }).id ?? null;
            } catch {
                /* */
            }
            if (errId != null) {
                // A stdio host (Claude Desktop) starts the broker and sends
                // `initialize` immediately, long before a browser or engine
                // provider has had a chance to connect, and it treats the failure
                // as a dead server with no retry. So the error names the two slots
                // that exist from the first millisecond instead of just reporting
                // the miss.
                this._stdioClientTransport?.send(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: errId,
                        error: {
                            code: -32000,
                            message:
                                `Provider "${this._stdioClientProvider}" not connected. A stdio host cannot wait for a provider to appear: pin ` +
                                `MCP_BROKER_STDIO_PROVIDER to "_all" (the aggregate slot, present at startup, and it announces tools as providers join) ` +
                                `or to "_broker" (introspection only: broker_info, providers_list, provider_status).`,
                        },
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

        if (this._interceptClientFrame(state, providerName, data, { type: "ws", socket: client })) return;

        if (!this._isProviderConnected(providerName, state)) {
            // Echo the request id and name the slot. With `id: null` a client that
            // correlates by id (every SDK does) drops the frame and then waits for
            // an answer that is never coming, so the symptom of an absent provider
            // was an indefinite hang rather than an error. The pointer to
            // `providers_list` is what turns it into something actionable: the
            // usual cause is a slot name that does not match the one the provider
            // registered.
            client.send(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: requestIdOf(data) ?? null,
                    error: {
                        code: -32000,
                        message: `Provider "${providerName}" is not connected. Call providers_list on the _broker slot to see which slots are live.`,
                    },
                })
            );
            return;
        }

        // Registered only once the frame is actually on its way out: an entry
        // added before the connectivity check has nothing to answer it and would
        // pin that id until the slot next disconnects.
        this._sendToProvider(state, providerName, this._trackRequest(state, providerName, data, { type: "ws", socket: client }, principal), principal);
    }

    private _routeFromProvider(state: IProviderState, providerName: string, data: string, origin: IProviderFrameOrigin): void {
        try {
            const msg = JSON.parse(data) as { id?: string | number; method?: unknown; params?: unknown };

            if (typeof msg.method === "string" && msg.method.startsWith(BROKER_METHOD_PREFIX)) {
                // Addressed to the broker itself, never relayed. Checked before
                // the id lookup: a `broker/*` request carries an id of the
                // provider's choosing, which must not be taken for a response.
                this._answerBrokerMethod(state, providerName, msg.id, msg.method, msg.params, origin);
            } else if (msg.id != null && typeof msg.method === "string") {
                // A request the provider opened itself: a response never
                // carries `method`. Answered here, at once, because nothing
                // downstream will: see `_answerProviderRequest`.
                this._answerProviderRequest(providerName, msg.id, msg.method, origin);
            } else if (msg.id != null) {
                // Response: route to the specific sink that made the request, and
                // put the client's own id back in place of the broker's before it
                // is delivered (see `_trackRequest`).
                const entry = state.pending.get(msg.id);
                if (entry) {
                    state.pending.delete(msg.id);
                    this._authority.releaseRef(entry.callerRef);
                    (msg as { id: unknown }).id = entry.clientId;
                    this._deliverToSink(state, entry.sink, JSON.stringify(msg));
                } else {
                    this._warnUnmatchedResponseId(providerName, msg.id);
                }
            } else if ((msg as { method?: unknown }).method === "notifications/resources/updated") {
                // Addressed: only the sessions subscribed to that URI get it.
                this._routeResourceUpdated(state, providerName, msg as { params?: unknown }, data);
            } else {
                // Notification (no id): broadcast to all clients of this provider.
                this._broadcast(state, providerName, data);
            }
        } catch {
            // The frame could not be parsed and routed as JSON-RPC. It is still
            // broadcast, because some providers legitimately put non-JSON-RPC text
            // on this socket and silently dropping it would be a behavior change,
            // but it no longer travels unannounced: the usual source is a reverse
            // proxy answering with an HTML error page under a 200, which then
            // surfaces in every client as an "unexpected token <" with nothing
            // naming the provider it came from.
            if (!this._nonJsonWarnedProviders.has(providerName)) {
                this._nonJsonWarnedProviders.add(providerName);
                const preview = data.length > 200 ? `${data.slice(0, 200)}...` : data;
                console.warn(
                    `[broker] provider "${providerName}" sent a frame the broker could not route as JSON-RPC; it is being broadcast to that slot's clients verbatim. ` +
                        `First 200 chars: ${JSON.stringify(preview)}. If this is HTML, something between the broker and the provider (a proxy, a login page) is answering instead of the provider. ` +
                        `Further such frames from this slot are not logged.`
                );
            }
            this._broadcast(state, providerName, data);
        }
    }

    /**
     * Serves one `broker/*` frame from a provider, and answers a request on
     * the channel it came from, at once.
     *
     * A notification gets no answer (there is nothing to answer it with); the
     * ones a later release defines are dropped here with one warning.
     */
    private _answerBrokerMethod(state: IProviderState, providerName: string, id: string | number | undefined, method: string, params: unknown, origin: IProviderFrameOrigin): void {
        if (id === undefined || id === null) {
            // Keyed by slot alone: a provider inventing method names must not
            // grow this set without bound.
            if (!this._brokerNotificationWarnedProviders.has(providerName)) {
                this._brokerNotificationWarnedProviders.add(providerName);
                console.warn(
                    `[broker] provider "${providerName}" sent the notification "${method}", which this broker does not handle; dropped. Further ones from this slot are not logged.`
                );
            }
            return;
        }
        const outcome =
            origin.kind === "upstream"
                ? { error: { code: -32601, message: `Method not found: ${method} is not available to a stdio or remote upstream, which has no provider identity.` } }
                : this._brokerMethod(state, providerName, method, params, origin.principal);
        const reply = "result" in outcome ? { jsonrpc: "2.0", id, result: outcome.result } : { jsonrpc: "2.0", id, error: outcome.error };
        origin.reply(JSON.stringify(reply));
    }

    /**
     * Runs one `broker/*` method for the provider serving `providerName`.
     *
     * Only a provider with an identity can use them: a WebSocket provider
     * (authenticated or not; anonymity is refused further in) or a loopback.
     * An upstream the broker spawned or dialed has none, so it is refused.
     */
    private _brokerMethod(
        state: IProviderState,
        providerName: string,
        method: string,
        params: unknown,
        principal: IProviderPrincipal | null = this._providerPrincipalOfSlot(providerName, state)
    ): BrokerMethodOutcome {
        if (this._upstreams.get(providerName)?.isOpen) {
            return { error: { code: -32601, message: `Method not found: ${method} is not available to a stdio or remote upstream, which has no provider identity.` } };
        }
        const origin = { slot: providerName, principal };
        switch (method) {
            case BROKER_DECLARE_METHOD:
                return this._authority.declare(params, origin);
            case BROKER_AUTHORIZE_METHOD:
                return this._authority.authorize(params, origin, (slot, brokerId) => this._providers.get(slot)?.pending.has(brokerId) ?? false);
            default:
                return { error: { code: -32601, message: `Method not found: ${method}. The broker answers ${BROKER_DECLARE_METHOD} and ${BROKER_AUTHORIZE_METHOD}.` } };
        }
    }

    /**
     * Answers, immediately, a request the provider opened itself.
     *
     * The broker relays no **server-to-client** request (`sampling/createMessage`,
     * `roots/list`, `elicitation/create`): it cannot tell which of the slot's
     * clients should answer. These frames used to be taken for responses, found
     * no pending entry, and were dropped, so the provider waited for an answer
     * that never came, at best until its own timeout. A provider that has to
     * time out to learn "no" holds the request, and whatever it guards, for the
     * whole timeout; under load that is what stops a provider from scaling. So
     * the answer is a JSON-RPC error, sent back on the socket (or envelope, or
     * loopback, or upstream) the request came from, with its id unchanged.
     *
     * `ping` is the one exception: it checks the link to the next hop, and the
     * broker is that hop, so it answers `{}` itself.
     */
    private _answerProviderRequest(providerName: string, id: string | number, method: string, origin: IProviderFrameOrigin): void {
        if (method === "ping") {
            origin.reply(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
            return;
        }

        origin.reply(
            JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: `Method not found: the broker does not relay requests opened by a provider (${method})` },
            })
        );

        if (this._providerRequestWarnedProviders.has(providerName)) return;
        this._providerRequestWarnedProviders.add(providerName);
        console.warn(
            `[broker] provider "${providerName}" opened a request of its own (${method}); the broker does not relay provider-initiated requests to clients, ` +
                `and answered -32601 at once. Further such requests from this slot are answered the same way without being logged.`
        );
    }

    /**
     * Reports a response carrying an id nothing is waiting for: the provider did
     * not echo the id it was given, or answered after the request deadline. The
     * frame is unroutable and dropped; the real client hangs until the deadline.
     * Requests the provider opens itself carry `method` and never get here
     * (see {@link _answerProviderRequest}).
     *
     * Once per slot: a provider doing this does it on every frame.
     */
    private _warnUnmatchedResponseId(providerName: string, id: string | number): void {
        if (this._unmatchedIdWarnedProviders.has(providerName)) return;
        this._unmatchedIdWarnedProviders.add(providerName);
        console.warn(
            `[broker] provider "${providerName}" sent a response with id ${JSON.stringify(id)}, which matches no request the broker is waiting on; it was dropped. ` +
                `Either the provider answered with a different id than the one it received (JSON-RPC requires echoing it verbatim, including its type: 1 and "1" are not the same id), ` +
                `or it answered after the request deadline (providerRequestTimeoutMs). ` +
                `Further unmatched ids from this slot are not logged.`
        );
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
        for (const session of state.httpSessions.values()) {
            // The principal rides on the session here rather than in a WeakMap
            // keyed by the response: a Streamable HTTP session spans many HTTP
            // exchanges, so there is no single response to hang it on.
            if (this._authorizeMcpFrame(providerName, data, session.principal)) {
                session.transport.send(data);
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
        state.connectedSinceMs = null;
        this._subscriptions.providerDisconnected(name);
        this._emitProviderChanged(name);
        // Echoing the **client's** id rather than `null` or the broker's: a
        // Streamable HTTP session matches the answer to its held-open POST by
        // the id it chose, so an unaddressed error would leave that request
        // hanging until it times out.
        for (const entry of state.pending.values()) {
            const error = JSON.stringify({
                jsonrpc: "2.0",
                id: entry.clientId,
                error: { code: -32000, message: `Provider "${name}" disconnected` },
            });
            this._deliverToSink(state, entry.sink, error);
        }
        state.pending.clear();
        for (const ic of state.internalClients) ic.onClose?.();
    }

    // -------------------------------------------------------------------------
    // Provider state helpers
    // -------------------------------------------------------------------------

    /**
     * Returns `true` if the provider is reachable, via a WebSocket connection,
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
                connectedSinceMs: null,
                pending: new Map(),
                sseSessions: new Map(),
                httpSessions: new Map(),
                wsClients: new Set(),
                internalClients: new Set(),
                httpEndpoint: null,
            };
            this._providers.set(name, state);
            this._emitProviderChanged(name);
        }
        return state;
    }

    // -------------------------------------------------------------------------
    // Resource subscriptions
    // -------------------------------------------------------------------------

    /** The {@link ClientKey} of a raw WS client socket. */
    private _wsClientKey(ws: WebSocket): ClientKey {
        let id = this._wsClientIds.get(ws);
        if (id === undefined) {
            id = this._nextWsClientId++;
            this._wsClientIds.set(ws, id);
        }
        return `ws:${id}`;
    }

    /** The {@link ClientKey} of a sink that is a client, `null` for the broker's own and internal sinks. */
    private _clientKeyOf(sink: ResponseSink): ClientKey | null {
        switch (sink.type) {
            case "ws":
                return this._wsClientKey(sink.socket);
            case "sse":
                return `sse:${sink.sessionId}`;
            case "http-session":
                return `http:${sink.sessionId}`;
            case "stdio":
                return STDIO_CLIENT_KEY;
            case "internal":
                return this._internalClientKey(sink.client);
            default:
                return null;
        }
    }

    /** The {@link ClientKey} of an in-process client from {@link openInternalClient}. */
    private _internalClientKey(client: IInternalClient): ClientKey {
        let id = this._internalClientIds.get(client);
        if (id === undefined) {
            id = this._nextInternalClientId++;
            this._internalClientIds.set(client, id);
        }
        return `internal:${id}`;
    }

    /** The principal behind a client sink, for the per-notification policy check. */
    private _principalOfSink(state: IProviderState, sink: ResponseSink): IPrincipal | null {
        switch (sink.type) {
            case "ws":
                return this._clientPrincipals.get(sink.socket) ?? null;
            case "sse": {
                const res = state.sseSessions.get(sink.sessionId);
                return res ? (this._streamPrincipals.get(res) ?? null) : null;
            }
            case "http-session":
                return state.httpSessions.get(sink.sessionId)?.principal ?? null;
            default:
                return null;
        }
    }

    /**
     * Answers `resources/subscribe` and `resources/unsubscribe` from the
     * broker's own registry instead of relaying them. Returns `true` when the
     * frame was one of those and has been (or will be) answered.
     *
     * Also remembers the last `initialize` of the slot, for {@link _replaySubscriptions}.
     *
     * Runs after the policy check. `resources/unsubscribe` is not classified,
     * so it is never refused: a client whose read grant was revoked must
     * still be able to drop what it holds. `_all` is skipped: it serves tools
     * and prompts only, and answers resources methods with `-32601` itself.
     */
    private _interceptClientFrame(state: IProviderState, providerName: string, frame: string, sink: ResponseSink): boolean {
        // A cheap guard before parsing: almost every frame is neither.
        if (!frame.includes('"resources/') && !frame.includes('"initialize"')) return false;
        const msg = parseObjectFrame(frame);
        if (!msg) return false;
        if (msg.method === "initialize") {
            state.lastInitializeParams = msg.params;
            return false;
        }
        if (msg.method !== "resources/subscribe" && msg.method !== "resources/unsubscribe") return false;
        if (providerName === AggregateServer.SLOT) return false;
        const id = msg.id;
        if (typeof id !== "string" && typeof id !== "number") return false;
        const client = this._clientKeyOf(sink);
        if (!client) return false;

        const answer = (outcome: SubscriptionOutcome): void => {
            const reply = outcome.ok ? { jsonrpc: "2.0", id, result: {} } : { jsonrpc: "2.0", id, error: outcome.error };
            this._deliverToSink(state, sink, JSON.stringify(reply));
        };
        const uri = (msg.params as { uri?: unknown } | undefined)?.uri;
        if (typeof uri !== "string" || uri.length === 0) {
            answer({ ok: false, error: { code: -32602, message: "Missing required parameter: uri" } });
            return true;
        }

        const pending =
            msg.method === "resources/subscribe" ? this._subscriptions.subscribe(providerName, client, sink, uri) : this._subscriptions.unsubscribe(providerName, client, uri);
        void pending.then(answer, (error: unknown) => answer({ ok: false, error: { code: -32603, message: `Subscription failed: ${(error as Error).message}` } }));
        return true;
    }

    /**
     * Sends one aggregated `resources/subscribe` or `resources/unsubscribe` to
     * the provider behind `slot` and resolves with its answer. Never rejects:
     * a disconnect or a timeout arrives as an error answer through the same
     * pending-request machinery every client request uses.
     */
    private _subscriptionRequest(slot: string, method: "resources/subscribe" | "resources/unsubscribe", uri: string): Promise<SubscriptionOutcome> {
        return this._brokerRequest(slot, method, { uri }).then((reply) => (reply.error ? { ok: false, error: reply.error } : { ok: true }));
    }

    /** Sends a request of the broker's own to a provider and resolves with the parsed answer. */
    private _brokerRequest(slot: string, method: string, params: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
        const state = this._providers.get(slot);
        if (!state || !this._isProviderConnected(slot, state)) {
            return Promise.resolve({ error: { code: -32000, message: `Provider "${slot}" not connected` } });
        }
        return new Promise((resolve) => {
            const sink: ResponseSink = {
                type: "broker",
                resolve: (frame) => {
                    const reply = parseObjectFrame(frame) as { result?: unknown; error?: { code: number; message: string } } | undefined;
                    resolve(reply ?? { error: { code: -32700, message: "Unparseable answer" } });
                },
            };
            this._sendToProvider(state, slot, this._trackRequest(state, slot, JSON.stringify({ jsonrpc: "2.0", id: 0, method, params }), sink));
        });
    }

    /**
     * Delivers a provider's `notifications/resources/updated` to the sessions
     * subscribed to its URI, and to nobody else.
     *
     * A frame without a usable URI is dropped, never broadcast: there is no
     * safe audience for it. Each recipient is re-checked against the policy,
     * because a grant can be revoked after the subscription was accepted; a
     * recipient that fails the check is unsubscribed as well as skipped.
     */
    private _routeResourceUpdated(state: IProviderState, providerName: string, msg: { params?: unknown }, data: string): void {
        const uri = (msg.params as { uri?: unknown } | undefined)?.uri;
        if (typeof uri !== "string" || uri.length === 0 || uri.length > this._subscriptions.limits.maxResourceUriLength) {
            if (!this._invalidUpdateWarnedProviders.has(providerName)) {
                this._invalidUpdateWarnedProviders.add(providerName);
                console.warn(
                    `[broker] provider "${providerName}" sent notifications/resources/updated without a usable params.uri; it was dropped, not broadcast. ` +
                        `The notification must name the one URI that changed, as a string of at most ${this._subscriptions.limits.maxResourceUriLength} characters. Further such frames from this slot are not logged.`
                );
            }
            return;
        }
        this._deliverResourceUpdated(state, providerName, uri, data);
    }

    private _deliverResourceUpdated(state: IProviderState, providerName: string, uri: string, data: string): void {
        for (const { client, sink } of this._subscriptions.subscribers(providerName, uri)) {
            // The stdio bridge and in-process clients are unchecked on every
            // path, this one included: neither carries a principal.
            if (sink.type !== "stdio" && sink.type !== "internal" && !this._authorizeMcpFrame(providerName, data, this._principalOfSink(state, sink))) {
                void this._subscriptions.unsubscribe(providerName, client, uri);
                continue;
            }
            this._deliverToSink(state, sink, data);
        }
    }

    /** A provider now serves `name`: announce it, and restore the subscriptions it should hold. */
    private _onProviderAttached(name: string): void {
        this._emitProviderChanged(name);
        if (this._subscriptions.hasSubscriptions(name)) {
            void this._replaySubscriptions(name).catch((error: unknown) => {
                console.error(`[broker] provider "${name}": restoring resource subscriptions failed: ${(error as Error).message}`);
            });
        }
    }

    /**
     * Re-subscribes a provider that (re)attached to URIs clients still hold,
     * once per URI.
     *
     * The provider is handshaken first, with the last `initialize` a client
     * sent on this slot, because a fresh provider has no session: requests
     * before `initialize` break the MCP lifecycle, and an mcp-core server
     * suppresses its list_changed notifications until it sees
     * `notifications/initialized`.
     *
     * Every subscriber then gets one `notifications/resources/updated`: the
     * content may have changed while nobody was watching, so a re-read is due.
     * Where the new provider refuses a URI, that is also what tells its
     * subscribers, since their re-read fails; their subscription is dropped.
     */
    private async _replaySubscriptions(name: string): Promise<void> {
        const params = this._providers.get(name)?.lastInitializeParams ?? {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: this.name, version: this.version },
        };
        const init = await this._brokerRequest(name, "initialize", params);
        if (init.error) {
            console.warn(`[broker] provider "${name}" refused the initialize sent before restoring subscriptions: ${init.error.message}. Subscriptions are restored anyway.`);
        } else {
            const state = this._providers.get(name);
            if (state) this._sendToProvider(state, name, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
        }

        const state = this._providers.get(name);
        for (const result of await this._subscriptions.replay(name)) {
            if (!result.outcome.ok) {
                console.warn(
                    `[broker] provider "${name}" refused to restore the subscription to "${result.uri}" after reconnecting: ${result.outcome.error.message}. ` +
                        `Its ${result.subscribers.length} subscriber(s) were dropped and told to re-read.`
                );
            }
            if (!state) continue;
            const data = JSON.stringify({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: result.uri } });
            for (const { sink } of result.subscribers) this._deliverToSink(state, sink, data);
        }
    }

    /**
     * Queues `name` for the next {@link onProvidersChanged} batch. Batched per
     * tick, so a multiplexed socket announcing ten slots, or a slot attaching
     * and joining `_all` in the same breath, produces one notification.
     */
    private _emitProviderChanged(name: string): void {
        this._changedSlots.add(name);
        if (this._changedSlotsTimer) return;
        this._changedSlotsTimer = setTimeout(() => {
            this._changedSlotsTimer = null;
            const names = [...this._changedSlots];
            this._changedSlots.clear();
            if (names.length > 0) this._providersChanged.emit(names);
        }, 0);
        this._changedSlotsTimer.unref?.();
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
