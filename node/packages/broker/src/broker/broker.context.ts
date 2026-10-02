import type { IBrokerAuthorityInfo } from "../authority/broker.authority";
import type { IEventSource } from "@cyanmycelium/mcp-core";
import type { IProviderTelemetryStats } from "../telemetry/telemetry.types";

/**
 * Read-only view of the broker's runtime state, exposed to broker behaviors.
 *
 * Decouples the behaviors from the concrete `WsTunnel` class, making them
 * unit-testable and reusable (e.g. a future .NET-backed context).
 */
export interface IBrokerContext {
    /** Package version (from package.json). */
    readonly version: string;

    /** Logical broker name reported to MCP clients. */
    readonly name: string;

    /** Timestamp of the most recent successful `start()`, or `null` if never started. */
    readonly startedAt: Date | null;

    /** Seconds since `startedAt`, or `0` if not running. */
    readonly uptimeSeconds: number;

    /** Bind host. `undefined` means default (`0.0.0.0`). */
    readonly host: string | undefined;

    /** TCP port the broker is listening on. */
    readonly port: number;

    /** Whether TLS is active for the HTTP/WS server. */
    readonly tls: boolean;

    /** All configured URL paths, with defaults already substituted. */
    readonly paths: {
        provider: string;
        providers: string;
        client: string;
        mcp: string;
        sse: string;
        messages: string;
    };

    /** Snapshot of every known provider slot, including disconnected ones. */
    getProvidersInfo(): IBrokerProviderInfo[];

    /** Snapshot of a single provider slot, or `undefined` if the name is unknown. */
    getProviderInfo(name: string): IBrokerProviderInfo | undefined;

    // -------------------------------------------------------------------------
    // Optional diagnostic surface
    //
    // Every accessor below is optional on purpose. The three members above are
    // what a context has always had to provide, and making any of these
    // mandatory would break every existing implementation (including the
    // hand-written stubs in the test suite) for a purely additive feature.
    //
    // `broker_diagnose` treats an absent accessor as "this check cannot run
    // here" and reports it as skipped, rather than guessing. Implement them to
    // light up the corresponding rules.
    // -------------------------------------------------------------------------

    /**
     * Membership of the reserved `_all` aggregate slot, or `undefined` when the
     * host cannot report it. Lets a diagnosis distinguish "the aggregate is
     * empty because nobody opted in" from "the aggregate is disabled".
     */
    getAggregateInfo?(): IBrokerAggregateInfo | undefined;

    /**
     * Security posture of the listening surface, or `undefined` when the host
     * cannot report it. Lets a diagnosis catch the combination that produces a
     * `403 invalid_origin` on a page the broker itself serves.
     */
    getSecurityInfo?(): IBrokerSecurityInfo | undefined;

    /**
     * Slot the stdio bridge is pinned to (`MCP_BROKER_STDIO_PROVIDER` /
     * `withStdioClient`), `null` when no bridge is configured, or `undefined`
     * when the host cannot report it. Lets a diagnosis catch a bridge pinned to
     * a slot that cannot exist at host start.
     */
    getStdioBridgeTarget?(): string | null | undefined;

    /**
     * Declarations, protected slots and live caller references, or `undefined`
     * when the host cannot report them. Lets a diagnosis catch a protected slot
     * nobody confirmed and a policy granting capabilities nobody declared.
     */
    getAuthorityInfo?(): IBrokerAuthorityInfo | undefined;

    /** `true` when execution limits are configured; `broker_limits_release` exists only then. */
    readonly limitsEnabled?: boolean;

    /** Releases the limit slots a call still holds, on behalf of `by`. `false` when no such call is held. */
    releaseLimitCall?(slot: string, requestId: string, by: readonly string[]): boolean;

    /** Bounded provider telemetry counters, or `undefined` when unsupported. */
    getTelemetryStats?(): IProviderTelemetryStats | undefined;

