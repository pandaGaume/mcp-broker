import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { WsTunnelBuilder } from "../src/index";
import type { WsTunnel } from "../src/ws/ws.tunnel";

const PORT = 3913;
const BASE = `ws://127.0.0.1:${PORT}`;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface IJsonRpc {
    jsonrpc: "2.0";
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
}

/**
 * A minimal MCP-server provider over a WebSocket. Opts into aggregation with a
 * registration frame, then answers initialize / tools / prompts. `tools/call`
 * echoes `<label>:<toolName>` so the test can prove routing.
 */
function fakeProvider(label: string, tools: Record<string, unknown>[], prompts: Record<string, unknown>[]): WebSocket {
    const ws = new WebSocket(`${BASE}/provider/${label}`);
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", aggregate: true })));
    ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as IJsonRpc;
        if (msg.id == null) return; // notification
        let result: Record<string, unknown>;
        switch (msg.method) {
            case "initialize":
                result = { protocolVersion: "2024-11-05", serverInfo: { name: label, version: "1" }, capabilities: { tools: {}, prompts: {} } };
                break;
            case "tools/list":
                result = { tools };
                break;
            case "prompts/list":
                result = { prompts };
                break;
            case "tools/call":
                result = { content: [{ type: "text", text: `${label}:${String(msg.params?.name)}` }] };
                break;
            default:
                ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }));
                return;
        }
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
    return ws;
}

/** A JSON-RPC client over a raw WebSocket, capturing responses and notifications. */
async function rpcClient(url: string): Promise<{
    ws: WebSocket;
    notifications: string[];
    request(method: string, params: Record<string, unknown>): Promise<IJsonRpc>;
}> {
    const ws = new WebSocket(url);
    const pending = new Map<number, (msg: IJsonRpc) => void>();
    const notifications: string[] = [];
    let nextId = 0;

    ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as IJsonRpc;
        if (msg.id != null && typeof msg.id === "number" && pending.has(msg.id)) {
            pending.get(msg.id)?.(msg);
            pending.delete(msg.id);
        } else if (msg.id == null && msg.method) {
            notifications.push(msg.method);
        }
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    return {
        ws,
        notifications,
        request(method, params) {
            const id = ++nextId;
            return new Promise<IJsonRpc>((resolve) => {
                pending.set(id, resolve);
                ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            });
        },
    };
}

