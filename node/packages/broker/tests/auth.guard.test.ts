import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { HttpAuthGuard, AuthError, type IResolvedAuth, type ITokenValidator, type IAccessTokenClaims } from "../src/auth/index";

/** A stub validator that echoes canned claims keyed by the raw token string. */
function stubValidator(table: Record<string, IAccessTokenClaims>): ITokenValidator {
    return {
        async validate(token: string, resource: string): Promise<IAccessTokenClaims> {
            const claims = table[token];
            if (!claims) throw new AuthError(401, "invalid_token", "unknown token");
            // Echo the resource into aud so downstream shape looks realistic.
            return { aud: resource, ...claims };
        },
    };
}

function makeGuard(overrides: Partial<IResolvedAuth> = {}): HttpAuthGuard {
    const auth: IResolvedAuth = {
        publicBaseUrl: "https://broker.test",
        authorizationServers: ["https://as.test"],
        scopesSupported: ["mcp:call"],
        validator: stubValidator({
            good: { sub: "u1", scope: "mcp:call extra" },
            noscope: { sub: "u2" },
            arrayscope: { sub: "u3", scopes: ["mcp:call"] },
        }),
        requiredScopes: ["mcp:call"],
        ...overrides,
    };
    return new HttpAuthGuard(auth, "/mcp");
}

/** Minimal IncomingMessage stub carrying just the Authorization header. */
function reqWith(authorization?: string): IncomingMessage {
    return { headers: authorization ? { authorization } : {} } as unknown as IncomingMessage;
}

describe("HttpAuthGuard, resource & metadata URIs", () => {
    const guard = makeGuard();

    it("builds the canonical resource URI for a slot", () => {
        expect(guard.resourceFor("weather")).toBe("https://broker.test/weather/mcp");
    });

    it("builds the RFC 9728 metadata URL for a slot", () => {
        expect(guard.metadataUrlFor("weather")).toBe("https://broker.test/.well-known/oauth-protected-resource/weather/mcp");
    });

    it("emits a metadata document pointing at the authorization server", () => {
        const doc = guard.metadataFor("weather");
        expect(doc.resource).toBe("https://broker.test/weather/mcp");
        expect(doc.authorization_servers).toEqual(["https://as.test"]);
        expect(doc.bearer_methods_supported).toEqual(["header"]);
        expect(doc.scopes_supported).toEqual(["mcp:call"]);
    });

    it("matches metadata requests and extracts the slot", () => {
        expect(guard.matchMetadataRequest("/.well-known/oauth-protected-resource/weather/mcp")).toBe("weather");
        expect(guard.matchMetadataRequest("/.well-known/oauth-protected-resource/weather/sse")).toBeNull();
        expect(guard.matchMetadataRequest("/weather/mcp")).toBeNull();
        expect(guard.matchMetadataRequest("/.well-known/oauth-protected-resource/weather")).toBeNull();
    });
});

describe("HttpAuthGuard, authorize", () => {
    it("rejects a missing token with 401 invalid_token", async () => {
        const guard = makeGuard();
        await expect(guard.authorize(reqWith(), "s")).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    });

    it("rejects a non-Bearer scheme", async () => {
        const guard = makeGuard();
        await expect(guard.authorize(reqWith("Basic abc"), "s")).rejects.toMatchObject({ status: 401 });
    });

    it("rejects an unknown token with the validator's 401", async () => {
        const guard = makeGuard();
        await expect(guard.authorize(reqWith("Bearer nope"), "s")).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    });

    it("accepts a valid token with the required scope", async () => {
        const guard = makeGuard();
        const principal = await guard.authorize(reqWith("Bearer good"), "s");
        expect(principal.claims.sub).toBe("u1");
        expect(principal.scopes.has("mcp:call")).toBe(true);
        expect(principal.scopes.has("extra")).toBe(true);
    });

    it("accepts array-form scopes", async () => {
        const guard = makeGuard();
        const principal = await guard.authorize(reqWith("Bearer arrayscope"), "s");
        expect(principal.scopes.has("mcp:call")).toBe(true);
    });

    it("rejects a valid token lacking the required scope with 403", async () => {
        const guard = makeGuard();
        await expect(guard.authorize(reqWith("Bearer noscope"), "s")).rejects.toMatchObject({
            status: 403,
            code: "insufficient_scope",
            scope: "mcp:call",
        });
    });

    it("applies a per-slot scope override", async () => {
        const guard = makeGuard({ perSlotScopes: { _broker: ["admin"] } });
        // 'good' has mcp:call+extra but not 'admin' → 403 on _broker.
        await expect(guard.authorize(reqWith("Bearer good"), "_broker")).rejects.toMatchObject({ status: 403, scope: "admin" });
        // …but still passes on a normal slot needing only mcp:call.
        await expect(guard.authorize(reqWith("Bearer good"), "weather")).resolves.toBeTruthy();
    });

    it("treats an empty requiredScopes as 'any valid token'", async () => {
        const guard = makeGuard({ requiredScopes: [] });
        await expect(guard.authorize(reqWith("Bearer noscope"), "s")).resolves.toBeTruthy();
    });
});

describe("HttpAuthGuard, writeChallenge", () => {
    it("writes an RFC 9728 Bearer challenge on 401", () => {
        const guard = makeGuard();
        const captured = { headers: {} as Record<string, string>, status: 0, body: "" };
        const res = {
            setHeader: (n: string, v: string) => void (captured.headers[n.toLowerCase()] = v),
            writeHead: (s: number) => void (captured.status = s),
            end: (c?: string) => void (captured.body = c ?? ""),
        } as unknown as ServerResponse;

        guard.writeChallenge(res, "weather", new AuthError(401, "invalid_token", "Missing bearer token"));

        expect(captured.status).toBe(401);
        const header = captured.headers["www-authenticate"];
        expect(header).toContain('Bearer resource_metadata="https://broker.test/.well-known/oauth-protected-resource/weather/mcp"');
        expect(header).toContain('error="invalid_token"');
        expect(header).toContain('error_description="Missing bearer token"');
        expect(JSON.parse(captured.body)).toMatchObject({ error: "invalid_token" });
    });

    it("advertises the required scope on 403", () => {
        const guard = makeGuard();
        const captured = { headers: {} as Record<string, string>, status: 0 };
        const res = {
            setHeader: (n: string, v: string) => void (captured.headers[n.toLowerCase()] = v),
            writeHead: (s: number) => void (captured.status = s),
            end: () => undefined,
        } as unknown as ServerResponse;

        guard.writeChallenge(res, "s", new AuthError(403, "insufficient_scope", "nope", "mcp:call"));

        expect(captured.status).toBe(403);
        expect(captured.headers["www-authenticate"]).toContain('scope="mcp:call"');
    });
});
