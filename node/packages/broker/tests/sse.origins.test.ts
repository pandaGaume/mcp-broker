import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { WsTunnelBuilder, type AllowedOrigins, type WsTunnel } from "../src/index";

/**
 * Origin validation on the **legacy SSE** pair, `/<slot>/sse` and
 * `/<slot>/messages`.
 *
 * `origins.test.ts` covers `/<slot>/mcp`, where the check lives in mcp-core.
 * These two endpoints are the broker's own, and until now they evaluated no
 * origin at all: with `Access-Control-Allow-Origin: *` set unconditionally and
 * a POST of JSON qualifying as a CORS *simple* request, any page the operator's
 * browser happened to load could open an `EventSource` on a slot, read the
 * session id off the `endpoint` event, and drive the broker. Both halves of the
 * contract are pinned here: no `Origin` always passes, and an `Origin` passes
 * only when it was named.
 */

let tunnel: WsTunnel | null = null;

async function start(allowed?: AllowedOrigins): Promise<string> {
    const builder = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1");
    if (allowed) builder.withAllowedOrigins(allowed);
    tunnel = builder.build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Opens the SSE stream, optionally posing as a browser, and returns the status.
 * The request is aborted immediately afterwards: an accepted SSE response never
 * ends on its own, so leaving it open would hang the test file.
 */
async function sseConnect(base: string, origin?: string): Promise<{ status: number; body: string }> {
    const controller = new AbortController();
    try {
        const res = await fetch(`${base}/_broker/sse`, { headers: origin ? { origin } : {}, signal: controller.signal });
        // Only a refusal has a body that terminates.
        const body = res.status === 200 ? "" : await res.text();
        return { status: res.status, body };
    } finally {
        controller.abort();
    }
}

/**
 * Posts to the legacy message endpoint. The session id is deliberately unknown:
 * the origin check runs before the session lookup, so an allowed caller gets the
 * `400` for the missing session and a refused one never reaches it.
 */
async function sseMessage(base: string, origin?: string): Promise<number> {
    const res = await fetch(`${base}/_broker/messages?sessionId=not-a-session`, {
        method: "POST",
        headers: origin ? { origin, "content-type": "application/json" } : { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    await res.text();
    return res.status;
}

afterEach(async () => {
    await tunnel?.stop();
    tunnel = null;
});

describe("browser origins on the legacy SSE transport", () => {
    it("accepts a client that sends no Origin, whatever the configuration", async () => {
        const base = await start();
        expect((await sseConnect(base)).status).toBe(200);
        // 400: the origin check passed and the unknown session id was reached.
        expect(await sseMessage(base)).toBe(400);
    });

    it("refuses every browser origin by default, on both endpoints", async () => {
        const base = await start();
        const stream = await sseConnect(base, "https://evil.example.com");
        expect(stream.status).toBe(403);
        expect(await sseMessage(base, "https://evil.example.com")).toBe(403);
    });

    it("names the refused origin and how to allow it", async () => {
        const base = await start();
        const stream = await sseConnect(base, "https://app.example.com");
        expect(stream.status).toBe(403);
        const payload = JSON.parse(stream.body) as { error: string; error_description: string };
        expect(payload.error).toBe("invalid_origin");
        // The refused value is echoed, and the fix is named rather than implied.
        expect(payload.error_description).toContain("https://app.example.com");
        expect(payload.error_description).toContain("MCP_BROKER_ALLOWED_ORIGINS");
    });

    it("accepts exactly the origins listed", async () => {
        const base = await start(["https://app.example.com"]);
        expect((await sseConnect(base, "https://app.example.com")).status).toBe(200);
        expect((await sseConnect(base, "https://evil.example.com")).status).toBe(403);
        expect(await sseMessage(base, "https://app.example.com")).toBe(400);
        expect(await sseMessage(base, "https://evil.example.com")).toBe(403);
    });

    it("uses the same predicate as /<slot>/mcp, including a pattern", async () => {
        const base = await start(/^https:\/\/[a-z0-9-]+\.example\.com$/);
        expect((await sseConnect(base, "https://other.example.com")).status).toBe(200);
        expect((await sseConnect(base, "http://other.example.com")).status).toBe(403);
    });
});
