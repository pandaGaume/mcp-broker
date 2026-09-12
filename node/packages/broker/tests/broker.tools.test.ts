import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { WsTunnelBuilder } from "../src/index";
import type { WsTunnel } from "../src/ws/ws.tunnel";
import { BROKER_GUIDES, BROKER_GUIDE_TOPICS, BROKER_GUIDE_URI_TEMPLATE } from "../src/broker/broker.guides";

/**
 * The two self-service surfaces on the reserved `_broker` slot: `broker_guide`,
 * which hands an agent the integration documentation without it having to find
 * a README, and `broker_diagnose`, which correlates the live counters into a
 * named problem with a fix.
 *
 * Both are exercised over a real tunnel through a raw WebSocket client, the
 * same way an integrator reaches them, rather than against the adapters
 * directly: what matters is that they are *discoverable* (listed in
 * `tools/list` and `resources/list`) and that the payload survives the round
 * trip, not that the adapter returns a string.
 */

interface IJsonRpc {
    jsonrpc: "2.0";
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
}

interface IToolResult {
    content?: { type: string; text?: string }[];
    isError?: boolean;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let tunnel: WsTunnel | null = null;
const sockets: WebSocket[] = [];

/**
 * Starts a tunnel and returns its `ws://` base URL.
 *
 * `explicitPort` matters for the pages and the diagnosis: both build their URLs
 * from `IBrokerContext.port`, which reports the port that was *configured*.
 * Under `withPort(0)` that is `0`, so the block would advertise `:0`. A test
 * about "the block carries the values in force here" therefore has to configure
 * a real port, the way a deployment does.
 */
async function start(explicitPort?: number): Promise<string> {
    tunnel = new WsTunnelBuilder()
        .withPort(explicitPort ?? 0)
        .withHost("127.0.0.1")
        .build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Reserves an ephemeral port, then releases it so the tunnel can configure it. */
async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const chosen = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    return chosen;
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

/** A JSON-RPC client over a raw WebSocket, correlating by numeric id. */
async function rpcClient(url: string): Promise<{ request(method: string, params?: Record<string, unknown>): Promise<IJsonRpc> }> {
    const ws = await open(url);
    const pending = new Map<number, (msg: IJsonRpc) => void>();
    let nextId = 0;

    ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as IJsonRpc;
        if (typeof msg.id === "number" && pending.has(msg.id)) {
            pending.get(msg.id)?.(msg);
            pending.delete(msg.id);
        }
    });

    return {
        request(method, params = {}) {
            const id = ++nextId;
            return new Promise((resolve) => {
                pending.set(id, resolve);
                ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            });
        },
    };
}

