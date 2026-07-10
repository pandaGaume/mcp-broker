import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { WsTunnelBuilder, AuthError, type WsTunnel, type ResolvedAuth, type TokenValidator, type AggregateScopeFilter } from "../src/index.js";

// "geoer" holds see:geo; "blind" holds an unrelated scope. Both authenticate.
const validator: TokenValidator = {
    async validate(token, resource) {
        if (token === "geoer") return { sub: "g", aud: resource, scope: "see:geo" };
        if (token === "blind") return { sub: "b", aud: resource, scope: "see:none" };
        throw new AuthError(401, "invalid_token", "bad token");
    },
};

// The geo provider is visible only to callers holding see:geo.
const aggregateScopeFilter: AggregateScopeFilter = (principal, provider) => (provider === "geo" ? principal.scopes.has("see:geo") : true);

const AUTH: ResolvedAuth = {
    publicBaseUrl: "https://broker.test",
    authorizationServers: ["https://as.test"],
    validator,
    requiredScopes: [],
    aggregateScopeFilter,
};

let tunnel: WsTunnel | null = null;
let provider: WebSocket | null = null;

async function start(): Promise<number> {
    tunnel = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1").withAuth(AUTH).build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return server.address().port;
}

/** Connects a mock provider that joins `_all` and serves one tool. */
async function connectProvider(port: number, slot: string, tools: { name: string }[]): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/provider/${slot}`);
    await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
    });
    ws.send(JSON.stringify({ type: "register", aggregate: true }));
    ws.on("message", (buf: Buffer) => {
        const m = JSON.parse(buf.toString()) as { id?: string | number | null; method?: string };
        if (m.id == null) return;
        let result: unknown = {};
        if (m.method === "initialize") result = { protocolVersion: "2024-11-05", serverInfo: { name: slot, version: "0" }, capabilities: {} };
        else if (m.method === "tools/list") result = { tools };
        else if (m.method === "prompts/list") result = { prompts: [] };
        else if (m.method === "tools/call") result = { content: [{ type: "text", text: "ok" }] };
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    });
    return ws;
}

async function toolsList(port: number, token: string): Promise<string[]> {
    const res = await fetch(`http://127.0.0.1:${port}/_all/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await res.json()) as { result?: { tools?: { name: string }[] } };
    return (body.result?.tools ?? []).map((t) => t.name);
}

/** Polls tools/list (as a privileged token) until the geo tool shows up. */
async function waitForGeo(port: number): Promise<void> {
    for (let i = 0; i < 40; i++) {
        const names = await toolsList(port, "geoer");
        if (names.some((n) => n.startsWith("geo-"))) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("geo provider never joined the aggregate");
}

afterEach(async () => {
    provider?.close();
    provider = null;
    await tunnel?.stop();
    tunnel = null;
});

describe("_all scope filtering end-to-end through the tunnel", () => {
    it("shows the geo provider only to a caller scoped for it", async () => {
        const port = await start();
        provider = await connectProvider(port, "geo", [{ name: "where" }]);
        await waitForGeo(port);

        const forGeoer = await toolsList(port, "geoer");
        expect(forGeoer.some((n) => n.startsWith("geo-"))).toBe(true);

        const forBlind = await toolsList(port, "blind");
        expect(forBlind.some((n) => n.startsWith("geo-"))).toBe(false);
    });
});
