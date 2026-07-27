import { describe, it, expect, beforeEach } from "vitest";
import { AggregateServer } from "../src/broker/aggregate/aggregate.server";
import type { IInternalClient } from "../src/ws/ws.interfaces";
import type { AggregateScopeFilter, IPrincipal } from "../src/index";

/** A fake in-process provider that answers initialize / list / call. */
function fakeProvider(tools: { name: string }[]): IInternalClient {
    const client: IInternalClient = {
        onMessage: null,
        onClose: null,
        send(message: string) {
            const m = JSON.parse(message) as { id?: string | number | null; method?: string };
            if (m.id == null) return; // notification
            let result: unknown = {};
            if (m.method === "initialize") result = { protocolVersion: "2024-11-05", serverInfo: { name: "x", version: "0" }, capabilities: {} };
            else if (m.method === "tools/list") result = { tools };
            else if (m.method === "prompts/list") result = { prompts: [] };
            else if (m.method === "tools/call") result = { content: [{ type: "text", text: "ok" }] };
            queueMicrotask(() => client.onMessage?.(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })));
        },
        close() {
            /* no-op */
        },
    };
    return client;
}

const TOOLS: Record<string, { name: string }[]> = {
    alpha: [{ name: "forecast" }],
    beta: [{ name: "invoice" }],
};

/** alpha needs scope see:alpha; beta needs see:beta; unlisted ⇒ visible to all. */
const filter: AggregateScopeFilter = (principal, provider) => {
    const required: Record<string, string[]> = { alpha: ["see:alpha"], beta: ["see:beta"] };
    const need = required[provider];
    if (!need) return true;
    return need.some((s) => principal.scopes.has(s));
};

const alice: IPrincipal = { claims: { sub: "alice" }, scopes: new Set(["see:alpha"]) };
const bob: IPrincipal = { claims: { sub: "bob" }, scopes: new Set(["see:beta"]) };

let agg: AggregateServer;
let counter = 0;
const pending = new Map<number, (m: Record<string, unknown>) => void>();

/** Issues a request to the aggregate as `principal` and resolves the reply. */
function rpc(principal: IPrincipal | null, method: string, params?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        const id = ++counter;
        pending.set(id, resolve);
        agg.sendAs(JSON.stringify({ jsonrpc: "2.0", id, method, params }), principal);
    });
}

beforeEach(async () => {
    agg = new AggregateServer((name) => fakeProvider(TOOLS[name] ?? []));
    agg.setScopeFilter(filter);
    agg.onMessage = (data: string) => {
        const m = JSON.parse(data) as Record<string, unknown>;
        const id = m.id as number | undefined;
        if (id != null && pending.has(id)) {
            pending.get(id)!(m);
            pending.delete(id);
        }
    };
    agg.start();
    await agg.addProvider("alpha");
    await agg.addProvider("beta");
});

/** Extracts the namespaced tool names from a tools/list reply. */
function toolNames(reply: Record<string, unknown>): string[] {
    const result = reply.result as { tools?: { name: string }[] } | undefined;
    return (result?.tools ?? []).map((t) => t.name);
}

describe("_all aggregate scope filtering", () => {
    it("shows every provider to an unfiltered caller (no principal)", async () => {
        const reply = await rpc(null, "tools/list");
        const names = toolNames(reply);
        expect(names.some((n) => n.startsWith("alpha-"))).toBe(true);
        expect(names.some((n) => n.startsWith("beta-"))).toBe(true);
    });

    it("narrows tools/list to the providers the caller is scoped for", async () => {
        const forAlice = toolNames(await rpc(alice, "tools/list"));
        expect(forAlice.some((n) => n.startsWith("alpha-"))).toBe(true);
        expect(forAlice.some((n) => n.startsWith("beta-"))).toBe(false);

        const forBob = toolNames(await rpc(bob, "tools/list"));
        expect(forBob.some((n) => n.startsWith("beta-"))).toBe(true);
        expect(forBob.some((n) => n.startsWith("alpha-"))).toBe(false);
    });

    it("lets a caller call a tool from a provider it can see", async () => {
        const alphaTool = toolNames(await rpc(alice, "tools/list"))[0];
        const reply = await rpc(alice, "tools/call", { name: alphaTool, arguments: {} });
        expect(reply.error).toBeUndefined();
        expect(reply.result).toBeDefined();
    });

    it("hides a forbidden provider's tool behind an 'unknown' error (no existence leak)", async () => {
        // Discover beta's namespaced tool name as bob, then try to call it as alice.
        const betaTool = toolNames(await rpc(bob, "tools/list"))[0];
        const reply = await rpc(alice, "tools/call", { name: betaTool, arguments: {} });
        const err = reply.error as { code: number; message: string } | undefined;
        expect(err).toBeDefined();
        expect(err?.code).toBe(-32602);
        expect(err?.message).toContain("Unknown aggregated tool");
    });

    it("applies no filtering when the scope filter is unset", async () => {
        agg.setScopeFilter(null);
        const forAlice = toolNames(await rpc(alice, "tools/list"));
        expect(forAlice.some((n) => n.startsWith("alpha-"))).toBe(true);
        expect(forAlice.some((n) => n.startsWith("beta-"))).toBe(true);
    });
});
