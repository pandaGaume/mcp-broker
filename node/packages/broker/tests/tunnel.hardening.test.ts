import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { WsTunnelBuilder } from "../src/index";
import type { WsTunnel } from "../src/ws/ws.tunnel";
import { openSession, sessionPost } from "./streamable.helper";

/**
 * The structural fixes on the WebSocket tunnel: per-sink request correlation,
 * request deadlines, slot takeover, handshake path rejection, and the two
 * framing-mismatch detectors.
 *
 * Every case here is a failure that used to be silent, which is why each
 * assertion checks a *named* outcome (an error the client can read, a close
 * reason, a refused handshake) rather than merely that nothing crashed.
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

/** Starts a tunnel on an ephemeral port and returns its `ws://` base URL. */
async function start(configure: (b: WsTunnelBuilder) => void = () => {}): Promise<string> {
    const builder = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1");
    configure(builder);
    tunnel = builder.build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Opens a socket and tracks it for teardown, resolving once it is open. */
async function open(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", (err) => reject(err));
    });
    return ws;
}

/** Attempts an upgrade and reports how it ended, without throwing. */
function attempt(url: string): Promise<{ opened: boolean; status?: number; body?: string }> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url);
        sockets.push(ws);
        const timer = setTimeout(() => resolve({ opened: false }), 3000);
        ws.once("open", () => {
            clearTimeout(timer);
            resolve({ opened: true });
        });
        ws.once("unexpected-response", (_req, res) => {
            clearTimeout(timer);
            // The refusal body carries the diagnosis, so it has to be drained
            // before the socket is torn down.
            let body = "";
            res.on("data", (chunk: Buffer) => {
                body += chunk.toString();
            });
            res.on("end", () => {
                resolve({ opened: false, status: res.statusCode, body });
                ws.terminate();
            });
        });
        ws.on("error", () => {
            /* a refused upgrade also emits an error */
        });
    });
}

/** Waits for the socket's close frame and reports its code and reason. */
function closure(ws: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
        ws.once("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
    });
}

/** Resolves with the next JSON-RPC frame the socket receives. */
function nextMessage(ws: WebSocket): Promise<IJsonRpc> {
    return new Promise((resolve) => {
        ws.once("message", (raw: Buffer) => resolve(JSON.parse(raw.toString()) as IJsonRpc));
    });
}

afterEach(async () => {
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

describe("pending requests are namespaced per client, not per slot", () => {
    it("keeps two clients that both chose id 1 apart, and renumbers on the wire", async () => {
        const base = await start();
        const provider = await open(`${base}/provider/echo`);

        // Answers with whatever `params.who` was sent, so a crossed response is
        // visible in the payload rather than only in the id.
        const seenIds: (string | number | null | undefined)[] = [];
        provider.on("message", (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as IJsonRpc;
            if (msg.id == null) return;
            seenIds.push(msg.id);
            provider.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { who: msg.params?.who } }));
        });

        const clientA = await open(`${base}/echo`);
        const clientB = await open(`${base}/echo`);
        const answerA = nextMessage(clientA);
        const answerB = nextMessage(clientB);

        // Both pick id 1, which used to make the second write evict the first:
        // one client received the other's result and its own request hung.
        clientA.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { who: "A" } }));
        clientB.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { who: "B" } }));

        const [a, b] = await Promise.all([answerA, answerB]);

        // Each client gets its own answer, addressed to the id it chose.
        expect(a.id).toBe(1);
        expect(a.result?.who).toBe("A");
        expect(b.id).toBe(1);
        expect(b.result?.who).toBe("B");

        // And the provider never saw the same id twice.
        expect(seenIds).toHaveLength(2);
        expect(seenIds[0]).not.toEqual(seenIds[1]);
    });

    it("keeps two Streamable HTTP sessions on one slot apart", async () => {
        // The reported failure, verbatim: two sessions on one slot both sending
        // id 2. One POST hung forever and the other received its result body.
        const base = await start();
        const http = base.replace("ws://", "http://");
        const provider = await open(`${base}/provider/echo`);
        provider.on("message", (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as IJsonRpc;
            if (msg.id == null) return;
            provider.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { who: msg.params?.who } }));
        });

        const a = await openSession(http, "echo");
        const b = await openSession(http, "echo");
        expect(a.sessionId).toBeTruthy();
        expect(b.sessionId).toBeTruthy();

        const call = (who: string): string => JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { who } });
        const [resA, resB] = await Promise.all([sessionPost(http, "echo", a.sessionId!, call("A")), sessionPost(http, "echo", b.sessionId!, call("B"))]);

        // Both POSTs answer, each with its own result, both addressed to id 2.
        expect(await resA.text()).toContain('"who":"A"');
        expect(await resB.text()).toContain('"who":"B"');
    });
});

