/**
 * Hand-rolled client transports for reaching a remote MCP server by URL.
 *
 * No `@modelcontextprotocol/sdk` dependency: the broker stays SDK-free, the
 * official SDK is only used outside the broker (in the demo) to prove the
 * broker is implementation-agnostic. Each transport is a thin frame relay ,
 * it does not interpret MCP, it pipes JSON-RPC strings both ways.
 */
import * as http from "node:http";
import * as https from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { WebSocket } from "ws";

/** Lifecycle + callbacks shared by every remote client transport. */
export interface IRemoteTransport {
    onMessage: ((data: string) => void) | null;
    onOpen: (() => void) | null;
    onClose: (() => void) | null;
    onError: ((error: Error) => void) | null;
    connect(): void;
    send(data: string): void;
    close(): void;
}

/** The three supported remote transports. */
export type RemoteTransportKind = "streamable-http" | "sse" | "websocket";

/** Issues an http/https request, picking the module from the URL scheme. */
function makeRequest(url: URL, options: RequestOptions, onResponse: (res: IncomingMessage) => void): ClientRequest {
    return url.protocol === "https:" ? https.request(url, options, onResponse) : http.request(url, options, onResponse);
}

/** First delay before reopening a dropped standalone GET stream. */
const STREAM_REOPEN_BASE_MS = 500;

/** Ceiling for the standalone GET stream reopen backoff. */
const STREAM_REOPEN_MAX_MS = 30_000;

/** Number of doublings applied to {@link STREAM_REOPEN_BASE_MS} before the cap. */
const STREAM_REOPEN_MAX_DOUBLINGS = 6;

/**
 * How long a standalone GET stream must stay up before its drop counts as a
 * one-off rather than a flap. Below this, the backoff keeps growing, so a server
 * that accepts the GET and closes it immediately is not polled twice a second
 * forever.
 */
const STREAM_HEALTHY_MS = 10_000;

/** How much of an unparseable upstream body is echoed into the log. */
const BODY_EXCERPT_LIMIT = 300;

/**
 * Collapses a response body to a single-line, length-capped excerpt. Logging the
 * body is the whole point of the diagnostic (an HTML error page is instantly
 * recognizable), but a full page in a log line is not.
 */
function bodyExcerpt(body: string): string {
    const oneLine = body.replace(/\s+/g, " ").trim();
    return oneLine.length <= BODY_EXCERPT_LIMIT ? oneLine : `${oneLine.slice(0, BODY_EXCERPT_LIMIT)}... (${oneLine.length} chars total)`;
}

/**
 * Incremental Server-Sent-Events decoder. Normalizes line endings, buffers
 * across chunks, and emits one `(event, data)` pair per complete SSE block.
 */
class SseDecoder {
    private _buf = "";

    feed(chunk: string, emit: (event: string, data: string) => void): void {
        this._buf += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        let sep: number;
        while ((sep = this._buf.indexOf("\n\n")) !== -1) {
            const block = this._buf.slice(0, sep);
            this._buf = this._buf.slice(sep + 2);
            let event = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
                if (line.startsWith(":")) continue; // comment
                const colon = line.indexOf(":");
                const field = colon === -1 ? line : line.slice(0, colon);
                let value = colon === -1 ? "" : line.slice(colon + 1);
                if (value.startsWith(" ")) value = value.slice(1);
                if (field === "event") event = value;
                else if (field === "data") data.push(value);
            }
            if (data.length > 0) emit(event, data.join("\n"));
        }
    }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

class WebSocketRemoteTransport implements IRemoteTransport {
    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    private _ws: WebSocket | null = null;

    constructor(
        private readonly _url: string,
        private readonly _headers: Record<string, string>
    ) {}

    connect(): void {
        const ws = new WebSocket(this._url, { headers: this._headers });
        this._ws = ws;
        ws.on("open", () => this.onOpen?.());
        ws.on("message", (data: Buffer) => this.onMessage?.(data.toString("utf8")));
        ws.on("close", () => this.onClose?.());
        ws.on("error", (err: Error) => this.onError?.(err));
    }

    send(data: string): void {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send(data);
    }

    close(): void {
        this._ws?.close();
        this._ws = null;
    }
}

// ---------------------------------------------------------------------------
// Legacy MCP SSE (GET event stream + POST message endpoint)
// ---------------------------------------------------------------------------

class SseRemoteTransport implements IRemoteTransport {
    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    private readonly _decoder = new SseDecoder();
    private _streamReq: ClientRequest | null = null;
    private _postUrl: string | null = null;
    private _closed = false;

    constructor(
        private readonly _url: string,
        private readonly _headers: Record<string, string>
    ) {}

