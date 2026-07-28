/**
 * Streamable HTTP helpers for the broker's HTTP tests.
 *
 * The `/<slot>/mcp` endpoint is served by mcp-core's `StreamableHttpEndpoint`,
 * which runs the transport's real state machine: `initialize` opens a session
 * and every later request must name it in `Mcp-Session-Id`. A test can no
 * longer POST a bare frame and expect it to reach the provider, so these
 * helpers do the handshake.
 */

const INITIALIZE = JSON.stringify({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "broker-tests", version: "0" },
    },
});

/**
 * Opens a session on `<base>/<slot>/mcp`.
 *
 * The handshake succeeds even with nothing behind the slot: the session belongs
 * to the broker, and the JSON-RPC error about the missing provider travels
 * inside it. `sessionId` is `null` when the request never got that far, which is
 * what a caller asserting a `401` or `403` wants back.
 */
export async function openSession(base: string, slot: string, headers: Readonly<Record<string, string>> = {}): Promise<{ sessionId: string | null; response: Response }> {
    const response = await fetch(`${base}/${slot}/mcp`, { method: "POST", headers: { ...headers }, body: INITIALIZE });
    return { sessionId: response.headers.get("mcp-session-id"), response };
}

/** POSTs one frame on an already-open session. */
export function sessionPost(base: string, slot: string, sessionId: string, body: string, headers: Readonly<Record<string, string>> = {}): Promise<Response> {
    return fetch(`${base}/${slot}/mcp`, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": sessionId },
        body,
    });
}

/**
 * Handshake plus one frame, for a test that only needs a single exchange.
 *
 * When the handshake itself is refused, its response is handed back untouched
 * rather than masked by a second request that could not have been sent.
 */
export async function mcpCall(base: string, slot: string, body: string, headers: Readonly<Record<string, string>> = {}): Promise<Response> {
    const { sessionId, response } = await openSession(base, slot, headers);
    if (!sessionId) return response;
    return sessionPost(base, slot, sessionId, body, headers);
}
