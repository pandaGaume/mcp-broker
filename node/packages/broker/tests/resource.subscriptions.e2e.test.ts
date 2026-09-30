import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { AuthError, WsTunnelBuilder, compileAuthorizationPolicy, type IResolvedAuth, type ITokenValidator, type WsTunnel } from "../src/index";
import { mcpCall, openSession, sessionPost } from "./streamable.helper";

/**
 * `resources/subscribe` across the tunnel, end to end.
 *
 * The provider here is a raw socket that records every frame, so each test can
 * assert what actually reached it: one subscribe per URI however many clients
 * asked, one unsubscribe when the last one leaves, and a replay after a
 * reconnect. Clients are real transports: raw WebSocket, legacy SSE and
 * Streamable HTTP.
 */

interface IJsonRpc {
    jsonrpc: "2.0";
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let tunnel: WsTunnel | null = null;
const sockets: WebSocket[] = [];
const aborts: AbortController[] = [];

afterEach(async () => {
    for (const a of aborts) a.abort();
    aborts.length = 0;
    for (const s of sockets) {
        try {
            s.terminate();
        } catch {
            /* ignore */
        }
    }
    sockets.length = 0;
    await tunnel?.stop();
    tunnel = null;
});

async function start(configure: (b: WsTunnelBuilder) => void = () => {}): Promise<{ ws: string; http: string }> {
    const builder = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1");
    configure(builder);
    tunnel = builder.build();
    await tunnel.start();
    const port = ((tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer.address() as AddressInfo).port;
    return { ws: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
}

/** A socket that keeps every frame it receives, and can wait for one. */
class Peer {
    readonly frames: IJsonRpc[] = [];
    private _waiters: { match: (m: IJsonRpc) => boolean; resolve: (m: IJsonRpc) => void }[] = [];

    constructor(readonly ws: WebSocket) {
        ws.on("message", (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as IJsonRpc;
            this.frames.push(msg);
            this._waiters = this._waiters.filter((w) => {
                if (!w.match(msg)) return true;
                w.resolve(msg);
                return false;
            });
        });
    }

    /** `onFrame` is installed before the socket opens, like a real provider installs its handler. */
    static async open(url: string, onFrame?: (peer: Peer, msg: IJsonRpc) => void): Promise<Peer> {
        const ws = new WebSocket(url);
        sockets.push(ws);
        const peer = new Peer(ws);
        if (onFrame) ws.on("message", (raw: Buffer) => onFrame(peer, JSON.parse(raw.toString()) as IJsonRpc));
        await new Promise<void>((resolve, reject) => {
            ws.once("open", () => resolve());
            ws.once("error", reject);
        });
        return peer;
    }

    send(msg: Record<string, unknown>): void {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...msg }));
    }

    next(match: (m: IJsonRpc) => boolean, timeoutMs = 2000): Promise<IJsonRpc> {
        const seen = this.frames.find(match);
        if (seen) return Promise.resolve(seen);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
            this._waiters.push({
                match,
                resolve: (m) => {
                    clearTimeout(timer);
                    resolve(m);
                },
            });
        });
    }

    /** Sends a request and resolves with its answer. */
    async request(id: number, method: string, params?: Record<string, unknown>): Promise<IJsonRpc> {
        const answer = this.next((m) => m.id === id && m.method === undefined);
        this.send({ id, method, params });
        return answer;
    }

    updates(uri?: string): IJsonRpc[] {
        return this.frames.filter((m) => m.method === "notifications/resources/updated" && (uri === undefined || m.params?.uri === uri));
    }
}

/**
 * A provider that answers every request with an empty result and records
 * what it was asked. `refuse` makes it answer `resources/subscribe` with an
 * error for the listed URIs.
 */
async function scriptedProvider(url: string, refuse: string[] = []): Promise<Peer> {
    return Peer.open(url, (provider, msg) => {
        if (msg.id == null || msg.method === undefined) return;
        if (msg.method === "resources/subscribe" && refuse.includes(String(msg.params?.uri))) {
            provider.send({ id: msg.id, error: { code: -32002, message: "Resource not found" } });
            return;
        }
        provider.send({ id: msg.id, result: {} });
    });
}

const sent = (provider: Peer, method: string) => provider.frames.filter((m) => m.method === method);

