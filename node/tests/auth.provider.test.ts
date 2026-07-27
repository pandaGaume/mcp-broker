import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { WsTunnelBuilder, AuthError, type WsTunnel, type IResolvedAuth, type ITokenValidator } from "../src/index.js";

const validator: ITokenValidator = {
    async validate(token, resource) {
        if (token === "good") return { sub: "u1", aud: resource, scope: "mcp:call" };
        if (token === "admin") return { sub: "root", aud: resource, scope: "mcp:call broker:admin" };
        throw new AuthError(401, "invalid_token", "bad token");
    },
};

const SECRET = "provider-s3cr3t";

let tunnel: WsTunnel | null = null;

async function start(opts: { auth?: IResolvedAuth; providerSecret?: string }): Promise<{ port: number }> {
    const builder = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1");
    if (opts.auth) builder.withAuth(opts.auth);
    if (opts.providerSecret) builder.withProviderSecret(opts.providerSecret);
    tunnel = builder.build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return { port: server.address().port };
}

function connect(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; status?: number }> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, headers ? { headers } : undefined);
        const timer = setTimeout(() => resolve({ ok: false, status: 0 }), 3000);
        ws.on("open", () => {
            clearTimeout(timer);
            ws.close();
            resolve({ ok: true });
        });
        ws.on("unexpected-response", (_req, res) => {
            clearTimeout(timer);
            resolve({ ok: false, status: res.statusCode });
            ws.terminate();
        });
        ws.on("error", () => {
            /* rejection also emits error; resolution already handled */
        });
    });
}

afterEach(async () => {
    await tunnel?.stop();
    tunnel = null;
});

describe("provider (engine) authentication — closes slot occupation", () => {
    it("rejects a dedicated provider connection without the secret", async () => {
        const { port } = await start({ providerSecret: SECRET });
        const result = await connect(`ws://127.0.0.1:${port}/provider/weather`);
        expect(result.ok).toBe(false);
        expect(result.status).toBe(401);
    });

    it("rejects a dedicated provider connection with a wrong secret", async () => {
        const { port } = await start({ providerSecret: SECRET });
        const result = await connect(`ws://127.0.0.1:${port}/provider/weather`, { "x-provider-token": "nope" });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(401);
    });

    it("accepts a dedicated provider with the secret via X-Provider-Token", async () => {
        const { port } = await start({ providerSecret: SECRET });
        const result = await connect(`ws://127.0.0.1:${port}/provider/weather`, { "x-provider-token": SECRET });
        expect(result.ok).toBe(true);
    });

    it("accepts a dedicated provider with the secret via Authorization: Bearer", async () => {
        const { port } = await start({ providerSecret: SECRET });
        const result = await connect(`ws://127.0.0.1:${port}/provider/weather`, { authorization: `Bearer ${SECRET}` });
        expect(result.ok).toBe(true);
    });

    it("authenticates the multiplexed /providers socket at the socket level", async () => {
        const { port } = await start({ providerSecret: SECRET });
        const denied = await connect(`ws://127.0.0.1:${port}/providers`);
        expect(denied.ok).toBe(false);
        expect(denied.status).toBe(401);
        const allowed = await connect(`ws://127.0.0.1:${port}/providers`, { "x-provider-token": SECRET });
        expect(allowed.ok).toBe(true);
    });

    it("leaves provider connections open when provider auth is disabled", async () => {
        const { port } = await start({});
        const result = await connect(`ws://127.0.0.1:${port}/provider/weather`);
        expect(result.ok).toBe(true);
    });
});

describe("_broker introspection is gated once auth is enabled", () => {
    const RPC = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    const auth: IResolvedAuth = {
        publicBaseUrl: "https://broker.test",
        authorizationServers: ["https://as.test"],
        validator,
        requiredScopes: ["mcp:call"],
        perSlotScopes: { _broker: ["broker:admin"] },
    };

    it("rejects an unauthenticated _broker call with 401", async () => {
        const { port } = await start({ auth });
        const res = await fetch(`http://127.0.0.1:${port}/_broker/mcp`, { method: "POST", body: RPC });
        expect(res.status).toBe(401);
    });

    it("rejects a token missing the admin scope with 403", async () => {
        const { port } = await start({ auth });
        const res = await fetch(`http://127.0.0.1:${port}/_broker/mcp`, { method: "POST", headers: { authorization: "Bearer good" }, body: RPC });
        expect(res.status).toBe(403);
        expect(res.headers.get("www-authenticate") ?? "").toContain('scope="broker:admin"');
    });

    it("lets an admin-scoped token reach the broker's own tools", async () => {
        const { port } = await start({ auth });
        const res = await fetch(`http://127.0.0.1:${port}/_broker/mcp`, { method: "POST", headers: { authorization: "Bearer admin" }, body: RPC });
        expect(res.status).toBe(200);
        const body = await res.json();
        // The broker loopback answers for real — a tools/list result, not an error.
        expect(body.result?.tools).toBeDefined();
        expect(body.error).toBeUndefined();
    });
});
