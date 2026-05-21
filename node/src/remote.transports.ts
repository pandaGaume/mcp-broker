/**
 * Hand-rolled client transports for reaching a remote MCP server by URL.
 *
 * No `@modelcontextprotocol/sdk` dependency: the broker stays SDK-free, the
 * official SDK is only used outside the broker (in the demo) to prove the
 * broker is implementation-agnostic. Each transport is a thin frame relay —
 * it does not interpret MCP, it pipes JSON-RPC strings both ways.
 */
import * as http from "node:http";
import * as https from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { WebSocket } from "ws";

/** Lifecycle + callbacks shared by every remote client transport. */
export interface RemoteTransport {
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

class WebSocketRemoteTransport implements RemoteTransport {
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

class SseRemoteTransport implements RemoteTransport {
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

class StreamableHttpRemoteTransport implements RemoteTransport {
    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    private _sessionId: string | null = null;
    private _streamReq: ClientRequest | null = null;
    private _closed = false;

    constructor(
        private readonly _url: string,
        private readonly _headers: Record<string, string>
    ) {}

    connect(): void {
        // Streamable HTTP is stateless — there is no connection to open. The
        // transport is usable as soon as connect() is called; the session id
        // is captured later from the first response that carries one.
        this._closed = false;
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
            /* not JSON — forward verbatim */
        }
        this.onMessage?.(trimmed);
    }

    /** Opens the optional standalone GET stream for server-initiated messages. */
    private _openServerStream(): void {
        if (this._closed || this._streamReq) return;
        const headers: Record<string, string> = { ...this._headers, Accept: "text/event-stream" };
        if (this._sessionId) headers["Mcp-Session-Id"] = this._sessionId;
        const req = makeRequest(new URL(this._url), { method: "GET", headers }, (res) => {
            if ((res.statusCode ?? 0) >= 400) {
                // The server may not support the standalone GET stream (405). Fine.
                res.resume();
                this._streamReq = null;
                return;
            }
            const decoder = new SseDecoder();
            res.setEncoding("utf8");
            res.on("data", (chunk: string) =>
                decoder.feed(chunk, (ev, data) => {
                    if (ev === "message") this.onMessage?.(data);
                })
            );
            res.on("end", () => {
                this._streamReq = null;
            });
        });
        this._streamReq = req;
        req.on("error", () => {
            this._streamReq = null;
        });
        req.end();
    }

    close(): void {
        this._closed = true;
        this._streamReq?.destroy();
        this._streamReq = null;
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Builds the transport of the given kind. */
export function createRemoteTransport(url: string, kind: RemoteTransportKind, headers: Record<string, string>): RemoteTransport {
    switch (kind) {
        case "websocket":
            return new WebSocketRemoteTransport(url, headers);
        case "sse":
            return new SseRemoteTransport(url, headers);
        case "streamable-http":
            return new StreamableHttpRemoteTransport(url, headers);
    }
}

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