/** Reads an SSE response body and keeps every JSON `data:` payload. */
function sseReader(response: Response) {
    const messages: IJsonRpc[] = [];
    const endpoints: string[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
        const reader = response.body!.getReader();
        for (;;) {
            let chunk;
            try {
                chunk = await reader.read();
            } catch {
                return;
            }
            if (chunk.done) return;
            buffer += decoder.decode(chunk.value, { stream: true });
            let cut: number;
            while ((cut = buffer.indexOf("\n\n")) >= 0) {
                const block = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                const event = /^event: (.*)$/m.exec(block)?.[1];
                const data = /^data: (.*)$/m.exec(block)?.[1];
                if (data === undefined) continue;
                if (event === "endpoint") endpoints.push(data);
                else {
                    try {
                        messages.push(JSON.parse(data) as IJsonRpc);
                    } catch {
                        /* not JSON-RPC */
                    }
                }
            }
        }
    })();
    return {
        messages,
        endpoints,
        async wait<T>(check: () => T | undefined, timeoutMs = 2000): Promise<T> {
            const until = Date.now() + timeoutMs;
            for (;;) {
                const value = check();
                if (value !== undefined) return value;
                if (Date.now() > until) throw new Error("timed out waiting on the SSE stream");
                await delay(10);
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Aggregation towards a provider
// ---------------------------------------------------------------------------

describe("resources/subscribe on a provider slot", () => {
    it("sends one upstream subscribe for two clients and routes updates to subscribers only", async () => {
        const { ws } = await start();
        const provider = await scriptedProvider(`${ws}/provider/plant`);
        const a = await Peer.open(`${ws}/plant`);
        const b = await Peer.open(`${ws}/plant`);
        const bystander = await Peer.open(`${ws}/plant`);

        expect((await a.request(1, "resources/subscribe", { uri: "plant://gauge" })).result).toEqual({});
        expect((await b.request(1, "resources/subscribe", { uri: "plant://gauge" })).result).toEqual({});
        expect(sent(provider, "resources/subscribe")).toHaveLength(1);

        provider.send({ method: "notifications/resources/updated", params: { uri: "plant://gauge" } });
        await a.next((m) => m.method === "notifications/resources/updated");
        await b.next((m) => m.method === "notifications/resources/updated");
        await delay(100);
        expect(bystander.updates()).toEqual([]);
    });

    it("sends one upstream unsubscribe, when the last subscriber leaves", async () => {
        const { ws } = await start();
        const provider = await scriptedProvider(`${ws}/provider/plant`);
        const a = await Peer.open(`${ws}/plant`);
        const b = await Peer.open(`${ws}/plant`);
        await a.request(1, "resources/subscribe", { uri: "plant://gauge" });
        await b.request(1, "resources/subscribe", { uri: "plant://gauge" });

        expect((await a.request(2, "resources/unsubscribe", { uri: "plant://gauge" })).result).toEqual({});
        await delay(50);
        expect(sent(provider, "resources/unsubscribe")).toHaveLength(0);

        await b.request(2, "resources/unsubscribe", { uri: "plant://gauge" });
        await provider.next((m) => m.method === "resources/unsubscribe");
        expect(sent(provider, "resources/unsubscribe")).toHaveLength(1);

        provider.send({ method: "notifications/resources/updated", params: { uri: "plant://gauge" } });
        await delay(100);
        expect(a.updates()).toEqual([]);
        expect(b.updates()).toEqual([]);
    });

    it("releases a client's subscriptions when its socket closes", async () => {
        const { ws } = await start();
        const provider = await scriptedProvider(`${ws}/provider/plant`);
        const a = await Peer.open(`${ws}/plant`);
        await a.request(1, "resources/subscribe", { uri: "plant://gauge" });
        a.ws.close();
        await provider.next((m) => m.method === "resources/unsubscribe");
        expect(tunnel!.getProviderInfo("plant")?.resourceSubscriptionCount).toBe(0);
    });

    it("relays the provider's refusal and holds nothing", async () => {
        const { ws } = await start();
        await scriptedProvider(`${ws}/provider/plant`, ["plant://gone"]);
        const a = await Peer.open(`${ws}/plant`);
        const answer = await a.request(1, "resources/subscribe", { uri: "plant://gone" });
        expect(answer.error?.code).toBe(-32002);
        expect(tunnel!.getProviderInfo("plant")?.resourceSubscriptionCount).toBe(0);
    });

    it("never broadcasts an update without a URI", async () => {
        const { ws } = await start();
        const provider = await scriptedProvider(`${ws}/provider/plant`);
        const a = await Peer.open(`${ws}/plant`);
        await a.request(1, "resources/subscribe", { uri: "plant://gauge" });
        provider.send({ method: "notifications/resources/updated", params: {} });
        provider.send({ method: "notifications/resources/updated" });
        await delay(100);
        expect(a.updates()).toEqual([]);
    });

    it("still broadcasts the other notifications", async () => {
        const { ws } = await start();
        const provider = await scriptedProvider(`${ws}/provider/plant`);
        const a = await Peer.open(`${ws}/plant`);
        provider.send({ method: "notifications/resources/list_changed" });
        await a.next((m) => m.method === "notifications/resources/list_changed");
    });

    it("re-handshakes a reconnected provider, replays once per URI, and tells subscribers to re-read", async () => {
        const { ws } = await start();
        const first = await scriptedProvider(`${ws}/provider/plant`);
        const a = await Peer.open(`${ws}/plant`);
        const b = await Peer.open(`${ws}/plant`);
        await a.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "client-a", version: "1" } });
        await a.request(2, "resources/subscribe", { uri: "plant://gauge" });
        await b.request(1, "resources/subscribe", { uri: "plant://gauge" });

        first.ws.close();
        await delay(50);
        const second = await scriptedProvider(`${ws}/provider/plant`);
        await second.next((m) => m.method === "resources/subscribe");

        // The handshake comes first, with the last client's initialize.
        const methods = second.frames.map((m) => m.method);
        expect(methods.indexOf("initialize")).toBeLessThan(methods.indexOf("resources/subscribe"));
        expect(second.frames.find((m) => m.method === "initialize")?.params?.clientInfo).toEqual({ name: "client-a", version: "1" });
        expect(methods).toContain("notifications/initialized");
        await delay(50);
        expect(sent(second, "resources/subscribe")).toHaveLength(1);

        await a.next((m) => m.method === "notifications/resources/updated");
        await b.next((m) => m.method === "notifications/resources/updated");

        second.send({ method: "notifications/resources/updated", params: { uri: "plant://gauge" } });
        await delay(100);
        expect(a.updates("plant://gauge")).toHaveLength(2);
    });

    it("refuses a subscription past the per-client limit", async () => {
        const { ws } = await start((b) => b.withResourceSubscriptionLimits({ maxSubscriptionsPerClient: 1 }));
        await scriptedProvider(`${ws}/provider/plant`);
        const a = await Peer.open(`${ws}/plant`);
        expect((await a.request(1, "resources/subscribe", { uri: "plant://1" })).result).toEqual({});
        const refused = await a.request(2, "resources/subscribe", { uri: "plant://2" });
        expect(refused.error?.code).toBe(-32000);
        expect(refused.error?.message).toContain("maxSubscriptionsPerClient");
    });

    it("serves an in-process client like any other: updates delivered, released on close", async () => {
        const { ws } = await start();
        const provider = await scriptedProvider(`${ws}/provider/plant`);
        const internal = tunnel!.openInternalClient("plant");
        const received: IJsonRpc[] = [];
        internal.onMessage = (data) => received.push(JSON.parse(data) as IJsonRpc);

        internal.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: { uri: "plant://gauge" } }));
        await provider.next((m) => m.method === "resources/subscribe");
        await delay(50);
        expect(received.find((m) => m.id === 1)?.result).toEqual({});

        provider.send({ method: "notifications/resources/updated", params: { uri: "plant://gauge" } });
        await delay(100);
        expect(received.filter((m) => m.method === "notifications/resources/updated")).toHaveLength(1);

        internal.close();
        await provider.next((m) => m.method === "resources/unsubscribe");
        expect(tunnel!.getProviderInfo("plant")?.resourceSubscriptionCount).toBe(0);
    });

    it("leaves _all alone: it still answers resources methods with -32601", async () => {
        const { ws } = await start();
        const a = await Peer.open(`${ws}/_all`);
        const answer = await a.request(1, "resources/subscribe", { uri: "broker://providers" });
        expect(answer.error?.code).toBe(-32601);
    });
});

