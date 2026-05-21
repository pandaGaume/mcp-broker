import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { WebSocket } from "ws";
import { WsTunnelBuilder } from "../src/index.js";
import type { WsTunnel } from "../src/ws.tunnel.js";

const BROKER_PORT = 3914;
const FAKE_PORT = 3915;

interface JsonRpc {
    jsonrpc: "2.0";
    id?: string | number | null;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
}

/**
 * A minimal MCP server over the Streamable HTTP transport. It assigns a session
 * id on `initialize` and rejects any later request that does not echo it back,
 * so the test proves the upstream transport captures and reuses the session id.
 */
function startFakeHttpServer(): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        if (req.method === "GET") {
            res.writeHead(405).end(); // no standalone server stream
            return;
        }
        if (req.method !== "POST") {
            res.writeHead(404).end();
            return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
        });
        req.on("end", () => {
            let msg: JsonRpc;
            try {
                msg = JSON.parse(body) as JsonRpc;
            } catch {
                res.writeHead(400).end();
                return;
            }
            if (msg.id == null) {
                res.writeHead(202).end(); // notification
                return;
            }
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            let payload: Record<string, unknown>;
            if (msg.method === "initialize") {
                headers["Mcp-Session-Id"] = "sess-123";
                payload = { result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake-http", version: "1" }, capabilities: { tools: {} } } };
            } else if (req.headers["mcp-session-id"] !== "sess-123") {
                payload = { error: { code: -32600, message: "missing or wrong Mcp-Session-Id" } };
            } else if (msg.method === "tools/list") {
                payload = { result: { tools: [{ name: "echo", description: "Echo back", inputSchema: { type: "object" } }] } };
            } else if (msg.method === "tools/call") {
                payload = { result: { content: [{ type: "text", text: `echoed:${JSON.stringify(msg.params?.arguments ?? {})}` }] } };
            } else {
                payload = { error: { code: -32601, message: "method not found" } };
            }
            res.writeHead(200, headers);
            res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...payload }));
        });
    });
    return new Promise((resolve) => server.listen(FAKE_PORT, "127.0.0.1", () => resolve(server)));
}

/** A JSON-RPC client over a raw WebSocket to a broker slot. */
async function rpcClient(url: string): Promise<{ ws: WebSocket; request(method: string, params: Record<string, unknown>): Promise<JsonRpc> }> {
    const ws = new WebSocket(url);
    const pending = new Map<number, (msg: JsonRpc) => void>();
    let nextId = 0;
    ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as JsonRpc;
        if (typeof msg.id === "number" && pending.has(msg.id)) {
            pending.get(msg.id)?.(msg);
            pending.delete(msg.id);
        }
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    return {
        ws,
        request(method, params) {
            const id = ++nextId;
            return new Promise<JsonRpc>((resolve) => {
                pending.set(id, resolve);
                ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            });
        },
    };
}

describe("remote upstream (mcpServers)", () => {
    let fake: http.Server;
    let tunnel: WsTunnel;
    const sockets: WebSocket[] = [];

    beforeAll(async () => {
        fake = await startFakeHttpServer();
        tunnel = new WsTunnelBuilder()
            .withPort(BROKER_PORT)
            .withHost("127.0.0.1")
            .withRemoteUpstream({ name: "echo", url: `http://127.0.0.1:${FAKE_PORT}/mcp`, transport: "streamable-http" })
            .build();
        await tunnel.start();
    });

    afterAll(async () => {
        for (const s of sockets) {
            try {
                s.close();
            } catch {
                /* ignore */
            }
        }
        await tunnel.stop();
        await new Promise<void>((resolve) => fake.close(() => resolve()));
    });

    it("relays a client through the broker slot to the remote Streamable HTTP server", async () => {
        const client = await rpcClient(`ws://127.0.0.1:${BROKER_PORT}/echo`);
        sockets.push(client.ws);

        // initialize — the response comes back relayed from the remote server.
        const init = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
        expect((init.result?.serverInfo as { name?: string })?.name).toBe("fake-http");

        // tools/list — succeeds only if the transport reused the captured session id.
        const list = await client.request("tools/list", {});
        expect(list.error).toBeUndefined();
        expect((list.result?.tools as { name: string }[]).map((t) => t.name)).toEqual(["echo"]);

        // tools/call — arguments round-trip to the remote server and back.
        const call = await client.request("tools/call", { name: "echo", arguments: { hi: 1 } });
        const text = (call.result?.content as { text: string }[])[0].text;
        expect(text).toBe('echoed:{"hi":1}');
    });
});