    connect(): void {
        const req = makeRequest(new URL(this._url), { method: "GET", headers: { ...this._headers, Accept: "text/event-stream" } }, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 400) {
                this.onError?.(new Error(`SSE GET responded ${status}`));
                res.resume();
                return;
            }
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => this._decoder.feed(chunk, (ev, data) => this._onEvent(ev, data)));
            res.on("end", () => {
                if (!this._closed) this.onClose?.();
            });
        });
        this._streamReq = req;
        req.on("error", (err: Error) => {
            if (!this._closed) this.onError?.(err);
        });
        req.end();
    }

    private _onEvent(event: string, data: string): void {
        if (event === "endpoint") {
            this._postUrl = new URL(data, this._url).toString();
            this.onOpen?.();
        } else if (event === "message") {
            this.onMessage?.(data);
        }
    }

    send(data: string): void {
        if (!this._postUrl) return;
        const req = makeRequest(new URL(this._postUrl), { method: "POST", headers: { ...this._headers, "Content-Type": "application/json" } }, (res) => res.resume());
        req.on("error", (err: Error) => this.onError?.(err));
        req.end(data);
    }

    close(): void {
        this._closed = true;
        this._streamReq?.destroy();
        this._streamReq = null;
    }
}

// ---------------------------------------------------------------------------
// Streamable HTTP (MCP 2025-03-26)
// ---------------------------------------------------------------------------

class StreamableHttpRemoteTransport implements IRemoteTransport {
    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    private _sessionId: string | null = null;
    private _streamReq: ClientRequest | null = null;
    private _closed = false;
    /** Reopen attempts since the standalone GET stream last stayed up healthily. */
    private _streamAttempt = 0;
    /** Pending reopen timer, `null` when no reopen is scheduled. */
    private _streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
    /** Set once the server says it has no standalone GET stream (405 / 501). */
    private _streamUnsupported = false;

    constructor(
        private readonly _url: string,
        private readonly _headers: Record<string, string>,
        /** Human name of the upstream, used in every diagnostic this class emits. */
        private readonly _label: string
    ) {}

    connect(): void {
        // Streamable HTTP is stateless, there is no connection to open. The
        // transport is usable as soon as connect() is called; the session id
        // is captured later from the first response that carries one.
        this._closed = false;
        this._streamAttempt = 0;
        this._streamUnsupported = false;
        this.onOpen?.();
    }

    send(data: string): void {
        if (this._closed) return;
        const headers: Record<string, string> = {
            ...this._headers,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        };
        if (this._sessionId) headers["Mcp-Session-Id"] = this._sessionId;
        const req = makeRequest(new URL(this._url), { method: "POST", headers }, (res) => this._handleResponse(res));
        req.on("error", (err: Error) => {
            if (!this._closed) this.onError?.(err);
        });
        req.end(data);
    }

    private _handleResponse(res: IncomingMessage): void {
        const sid = res.headers["mcp-session-id"];
        if (typeof sid === "string" && sid.length > 0 && sid !== this._sessionId) {
            this._sessionId = sid;
            this._openServerStream();
        }
        const status = res.statusCode ?? 0;
        if (status === 202) {
            res.resume();
            return;
        }
        if (status >= 400) {
            this.onError?.(new Error(`Streamable HTTP POST responded ${status}`));
            res.resume();
            return;
        }
        res.setEncoding("utf8");
        if (String(res.headers["content-type"] ?? "").includes("text/event-stream")) {
            const decoder = new SseDecoder();
            res.on("data", (chunk: string) =>
                decoder.feed(chunk, (ev, data) => {
                    if (ev === "message") this.onMessage?.(data);
                })
            );
        } else {
            let body = "";
            res.on("data", (chunk: string) => {
                body += chunk;
            });
            res.on("end", () => this._emitJsonBody(body));
        }
    }

