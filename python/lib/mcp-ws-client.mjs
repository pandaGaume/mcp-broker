import { createRequire } from "node:module";
import { EventEmitter, once } from "node:events";

const require = createRequire(new URL("../../node/package.json", import.meta.url));
const WebSocket = require("ws");

export async function connectWs(base, slot, options = {}) {
    const ws = new WebSocket(`${base}/${encodeURIComponent(slot)}`, { handshakeTimeout: 5000, ...options });
    const frames = new EventEmitter();
    const pending = new Map();
    let id = 0;
    ws.on("message", data => {
        const frame = JSON.parse(data.toString());
        if (frame.id !== undefined && pending.has(frame.id)) {
            const { resolve, reject, timer } = pending.get(frame.id);
            clearTimeout(timer);
            pending.delete(frame.id);
            if (frame.error) reject(Object.assign(new Error(frame.error.message), { rpc: frame.error }));
            else resolve(frame.result);
        } else if (frame.method) frames.emit(frame.method, frame.params);
    });
    ws.on("close", () => {
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Connection closed")); }
        pending.clear();
    });
    await once(ws, "open");
    function request(method, params = {}) {
        return new Promise((resolve, reject) => {
            const requestId = ++id;
            const timer = setTimeout(() => {
                pending.delete(requestId);
                reject(new Error(`Timeout: ${method}`));
            }, 6000);
            pending.set(requestId, { resolve, reject, timer });
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
        });
    }
    const initialized = await request("initialize", {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "python-features-test", version: "1" },
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    return { request, frames, initialized, ws,
        callTool: (name, args = {}) => request("tools/call", { name, arguments: args }),
        listTools: () => request("tools/list"),
        close: async () => {
            if (ws.readyState === WebSocket.CLOSED) return;
            const closed = once(ws, "close");
            ws.close();
            await closed;
        },
    };
}
