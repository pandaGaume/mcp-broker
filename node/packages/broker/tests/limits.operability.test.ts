import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DirectTransport, callerReferenceOf } from "@cyanmycelium/mcp-broker-provider";
import { startTestBroker, type ITestBroker } from "../src/testing";
import { mcpCall } from "./streamable.helper";
import type { ILimitsConfig } from "../src/limits/controller";

/**
 * Execution limits on a supervised plant gateway: a budget on a resource with
 * engineering limits, a slot freed by its deadline, and an operator releasing
 * a stuck call from a running broker.
 */

if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
}

interface Reply {
    result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] };
    error?: { code: number; message: string; data?: { reason: string; ruleId?: string } };
}

let broker: ITestBroker;
const transports: DirectTransport[] = [];
afterEach(async () => {
    for (const t of transports.splice(0)) t.close();
    await broker?.stop();
});

const POLICY = {
    roles: {
        caller: { capabilities: ["mcp.tools.call", "plc.write"] },
        limitsAdmin: { capabilities: ["broker.limits.admin", "broker.providers.read"] },
    },
    assignments: [
        { id: "operators", subject: "user:alice", role: "caller", resource: "/plc/**" },
        { id: "ops", subject: "user:ops", role: "limitsAdmin", resource: "/_system/broker" },
    ],
};

async function start(limits: ILimitsConfig | undefined, timeout = 10000): Promise<void> {
    broker = await startTestBroker({
        callers: { alice: {}, ops: {} },
        providers: { plc: { allowedResources: ["/plc/**"] } },
        policy: POLICY,
        configure: (b) => {
            if (limits) b.withLimits(limits);
            b.withProviderRequestTimeout(timeout);
        },
    });
}

/** A PLC provider whose tools/call handler the test controls; `answer: false` never answers. */
async function plc(onCall: (msg: { id: string; params: { _meta?: Record<string, unknown> } }, t: DirectTransport) => void): Promise<DirectTransport> {
    const t = new DirectTransport(broker.providerUrl("plc"), { secret: broker.providerSecret("plc") });
    transports.push(t);
    t.onMessage = (raw) => {
        const m = JSON.parse(raw);
        if (m.id === undefined) return;
        if (m.method === "tools/call") return onCall(m, t);
        t.send(
            JSON.stringify({
                jsonrpc: "2.0",
                id: m.id,
                result: m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "plc", version: "1" } } : {},
            })
        );
    };
    const opened = new Promise<void>((resolve) => (t.onOpen = resolve));
    t.connect();
    await opened;
    await t.broker.declare({
        version: "1",
        domain: "plc",
        namespace: { resource: "/plc" },
        capabilities: ["plc.write"],
        resources: [{ resource: "uns://plc/motor01/speed", resourcePath: "/plc/motor01/speed", effect: "physical-action", limits: { minValue: 0, maxValue: 1500 } }],
        budgetUnits: ["plc-write"],
    });
    return t;
}

const answer = (t: DirectTransport, id: string, text = "ok") => t.send(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }));

async function call(slot: string, caller: string, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
    return (
        await mcpCall(broker.url, slot, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), broker.bearer(caller))
    ).json() as Promise<Reply>;
}

describe("budgets on resources with engineering limits", () => {
    it("reserves on a constrained allow, and hands the constraints to the provider", async () => {
        await start({ rules: [{ id: "writes", budget: { unit: "plc-write", max: 10, windowMs: 60000 } }] });
        let grant: unknown;
        await plc((m, t) => {
            void t.broker
                .reserveBudget({
                    principal: { type: "caller-ref", ref: callerReferenceOf(m.params._meta)!.ref },
                    capability: "plc.write",
                    resource: "uns://plc/motor01/speed",
                    resourcePath: "/plc/motor01/speed",
                    unit: "plc-write",
                    quantity: 1,
                    idempotencyKey: "k1",
                })
                .then(
                    (g) => (grant = g),
                    (e: unknown) => (grant = e)
                )
                .finally(() => answer(t, m.id));
        });
        await call("plc", "alice", "write");
        expect(grant).toMatchObject({ effect: "allow-with-constraints", obligations: { constraints: { minValue: 0, maxValue: 1500 } }, replayed: false });
    });
});

describe("a deadline and a held concurrency slot", () => {
    it('frees the slot at the deadline when the rule says onTimeout: "release"', async () => {
        await start({ rules: [{ id: "reads", concurrency: 1, onTimeout: "release" }] }, 300);
        let first = true;
        await plc((m, t) => {
            if (first)
                first = false; // the first call never gets an answer
            else answer(t, m.id);
        });
        expect((await call("plc", "alice", "read")).error?.message).toMatch(/did not respond/);
        await new Promise((r) => setTimeout(r, 400));
        expect((await call("plc", "alice", "read")).result?.content?.[0].text).toBe("ok");
    });

    it("keeps holding by default, and an operator releases it with broker_limits_release", async () => {
        await start({ rules: [{ id: "writes", concurrency: 1 }] }, 300);
        let first = true;
        await plc((m, t) => {
            if (first) first = false;
            else answer(t, m.id);
        });
        await call("plc", "alice", "write");
        await new Promise((r) => setTimeout(r, 400));
        expect((await call("plc", "alice", "write")).error?.data?.reason).toBe("concurrency-exceeded");

        const held = broker.tunnel.getAuthorityInfo().limits!.activeCalls[0]!;
        // Without broker.limits.admin the frame never reaches the tool.
        expect((await call("_broker", "alice", "broker_limits_release", { slot: "plc", requestId: held.requestId })).error?.code).toBe(-32001);
        const released = await call("_broker", "ops", "broker_limits_release", { slot: "plc", requestId: held.requestId });
        expect(released.error, JSON.stringify(released)).toBeUndefined();
        expect(released.result?.isError).not.toBe(true);
        expect(JSON.parse(released.result!.content![0].text)).toMatchObject({ released: true, by: ["user:ops"] });
        expect((await call("plc", "alice", "write")).result?.content?.[0].text).toBe("ok");
    });

    it("lists broker_limits_release only when limits are configured", async () => {
        await start(undefined);
        const listed = (await mcpCall(broker.url, "_broker", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), broker.bearer("ops")).then((r) => r.json())) as Reply;
        expect(listed.result?.tools?.map((t) => t.name)).not.toContain("broker_limits_release");
    });
});