// ---------------------------------------------------------------------------
// _broker
// ---------------------------------------------------------------------------

describe("resources/subscribe on _broker", () => {
    it("announces subscribe and notifies broker://providers when a provider connects", async () => {
        const { ws } = await start();
        const client = await Peer.open(`${ws}/_broker`);
        const bystander = await Peer.open(`${ws}/_broker`);

        const init = await client.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });
        expect((init.result?.capabilities as { resources?: unknown }).resources).toEqual({ subscribe: true, listChanged: true });
        client.send({ method: "notifications/initialized" });

        expect((await client.request(2, "resources/subscribe", { uri: "broker://providers" })).result).toEqual({});
        expect((await client.request(3, "resources/subscribe", { uri: "broker://providers/hq-spoony01" })).result).toEqual({});

        await scriptedProvider(`${ws}/provider/hq-spoony01`);
        await client.next((m) => m.method === "notifications/resources/updated" && m.params?.uri === "broker://providers");
        await client.next((m) => m.method === "notifications/resources/updated" && m.params?.uri === "broker://providers/hq-spoony01");

        // The read that follows is live, not the snapshot cached at first read.
        const read = await client.request(4, "resources/read", { uri: "broker://providers/hq-spoony01" });
        const info = JSON.parse((read.result?.contents as { text: string }[])[0].text) as { connected: boolean };
        expect(info.connected).toBe(true);

        await delay(100);
        expect(bystander.updates()).toEqual([]);
    });

    it("notifies on disconnect too", async () => {
        const { ws } = await start();
        const client = await Peer.open(`${ws}/_broker`);
        const provider = await scriptedProvider(`${ws}/provider/plant`);
        await delay(50);
        await client.request(1, "resources/subscribe", { uri: "broker://providers/plant" });
        provider.ws.close();
        await client.next((m) => m.method === "notifications/resources/updated" && m.params?.uri === "broker://providers/plant");
    });
});

