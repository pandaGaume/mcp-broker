/**
 * Common contract for an upstream MCP server bound to a provider slot.
 *
 * The broker treats every upstream the same way: it muxes the slot's clients
 * onto the single upstream connection, regardless of the underlying transport.
 *
 * Implementations:
 * - `StdioUpstream`  — a local child process (newline-delimited JSON-RPC over stdio).
 * - `RemoteUpstream` — a remote MCP server reached by URL (Streamable HTTP / SSE / WebSocket).
 *
 * `StdioUpstream` is reused as-is by the future `.mcpb` bundle loader: a bundle
 * is a local server whose `mcp_config` maps directly onto a stdio upstream.
 */
export interface Upstream {
    /** Provider slot name this upstream is bound to. */
    readonly name: string;
    /** Whether the upstream connection is currently usable. */
    readonly isOpen: boolean;
    /** Receives one complete JSON-RPC message from the upstream server. */
    onMessage: ((data: string) => void) | null;
    /** Fires once the upstream connection is established and ready to send. */
    onOpen: (() => void) | null;
    /** Fires when the upstream connection closes. */
    onClose: (() => void) | null;
    /** Fires on a connection or runtime error. */
    onError: ((error: Error) => void) | null;
    /** Opens the upstream connection. */
    connect(): void;
    /** Sends one JSON-RPC message to the upstream server. */
    send(data: string): void;
    /** Closes the upstream connection. */
    close(): void;
}