/** The single text block of a tool result, or `""` when there is none. */
function textOf(msg: IJsonRpc): string {
    const result = msg.result as IToolResult | undefined;
    return result?.content?.find((c) => c.type === "text")?.text ?? "";
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

describe("broker_guide", () => {
    it("is listed as a tool, and every page is listed as its own resource", async () => {
        const base = await start();
        const broker = await rpcClient(`${base}/_broker`);

        const tools = ((await broker.request("tools/list")).result?.tools as { name: string; description?: string }[]) ?? [];
        const names = tools.map((t) => t.name);
        // Alongside the three pre-existing ones, which must not have been lost.
        expect(names).toEqual(expect.arrayContaining(["broker_info", "providers_list", "provider_status", "broker_guide", "broker_diagnose"]));
        expect(tools.find((t) => t.name === "broker_guide")?.description).toBeTruthy();

        const resources = ((await broker.request("resources/list")).result?.resources as { uri: string; name?: string }[]) ?? [];
        const uris = resources.map((r) => r.uri);
        // Individually, not merely behind the template: a client that never
        // reads a template must still be able to see that a troubleshooting
        // page exists without guessing its name.
        for (const guide of BROKER_GUIDES) expect(uris).toContain(guide.uri);

        const templates = ((await broker.request("resources/templates/list")).result?.resourceTemplates as { uriTemplate: string }[]) ?? [];
        expect(templates.map((t) => t.uriTemplate)).toContain(BROKER_GUIDE_URI_TEMPLATE);
    });

    it("serves a page as a resource, with this broker's own configuration appended", async () => {
        const port = await freePort();
        const base = await start(port);
        const broker = await rpcClient(`${base}/_broker`);

        const read = await broker.request("resources/read", { uri: "broker://guide/troubleshooting" });
        const contents = (read.result?.contents as { uri: string; mimeType?: string; text?: string }[]) ?? [];
        expect(contents).toHaveLength(1);
        expect(contents[0].mimeType).toBe("text/markdown");

        const text = contents[0].text ?? "";
        expect(text.length).toBeGreaterThan(1000);
        // The live block is the reason the prose can never silently contradict
        // the deployment, so it has to carry the real port.
        expect(text).toContain("Effective configuration of this broker");
        expect(text).toContain(`127.0.0.1:${port}`);
    });

    it("returns the index when called with no topic, and a named page when given one", async () => {
        const base = await start();
        const broker = await rpcClient(`${base}/_broker`);

        const index = await broker.request("tools/call", { name: "broker_guide", arguments: {} });
        expect((index.result as IToolResult).isError).toBeFalsy();
        // A single discovery call is already useful: it hands back the index
        // page itself rather than a list of links.
        expect(textOf(index)).toContain("publish-provider");
        expect(textOf(index)).toContain("troubleshooting");

        const page = await broker.request("tools/call", { name: "broker_guide", arguments: { topic: "publish-provider" } });
        const body = textOf(page);
        // The pairing rule is the single fact this page exists to carry.
        expect(body).toContain("DirectTransport");
        expect(body).toContain("MultiplexTransport");
        expect(body).toContain("/providers");
    });

    it("names every valid topic when given one that does not exist", async () => {
        const base = await start();
        const broker = await rpcClient(`${base}/_broker`);

        const bad = await broker.request("tools/call", { name: "broker_guide", arguments: { topic: "nope" } });
        expect((bad.result as IToolResult).isError).toBe(true);
        const message = textOf(bad);
        expect(message).toContain('"nope"');
        for (const topic of BROKER_GUIDE_TOPICS) expect(message).toContain(topic);
    });
});

describe("broker_diagnose", () => {
    /** Calls the tool and parses the JSON payload it returns. */
    async function diagnose(broker: { request(method: string, params?: Record<string, unknown>): Promise<IJsonRpc> }, args: Record<string, unknown> = {}): Promise<IJsonRpc> {
        return broker.request("tools/call", { name: "broker_diagnose", arguments: args });
    }

    it("reports the live state of a healthy broker without inventing problems", async () => {
        const base = await start();
        const broker = await rpcClient(`${base}/_broker`);

        const answer = await diagnose(broker);
        expect((answer.result as IToolResult).isError).toBeFalsy();
        const report = JSON.parse(textOf(answer)) as {
            broker: { name: string; startedAt: string | null; endpoints: Record<string, string> };
            slots: { name: string; reserved: boolean }[];
            problems: { id: string; fix: string }[];
            checksSkipped: { id: string; reason: string }[];
        };

        expect(report.broker.startedAt).toBeTruthy();
        // The endpoints are ready to paste, not templates the caller assembles.
        expect(report.broker.endpoints.providers).toContain("/providers");
        expect(report.slots.find((s) => s.name === "_broker")?.reserved).toBe(true);
        // Nothing is wrong, so no rule may claim otherwise; a rule whose input
        // is unreachable is reported as skipped rather than guessed at.
        expect(report.problems.some((p) => p.id === "transport-path-mismatch")).toBe(false);
        expect(Array.isArray(report.checksSkipped)).toBe(true);
        // Every problem, whatever it is, ends in an action.
        for (const problem of report.problems) expect(problem.fix.length).toBeGreaterThan(20);
    });

    it("names the transport/path mismatch when a slot has work in flight and no answers", async () => {
        // The reported field failure: a MultiplexTransport connected to the
        // slot-scoped path. The slot registers from the URL, so it reports
        // itself connected, and every plain frame the broker writes is
        // discarded. `pendingCount` is the only externally visible trace, which
        // is exactly the correlation this rule does for the caller.
        const base = await start();
        await open(`${base}/provider/graph-editor`);
        const client = await open(`${base}/graph-editor`);
        client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
        await delay(200);

        expect(tunnel?.getProviderInfo("graph-editor")?.pendingCount).toBeGreaterThan(0);

        const broker = await rpcClient(`${base}/_broker`);
        const report = JSON.parse(textOf(await diagnose(broker, { slot: "graph-editor" }))) as {
            problems: { id: string; severity: string; slot?: string; evidence: Record<string, unknown>; fix: string }[];
        };

        const problem = report.problems.find((p) => p.id === "transport-path-mismatch");
        expect(problem).toBeTruthy();
        expect(problem!.severity).toBe("error");
        expect(problem!.slot).toBe("graph-editor");
        expect(problem!.evidence.transport).toBe("ws");
        // The fix restates the whole pairing rule inline, so a caller acting on
        // this one entry needs nothing else.
        expect(problem!.fix).toContain("MultiplexTransport");
        expect(problem!.fix).toContain("DirectTransport");
        expect(problem!.fix).toContain("/provider/graph-editor");
        expect(problem!.fix).toContain("/providers");
    });

    it("refuses a slot it has never heard of, and says how to list the real ones", async () => {
        const base = await start();
        const broker = await rpcClient(`${base}/_broker`);

        const answer = await diagnose(broker, { slot: "typo-slot" });
        expect((answer.result as IToolResult).isError).toBe(true);
        const message = textOf(answer);
        expect(message).toContain("typo-slot");
        expect(message).toContain("providers_list");
        expect(message).toContain("case-sensitive");
    });
});
