import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { WsTunnelBuilder } from "../src/index";
import { LimitController } from "../src/limits/controller";
import type { WsTunnel } from "../src/ws/ws.tunnel";

/**
 * `notifications/cancelled` through the tunnel.
 *
 * The broker renumbers every request, so a client's cancellation names an id
 * the provider never saw. These cases pin the translation, and the refusal
 * that keeps one client from cancelling another's request with the
 * predictable broker ids.
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

async function start(): Promise<string> {
    tunnel = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1").build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function open(url: string, onOpen?: (ws: WebSocket) => void): Promise<WebSocket> {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
        ws.once("open", () => {
            onOpen?.(ws);
            resolve();
        });
        ws.once("error", (err) => reject(err));
    });
    return ws;
}

/** Collects every frame a socket receives. */
function record(ws: WebSocket): IJsonRpc[] {
    const frames: IJsonRpc[] = [];
    ws.on("message", (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString()) as IJsonRpc | IJsonRpc[];
        for (const f of Array.isArray(parsed) ? parsed : [parsed]) frames.push(f);
    });
    return frames;
}

/** Waits until `predicate` holds, or fails after a second. */
async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await delay(10);
    }
    throw new Error("condition not met within 1s");
}

const cancel = (requestId: string | number): string => JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "moved on" } });
const call = (id: string | number): string => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "slow" } });
const cancellations = (frames: IJsonRpc[]) => frames.filter((f) => f.method === "notifications/cancelled");

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

describe("a client's cancellation on a slot", () => {
    it("reaches the provider under the broker's id, and settles the request", async () => {
        const base = await start();
        const provider = await open(`${base}/provider/slow`);
        const atProvider = record(provider);
        const client = await open(`${base}/slow`);
        const atClient = record(client);

        client.send(call(1));
        await until(() => atProvider.some((f) => f.method === "tools/call"));
        const brokerId = atProvider.find((f) => f.method === "tools/call")!.id!;
        expect(brokerId).not.toBe(1);
        expect(tunnel?.getProviderInfo("slow")?.pendingCount).toBe(1);

        client.send(cancel(1));
        await until(() => cancellations(atProvider).length === 1);
        expect(cancellations(atProvider)[0].params).toEqual({ requestId: brokerId, reason: "moved on" });
        expect(tunnel?.getProviderInfo("slow")?.pendingCount).toBe(0);

        // A provider that answers anyway: the answer goes nowhere.
        provider.send(JSON.stringify({ jsonrpc: "2.0", id: brokerId, result: { content: [] } }));
        await delay(100);
        expect(atClient).toEqual([]);
    });

    it("never lets a client cancel another client's request", async () => {
        const base = await start();
        const provider = await open(`${base}/provider/slow`);
        const atProvider = record(provider);
        const owner = await open(`${base}/slow`);
        const intruder = await open(`${base}/slow`);

        owner.send(call(1));
        await until(() => atProvider.some((f) => f.method === "tools/call"));
        const brokerId = atProvider.find((f) => f.method === "tools/call")!.id!;

        // Same client id, and the guessed broker id itself.
        intruder.send(cancel(1));
        intruder.send(cancel(brokerId));
        await delay(100);
        expect(cancellations(atProvider)).toEqual([]);
        expect(tunnel?.getProviderInfo("slow")?.pendingCount).toBe(1);

        // The owner's own cancellation still works.
        owner.send(cancel(1));
        await until(() => cancellations(atProvider).length === 1);
    });

    it("drops a cancellation for an unknown or answered id", async () => {
        const base = await start();
        const provider = await open(`${base}/provider/echo`);
        const atProvider = record(provider);
        provider.on("message", (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as IJsonRpc;
            if (msg.id != null && msg.method) provider.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        });
        const client = await open(`${base}/echo`);
        const atClient = record(client);

        client.send(call("a"));
        await until(() => atClient.some((f) => f.id === "a"));
        client.send(cancel("a"));
        client.send(cancel("never-sent"));
        client.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }));
        await delay(100);
        expect(cancellations(atProvider)).toEqual([]);
    });

    it("translates a cancellation inside a batch, and drops what it cannot", async () => {
        const base = await start();
        const provider = await open(`${base}/provider/slow`);
        const atProvider = record(provider);
        const client = await open(`${base}/slow`);

        client.send(call(7));
        await until(() => atProvider.some((f) => f.method === "tools/call"));
        const brokerId = atProvider.find((f) => f.method === "tools/call")!.id!;

        client.send(JSON.stringify([JSON.parse(cancel(7)), JSON.parse(cancel(99))]));
        await until(() => cancellations(atProvider).length >= 1);
        await delay(50);
        expect(cancellations(atProvider).map((f) => f.params?.requestId)).toEqual([brokerId]);
    });
});