describe("a request a provider never answers eventually fails", () => {
    it("returns a JSON-RPC error naming the slot and the deadline", async () => {
        const base = await start((b) => b.withProviderRequestTimeout(300));
        // A provider that connects, stays connected, and answers nothing: the
        // ordinary presentation of a throttled background browser tab.
        await open(`${base}/provider/mute`);

        const client = await open(`${base}/mute`);
        const answer = nextMessage(client);
        client.send(JSON.stringify({ jsonrpc: "2.0", id: "req-7", method: "tools/list" }));

        const error = await answer;
        expect(error.id).toBe("req-7");
        expect(error.error?.code).toBe(-32000);
        expect(error.error?.message).toContain('Provider "mute" did not respond within 300ms');
    });

    it("leaves the slot usable afterwards and clears the pending entry", async () => {
        const base = await start((b) => b.withProviderRequestTimeout(300));
        await open(`${base}/provider/mute`);
        const client = await open(`${base}/mute`);

        const answer = nextMessage(client);
        client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
        await answer;

        expect(tunnel?.getProviderInfo("mute")?.pendingCount).toBe(0);
    });
});

describe("the heartbeat", () => {
    it("leaves a responsive provider alone across several sweeps", async () => {
        // The failure this guards against is the expensive one: a heartbeat that
        // evicts healthy providers on a timer. `ws` answers a ping from the
        // protocol layer, so a connected socket must survive every sweep.
        const base = await start((b) => b.withProviderHeartbeat(80));
        const provider = await open(`${base}/provider/steady`);
        const client = await open(`${base}/steady`);

        await delay(500);

        expect(provider.readyState).toBe(WebSocket.OPEN);
        expect(tunnel?.getProviderInfo("steady")?.connected).toBe(true);

        // And it is still relaying afterwards, not merely still open.
        provider.on("message", (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as IJsonRpc;
            provider.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
        });
        const answer = nextMessage(client);
        client.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }));
        expect((await answer).result?.ok).toBe(true);
    });

    it("can be disabled, and then never takes a slot from anyone", async () => {
        const base = await start((b) => b.withProviderHeartbeat(0));
        await open(`${base}/provider/pinned`);

        const second = await open(`${base}/provider/pinned`);
        const closed = await closure(second);
        expect(closed.code).toBe(1008);
        // With no liveness evidence the broker refuses rather than guessing, and
        // says how to get the evidence.
        expect(tunnel?.getProviderInfo("pinned")?.connected).toBe(true);
    });
});