    /**
     * Fires with the names of the slots whose *state* changed: a slot
     * appeared, a provider attached or detached, a slot joined or left `_all`.
     * Changes in the same tick arrive as one batch.
     *
     * Counters (`pendingCount`, `clientCount`, `sessionCount`) deliberately do
     * not fire it: reading a resource moves them, so notifying on them would
     * make every read trigger the next notification. They stay readable on
     * demand. `_broker` turns this into `notifications/resources/updated` on
     * `broker://providers` and `broker://providers/<name>`.
     */
    readonly onProvidersChanged?: IEventSource<readonly string[]>;
}

/**
 * Membership snapshot of the reserved `_all` aggregate slot.
 *
 * `providers` lists the slot names currently contributing tools and prompts,
 * which normally includes `_broker`. It is not the same set as "connected
 * slots": a provider is in `_all` only if it opted in.
 */
export interface IBrokerAggregateInfo {
    /** `false` when the aggregate slot was disabled at construction. */
    enabled: boolean;

    /** Slot names currently contributing to the aggregate. */
    providers: readonly string[];
}

/** What the broker enforces on its listening surface right now. */
export interface IBrokerSecurityInfo {
    /** `true` when at least one browser origin is allowed on `/<slot>/mcp`. */
    allowedOriginsConfigured: boolean;

    /** `true` when clients must present an OAuth 2.1 bearer token. */
    clientAuthEnabled: boolean;

    /** `true` when providers must authenticate at the WebSocket upgrade. */
    providerAuthEnabled: boolean;

    /** URL prefixes served as static files, e.g. `["/bundle", "/"]`. */
    staticMountPrefixes: readonly string[];
}

/**
 * Transport kind currently feeding a provider slot.
 *
 * - `ws`: dedicated WebSocket provider (`/provider/<name>`).
 * - `ws-multiplex`: multiplexed WebSocket envelope on `/providers`.
 * - `stdio`: child process spawned at broker startup.
 * - `loopback`: in-process transport (e.g. the broker exposing itself as `_broker`).
 * - `none`: the slot was referenced by a client but no provider has attached yet.
 */
export type BrokerProviderTransport = "ws" | "ws-multiplex" | "stdio" | "loopback" | "none";

export interface IBrokerProviderInfo {
    /** Slot name as advertised on `/<name>/...` endpoints. */
    name: string;

    /** Which transport is currently feeding the slot. */
    transport: BrokerProviderTransport;

    /** `true` iff the slot is reachable for routing right now. */
    connected: boolean;

    /**
     * `true` when the provider is a member of the `_all` aggregate right now:
     * it opted in and its `initialize` went through. The other side of
     * {@link IBrokerAggregateInfo.providers}, per slot.
     */
    aggregate: boolean;

    /**
     * When the provider now serving the slot attached, ISO-8601; `null`
     * while nothing serves it. Survives nothing: a reconnection is a new
     * date, which is the point (a slot that says "since 3 s ago" every time
     * you look is flapping).
     */
    connectedSince: string | null;

    /** Milliseconds since `connectedSince`, computed at the time of the call; `null` when disconnected. */
    connectedForMs: number | null;

    /**
     * Number of raw-WebSocket MCP clients on this slot. Clients, not the
     * provider: a connected provider nobody is calling reads
     * `clientCount: 0, sessionCount: 0, pendingCount: 0`.
     */
    clientCount: number;

    /** Number of long-lived sessions (SSE + Streamable HTTP GET streams). */
    sessionCount: number;

    /** Number of in-flight JSON-RPC requests awaiting a response. */
    pendingCount: number;

    /**
     * Client/URI pairs held by `resources/subscribe` on this slot. A number
     * that only grows is the signature of Streamable HTTP clients leaving
     * without `DELETE`: their sessions, and so their subscriptions, never
     * expire. Optional so hand-written contexts keep compiling.
     */
    resourceSubscriptionCount?: number;
}

/** @deprecated Use {@link IBrokerContext}. */
export type BrokerContext = IBrokerContext;

/** @deprecated Use {@link IBrokerProviderInfo}. */
export type BrokerProviderInfo = IBrokerProviderInfo;
