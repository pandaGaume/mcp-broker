/**
 * Read-only view of the broker's runtime state, exposed to broker behaviors.
 *
 * Decouples the behaviors from the concrete `WsTunnel` class, making them
 * unit-testable and reusable (e.g. a future .NET-backed context).
 */
export interface BrokerContext {
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
    getProvidersInfo(): BrokerProviderInfo[];

    /** Snapshot of a single provider slot, or `undefined` if the name is unknown. */
    getProviderInfo(name: string): BrokerProviderInfo | undefined;
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

export interface BrokerProviderInfo {
    /** Slot name as advertised on `/<name>/...` endpoints. */
    name: string;

    /** Which transport is currently feeding the slot. */
    transport: BrokerProviderTransport;

    /** `true` iff the slot is reachable for routing right now. */
    connected: boolean;

    /** Number of raw-WebSocket MCP clients on this slot. */
    clientCount: number;

    /** Number of long-lived sessions (SSE + Streamable HTTP GET streams). */
    sessionCount: number;

    /** Number of in-flight JSON-RPC requests awaiting a response. */
    pendingCount: number;
}