describe("slot takeover", () => {
    it("refuses a second provider while the incumbent still answers the heartbeat", async () => {
        const base = await start();
        await open(`${base}/provider/busy`);

        const second = await open(`${base}/provider/busy`);
        const closed = await closure(second);

        expect(closed.code).toBe(1008);
        expect(closed.reason).toContain('"busy"');
        // The refusal says what to do next rather than only what went wrong, and
        // it survives the 123-byte cap RFC 6455 puts on a close reason.
        expect(closed.reason).toContain("provider_status");
        expect(Buffer.byteLength(closed.reason, "utf8")).toBeLessThanOrEqual(123);
    });

    it("hands the slot over when the incumbent missed its heartbeat", async () => {
        const base = await start();
        const incumbent = await open(`${base}/provider/busy`);
        await delay(50);

        // Simulate the state a half-open socket reaches after one sweep: the
        // ping went out and no pong came back. Reaching into the tunnel is
        // deliberate; the alternative is waiting out a real heartbeat interval.
        const alive = (tunnel as unknown as { _alive: WeakMap<WebSocket, boolean> })._alive;
        const held = (tunnel as unknown as { _providers: Map<string, { ws: WebSocket | null }> })._providers.get("busy")?.ws;
        expect(held).toBeTruthy();
        alive.set(held!, false);

        const newcomer = await open(`${base}/provider/busy`);
        const evicted = closure(incumbent);
        await delay(100);

        // The newcomer holds the slot and the zombie was terminated.
        expect(newcomer.readyState).toBe(WebSocket.OPEN);
        expect(tunnel?.getProviderInfo("busy")?.connected).toBe(true);
        await evicted;
    });

    it('falls back to "liveness" for takeover mode "always" when provider auth is off', async () => {
        const base = await start((b) => b.withProviderTakeover("always"));
        await open(`${base}/provider/busy`);

        // Without an authenticator there are no principals to compare, so
        // honoring "always" would let anyone able to reach the URL evict the
        // real provider.
        const second = await open(`${base}/provider/busy`);
        const closed = await closure(second);
        expect(closed.code).toBe(1008);
    });
});

describe("WebSocket paths that cannot work are refused at the handshake", () => {
    it("refuses the bare provider prefix and a multi-segment slot", async () => {
        const base = await start();

        const bare = await attempt(`${base}/provider`);
        expect(bare.opened).toBe(false);
        expect(bare.status).toBe(400);
        expect(bare.body).toContain("/provider/<name>");

        const nested = await attempt(`${base}/provider/a/b`);
        expect(nested.opened).toBe(false);
        expect(nested.status).toBe(400);
        // The refusal names the spelling that does work.
        expect(nested.body).toContain("percent-encode");
    });

    it("keeps every path that does work", async () => {
        const base = await start();

        // A slot nobody configured: claiming a free slot by connecting is how a
        // provider registers, so this must stay accepted.
        expect((await attempt(`${base}/provider/brand-new`)).opened).toBe(true);
        // A hierarchical slot name, percent-encoded into one segment.
        expect((await attempt(`${base}/provider/%2Fsite-a%2Fline-3`)).opened).toBe(true);
        expect((await attempt(`${base}/providers`)).opened).toBe(true);
        expect((await attempt(`${base}/some-slot`)).opened).toBe(true);
        expect((await attempt(`${base}/`)).opened).toBe(true);
    });
});

describe("framing mismatches are named on the first frame", () => {
    it("refuses an envelope on the slot-scoped path and names both corrections", async () => {
        const base = await start();
        const provider = await open(`${base}/provider/scene`);
        const closed = closure(provider);

        // A MultiplexTransport pointed at a DirectTransport URL. Before this the
        // socket stayed open, reported connected, and answered nothing.
        provider.send(JSON.stringify({ provider: "scene", payload: { jsonrpc: "2.0", method: "notifications/register" } }));

        const end = await closed;
        expect(end.code).toBe(1008);
        expect(end.reason).toContain("DirectTransport");
        expect(end.reason).toContain("/providers");
        // RFC 6455 caps a close reason at 123 bytes; `ws` throws rather than truncating.
        expect(Buffer.byteLength(end.reason, "utf8")).toBeLessThanOrEqual(123);
    });

    it("refuses a plain JSON-RPC frame on the multiplexed path and replies in that framing", async () => {
        const base = await start();
        const provider = await open(`${base}/providers`);
        const reply = nextMessage(provider);
        const closed = closure(provider);

        // A DirectTransport pointed at the shared base.
        provider.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/register" }));

        // The diagnosis comes back as a bare frame, the only framing this peer
        // can read, and the close reason carries the short form.
        const error = await reply;
        expect(error.error?.message).toContain("MultiplexTransport");
        const end = await closed;
        expect(end.code).toBe(1008);
        expect(end.reason).toContain("/provider/<name>");
    });

    it("leaves a merely malformed first frame alone", async () => {
        const base = await start();
        const provider = await open(`${base}/provider/tolerant`);

        // Not an envelope and not JSON-RPC: a dialect the broker does not
        // recognize is not a wiring mistake, so the socket stays up.
        provider.send("not json at all");
        await delay(100);
        expect(provider.readyState).toBe(WebSocket.OPEN);
        expect(tunnel?.getProviderInfo("tolerant")?.connected).toBe(true);
    });

    it("still accepts the legacy registration control frame", async () => {
        const base = await start();
        const provider = await open(`${base}/provider/legacy`);
        provider.send(JSON.stringify({ type: "register", aggregate: true }));
        await delay(100);
        expect(provider.readyState).toBe(WebSocket.OPEN);
    });
});