describe("a client's cancellation on _all", () => {
    it("withdraws the routed call from the provider and answers nothing", async () => {
        const base = await start();
        const atProvider: IJsonRpc[] = [];
        const provider = await open(`${base}/provider/slow`, (ws) => ws.send(JSON.stringify({ type: "register", aggregate: true })));
        provider.on("message", (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as IJsonRpc;
            atProvider.push(msg);
            if (msg.id == null) return;
            const answers: Record<string, unknown> = {
                initialize: { protocolVersion: "2024-11-05", serverInfo: { name: "slow", version: "1" }, capabilities: { tools: {} } },
                "tools/list": { tools: [{ name: "wait", description: "Waits.", inputSchema: { type: "object" } }] },
                "prompts/list": { prompts: [] },
            };
            // tools/call is left unanswered on purpose.
            if (msg.method && msg.method in answers) provider.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: answers[msg.method] }));
        });

        const client = await open(`${base}/_all`);
        const atClient = record(client);
        // The provider joins `_all` asynchronously: list until its tool shows.
        let listId = 100;
        for (let i = 0; i < 50 && !atClient.some((f) => JSON.stringify(f.result ?? {}).includes("slow-wait")); i++) {
            client.send(JSON.stringify({ jsonrpc: "2.0", id: ++listId, method: "tools/list" }));
            await delay(20);
        }
        expect(atClient.some((f) => JSON.stringify(f.result ?? {}).includes("slow-wait"))).toBe(true);

        client.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow-wait", arguments: {} } }));
        await until(() => atProvider.some((f) => f.method === "tools/call"));
        const subId = atProvider.find((f) => f.method === "tools/call")!.id!;

        client.send(cancel(2));
        await until(() => cancellations(atProvider).length === 1);
        expect(cancellations(atProvider)[0].params?.requestId).toBe(subId);
        await delay(100);
        expect(atClient.some((f) => f.id === 2)).toBe(false);
    });
});

describe("execution limits on a cancellation", () => {
    it("frees what a deadline would free, and audits it as a cancel", () => {
        const context = { subjects: ["user:alice"], provider: "lan", providerId: "net", capability: "network.discover", resource: "/ot/site/lan", requestId: "r1" };
        const c = new LimitController({
            rules: [
                { id: "reads", concurrency: 1, onTimeout: "release" },
                { id: "writes", match: { capability: "plc.write" }, concurrency: 1 },
            ],
        });
        try {
            expect(c.admit({ ...context, requestId: "r1" }, []).allowed).toBe(true);
            c.cancelled("lan", "r1");
            expect(c.admit({ ...context, requestId: "r2" }, []).allowed).toBe(true);
            expect(c.info().recentEvents.some((e) => e.action === "cancel" && e.releasedRules?.[0] === "reads")).toBe(true);

            // r2 holds "reads", which matches every call: let it finish.
            c.complete("lan", "r2");
            const write = { ...context, capability: "plc.write" };
            expect(c.admit({ ...write, requestId: "w1" }, []).allowed).toBe(true);
            c.cancelled("lan", "w1");
            expect(c.admit({ ...write, requestId: "w2" }, [])).toMatchObject({ allowed: false, error: { reason: "concurrency-exceeded" } });
        } finally {
            c.close();
        }
    });
});
