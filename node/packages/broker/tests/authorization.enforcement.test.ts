import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import {
    AuthError,
    WsTunnelBuilder,
    compileAuthorizationPolicy,
    type IInternalClient,
    type AggregateScopeFilter,
    type IPrincipal,
    type IProviderAuthenticator,
    type IResolvedAuth,
    type ITokenValidator,
    type WsTunnel,
} from "../src/index.js";
import { AggregateServer } from "../src/broker/aggregate/aggregate.server.js";

const validator: ITokenValidator = {
    async validate(token, resource) {
        if (token === "alice") return { sub: "alice", groups: ["maintenance"], aud: resource, scope: "mcp:call" };
        if (token === "bob") return { sub: "bob", aud: resource, scope: "mcp:call" };
        throw new AuthError(401, "invalid_token");
    },
};

const authorization = compileAuthorizationPolicy({
    subjectMapping: { userClaim: "sub", groupClaims: ["groups"], clientClaim: "client_id" },
    roles: {
        viewer: { capabilities: ["mcp.tools.list", "mcp.prompts.read"] },
        maintenance: { inherits: ["viewer"], capabilities: ["mcp.tools.diagnose"] },
        brokerReader: { capabilities: ["broker.providers.read"] },
    },
    assignments: [
        {
            id: "maintenance-site-a",
            subject: "group:maintenance",
            role: "maintenance",
            resource: "/enterprise/site-a/**",
        },
        {
            id: "alice-broker",
            subject: "user:alice",
            role: "brokerReader",
            resource: "/_system/broker",
        },
    ],
    denies: [
        {
            id: "protect-critical",
            subject: "group:maintenance",
            capabilities: ["mcp.tools.diagnose"],
            resource: "/enterprise/site-a/critical",
        },
    ],
    slotResources: {
        motor: "/enterprise/site-a/motor",
        critical: "/enterprise/site-a/critical",
        alpha: "/enterprise/site-a/alpha",
        beta: "/enterprise/site-b/beta",
    },
    toolCapabilities: {
        diagnose_motor: "mcp.tools.diagnose",
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

const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const DIAGNOSE = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "diagnose_motor", arguments: {} },
});

let tunnel: WsTunnel | null = null;

async function startTunnel(): Promise<string> {
    tunnel = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1").withAuth(auth).build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
    await tunnel?.stop();
    tunnel = null;
});

describe("hierarchical policy enforcement on direct slots", () => {
    it("allows a caller through inherited subtree access", async () => {
        const base = await startTunnel();
        const response = await fetch(`${base}/motor/mcp`, {
            method: "POST",
            headers: { authorization: "Bearer alice" },
            body: LIST,
        });
        expect(response.status).toBe(200);
        expect((await response.json()).error?.message).toContain("not connected");
    });

    it("denies a caller with no matching assignment", async () => {
        const base = await startTunnel();
        const response = await fetch(`${base}/motor/mcp`, {
            method: "POST",
            headers: { authorization: "Bearer bob" },
            body: LIST,
        });
        expect(response.status).toBe(403);
        expect((await response.json()).error).toMatchObject({ code: -32001, message: "Forbidden" });
    });

    it("applies an exact explicit deny over an inherited role grant", async () => {
        const base = await startTunnel();
        const response = await fetch(`${base}/critical/mcp`, {
            method: "POST",
            headers: { authorization: "Bearer alice" },
            body: DIAGNOSE,
        });
        expect(response.status).toBe(403);
    });

    it("protects _broker with its independent reserved resource", async () => {
        const base = await startTunnel();
        const allowed = await fetch(`${base}/_broker/mcp`, {
            method: "POST",
            headers: { authorization: "Bearer alice" },
            body: LIST,
        });
        expect(allowed.status).toBe(200);

        const denied = await fetch(`${base}/_broker/mcp`, {
            method: "POST",
            headers: { authorization: "Bearer bob" },
            body: LIST,
        });
        expect(denied.status).toBe(403);
    });
});

interface ITool {
    readonly name: string;
}

function fakeProvider(tools: readonly ITool[]): IInternalClient {
    const client: IInternalClient = {
        onMessage: null,
        onClose: null,
        send(message: string) {
            const request = JSON.parse(message) as { id?: string | number; method?: string };
            if (request.id == null) return;
            let result: unknown = {};
            if (request.method === "initialize") {
                result = { protocolVersion: "2024-11-05", serverInfo: { name: "fake", version: "1" }, capabilities: {} };
            } else if (request.method === "tools/list") {
                result = { tools };
            } else if (request.method === "prompts/list") {
                result = { prompts: [] };
            } else if (request.method === "tools/call") {
                result = { content: [{ type: "text", text: "ok" }] };
            }
            queueMicrotask(() => client.onMessage?.(JSON.stringify({ jsonrpc: "2.0", id: request.id, result })));
        },
        close() {
            // Nothing to release in the fake transport.
        },
    };
    return client;
}