describe("the aggregate opt-in has one shape on both paths", () => {
    /** Answers initialize / tools/list with a single tool named `<label>-tool`. */
    function serve(ws: WebSocket, label: string, wrap: boolean): void {
        ws.on("message", (raw: Buffer) => {
            const frame = JSON.parse(raw.toString()) as { provider?: string; payload?: IJsonRpc } & IJsonRpc;
            const msg = (wrap ? frame.payload : frame) as IJsonRpc;
            if (msg?.id == null) return;
            const result =
                msg.method === "initialize"
                    ? { protocolVersion: "2024-11-05", serverInfo: { name: label, version: "1" }, capabilities: { tools: {} } }
                    : msg.method === "tools/list"
                      ? { tools: [{ name: "tool", description: "a tool", inputSchema: { type: "object" } }] }
                      : null;
            if (!result) {
                const err = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
                ws.send(wrap ? JSON.stringify({ provider: label, payload: err }) : JSON.stringify(err));
                return;
            }
            const ok = { jsonrpc: "2.0", id: msg.id, result };
            ws.send(wrap ? JSON.stringify({ provider: label, payload: ok }) : JSON.stringify(ok));
        });
    }

    /** Polls `_all` until the named tool appears, or gives up. */
    async function aggregatedTools(base: string): Promise<string[]> {
        const client = await open(`${base}/_all`);
        let names: string[] = [];
        for (let i = 0; i < 60; i++) {
            const answer = nextMessage(client);
            client.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/list", params: {} }));
            const tools = ((await answer).result?.tools as Record<string, unknown>[]) ?? [];
            names = tools.map((t) => String(t.name)).filter((n) => !n.startsWith("_broker-"));
            if (names.length > 0) break;
            await delay(50);
        }
        return names;
    }

    it("honors params.aggregate on the slot-scoped path", async () => {
        const base = await start();
        const provider = await open(`${base}/provider/direct`);
        serve(provider, "direct", false);
        provider.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/register", params: { aggregate: true } }));

        expect(await aggregatedTools(base)).toEqual(["direct-tool"]);
    });

    it("honors params.aggregate on the multiplexed path, which could not aggregate at all before", async () => {
        const base = await start();
        const provider = await open(`${base}/providers`);
        serve(provider, "muxed", true);
        provider.send(JSON.stringify({ provider: "muxed", payload: { jsonrpc: "2.0", method: "notifications/register", params: { aggregate: true } } }));

        expect(await aggregatedTools(base)).toEqual(["muxed-tool"]);
    });

    it("still honors the legacy control frame on the multiplexed path", async () => {
        // The legacy `{type:"register"}` shape is kept working indefinitely for
        // hand-written providers, and it has to behave the same on both paths:
        // the slot-scoped one is covered above, this is its twin.
        const base = await start();
        const provider = await open(`${base}/providers`);
        serve(provider, "legacy-mux", true);
        provider.send(JSON.stringify({ provider: "legacy-mux", payload: { type: "register", aggregate: true } }));

        expect(await aggregatedTools(base)).toEqual(["legacy-mux-tool"]);
    });

    it("does not put a provider in `_all` unless it asked", async () => {
        const base = await start();
        const provider = await open(`${base}/provider/private`);
        serve(provider, "private", false);
        // The registration without `params`, which is what the SDK sends when
        // `aggregate` was not set. `_all` is a confidentiality boundary.
        provider.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/register" }));
        await delay(300);

        expect(await aggregatedTools(base)).toEqual([]);
    });
});