// ---------------------------------------------------------------------------
// Same behavior on legacy SSE and Streamable HTTP
// ---------------------------------------------------------------------------

describe("resources/subscribe over HTTP transports", () => {
    it("works over legacy SSE, and closing the stream releases the subscription", async () => {
        const { ws, http } = await start();
        const provider = await scriptedProvider(`${ws}/provider/plant`);

        const abort = new AbortController();
        aborts.push(abort);
        const stream = sseReader(await fetch(`${http}/plant/sse`, { signal: abort.signal }));
        const endpoint = await stream.wait(() => stream.endpoints[0]);

        await fetch(`${http}${endpoint}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "resources/subscribe", params: { uri: "plant://gauge" } }) });
        await stream.wait(() => stream.messages.find((m) => m.id === 7));
        expect(sent(provider, "resources/subscribe")).toHaveLength(1);

        provider.send({ method: "notifications/resources/updated", params: { uri: "plant://gauge" } });
        await stream.wait(() => stream.messages.find((m) => m.method === "notifications/resources/updated"));

        abort.abort();
        await provider.next((m) => m.method === "resources/unsubscribe");
    });

    it("works over Streamable HTTP, and DELETE releases the subscription", async () => {
        const { ws, http } = await start();
        const provider = await scriptedProvider(`${ws}/provider/plant`);
        const { sessionId } = await openSession(http, "plant");
        expect(sessionId).toBeTruthy();

        const abort = new AbortController();
        aborts.push(abort);
        const stream = sseReader(await fetch(`${http}/plant/mcp`, { headers: { accept: "text/event-stream", "mcp-session-id": sessionId! }, signal: abort.signal }));

        const answer = await sessionPost(http, "plant", sessionId!, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "resources/subscribe", params: { uri: "plant://gauge" } }));
        const body = await answer.text();
        expect(body).toContain('"result":{}');

        provider.send({ method: "notifications/resources/updated", params: { uri: "plant://gauge" } });
        await stream.wait(() => stream.messages.find((m) => m.method === "notifications/resources/updated"));

        await fetch(`${http}/plant/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId! } });
        await provider.next((m) => m.method === "resources/unsubscribe");
    });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe("resources/subscribe under an authorization policy", () => {
    const validator: ITokenValidator = {
        async validate(token, resource) {
            if (token === "reader" || token === "stranger") return { sub: token, aud: resource, scope: "mcp:call" };
            throw new AuthError(401, "invalid_token");
        },
    };
    const authorization = compileAuthorizationPolicy({
        subjectMapping: { userClaim: "sub" },
        roles: { reader: { capabilities: ["mcp.resources.read"] } },
        assignments: [{ id: "reader-plant", subject: "user:reader", role: "reader", resource: "/site/plant" }],
        slotResources: { plant: "/site/plant" },
    });
    const auth: IResolvedAuth = {
        publicBaseUrl: "https://broker.test",
        authorizationServers: ["https://as.test"],
        validator,
        requiredScopes: ["mcp:call"],
        authorization,
        slotResourceResolver: authorization.slotResourceResolver,
    };
    const SUBSCRIBE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: { uri: "plant://gauge" } });
    const UNSUBSCRIBE = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/unsubscribe", params: { uri: "plant://gauge" } });

    it("refuses a subscription without mcp.resources.read on the slot, and never refuses an unsubscribe", async () => {
        const { http } = await start((b) => b.withAuth(auth));

        const denied = (await (await mcpCall(http, "plant", SUBSCRIBE, { authorization: "Bearer stranger" })).json()) as IJsonRpc;
        expect(denied.error?.code).toBe(-32001);

        // Allowed by policy; it then fails only because nothing serves the slot.
        const allowed = (await (await mcpCall(http, "plant", SUBSCRIBE, { authorization: "Bearer reader" })).json()) as IJsonRpc;
        expect(allowed.error?.code).toBe(-32000);
        expect(allowed.error?.message).toContain("not connected");

        const unsubscribed = (await (await mcpCall(http, "plant", UNSUBSCRIBE, { authorization: "Bearer stranger" })).json()) as IJsonRpc;
        expect(unsubscribed.result).toEqual({});
    });
});