describe("_all policy filtering", () => {
    let aggregate: AggregateServer;
    let nextId: number;
    let pending: Map<number, (message: Record<string, unknown>) => void>;

    beforeEach(async () => {
        nextId = 0;
        pending = new Map();
        aggregate = new AggregateServer(() => fakeProvider([{ name: "diagnose_motor" }]));
        aggregate.setPolicyAuthorization(authorization);
        aggregate.onMessage = (data) => {
            const message = JSON.parse(data) as Record<string, unknown>;
            const id = message.id;
            if (typeof id === "number") {
                pending.get(id)?.(message);
                pending.delete(id);
            }
        };
        aggregate.start();
        await aggregate.addProvider("alpha");
        await aggregate.addProvider("beta");
    });

    function rpc(principal: IPrincipal, method: string, params?: unknown): Promise<Record<string, unknown>> {
        return new Promise((resolve) => {
            const id = ++nextId;
            pending.set(id, resolve);
            aggregate.sendAs(JSON.stringify({ jsonrpc: "2.0", id, method, params }), principal);
        });
    }

    const alice: IPrincipal = {
        claims: { sub: "alice", groups: ["maintenance"] },
        scopes: new Set(["mcp:call"]),
    };
    const bob: IPrincipal = {
        claims: { sub: "bob" },
        scopes: new Set(["mcp:call"]),
    };

    it("hides providers outside the caller's authorized subtree", async () => {
        const reply = await rpc(alice, "tools/list");
        const tools = (reply.result as { tools: ITool[] }).tools.map((tool) => tool.name);
        expect(tools.some((name) => name.startsWith("alpha-"))).toBe(true);
        expect(tools.some((name) => name.startsWith("beta-"))).toBe(false);
        expect((await rpc(bob, "tools/list")).result).toEqual({ tools: [] });
    });

    it("makes unauthorized provider calls indistinguishable from unknown calls", async () => {
        const betaName = "beta-diagnose_motor";
        const reply = await rpc(alice, "tools/call", { name: betaName, arguments: {} });
        expect(reply.error).toMatchObject({ code: -32602 });
    });

    it("combines legacy providerScopes and hierarchical policies restrictively", async () => {
        const legacyFilter: AggregateScopeFilter = (_principal, provider) => provider !== "alpha";
        aggregate.setScopeFilter(legacyFilter);
        expect((await rpc(alice, "tools/list")).result).toEqual({ tools: [] });
    });
});

describe("provider namespace restrictions", () => {
    const providerAuth: IProviderAuthenticator = {
        authenticate() {
            return {
                authenticated: true,
                principal: {
                    id: "device:serial-42",
                    allowedResources: ["/enterprise/site-a/line-3/**"],
                },
            };
        },
    };

    async function startProviderTunnel(): Promise<{ base: string; instance: WsTunnel }> {
        const instance = new WsTunnelBuilder()
            .withPort(0)
            .withHost("127.0.0.1")
            .withProviderAuth(providerAuth)
            .withSlotResourceResolver(authorization.slotResourceResolver)
            .build();
        tunnel = instance;
        await instance.start();
        const server = (instance as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
        return { base: `ws://127.0.0.1:${server.address().port}`, instance };
    }

    function connect(url: string): Promise<{ socket?: WebSocket; status?: number }> {
        return new Promise((resolve) => {
            const socket = new WebSocket(url);
            socket.once("open", () => resolve({ socket }));
            socket.once("unexpected-response", (_request, response) => {
                resolve({ status: response.statusCode });
                socket.terminate();
            });
            socket.on("error", () => {
                // Rejected upgrades also emit an error.
            });
        });
    }

    it("allows a resource inside the provider namespace and rejects a sibling", async () => {
        const { base } = await startProviderTunnel();
        const allowed = await connect(`${base}/provider/%2Fenterprise%2Fsite-a%2Fline-3%2Fmotor-7`);
        expect(allowed.socket?.readyState).toBe(WebSocket.OPEN);
        allowed.socket?.close();

        const denied = await connect(`${base}/provider/%2Fenterprise%2Fsite-a%2Fline-4%2Fmotor-8`);
        expect(denied.status).toBe(403);

        const parent = await connect(`${base}/provider/%2Fenterprise%2Fsite-a`);
        expect(parent.status).toBe(403);
    });

    it("enforces every announced slot on a multiplexed provider connection", async () => {
        const { base, instance } = await startProviderTunnel();
        const connected = await connect(`${base}/providers`);
        const socket = connected.socket!;
        const rejection = new Promise<Record<string, unknown>>((resolve) => {
            socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
        });
        socket.send(
            JSON.stringify({
                provider: "/enterprise/site-a/line-4/motor-8",
                payload: { jsonrpc: "2.0", id: 1, method: "ping" },
            })
        );
        expect(await rejection).toMatchObject({
            payload: { error: { code: -32001, message: "Provider registration forbidden" } },
        });
        expect(instance.providerNames).not.toContain("/enterprise/site-a/line-4/motor-8");
        socket.close();
    });
});