describe("aggregate _all slot", () => {
    let tunnel: WsTunnel;
    const sockets: WebSocket[] = [];

    beforeAll(async () => {
        tunnel = new WsTunnelBuilder().withPort(PORT).withHost("127.0.0.1").build();
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
    });

    it("unions tools and prompts from opted-in providers and routes calls back", async () => {
        sockets.push(fakeProvider("weather", [{ name: "forecast", description: "Weather forecast", inputSchema: { type: "object" } }], []));
        sockets.push(fakeProvider("db", [{ name: "query", description: "Run a query", inputSchema: { type: "object" } }], [{ name: "report", description: "Build a report" }]));

        const client = await rpcClient(`${BASE}/_all`);
        sockets.push(client.ws);

        await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });

        // `_all` also aggregates the broker's own `_broker` slot; filter it out
        // when asserting the external providers' tool set.
        const externalNames = (tools: Record<string, unknown>[]): string[] => tools.map((t) => String(t.name)).filter((n) => !n.startsWith("_broker-"));

        // Poll tools/list until both external providers finished their handshake.
        let tools: Record<string, unknown>[] = [];
        for (let i = 0; i < 60 && externalNames(tools).length < 2; i++) {
            const res = await client.request("tools/list", {});
            tools = (res.result?.tools as Record<string, unknown>[]) ?? [];
            if (externalNames(tools).length < 2) await delay(50);
        }

        // Names are provider-prefixed with the `-` separator.
        expect(externalNames(tools).sort()).toEqual(["db-query", "weather-forecast"]);

        // Descriptions carry the provider tag.
        const forecast = tools.find((t) => t.name === "weather-forecast");
        expect(String(forecast?.description)).toContain("[weather]");

        // Prompts are aggregated the same way.
        const prompts = (await client.request("prompts/list", {})).result?.prompts as Record<string, unknown>[];
        expect(prompts.map((p) => p.name)).toEqual(["db-report"]);

        // tools/call routes to the origin provider with the original tool name.
        const call = await client.request("tools/call", { name: "weather-forecast", arguments: {} });
        expect(JSON.stringify(call.result)).toContain("weather:forecast");

        // An unknown aggregated name yields a JSON-RPC error.
        const bad = await client.request("tools/call", { name: "nope-missing", arguments: {} });
        expect(bad.error).toBeTruthy();
    });

    it("drops a provider's tools and emits list_changed when it disconnects", async () => {
        const client = await rpcClient(`${BASE}/_all`);
        sockets.push(client.ws);

        // The `weather` socket is sockets[0].
        sockets[0].close();

        let tools: Record<string, unknown>[] = [];
        for (let i = 0; i < 60; i++) {
            tools = ((await client.request("tools/list", {})).result?.tools as Record<string, unknown>[]) ?? [];
            if (!tools.some((t) => t.name === "weather-forecast")) break;
            await delay(50);
        }

        expect(tools.some((t) => t.name === "weather-forecast")).toBe(false);
        expect(tools.some((t) => t.name === "db-query")).toBe(true);
        expect(client.notifications).toContain("notifications/tools/list_changed");
    });

    it("reports its membership through getAggregateInfo, so broker_diagnose can read it", async () => {
        // `weather` was closed by the previous test; `db` is still registered.
        const info = tunnel.getAggregateInfo();
        expect(info.enabled).toBe(true);
        expect(info.providers).toContain("db");
        expect(info.providers).not.toContain("weather");

        const client = await rpcClient(`${BASE}/_broker`);
        sockets.push(client.ws);
        await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
        const diagnosis = (await client.request("tools/call", { name: "broker_diagnose", arguments: {} })).result as {
            content: { type: string; text: string }[];
        };
        const report = JSON.parse(diagnosis.content[0].text) as { checksSkipped: { id: string }[]; problems: { id: string }[] };
        expect(report.checksSkipped.map((c) => c.id)).not.toContain("aggregate-empty");
        expect(report.problems.map((p) => p.id)).not.toContain("aggregate-empty");
    });

    it("tells, per slot, whether the provider is in _all and since when it attached", async () => {
        // `weather` is gone, `db` still serves its slot and opted in.
        const db = tunnel.getProviderInfo("db");
        expect(db?.connected).toBe(true);
        expect(db?.aggregate).toBe(true);
        expect(typeof db?.connectedSince).toBe("string");
        expect(Number.isNaN(Date.parse(db?.connectedSince ?? ""))).toBe(false);
        expect(db?.connectedForMs).toBeGreaterThanOrEqual(0);
        // Nobody is calling db right now: the counts are the slot's callers,
        // not the provider, and read zero for a connected provider.
        expect(db?.clientCount).toBe(0);
        expect(db?.pendingCount).toBe(0);

        const weather = tunnel.getProviderInfo("weather");
        expect(weather?.connected).toBe(false);
        expect(weather?.aggregate).toBe(false);
        expect(weather?.connectedSince).toBeNull();
        expect(weather?.connectedForMs).toBeNull();

        // The broker's own slot: loopback, attached at start, in _all.
        const broker = tunnel.getProviderInfo("_broker");
        expect(broker?.transport).toBe("loopback");
        expect(broker?.aggregate).toBe(true);
        expect(broker?.connectedSince).not.toBeNull();
        // `_all` is the aggregate, not a member of itself.
        expect(tunnel.getProviderInfo("_all")?.aggregate).toBe(false);
    });

    it("aggregates the broker's own introspection tools into `_all`", async () => {
        const client = await rpcClient(`${BASE}/_all`);
        sockets.push(client.ws);

        await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });

        let brokerTools: string[] = [];
        for (let i = 0; i < 60 && brokerTools.length < 3; i++) {
            const tools = ((await client.request("tools/list", {})).result?.tools as Record<string, unknown>[]) ?? [];
            brokerTools = tools.map((t) => String(t.name)).filter((n) => n.startsWith("_broker-"));
            if (brokerTools.length < 3) await delay(50);
        }

        // Containment, not equality: the `_broker` slot grows tools over time
        // (the guide and the self-diagnosis joined the three introspection
        // ones), and this test is about the aggregate prefixing them, not
        // about how many there are.
        expect(brokerTools).toEqual(expect.arrayContaining(["_broker-broker_info", "_broker-provider_status", "_broker-providers_list"]));

        // The aggregated call routes back into the broker's own server.
        const call = await client.request("tools/call", { name: "_broker-broker_info", arguments: {} });
        expect(call.error).toBeUndefined();
        expect(call.result).toBeTruthy();
    });
});
