/**
 * A minimal MCP client over Streamable HTTP, in ~90 lines of `fetch`.
 *
 * Enough to prove a slot end to end: `initialize`, then any request. It exists
 * so the samples can verify themselves without pulling an SDK in, and so the
 * exact wire shape a broker slot expects is visible in one readable file.
 *
 * Three things about `/<slot>/mcp` that are easy to get wrong:
 *
 * 1. `initialize` opens a SESSION. The broker answers with an `Mcp-Session-Id`
 *    header, and every later request on that slot must send it back. Posting a
 *    second frame without it starts a new session that knows nothing.
 * 2. `Accept` must list BOTH `application/json` and `text/event-stream`. The
 *    endpoint picks the response framing; a client that accepts only one gets
 *    refused for the other.
 * 3. A response body may be plain JSON or a one-event SSE stream. `readFrame`
 *    below handles both, because which one you get is not yours to choose.
 *
 * From Node there is no `Origin` header, so `allowedOrigins` never applies:
 * that check exists for browsers only. From a page it applies to every request,
 * including one served by the broker itself. See browser-provider/README.md.
 */

/** Protocol revision these samples negotiate. */
export const PROTOCOL_VERSION = "2025-06-18";

/**
 * Opens a session on `<baseUrl>/<slot>/mcp` and returns a client bound to it.
 *
 * @param {string} baseUrl e.g. "http://localhost:3000"
 * @param {string} slot    Provider slot name, or a reserved slot ("_all", "_broker").
 * @param {object} [options]
 * @param {Record<string,string>} [options.headers] Extra headers, e.g. Authorization.
 */
export async function connectMcp(baseUrl, slot, options = {}) {
    const endpoint = `${baseUrl.replace(/\/$/, "")}/${slot}/mcp`;
    const extra = options.headers ?? {};

    const post = async (body, sessionId) => {
        const headers = {
            "Content-Type": "application/json",
            // Both, always. See note 2 above.
            Accept: "application/json, text/event-stream",
            ...extra,
        };
        if (sessionId) headers["Mcp-Session-Id"] = sessionId;

        const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`${endpoint} answered HTTP ${response.status} ${response.statusText}. ${text.slice(0, 400)}`);
        }
        return response;
    };

    const initResponse = await post(
        {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: "mcp-broker-samples", version: "0" },
            },
        },
        null
    );

    const sessionId = initResponse.headers.get("mcp-session-id");
    const initResult = await readFrame(initResponse);
    if (initResult?.error) {
        throw new Error(`initialize on slot "${slot}" was refused: ${initResult.error.message} (code ${initResult.error.code}).`);
    }

    let nextId = 2;

    /** Sends one JSON-RPC request on the open session and returns its result. */
    const request = async (method, params) => {
        const response = await post({ jsonrpc: "2.0", id: nextId++, method, params }, sessionId);
        const frame = await readFrame(response);
        if (frame?.error) {
            const err = new Error(`${method} on slot "${slot}" failed: ${frame.error.message} (code ${frame.error.code}).`);
            err.rpc = frame.error;
            throw err;
        }
        return frame?.result;
    };

    return {
        endpoint,
        slot,
        sessionId,
        serverInfo: initResult?.result?.serverInfo,
        request,
        listTools: () => request("tools/list", {}),
        callTool: (name, args = {}) => request("tools/call", { name, arguments: args }),
        /** Ends the session. The broker frees it; skipping this only leaks a session. */
        close: () =>
            fetch(endpoint, { method: "DELETE", headers: sessionId ? { "Mcp-Session-Id": sessionId, ...extra } : extra }).catch(() => undefined),
    };
}

/**
 * Reads one JSON-RPC frame out of a Streamable HTTP response, whichever framing
 * the endpoint chose.
 *
 * `application/json` is the body itself. `text/event-stream` is one or more
 * `data:` lines; the first frame carrying an `id` is the answer to the request
 * just sent, and anything before it is a notification.
 */
export async function readFrame(response) {
    const text = await response.text();
    if (!text.trim()) return undefined;

    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) {
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`Expected JSON from ${response.url} but got ${type || "no content-type"}: ${text.slice(0, 300)}`);
        }
    }

    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        const frame = JSON.parse(payload);
        if (frame.id !== undefined) return frame;
    }
    return undefined;
}

/** Extracts the plain text out of an MCP `tools/call` result. */
export function toolText(result) {
    return (result?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

/** Resolves once `<baseUrl>` answers, or rejects after `timeoutMs`. */
export async function waitForBroker(baseUrl, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = "no attempt made";
    while (Date.now() < deadline) {
        try {
            // Any HTTP answer proves the listener is up; 404 is a fine answer.
            await fetch(`${baseUrl.replace(/\/$/, "")}/_broker/mcp`, { method: "OPTIONS" });
            return;
        } catch (err) {
            lastError = err.message;
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }
    throw new Error(`${baseUrl} did not answer within ${timeoutMs}ms. Last error: ${lastError}. Is the broker running on that port?`);
}
