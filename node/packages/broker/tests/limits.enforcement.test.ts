import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DirectTransport, MultiplexTransport, callerReferenceOf } from "@cyanmycelium/mcp-broker-provider";
import { startTestBroker, type ITestBroker } from "../src/testing";
import { mcpCall } from "./streamable.helper";
import type { ILimitsConfig } from "../src/limits/controller";

interface Frame {
    id: string | number;
    method?: string;
    params: { _meta?: Record<string, unknown> };
}
interface Reply {
    result?: { tools?: { name: string }[]; statuses?: string[] };
    error?: { data?: { reason: string; ruleId?: string } };
}
const directories: string[] = [];
let broker: ITestBroker;
const transports: (DirectTransport | MultiplexTransport)[] = [],
    sockets: WebSocket[] = [];
afterEach(async () => {
    for (const t of transports.splice(0)) t.close();
    for (const s of sockets.splice(0)) s.terminate();
    await broker?.stop();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
const call = (id = 1, name = "scan") => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
async function start(limits: ILimitsConfig, timeout = 10000) {
    broker = await startTestBroker({
        callers: { alice: {}, bob: {} },
        providers: { net: { allowedResources: ["/lan/**"] }, other: { allowedResources: ["/other/**"] } },
        configure: (b) => b.withLimits(limits).withProviderRequestTimeout(timeout),
    });
}
async function provider(handler?: (msg: Frame, t: DirectTransport) => void, aggregate = false, slot = "lan", identity = "net") {
    const t = new DirectTransport(broker.providerUrl(slot), { secret: broker.providerSecret(identity), aggregate });
    transports.push(t);
    let executions = 0;
    t.onMessage = (raw) => {
        const m = JSON.parse(raw);
        if (m.id === undefined) return;
        const reply = (result: unknown) => t.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", serverInfo: { name: slot, version: "1" }, capabilities: { tools: {} } });
        if (m.method === "tools/list") return reply({ tools: [{ name: "scan", inputSchema: { type: "object" } }] });
        if (m.method !== "tools/call") return reply({});
        executions++;
        if (handler) handler(m, t);
        else reply({ content: [{ type: "text", text: "ok" }] });
    };
    const opened = new Promise<void>((resolve) => {
        t.onOpen = resolve;
    });
    t.connect();
    await opened;
    // A control roundtrip also proves the provider slot is attached.
    await t.broker.declare({
        version: "1",
        domain: slot === "lan" ? "network" : "other",
        namespace: { resource: "/" + slot },
        capabilities: [slot === "lan" ? "network.scan" : "other.scan"],
        budgetUnits: ["packet"],
    });
    return { t, executions: () => executions };
}
async function http(caller = "alice", slot = "lan", name = "scan") {
    return (await mcpCall(broker.url, slot, JSON.stringify(call(1, name)), broker.bearer(caller))).json();
}
async function ws() {
    const s = new WebSocket(broker.wsUrl + "/lan", { headers: broker.bearer("alice") });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
        s.once("open", resolve);
        s.once("error", reject);
    });
    return s;
}
function request(s: WebSocket, value: unknown): Promise<Reply> {
    return new Promise((resolve) => {
        s.once("message", (raw) => resolve(JSON.parse(raw.toString())));
        s.send(JSON.stringify(value));
    });
}
describe("admission through the real broker", () => {
    it("restores call debits across a real broker restart", async () => {
        const directory = mkdtempSync(join(tmpdir(), "broker-restart-limits-"));
        directories.push(directory);
        const limits = { storeFile: join(directory, "ledger.json"), rules: [{ id: "calls", calls: { max: 1, windowMs: 60000 } }] };
        await start(limits);
        await provider();
        expect(await http()).toHaveProperty("result");
        await broker.stop();
        await start(limits);
        const p = await provider();
        expect(await http()).toHaveProperty("error");
        expect(p.executions()).toBe(0);
    });

    it("applies the same quota to legacy SSE without dispatching the refused request", async () => {
        await start({ rules: [{ id: "all", calls: { max: 1, windowMs: 60000 } }] });
        const p = await provider();
        await http();
        const abort = new AbortController();
        const response = await fetch(broker.url + "/lan/sse", { headers: broker.bearer("alice"), signal: abort.signal });
        const reader = response.body!.getReader();
        try {
            const first = new TextDecoder().decode((await reader.read()).value);
            const endpoint = /^data: (.+)$/m.exec(first)![1];
            expect((await fetch(broker.url + endpoint, { method: "POST", headers: broker.bearer("alice"), body: JSON.stringify(call()) })).status).toBe(202);
            let frame = "";
            while (!frame.includes("limit-exceeded")) frame += new TextDecoder().decode((await reader.read()).value);
            expect(frame).toContain('"ruleId":"all"');
            expect(p.executions()).toBe(1);
        } finally {
            abort.abort();
            await reader.cancel().catch(() => {});
        }
    });
    it("retains call quotas across provider reconnects", async () => {
        await start({ rules: [{ id: "all", calls: { max: 1, windowMs: 60000 } }] });
        const first = await provider();
        expect(await http()).toHaveProperty("result");
        first.t.close();
        await new Promise((r) => setTimeout(r, 20));
        const second = await provider();
        expect(await http()).toHaveProperty("error");
        expect(second.executions()).toBe(0);
    });
    it("refuses a provider that has not declared the required budget unit", async () => {
        await start({ rules: [{ id: "ops", budget: { unit: "native-operation", max: 1, windowMs: 60000 }, requireReservation: true }] });
        const p = await provider();
        expect(((await http()) as Reply).error!.data!.reason).toBe("reservation-unsupported");
        expect(p.executions()).toBe(0);
    });
    it("serializes simultaneous reservations received on a multiplexed provider", async () => {
        await start({ rules: [{ id: "ops", budget: { unit: "packet", max: 1, windowMs: 60000 } }] });
        const t = MultiplexTransport.create("lan", broker.providersUrl, { secret: broker.providerSecret("net") });
        transports.push(t);
        t.onMessage = (raw) => {
            const m = JSON.parse(raw);
            if (!m.id) return;
            if (m.method !== "tools/call") {
                t.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
                return;
            }
            const query = {
                principal: { type: "caller-ref" as const, ref: callerReferenceOf(m.params._meta)!.ref },
                capability: "network.scan",
                resource: "lan",
                resourcePath: "/lan",
                unit: "packet",
                quantity: 1,
                idempotencyKey: "a",
            };
            void Promise.allSettled([t.broker.reserveBudget(query), t.broker.reserveBudget({ ...query, idempotencyKey: "b" })]).then((results) =>
                t.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { statuses: results.map((r) => r.status) } }))
            );
        };
        const opened = new Promise<void>((resolve) => {
            t.onOpen = resolve;
        });
        t.connect();
        await opened;
        await t.broker.declare({
            version: "1",
            domain: "network",
            namespace: { resource: "/lan" },
            capabilities: ["network.scan"],
            budgetUnits: ["packet"],
            resultsRequired: ["network.scan"],
        });
        expect(((await http()) as Reply).result!.statuses!.sort()).toEqual(["fulfilled", "rejected"]);
        expect(broker.tunnel.getAuthorityInfo().results.awaited).toBe(0);
    });

    it("shares HTTP and WebSocket quotas and never dispatches a refused call", async () => {
        await start({ rules: [{ id: "all", calls: { max: 1, windowMs: 60000 } }] });
        const p = await provider();
        expect(await http()).toHaveProperty("result");
        const result = await request(await ws(), call());
        expect(result.error!.data!).toMatchObject({ reason: "limit-exceeded", ruleId: "all" });
        expect(await http("bob")).toHaveProperty("error");
        expect(p.executions()).toBe(1);
    });
    it("applies admission to internal clients and blocks batch/notification bypasses", async () => {
        await start({ rules: [{ id: "all", calls: { max: 1, windowMs: 60000 } }] });
        const p = await provider();
        const client = broker.tunnel.openInternalClient("lan");
        const result = new Promise<string>((resolve) => {
            client.onMessage = resolve;
        });
        // Anonymous internal caller must fail authorization, without consuming a quota.
        client.send(JSON.stringify(call()));
        expect(JSON.parse(await result)).toHaveProperty("error");
        const s = await ws();
        expect(await request(s, [call()])).toHaveProperty("error");
        s.send(JSON.stringify({ ...call(), id: undefined }));
        expect(await http()).toHaveProperty("result");
        expect(p.executions()).toBe(1);
        client.close();
    });
    it("counts aggregate calls only against the actual provider", async () => {
        await start({ rules: [{ id: "all", calls: { max: 1, windowMs: 60000 } }] });
        const p = await provider(undefined, true);
        let name: string | undefined;
        for (let i = 0; i < 40 && !name; i++) {
            const list = (await (await mcpCall(broker.url, "_all", JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }), broker.bearer("alice"))).json()) as Reply;
            name = list.result?.tools?.find((t: { name: string }) => t.name.startsWith("lan-"))?.name;
            if (!name) await new Promise((r) => setTimeout(r, 10));
        }
        expect(name).toBeTruthy();
        expect(await http("alice", "_all", name)).toHaveProperty("result");
        expect(await http()).toHaveProperty("error");
        expect(p.executions()).toBe(1);
    });
    it("keeps concurrency occupied after timeout and releases on the late provider response", async () => {
        await start({ rules: [{ id: "one", concurrency: 1 }] }, 50);
        let pending: Frame | undefined;
        const p = await provider((m) => {
            pending = m;
        });
        expect(await http()).toHaveProperty("error");
        expect(((await http()) as Reply).error!.data!.reason).toBe("concurrency-exceeded");
        p.t.send(JSON.stringify({ jsonrpc: "2.0", id: pending!.id, result: {} }));
        await new Promise((r) => setTimeout(r, 20));
        expect(broker.tunnel.getAuthorityInfo().limits!.activeCalls).toHaveLength(0);
    });
    it("reserves for the broker-issued caller, rejects stolen references, and settles after the reply", async () => {
        await start({ rules: [{ id: "ops", budget: { unit: "packet", max: 1, windowMs: 60000 } }] });
        const other = await provider(undefined, false, "other", "other");
        let reservationId = "";
        const p = await provider((m, t) => {
            void (async () => {
                const ref = callerReferenceOf(m.params._meta)!.ref;
                const query = {
                    principal: { type: "caller-ref" as const, ref },
                    capability: "network.scan",
                    resource: "lan",
                    resourcePath: "/lan",
                    unit: "packet",
                    quantity: 1,
                    idempotencyKey: "one",
                };
                await expect(other.t.broker.reserveBudget(query)).rejects.toThrow();
                // Authorization alone never debits a quota.
                for (let i = 0; i < 3; i++)
                    expect(
                        (
                            await t.broker.authorize({
                                principal: query.principal,
                                checks: [{ capability: query.capability, resource: query.resource, resourcePath: query.resourcePath }],
                            })
                        ).decisions[0].allowed
                    ).toBe(true);
                const grant = await t.broker.reserveBudget(query);
                reservationId = grant.reservationId;
                expect((await t.broker.reserveBudget(query)).reservationId).toBe(grant.reservationId);
                await expect(t.broker.reserveBudget({ ...query, idempotencyKey: "two" })).rejects.toThrow();
                t.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
            })().catch((e) => t.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -1, message: String(e) } })));
        });
        expect(await http()).toHaveProperty("result");
        await expect(other.t.broker.settleBudget({ reservationId, used: 1, result: "success" })).rejects.toThrow();
        expect(await p.t.broker.settleBudget({ reservationId, used: 1, result: "success" })).toEqual({ settled: true });
    });
});
