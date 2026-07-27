import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { WsTunnelBuilder, AuthError, type WsTunnel, type IResolvedAuth, type ITokenValidator } from "../src/index.js";

/** `Response.json()` yields `unknown`; this is the shape these tests assert on. */
type JsonRpcBody = { result?: { tools?: unknown[] }; error?: { code: number; message: string } };

/** Validator that accepts "good" (with scope) and "noscope"; rejects the rest. */
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
    scopesSupported: ["mcp:call"],
    validator,
    requiredScopes: ["mcp:call"],
};

const RPC = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

let tunnel: WsTunnel | null = null;

/** Starts a tunnel on an ephemeral port and returns its base URL. */
async function start(withAuth: boolean): Promise<string> {
    const builder = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1");
    if (withAuth) builder.withAuth(AUTH);
    tunnel = builder.build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
    await tunnel?.stop();
    tunnel = null;
});

describe("resource-server auth over HTTP", () => {
    it("serves Protected Resource Metadata unauthenticated", async () => {
        const base = await start(true);
        const res = await fetch(`${base}/.well-known/oauth-protected-resource/weather/mcp`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
            resource: "https://broker.test/weather/mcp",
            authorization_servers: ["https://as.test"],
            bearer_methods_supported: ["header"],
        });
    });

    it("challenges an unauthenticated MCP POST with 401 + WWW-Authenticate", async () => {
        const base = await start(true);
        const res = await fetch(`${base}/weather/mcp`, { method: "POST", body: RPC });
        expect(res.status).toBe(401);
        const header = res.headers.get("www-authenticate") ?? "";
        expect(header).toContain('resource_metadata="https://broker.test/.well-known/oauth-protected-resource/weather/mcp"');
        expect(header).toContain('error="invalid_token"');
    });

    it("rejects a token without the required scope with 403", async () => {
        const base = await start(true);
        const res = await fetch(`${base}/weather/mcp`, { method: "POST", headers: { authorization: "Bearer noscope" }, body: RPC });
        expect(res.status).toBe(403);
        expect(res.headers.get("www-authenticate") ?? "").toContain('scope="mcp:call"');
    });

    it("passes a valid token through to the handler (provider-not-connected proves the gate opened)", async () => {
        const base = await start(true);
        const res = await fetch(`${base}/weather/mcp`, { method: "POST", headers: { authorization: "Bearer good" }, body: RPC });
        expect(res.status).toBe(200);
        const body = (await res.json()) as JsonRpcBody;
        expect(body.error?.code).toBe(-32000);
        expect(String(body.error?.message)).toContain("not connected");
    });

    it("does not require auth for the CORS preflight", async () => {
        const base = await start(true);
        const res = await fetch(`${base}/weather/mcp`, { method: "OPTIONS" });
        expect(res.status).toBe(204);
    });

    it("leaves behavior unchanged when auth is disabled", async () => {
        const base = await start(false);
        // No metadata endpoint when auth is off.
        const meta = await fetch(`${base}/.well-known/oauth-protected-resource/weather/mcp`);
        expect(meta.status).toBe(404);
        // MCP POST reaches the handler with no token.
        const res = await fetch(`${base}/weather/mcp`, { method: "POST", body: RPC });
        expect(res.status).toBe(200);
        const body = (await res.json()) as JsonRpcBody;
        expect(body.error?.code).toBe(-32000);
    });
});
