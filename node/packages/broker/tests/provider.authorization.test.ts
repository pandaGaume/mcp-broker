import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { LoopbackTransport } from "@cyanmycelium/mcp-core";
import { diagnoseBroker } from "../src/broker/broker.diagnostics";
import { mcpCall, openSession, sessionPost } from "./streamable.helper";
import { AuthError, CALLER_META_KEY, WsTunnelBuilder, compileAuthorizationPolicy, type IResolvedAuth, type ITokenValidator, type WsTunnel } from "../src/index";

/**
 * The broker as the single decision point for a provider that declares its own
 * authorization domain (SCADA): declarations, caller references,
 * `broker/authorize`, protected slots, and the `_all` path.
 *
 * Numbers in the test names refer to the acceptance tests of the SCADA broker
 * evolution brief.
 */

interface IJsonRpc {
    jsonrpc: "2.0";
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: { errors?: string[] } };
}

const validator: ITokenValidator = {
    async validate(token, resource) {
        if (token === "operator") return { sub: "olivia", groups: ["operators-line1"], aud: resource, scope: "mcp:call" };
        if (token === "scada") return { sub: "scada-svc", service: "mcp-scada", aud: resource, scope: "mcp:call" };
        if (token === "visitor") return { sub: "victor", aud: resource, scope: "mcp:call" };
        throw new AuthError(401, "invalid_token");
    },
};

const authorization = compileAuthorizationPolicy({
    subjectMapping: { userClaim: "sub", groupClaims: ["groups"], serviceClaims: ["service"] },
    roles: {
        caller: { capabilities: ["mcp.tools.list", "mcp.tools.call"] },
        "scada-operator": { inherits: ["caller"], capabilities: ["scada.observe", "scada.control"] },
    },
    assignments: [
        { id: "line1-operators", subject: "group:operators-line1", role: "scada-operator", resource: "/production/site1/**" },
        { id: "scada-service", subject: "service:mcp-scada", role: "caller", resource: "/production/site1/**" },
    ],
    denies: [{ id: "no-line2-control", subject: "group:operators-line1", capabilities: ["scada.control"], resource: "/production/site1/line2/**" }],
    slotResources: {
        scada: "/production/site1/scada",
        scada2: "/production/site1/scada2",
        plain: "/production/site1/plain",
        "bench-motor01": "/production/site1/bench/motor01",
        "bench-aux": "/production/site1/bench/aux",
    },
});

const auth: IResolvedAuth = {
    publicBaseUrl: "https://broker.test",
    authorizationServers: ["https://as.test"],
    validator,
    requiredScopes: ["mcp:call"],
    authorization,
    slotResourceResolver: authorization.slotResourceResolver,
};

const PROVIDERS = [
    { id: "mcp-scada", secret: "s-scada", subjects: ["service:mcp-scada"], allowedResources: ["/production/site1/**"] },
    { id: "modbus-bench", secret: "s-modbus", allowedResources: ["/production/site1/bench/**"] },
    { id: "intruder", secret: "s-intruder", allowedResources: ["**"] },
];

const DECLARATION = {
    version: "2026-10-01.1",
    domain: "scada",
    namespace: { resource: "/production/site1" },
    capabilities: ["scada.observe", "scada.control"],
    resources: [
        {
            resource: "uns://production/site1/line1/motor01/speed_setpoint",
            resourcePath: "/production/site1/line1/motor01/speed_setpoint",
            effect: "physical-action",
            limits: { minValue: 0, maxValue: 1500 },
        },
    ],
    protects: ["bench-motor01"],
};

let tunnel: WsTunnel | null = null;
const sockets: WebSocket[] = [];
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function start(configure: (b: WsTunnelBuilder) => void = () => {}): Promise<string> {
    const builder = new WsTunnelBuilder()
        .withPort(0)
        .withHost("127.0.0.1")
        .withAuth(auth)
        .withProviderPrincipals(PROVIDERS)
        .withProtectedSlots({ "bench-motor01": { declaredBy: "mcp-scada", publishedBy: "modbus-bench" } });
    configure(builder);
    tunnel = builder.build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
    for (const s of sockets) s.terminate();
    sockets.length = 0;
    await tunnel?.stop();
    tunnel = null;
});

