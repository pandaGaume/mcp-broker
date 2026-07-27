import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { JwtTokenValidator, AuthError } from "../src/auth/index";

const ISSUER = "https://as.test";
const RESOURCE = "https://broker.test/weather/mcp";
const KID = "test-key-1";

let jwksServer: Server;
let jwksUri: string;
// Derived from the generator rather than named: jose v6 already dropped the
// `KeyLike` this used to import, and this form cannot go stale again.
type GeneratedKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let privateKey: GeneratedKey;
let validator: JwtTokenValidator;

/** Signs an RS256 JWT for the test key, overriding fields per case. */
async function sign(claims: Record<string, unknown>, opts: { aud?: string; exp?: string | number; iss?: string } = {}): Promise<string> {
    const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .setIssuedAt()
        .setIssuer(opts.iss ?? ISSUER)
        .setAudience(opts.aud ?? RESOURCE);
    jwt.setExpirationTime(opts.exp ?? "5m");
    return jwt.sign(privateKey);
}

beforeAll(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair("RS256");
    privateKey = priv;
    const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };
    const jwks = JSON.stringify({ keys: [jwk] });

    jwksServer = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(jwks);
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    jwksUri = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks`;

    validator = new JwtTokenValidator({ jwksUri, issuer: ISSUER });
});

afterAll(() => {
    jwksServer?.close();
});

describe("JwtTokenValidator", () => {
    it("accepts a well-formed token issued for the resource", async () => {
        const token = await sign({ sub: "user-1", scope: "mcp:call" });
        const claims = await validator.validate(token, RESOURCE);
        expect(claims.sub).toBe("user-1");
        expect(claims.scope).toBe("mcp:call");
        expect(claims.aud).toBe(RESOURCE);
    });

    it("rejects a token minted for a different audience (RFC 8707 binding)", async () => {
        const token = await sign({ sub: "user-1" }, { aud: "https://broker.test/other/mcp" });
        await expect(validator.validate(token, RESOURCE)).rejects.toBeInstanceOf(AuthError);
        await expect(validator.validate(token, RESOURCE)).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    });

    it("rejects a token from an unexpected issuer", async () => {
        const token = await sign({ sub: "user-1" }, { iss: "https://evil.test" });
        await expect(validator.validate(token, RESOURCE)).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    });

    it("rejects an expired token", async () => {
        const token = await sign({ sub: "user-1" }, { exp: Math.floor(Date.now() / 1000) - 60 });
        await expect(validator.validate(token, RESOURCE)).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    });

    it("rejects a token with a tampered signature", async () => {
        const token = await sign({ sub: "user-1" });
        const tampered = token.slice(0, -3) + (token.endsWith("AAA") ? "BBB" : "AAA");
        await expect(validator.validate(tampered, RESOURCE)).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    });

    it("rejects a token signed by an unknown key", async () => {
        const { privateKey: strangerKey } = await generateKeyPair("RS256");
        const token = await new SignJWT({ sub: "user-1" })
            .setProtectedHeader({ alg: "RS256", kid: "stranger" })
            .setIssuedAt()
            .setIssuer(ISSUER)
            .setAudience(RESOURCE)
            .setExpirationTime("5m")
            .sign(strangerKey);
        await expect(validator.validate(token, RESOURCE)).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    });
});
