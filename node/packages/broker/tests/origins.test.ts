import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { WsTunnelBuilder, type AllowedOrigins, type WsTunnel } from "../src/index";

/**
 * Origin validation on `/<slot>/mcp`.
 *
 * The endpoint is closed to browsers unless the operator opens it, and a client
 * that sends no `Origin` at all is never affected. These are the two halves the
 * spec's DNS-rebinding protection rests on, so both are pinned here.
 */

const INITIALIZE = JSON.stringify({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

let tunnel: WsTunnel | null = null;

async function start(allowed?: AllowedOrigins): Promise<string> {
    const builder = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1");
    if (allowed) builder.withAllowedOrigins(allowed);
    tunnel = builder.build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return `http://127.0.0.1:${server.address().port}`;
}

/** Opens a session on `_broker`, optionally posing as a browser. */
function post(base: string, origin?: string): Promise<Response> {
    return fetch(`${base}/_broker/mcp`, {
        method: "POST",
        headers: origin ? { origin } : {},
        body: INITIALIZE,
    });
}

afterEach(async () => {
    await tunnel?.stop();
    tunnel = null;
});

describe("browser origins on /<slot>/mcp", () => {
    it("accepts a client that sends no Origin, whatever the configuration", async () => {
        const base = await start();
        expect((await post(base)).status).toBe(200);
    });

    it("refuses every browser origin by default", async () => {
        const base = await start();
        expect((await post(base, "https://app.example.com")).status).toBe(403);
    });

    it("accepts exactly the origins listed", async () => {
        const base = await start(["https://app.example.com"]);
        expect((await post(base, "https://app.example.com")).status).toBe(200);
        expect((await post(base, "https://evil.example.com")).status).toBe(403);
        // Prefix, not whole-value: a suffix must not be enough to get in.
        expect((await post(base, "https://app.example.com.evil.test")).status).toBe(403);
    });

    it("accepts the origins a pattern matches", async () => {
        const base = await start(/^https:\/\/[a-z0-9-]+\.example\.com$/);
        expect((await post(base, "https://app.example.com")).status).toBe(200);
        expect((await post(base, "https://other.example.com")).status).toBe(200);
        expect((await post(base, "http://app.example.com")).status).toBe(403);
        expect((await post(base, "https://app.example.com.evil.test")).status).toBe(403);
    });

    it("keeps a global pattern stateless across requests", async () => {
        // A `g` regex advances `lastIndex` on every `test`, so the same origin
        // would be accepted and refused in turn if the flag leaked through.
        const base = await start(/^https:\/\/app\.example\.com$/g);
        expect((await post(base, "https://app.example.com")).status).toBe(200);
        expect((await post(base, "https://app.example.com")).status).toBe(200);
    });

    it("defers to a predicate when one is supplied", async () => {
        const base = await start((origin) => origin.endsWith(".example.com"));
        expect((await post(base, "https://anything.example.com")).status).toBe(200);
        expect((await post(base, "https://example.org")).status).toBe(403);
    });
});