    private _emitJsonBody(body: string): void {
        const trimmed = body.trim();
        if (!trimmed) return;
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                for (const message of parsed) this.onMessage?.(JSON.stringify(message));
                return;
            }
        } catch {
            // Not JSON at all. In practice this is a reverse proxy or gateway
            // answering in place of the MCP server, classically an HTML error
            // page served with status 200. The body is still forwarded verbatim
            // so the client fails fast instead of hanging, but it has to be named
            // here: otherwise the only symptom is an "unexpected token <" on the
            // client with nothing saying which upstream produced it.
            console.error(
                `[broker] upstream "${this._label}": ${this._url} answered a POST with a body that is not JSON. Forwarding it verbatim to the slot's clients, which will report a parse error. ` +
                    `Body: ${bodyExcerpt(trimmed)} ` +
                    `Something in front of the MCP server is answering instead of it: make the proxy pass POST ${this._url} through untouched, or point this upstream's url straight at the MCP server.`
            );
        }
        this.onMessage?.(trimmed);
    }

    /**
     * Opens the optional standalone GET stream that carries server-initiated
     * messages (`notifications/tools/list_changed`, sampling requests, log
     * messages).
     *
     * POST traffic keeps working without it, so a stream that dies quietly
     * presents as "the tool list went stale and never refreshes" while the slot
     * still reports as connected. Every drop is therefore named and the stream
     * is reopened with backoff.
     */
    private _openServerStream(): void {
        if (this._closed || this._streamReq || this._streamUnsupported) return;
        this._clearStreamRetry();
        const headers: Record<string, string> = { ...this._headers, Accept: "text/event-stream" };
        if (this._sessionId) headers["Mcp-Session-Id"] = this._sessionId;
        const req = makeRequest(new URL(this._url), { method: "GET", headers }, (res) => {
            const status = res.statusCode ?? 0;
            // 405 / 501 is the documented "this server has no standalone GET
            // stream" answer. Nothing is wrong and a retry cannot change it.
            if (status === 405 || status === 501) {
                this._streamUnsupported = true;
                res.resume();
                this._streamReq = null;
                return;
            }
            if (status >= 400) {
                res.resume();
                this._streamReq = null;
                this._scheduleServerStreamReopen(
                    `the standalone GET stream was refused with HTTP ${status}` +
                        (status === 401 || status === 403
                            ? `. POST requests are still accepted, so the upstream is reachable but the GET stream is not authorized: check that the headers configured for this upstream are also honored on GET ${this._url}`
                            : "")
                );
                return;
            }
            const openedAt = Date.now();
            const decoder = new SseDecoder();
            res.setEncoding("utf8");
            res.on("data", (chunk: string) =>
                decoder.feed(chunk, (ev, data) => {
                    if (ev === "message") this.onMessage?.(data);
                })
            );
            res.on("end", () => {
                this._streamReq = null;
                // A stream that stayed up was healthy, so the next drop starts the
                // backoff over and recovers fast. One that died on arrival keeps
                // the backoff growing instead of hot-looping.
                if (Date.now() - openedAt >= STREAM_HEALTHY_MS) this._streamAttempt = 0;
                this._scheduleServerStreamReopen("the standalone GET stream ended");
            });
        });
        this._streamReq = req;
        req.on("error", (err: Error) => {
            this._streamReq = null;
            this._scheduleServerStreamReopen(`the standalone GET stream failed: ${err.message}`);
        });
        req.end();
    }

    /**
     * Names a lost GET stream and schedules a reopen with exponential backoff.
     * Gated on `_closed` so a deliberate {@link close} never reconnects, and on
     * `_streamUnsupported` so a server without the stream is not retried.
     */
    private _scheduleServerStreamReopen(reason: string): void {
        if (this._closed || this._streamUnsupported || this._streamRetryTimer) return;
        const attempt = ++this._streamAttempt;
        const delay = Math.min(STREAM_REOPEN_MAX_MS, STREAM_REOPEN_BASE_MS * 2 ** Math.min(attempt - 1, STREAM_REOPEN_MAX_DOUBLINGS));
        console.error(
            `[broker] upstream "${this._label}": ${reason}. Server-initiated messages from ${this._url} (tool and prompt list_changed notifications, sampling requests) stop until it is back, ` +
                `while POST requests keep working and the slot keeps reporting as connected. Reopening in ${delay}ms (attempt ${attempt}).`
        );
        const timer = setTimeout(() => {
            this._streamRetryTimer = null;
            this._openServerStream();
        }, delay);
        timer.unref();
        this._streamRetryTimer = timer;
    }

    /** Cancels a pending reopen, if any. */
    private _clearStreamRetry(): void {
        if (!this._streamRetryTimer) return;
        clearTimeout(this._streamRetryTimer);
        this._streamRetryTimer = null;
    }

    close(): void {
        this._closed = true;
        this._clearStreamRetry();
        this._streamReq?.destroy();
        this._streamReq = null;
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds the transport of the given kind.
 *
 * `label` is the provider slot name this transport serves. It appears in every
 * diagnostic the transport emits, so an operator reading a broker log knows
 * which upstream is misbehaving without correlating URLs by hand. It defaults to
 * the URL when the caller has nothing better.
 */
export function createRemoteTransport(url: string, kind: RemoteTransportKind, headers: Record<string, string>, label: string = url): IRemoteTransport {
    switch (kind) {
        case "websocket":
            return new WebSocketRemoteTransport(url, headers);
        case "sse":
            return new SseRemoteTransport(url, headers);
        case "streamable-http":
            return new StreamableHttpRemoteTransport(url, headers, label);
    }
}

/** @deprecated Use {@link IRemoteTransport}. */
export type RemoteTransport = IRemoteTransport;

/** Heuristic transport detection from the URL when none is configured. */
export function detectTransport(url: string): RemoteTransportKind {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return "streamable-http";
    }
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return "websocket";
    if (parsed.pathname.replace(/\/+$/, "").endsWith("/sse")) return "sse";
    return "streamable-http";
}
