import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { WsTunnelBuilder, AuthError, type WsTunnel, type IResolvedAuth, type ITokenValidator } from "../src/index";

const validator: ITokenValidator = {
    async validate(token, resource) {
        if (token === "good") return { sub: "u1", aud: resource, scope: "mcp:call" };
        if (token === "noscope") return { sub: "u2", aud: resource };
        throw new AuthError(401, "invalid_token", "bad token");
    },
};

const AUTH: IResolvedAuth = {
    publicBaseUrl: "https://broker.test",
    authorizationServers: ["https://as.test"],
    validator,
    requiredScopes: ["mcp:call"],
};

let tunnel: WsTunnel | null = null;

async function start(withAuth: boolean): Promise<string> {
    const builder = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1");
    if (withAuth) builder.withAuth(AUTH);
    tunnel = builder.build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return `ws://127.0.0.1:${server.address().port}`;
}

/** Attempts a WS client upgrade; resolves whether it opened and any HTTP status. */
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
            /* handshake rejection also emits error; resolution already handled */
        });
    });
}

afterEach(async () => {
    await tunnel?.stop();
    tunnel = null;
});

describe("resource-server auth for WebSocket clients", () => {
    it("rejects a tokenless WS client with a 401 upgrade response", async () => {
        const base = await start(true);
        const result = await connect(`${base}/weather`);
        expect(result.ok).toBe(false);
        expect(result.status).toBe(401);
    });

    it("rejects a WS client whose token lacks the required scope with 403", async () => {
        const base = await start(true);
        const result = await connect(`${base}/weather`, { authorization: "Bearer noscope" });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(403);
    });

    it("accepts a WS client with a valid bearer token", async () => {
        const base = await start(true);
        const result = await connect(`${base}/weather`, { authorization: "Bearer good" });
        expect(result.ok).toBe(true);
    });

    it("accepts any WS client when auth is disabled", async () => {
        const base = await start(false);
        const result = await connect(`${base}/weather`);
        expect(result.ok).toBe(true);
    });
});
