/**
 * mcp-ws-client.js — a minimal MCP client over a raw WebSocket.
 *
 * The broker exposes every slot as a raw-WebSocket client transport at
 * `ws://<host>/<slot>`: the frames are plain newline-free JSON-RPC, relayed
 * untouched to whatever server backs the slot (`_broker`, `_all`, or any
 * tunnelled provider). There is therefore nothing broker-specific here — this
 * is a standard MCP client. It is kept separate from `app.js` the same way the
 * provider-tunnel demo keeps its MCP server in `toolbox-server.js`.
 *
 * Zero dependencies; speaks just enough of MCP for the explorer demo:
 * `initialize`, `tools/list`, `tools/call`.
 */

/** MCP protocol version negotiated with the slot. */
const PROTOCOL_VERSION = "2024-11-05";

/** Per-request timeout. */
const REQUEST_TIMEOUT_MS = 15_000;

export class McpWebSocketClient {
    /**
     * @param {string} url Full slot URL, e.g. `ws://host:3000/_broker`.
     */
    constructor(url) {
        this.url = url;
        this._ws = null;
        this._pending = new Map();
        this._nextId = 0;

        /** @type {null | (() => void)} Fires when the socket closes. */
        this.onClose = null;
        /** @type {null | ((error: Error) => void)} Fires on a socket error. */
        this.onError = null;
    }

    /**
     * Opens the WebSocket. Resolves once the broker accepts the upgrade.
     * @returns {Promise<void>}
     */
    open() {
        return new Promise((resolve, reject) => {
            let opened = false;
            const ws = new WebSocket(this.url);
            this._ws = ws;

            ws.onopen = () => {
                opened = true;
                resolve();
            };
            ws.onerror = () => {
                const err = new Error(`WebSocket error on ${this.url}`);
                this.onError?.(err);
                if (!opened) reject(err);
            };
            ws.onclose = () => {
                this._rejectAll("connection closed");
                this.onClose?.();
            };
            ws.onmessage = (ev) => {
                let msg;
                try {
                    msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
                } catch {
                    return;
                }
                if (msg && typeof msg.id === "number" && this._pending.has(msg.id)) {
                    const pending = this._pending.get(msg.id);
                    this._pending.delete(msg.id);
                    clearTimeout(pending.timer);
                    pending.resolve(msg);
                }
            };
        });
    }

    /** Runs the MCP `initialize` handshake. */
    async initialize() {
        const res = await this._request("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "broker-explorer", version: "1.0.0" },
        });
        this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
        return res.result;
    }

    /** Lists the slot's tools. */
    async listTools() {
        const res = await this._request("tools/list", {});
        if (res.error) throw new Error(res.error.message || "tools/list failed");
        return res.result?.tools ?? [];
    }

    /** Calls a tool and returns the raw JSON-RPC result (or throws on error). */
    async callTool(name, args) {
        const res = await this._request("tools/call", { name, arguments: args });
        if (res.error) throw new Error(res.error.message || "tools/call failed");
        return res.result;
    }

    /** Closes the WebSocket. */
    close() {
        this._ws?.close();
    }

    _send(obj) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(obj));
        }
    }

    _request(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this._nextId;
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`request "${method}" timed out`));
            }, REQUEST_TIMEOUT_MS);
            this._pending.set(id, { resolve, reject, timer });
            this._send({ jsonrpc: "2.0", id, method, params });
        });
    }

    _rejectAll(reason) {
        for (const pending of this._pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
        this._pending.clear();
    }
}
