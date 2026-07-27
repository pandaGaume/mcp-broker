/**
 * broker-tunnel.js — connect an MCP server to @cyanmycelium/mcp-broker.
 *
 * This is the ONLY broker-specific code you need to tunnel an MCP server
 * (browser-side or anywhere a WebSocket is available) to the broker. Copy
 * this file as-is; it has zero dependencies.
 *
 * The broker's provider model is "the server dials out": an MCP server opens
 * an outbound WebSocket to `/provider/<name>` and the broker relays every MCP
 * client that targets that slot. No shipped MCP SDK transport covers that
 * direction, so `BrokerTunnelTransport` below is a thin shim implementing the
 * SDK's structural `Transport` interface (start / send / close / onmessage /
 * onclose / onerror) over a browser `WebSocket`. The MCP protocol itself is
 * untouched — any standard MCP server works through it.
 *
 * @example
 *   import { Server } from "https://esm.sh/@modelcontextprotocol/sdk@1.12.3/server/index.js";
 *   import { BrokerTunnelTransport } from "./lib/broker-tunnel.js";
 *
 *   const server = new Server({ name: "my-provider", version: "1.0.0" },
 *                             { capabilities: { tools: {} } });
 *   // server.setRequestHandler(...) — your tools and resources
 *
 *   const transport = new BrokerTunnelTransport("ws://localhost:3000/provider/my-provider");
 *   transport.onTunnelClose = (code, reason) =>
 *       console.log(describeTunnelClose(code, reason));
 *   await server.connect(transport);
 */

/**
 * MCP SDK transport backed by an outbound WebSocket to the broker.
 *
 * The MCP SDK owns `onmessage` / `onclose` / `onerror` (it assigns them inside
 * `Server.connect`). The page observes the raw socket through the separate
 * `onTunnelOpen` / `onTunnelClose` / `onTunnelError` hooks, so application code
 * and the SDK never overwrite each other's callbacks.
 */
export class BrokerTunnelTransport {
    /**
     * @param {string} url Full provider URL, e.g. `ws://host:3000/provider/<name>`.
     * @param {{ aggregate?: boolean }} [options] When `aggregate` is true, the
     *   transport sends a broker registration frame on open so this server
     *   joins the broker's `_all` aggregate slot.
     */
    constructor(url, options = {}) {
        this.url = url;
        this._ws = null;
        this._aggregate = options.aggregate === true;

        // Set by the MCP SDK inside Server.connect() — do not assign these yourself.
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;

        // Page-owned observation hooks — assign these before Server.connect().
        /** @type {null | (() => void)} */
        this.onTunnelOpen = null;
        /** @type {null | ((code: number, reason: string) => void)} */
        this.onTunnelClose = null;
        /** @type {null | ((error: Error) => void)} */
        this.onTunnelError = null;

        // Last close code/reason — useful for diagnostics after the fact.
        this.closeCode = null;
        this.closeReason = "";
    }

    /**
     * Opens the WebSocket. Called by `Server.connect()`. The returned promise
     * resolves once the broker accepts the WebSocket upgrade.
     *
     * Note: a successful upgrade is not yet a usable slot — the broker may
     * still reject the slot at the application layer with a 1008 close (name
     * already taken, or reserved) a few milliseconds later. Watch
     * `onTunnelClose` for that case.
     *
     * @returns {Promise<void>}
     */
    start() {
        return new Promise((resolve, reject) => {
            let opened = false;
            const ws = new WebSocket(this.url);
            this._ws = ws;

            ws.onopen = () => {
                opened = true;
                // Optional broker registration frame — it MUST precede any MCP
                // traffic, so it is sent here before start() resolves.
                if (this._aggregate) {
                    ws.send(JSON.stringify({ type: "register", aggregate: true }));
                }
                this.onTunnelOpen?.();
                resolve();
            };

            ws.onerror = () => {
                const err = new Error(`WebSocket error on ${this.url}`);
                this.onTunnelError?.(err);
                this.onerror?.(err);
                // Reject start() only if the socket never opened — a post-open
                // error is a runtime failure, not a connect failure.
                if (!opened) reject(err);
            };

            ws.onclose = (ev) => {
                this.closeCode = ev.code;
                this.closeReason = ev.reason;
                this.onTunnelClose?.(ev.code, ev.reason);
                this.onclose?.();
            };

            ws.onmessage = (ev) => {
                let parsed;
                try {
                    parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
                } catch {
                    return; // not JSON — drop
                }
                this.onmessage?.(parsed);
            };
        });
    }

    /**
     * Sends one JSON-RPC message. Called by the MCP SDK.
     * @param {object} message
     * @returns {Promise<void>}
     */
    send(message) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(message));
        }
        return Promise.resolve();
    }

    /**
     * Closes the WebSocket. Called by `Server.close()`.
     * @returns {Promise<void>}
     */
    close() {
        this._ws?.close();
        return Promise.resolve();
    }
}

/** WebSocket close code the broker uses to reject a provider slot. */
export const BROKER_REJECT_CODE = 1008;

/**
 * Turns a tunnel WebSocket close into a human-readable diagnosis — the
 * "handshake check". Three cases matter when tunnelling to the broker:
 *
 * - 1008  → the broker rejected the slot (name already connected, or reserved).
 * - closed before the tunnel was ever up → the broker is unreachable.
 * - any other close while up → the tunnel dropped unexpectedly.
 *
 * @param {number} code        WebSocket close code.
 * @param {string} reason      WebSocket close reason (may be empty).
 * @param {boolean} wasOpen    Whether the tunnel had reached a usable state.
 * @returns {{ level: "error" | "warn", message: string }}
 */
export function describeTunnelClose(code, reason, wasOpen) {
    if (code === BROKER_REJECT_CODE) {
        return { level: "error", message: `Broker rejected the provider slot: ${reason || "policy violation (1008)"}` };
    }
    if (!wasOpen) {
        return { level: "error", message: "Broker unreachable — the WebSocket closed before the tunnel opened." };
    }
    if (code && code !== 1000 && code !== 1005) {
        return { level: "warn", message: `Tunnel closed unexpectedly (code ${code}${reason ? ", " + reason : ""}).` };
    }
    return { level: "warn", message: "Tunnel closed." };
}