/** Opens a socket; resolves with it once open, or with the close/refusal when it is not accepted. */
function connect(url: string, headers: Record<string, string>): Promise<{ ws: WebSocket; opened: boolean; status?: number; close?: { code: number; reason: string } }> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { headers });
        sockets.push(ws);
        ws.once("open", () => resolve({ ws, opened: true }));
        ws.once("unexpected-response", (_req, res) => {
            resolve({ ws, opened: false, status: res.statusCode });
            ws.terminate();
        });
        ws.on("error", () => {});
    });
}

function closure(ws: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => ws.once("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() })));
}

/**
 * A provider on `/provider/<slot>`: answers the MCP handshake and one tool,
 * records every request it receives, and can call the broker.
 */
class FakeProvider {
    readonly received: IJsonRpc[] = [];
    /** Called on `tools/call`; its return value is the tool result. Defaults to `{}`. */
    onCall: ((request: IJsonRpc) => Promise<Record<string, unknown>>) | null = null;
    private _next = 1;
    private readonly _waiting = new Map<string, (reply: IJsonRpc) => void>();

    private constructor(readonly ws: WebSocket) {
        ws.on("message", (raw: Buffer) => void this._handle(JSON.parse(raw.toString()) as IJsonRpc));
    }

    static async open(base: string, slot: string, secret: string, aggregate = false): Promise<FakeProvider> {
        const { ws, opened } = await connect(`${base}/provider/${slot}`, { "x-provider-token": secret });
        if (!opened) throw new Error(`provider ${slot} refused`);
        const provider = new FakeProvider(ws);
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/register", params: { aggregate } }));
        return provider;
    }

    /** Sends a `broker/*` request and resolves with the broker's answer. */
    call(method: string, params: unknown): Promise<IJsonRpc> {
        const id = `p-${this._next++}`;
        return new Promise((resolve) => {
            this._waiting.set(id, resolve);
            this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    }

    private async _handle(msg: IJsonRpc): Promise<void> {
        if (typeof msg.id === "string" && this._waiting.has(msg.id) && msg.method === undefined) {
            this._waiting.get(msg.id)!(msg);
            this._waiting.delete(msg.id);
            return;
        }
        if (msg.id == null || msg.method === undefined) return;
        this.received.push(msg);
        let result: Record<string, unknown> = {};
        if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", serverInfo: { name: "fake", version: "1" }, capabilities: { tools: {} } };
        else if (msg.method === "tools/list") result = { tools: [{ name: "write", description: "write a value", inputSchema: { type: "object" } }] };
        else if (msg.method === "tools/call") result = this.onCall ? await this.onCall(msg) : { content: [] };
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    }
}

/** A raw WebSocket MCP client on `/<slot>`, authenticated with a bearer token. */
class Client {
    private _next = 1;
    private readonly _waiting = new Map<number, (reply: IJsonRpc) => void>();

    private constructor(readonly ws: WebSocket) {
        ws.on("message", (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as IJsonRpc;
            if (typeof msg.id === "number") this._waiting.get(msg.id)?.(msg);
        });
    }

    static async open(base: string, slot: string, token: string): Promise<Client> {
        const { ws, opened } = await connect(`${base}/${slot}`, { authorization: `Bearer ${token}` });
        if (!opened) throw new Error(`client on ${slot} refused`);
        return new Client(ws);
    }

    request(method: string, params: Record<string, unknown>): Promise<IJsonRpc> {
        const id = this._next++;
        return new Promise((resolve) => {
            this._waiting.set(id, resolve);
            this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    }
}

function callerOf(request: IJsonRpc): { ref: string; correlationId: string; traceId?: string } | undefined {
    return (request.params?._meta as Record<string, { ref: string; correlationId: string; traceId?: string }> | undefined)?.[CALLER_META_KEY];
}

describe("broker/authorization/declare", () => {
    it("accepts a well-formed declaration from an identified provider", async () => {
        const base = await start();
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        const reply = await scada.call("broker/authorization/declare", DECLARATION);
        expect(reply.error).toBeUndefined();
        expect(reply.result).toMatchObject({ accepted: true, version: "2026-10-01.1" });
        expect(tunnel!.getAuthorityInfo().protectedSlots).toEqual([{ slot: "bench-motor01", declaredBy: "mcp-scada", publishedBy: "modbus-bench", confirmed: true }]);
    });

    it("T5: refuses, whole, a declaration that grants rights or reaches outside its domain", async () => {
        const base = await start();
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        const reply = await scada.call("broker/authorization/declare", {
            ...DECLARATION,
            capabilities: ["scada.observe", "mcp.tools.call", "*"],
            assignments: [{ subject: "user:me", role: "admin", resource: "/**" }],
            roles: {},
        });
        expect(reply.error?.code).toBe(-32602);
        const errors = reply.error?.data?.errors?.join("\n") ?? "";
        expect(errors).toContain('"assignments" is not accepted');
        expect(errors).toContain('"roles" is not accepted');
        expect(errors).toContain('capability "mcp.tools.call" is outside the declared domain');
        expect(errors).toContain('capability "*"');
        expect(tunnel!.getAuthorityInfo().declarations).toEqual([]);
    });

    it("T6: refuses an anonymous provider and a namespace outside allowedResources", async () => {
        const base = await start((b) => b.withProviderPrincipals(PROVIDERS));
        const bench = await FakeProvider.open(base, "bench-aux", "s-modbus");
        const reply = await bench.call("broker/authorization/declare", { ...DECLARATION, protects: [] });
        expect(reply.error?.data?.errors?.join("\n")).toContain("outside this provider's allowedResources");

        // Anonymous: no provider auth at all, and no protected slots.
        await tunnel!.stop();
        tunnel = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1").build();
        await tunnel.start();
        const port = ((tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer.address() as AddressInfo).port;
        const anonymous = await FakeProvider.open(`ws://127.0.0.1:${port}`, "scada", "none");
        const refused = await anonymous.call("broker/authorization/declare", { ...DECLARATION, protects: [] });
        expect(refused.error?.data?.errors?.[0]).toContain("anonymous");
    });

    it("refuses to protect a slot the operators did not list", async () => {
        const base = await start();
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        const reply = await scada.call("broker/authorization/declare", { ...DECLARATION, protects: ["opcua-line1"] });
        expect(reply.error?.data?.errors?.join("\n")).toContain("not listed in authorization.protectedSlots");
    });
});

describe("caller references", () => {
    it("T1: strips a caller reference a client wrote itself, on an undeclared slot", async () => {
        const base = await start();
        const plain = await FakeProvider.open(base, "plain", "s-intruder");
        const client = await Client.open(base, "plain", "operator");
        await client.request("tools/call", { name: "write", arguments: {}, _meta: { [CALLER_META_KEY]: { ref: "cr_forgedforgedforged" }, progressToken: 1 } });
        const call = plain.received.find((m) => m.method === "tools/call")!;
        expect(callerOf(call)).toBeUndefined();
        expect(call.params?._meta).toEqual({
            progressToken: 1,
            traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
        });
    });

    it("replaces a forged reference with the broker's own on a declared slot, and decides on it", async () => {
        const base = await start();
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        await scada.call("broker/authorization/declare", DECLARATION);

        let decisions: unknown;
        scada.onCall = async (request) => {
            const caller = callerOf(request)!;
            const reply = await scada.call("broker/authorize", {
                principal: { type: "caller-ref", ref: caller.ref },
                checks: [
                    {
                        capability: "scada.control",
                        resource: "uns://production/site1/line1/motor01/speed_setpoint",
                        resourcePath: "/production/site1/line1/motor01/speed_setpoint",
                        attributes: { requestedValue: 1200, token: "x" },
                    },
                    { capability: "scada.control", resource: "uns://production/site1/line2/pump", resourcePath: "/production/site1/line2/pump" },
                ],
            });
            decisions = reply.result?.decisions;
            return { content: [] };
        };

        const client = await Client.open(base, "scada", "operator");
        const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
        await client.request("tools/call", {
            name: "write",
            arguments: {},
            _meta: { [CALLER_META_KEY]: { ref: "cr_forgedforgedforged", correlationId: "x" }, traceparent },
        });

        const caller = callerOf(scada.received.find((m) => m.method === "tools/call")!)!;
        expect(caller.ref).toMatch(/^cr_/);
        expect(caller.ref).not.toBe("cr_forgedforgedforged");
        expect(caller.traceId).toBe("0123456789abcdef0123456789abcdef");
        expect(scada.received.find((m) => m.method === "tools/call")!.params?._meta).toMatchObject({ traceparent });
        expect(decisions).toEqual([
            expect.objectContaining({ effect: "allow", reason: "role-grant", policies: ["line1-operators"], decisionId: expect.stringMatching(/^dec_/) }),
            expect.objectContaining({ effect: "deny", reason: "explicit-deny", policies: ["no-line2-control"] }),
        ]);
    });

    it("T2: refuses a reference once its request was answered, or on another slot", async () => {
        const base = await start();
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        await scada.call("broker/authorization/declare", DECLARATION);
        const client = await Client.open(base, "scada", "operator");
        await client.request("tools/call", { name: "write", arguments: {} });
        const ref = callerOf(scada.received.find((m) => m.method === "tools/call")!)!.ref;
        const check = { capability: "scada.observe", resource: "uns://x", resourcePath: "/production/site1/line1" };

        const late = await scada.call("broker/authorize", { principal: { type: "caller-ref", ref }, checks: [check] });
        expect(late.error?.code).toBe(-32602);
        expect(late.error?.message).toMatch(/unknown, expired/);

        // Same principal on another declared slot, presenting a live reference from the first.
        const other = await FakeProvider.open(base, "scada2", "s-scada");
        let crossSlot: IJsonRpc | undefined;
        scada.onCall = async (request) => {
            crossSlot = await other.call("broker/authorize", { principal: { type: "caller-ref", ref: callerOf(request)!.ref }, checks: [check] });
            return {};
        };
        await client.request("tools/call", { name: "write", arguments: {} });
        expect(crossSlot?.error?.message).toMatch(/another slot/);
    });

    it("T3: refuses an unknown principal form, an identity in clear, or a mix", async () => {
        const base = await start();
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        await scada.call("broker/authorization/declare", DECLARATION);
        const check = { capability: "scada.observe", resource: "uns://x", resourcePath: "/production/site1/line1" };
        for (const principal of [
            { type: "user", subject: "user:alice" },
            { type: "caller-ref", ref: "user:alice" },
            { type: "caller-ref", ref: "cr_aaaaaaaaaaaa", subject: "user:alice" },
            { type: "provider", ref: "cr_aaaaaaaaaaaa" },
            { subjects: ["user:alice"] },
        ]) {
            const reply = await scada.call("broker/authorize", { principal, checks: [check] });
            expect(reply.error?.code, JSON.stringify(principal)).toBe(-32602);
        }
    });

    it("T4, T22: denies a resource outside the namespace, or a declared one under another path", async () => {
        const base = await start();
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        await scada.call("broker/authorization/declare", DECLARATION);
        const reply = await scada.call("broker/authorize", {
            principal: { type: "provider" },
            checks: [
                { capability: "scada.observe", resource: "uns://elsewhere", resourcePath: "/production/site2/line1" },
                { capability: "scada.control", resource: "uns://production/site1/line1/motor01/speed_setpoint", resourcePath: "/production/site1/line1/other" },
                { capability: "scada.observe", resource: "uns://x", resourcePath: "/production/site1/%2Fescape" },
                { capability: "scada.execute", resource: "uns://x", resourcePath: "/production/site1/line1" },
            ],
        });
        expect((reply.result?.decisions as { reason: string }[]).map((d) => d.reason)).toEqual([
            "undeclared-resource",
            "undeclared-resource",
            "undeclared-resource",
            "undeclared-capability",
        ]);
    });

    it("refuses broker/authorize before any declaration", async () => {
        const base = await start();
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        const reply = await scada.call("broker/authorize", { principal: { type: "provider" }, checks: [] });
        expect(reply.error?.code).toBe(-32003);
    });

    it("T14: answers an unknown broker/* method at once", async () => {
        const base = await start();
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        const reply = await scada.call("broker/teleport", {});
        expect(reply.error?.code).toBe(-32601);
    });

    it("T15: hands the reference through _all, built from the caller of _all", async () => {
        const base = await start();
        const scada = await FakeProvider.open(base, "scada", "s-scada", true);
        await scada.call("broker/authorization/declare", DECLARATION);
        let decision: unknown;
        scada.onCall = async (request) => {
            const reply = await scada.call("broker/authorize", {
                principal: { type: "caller-ref", ref: callerOf(request)!.ref },
                checks: [{ capability: "scada.observe", resource: "uns://x", resourcePath: "/production/site1/line1" }],
            });
            decision = (reply.result?.decisions as unknown[])[0];
            return { content: [] };
        };

        const client = await Client.open(base, "_all", "operator");
        let tools: string[] = [];
        for (let i = 0; i < 40 && !tools.includes("scada-write"); i++) {
            tools = (((await client.request("tools/list", {})).result?.tools as { name: string }[]) ?? []).map((t) => t.name);
            await delay(25);
        }
        const answer = await client.request("tools/call", { name: "scada-write", arguments: {}, _meta: { [CALLER_META_KEY]: { ref: "cr_forgedforgedforged" } } });
        expect(answer.error).toBeUndefined();
        expect(decision).toEqual(expect.objectContaining({ effect: "allow", policies: ["line1-operators"] }));
    });
});

describe("protected slots", () => {
    it("T7: admits only the declarer's client identity, only the configured publisher, and never joins _all", async () => {
        const base = await start();

        // Publication: the configured publisher only.
        const intruder = await connect(`${base}/provider/bench-motor01`, { "x-provider-token": "s-intruder" });
        expect(intruder.opened).toBe(true);
        expect((await closure(intruder.ws)).code).toBe(1008);
        const bench = await FakeProvider.open(base, "bench-motor01", "s-modbus", true);

        // Callers: the declaring provider's own client identity only, from startup,
        // before any declaration.
        const operator = await connect(`${base}/bench-motor01`, { authorization: "Bearer operator" });
        expect((await closure(operator.ws)).code).toBe(1008);
        const scadaClient = await Client.open(base, "bench-motor01", "scada");
        const read = await scadaClient.request("tools/call", { name: "write", arguments: {} });
        expect(read.error).toBeUndefined();
        expect(bench.received.some((m) => m.method === "tools/call")).toBe(true);

        // Never in `_all`, although it asked.
        await delay(100);
        expect(tunnel!.getAggregateInfo().providers).not.toContain("bench-motor01");

        // A disconnected declarer reopens nothing.
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        await scada.call("broker/authorization/declare", DECLARATION);
        scada.ws.close();
        await delay(50);
        const again = await connect(`${base}/bench-motor01`, { authorization: "Bearer visitor" });
        expect((await closure(again.ws)).code).toBe(1008);
    });

    it("cannot be configured without provider authentication", () => {
        expect(() =>
            new WsTunnelBuilder()
                .withPort(0)
                .withProtectedSlots({ x: { declaredBy: "a", publishedBy: "b" } })
                .build()
        ).toThrow(/provider authentication is off/);
    });

    it("cannot protect a reserved slot", () => {
        expect(() =>
            new WsTunnelBuilder()
                .withPort(0)
                .withProviderPrincipals(PROVIDERS)
                .withProtectedSlots({ _all: { declaredBy: "a", publishedBy: "b" } })
                .build()
        ).toThrow(/reserved/);
    });
});

describe("in-process loopback providers", () => {
    it("declare and decide through the handle registerLoopbackProvider returns", async () => {
        await start((b) =>
            b
                .withProtectedSlots({ "bench-motor01": { declaredBy: "in-process-scada", publishedBy: "modbus-bench" } })
                .withProviderPrincipals([...PROVIDERS, { id: "in-process-scada", secret: "unused", subjects: ["service:mcp-scada"], allowedResources: ["/production/site1/**"] }])
        );
        const [, providerEnd] = LoopbackTransport.createPair();
        const handle = tunnel!.registerLoopbackProvider("scada", providerEnd, {
            principal: { id: "in-process-scada", subjects: ["service:mcp-scada"], allowedResources: ["/production/site1/**"] },
        });

        const declared = await handle.declare(DECLARATION);
        expect("result" in declared && declared.result).toMatchObject({ accepted: true });
        const decided = await handle.authorize({
            principal: { type: "provider" },
            checks: [{ capability: "scada.observe", resource: "uns://x", resourcePath: "/production/site1/line1" }],
        });
        // The provider's own subjects hold no scada grant in this policy.
        expect("result" in decided && (decided.result as { decisions: { reason: string }[] }).decisions[0].reason).toBe("no-matching-grant");
    });

    it("cannot publish into a protected slot under another principal", async () => {
        await start();
        const [, providerEnd] = LoopbackTransport.createPair();
        expect(() => tunnel!.registerLoopbackProvider("bench-motor01", providerEnd, { principal: { id: "mcp-scada" } })).toThrow(/protected/);
    });
});

describe("broker_diagnose", () => {
    it("reports an unconfirmed protected slot, then the confirmation, and capabilities nobody declared", async () => {
        const base = await start();
        const before = diagnoseBroker(tunnel!)!;
        expect(before.problems.find((p) => p.id === "protected-slot-unconfirmed")?.slot).toBe("bench-motor01");
        expect(before.problems.find((p) => p.id === "undeclared-capability")?.evidence.undeclaredCapabilities).toEqual(["scada.control", "scada.observe"]);

        const scada = await FakeProvider.open(base, "scada", "s-scada");
        await scada.call("broker/authorization/declare", DECLARATION);
        const after = diagnoseBroker(tunnel!)!;
        expect(after.problems.map((p) => p.id)).not.toContain("protected-slot-unconfirmed");
        expect(after.problems.map((p) => p.id)).not.toContain("undeclared-capability");
        expect(after.authority?.policyVersion).toMatch(/\.1$/);
    });
});

describe("without any declaration", () => {
    it("T8: adds only the W3C trace context when no caller reference applies", async () => {
        const base = await start();
        const plain = await FakeProvider.open(base, "plain", "s-intruder");
        const client = await Client.open(base, "plain", "operator");
        await client.request("tools/call", { name: "write", arguments: { a: 1 } });
        const call = plain.received.find((m) => m.method === "tools/call")!;
        expect(call.params).toEqual({
            name: "write",
            arguments: { a: 1 },
            _meta: { traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/) },
        });
    });
});

describe("hardening found in review", () => {
    it("refuses a reserved domain, a domain another provider owns, namespace /, and a provider allowed everywhere", async () => {
        const base = await start((b) =>
            b.withProviderPrincipals([...PROVIDERS, { id: "other-scada", secret: "s-other", subjects: ["service:other"], allowedResources: ["/production/site1/**"] }])
        );
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        await scada.call("broker/authorization/declare", DECLARATION);

        const other = await FakeProvider.open(base, "scada2", "s-other");
        const taken = await other.call("broker/authorization/declare", { ...DECLARATION, protects: [] });
        expect(taken.error?.data?.errors?.join("\n")).toContain('already declared by provider "mcp-scada"');
        const reserved = await other.call("broker/authorization/declare", { ...DECLARATION, domain: "mcp", capabilities: ["mcp.tools.call"], protects: [] });
        expect(reserved.error?.data?.errors?.join("\n")).toContain("reserved");
        const root = await other.call("broker/authorization/declare", {
            ...DECLARATION,
            domain: "other",
            capabilities: ["other.read"],
            namespace: { resource: "/" },
            resources: [],
            protects: [],
        });
        expect(root.error?.data?.errors?.join("\n")).toContain('cannot be "/"');

        const everywhere = await FakeProvider.open(base, "plain", "s-intruder");
        const wide = await everywhere.call("broker/authorization/declare", { ...DECLARATION, domain: "wide", capabilities: ["wide.read"], resources: [], protects: [] });
        expect(wide.error?.data?.errors?.[0]).toContain("may publish anywhere");
    });

    it("re-serializes every client frame, drops response-shaped batch items, and strips the key from notifications", async () => {
        const base = await start();
        const raw: string[] = [];
        const { ws } = await connect(`${base}/provider/plain`, { "x-provider-token": "s-intruder" });
        ws.on("message", (data: Buffer) => raw.push(data.toString()));
        const client = await connect(`${base}/plain`, { authorization: "Bearer operator" });

        // Two `_meta` keys: JSON.parse keeps the last, a C parser may keep the first.
        client.ws.send(`{"jsonrpc":"2.0","method":"notifications/x","params":{"_meta":{"${CALLER_META_KEY}":{"ref":"cr_forgedforgedforged"}},"_meta":{}}}`);
        client.ws.send(
            JSON.stringify([
                { jsonrpc: "2.0", id: "provider-broker-1", result: { accepted: true } },
                { jsonrpc: "2.0", method: "notifications/y", params: { _meta: { [CALLER_META_KEY]: { ref: "cr_forgedforgedforged" } } } },
            ])
        );
        await delay(100);
        expect(raw.join("\n")).not.toContain("cr_forged");
        expect(raw.join("\n")).not.toContain("provider-broker-1");
    });

    it("refuses a reference once its client went away", async () => {
        const base = await start();
        const scada = await FakeProvider.open(base, "scada", "s-scada");
        await scada.call("broker/authorization/declare", DECLARATION);
        let release: () => void = () => {};
        const held = new Promise<void>((r) => (release = r));
        let ref = "";
        scada.onCall = async (request) => {
            ref = callerOf(request)!.ref;
            await held;
            return {};
        };
        const client = await Client.open(base, "scada", "operator");
        void client.request("tools/call", { name: "write", arguments: {} });
        await delay(50);
        client.ws.close();
        await delay(50);
        const reply = await scada.call("broker/authorize", {
            principal: { type: "caller-ref", ref },
            checks: [{ capability: "scada.observe", resource: "uns://x", resourcePath: "/production/site1/line1" }],
        });
        expect(reply.error?.message).toMatch(/unknown, expired|expired/);
        release();
    });

    it("refuses a protected slot over Streamable HTTP and SSE as well", async () => {
        const base = (await start()).replace("ws://", "http://");
        const post = await mcpCall(base, "bench-motor01", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), { authorization: "Bearer operator" });
        expect(post.status).toBe(403);
        const sse = await fetch(`${base}/bench-motor01/sse`, { headers: { authorization: "Bearer operator" } });
        expect(sse.status).toBe(403);
    });

    it("refuses the wrong publisher on the multiplexed path", async () => {
        const base = await start();
        const { ws } = await connect(`${base}/providers`, { "x-provider-token": "s-intruder" });
        const answer = new Promise<string>((resolve) => ws.once("message", (data: Buffer) => resolve(data.toString())));
        ws.send(JSON.stringify({ provider: "bench-motor01", payload: { jsonrpc: "2.0", method: "notifications/register" } }));
        expect(await answer).toContain("protected");
        expect(tunnel!.getProviderInfo("bench-motor01")?.connected ?? false).toBe(false);
    });

    it("pins a Streamable HTTP session to the caller that opened it", async () => {
        const base = (await start()).replace("ws://", "http://");
        await FakeProvider.open(base.replace("http://", "ws://"), "plain", "s-intruder");
        const opened = await openSession(base, "plain", { authorization: "Bearer operator" });
        expect(opened.sessionId).toBeTruthy();
        const own = await sessionPost(base, "plain", opened.sessionId!, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), { authorization: "Bearer operator" });
        expect(own.status).toBe(200);
        const other = await sessionPost(base, "plain", opened.sessionId!, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }), { authorization: "Bearer visitor" });
        expect(other.status).toBe(403);
    });

    it("refuses protectedSlots naming the shared secret or an unknown provider", () => {
        const build = (declaredBy: string, publishedBy: string) => () =>
            new WsTunnelBuilder().withPort(0).withProviderPrincipals(PROVIDERS).withProtectedSlots({ x: { declaredBy, publishedBy } }).build();
        expect(build("mcp-scada", "shared-secret")).toThrow(/shared-secret/);
        expect(build("nobody", "modbus-bench")).toThrow(/not in the providers table/);
    });

    it("refuses a loopback over a slot a live socket holds", async () => {
        const base = await start();
        await FakeProvider.open(base, "plain", "s-intruder");
        const [, providerEnd] = LoopbackTransport.createPair();
        expect(() => tunnel!.registerLoopbackProvider("plain", providerEnd)).toThrow(/WebSocket provider currently holds/);
    });
});
