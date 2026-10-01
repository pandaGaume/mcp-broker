import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { DirectTransport, callerReferenceOf } from "@cyanmycelium/mcp-broker-provider";
import { startTestBroker, type ITestBroker } from "../src/testing/index";
import { mcpCall } from "./streamable.helper";

/**
 * The test kit end to end, the way a consumer such as mcp-scada uses it: a
 * real DirectTransport authenticating with its secret, a declaration, HTTP
 * clients with test tokens, and decisions made by the real policy engine.
 *
 * Kept short on purpose: it doubles as the example the testing guide points to.
 */

// The provider transports use the global WebSocket, which Node has from 22 on.
// On Node 20 (still supported, and what CI runs) `ws` stands in; it accepts
// the same `{ headers }` the transports pass for the secret.
if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = NodeWebSocket as unknown as typeof globalThis.WebSocket;
}

let broker: ITestBroker | null = null;
afterEach(async () => {
    await broker?.stop();
    broker = null;
});

/** A minimal provider: answers initialize, and on tools/call asks the broker about its caller. */
function scadaProvider(transport: DirectTransport): void {
    transport.onMessage = (raw) => {
        const msg = JSON.parse(raw) as { id?: string; method?: string; params?: { _meta?: Record<string, unknown> } };
        if (msg.id === undefined) return;
        const reply = (result: unknown) => transport.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        if (msg.method === "initialize") return reply({ protocolVersion: "2025-06-18", serverInfo: { name: "scada", version: "1" }, capabilities: { tools: {} } });
        if (msg.method !== "tools/call") return reply({});

        const caller = callerReferenceOf(msg.params?._meta);
        void transport.broker
            .authorize({
                principal: { type: "caller-ref", ref: caller!.ref },
                checks: [{ capability: "scada.control", resource: "uns://production/site1/line1/motor01/speed", resourcePath: "/production/site1/line1/motor01/speed" }],
            })
            .then(({ decisions }) => reply({ content: [{ type: "text", text: decisions[0].effect }] }));
    };
}

async function callTool(slot: string, caller: string): Promise<string> {
    const response = await mcpCall(
        broker!.url,
        slot,
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "write", arguments: {} } }),
        broker!.bearer(caller)
    );
    const body = (await response.json()) as { result?: { content: { text: string }[] }; error?: { message: string } };
    return body.result?.content[0].text ?? `error: ${body.error?.message}`;
}

describe("startTestBroker", () => {
    it("runs the whole declare / call / decide loop with no authorization server", async () => {
        broker = await startTestBroker({
            callers: {
                operator: { groups: ["operators-line1"] },
                visitor: {},
            },
            providers: {
                "mcp-scada": { subjects: ["service:mcp-scada"], allowedResources: ["/production/site1/**"] },
            },
            policy: {
                slotResources: { scada: "/production/site1/scada" },
                roles: {
                    caller: { capabilities: ["mcp.tools.call"] },
                    operator: { inherits: ["caller"], capabilities: ["scada.control"] },
                },
                assignments: [
                    { id: "operators", subject: "group:operators-line1", role: "operator", resource: "/production/site1/**" },
                    { id: "visitors", subject: "user:visitor", role: "caller", resource: "/production/site1/**" },
                ],
            },
        });

        const transport = new DirectTransport(broker.providerUrl("scada"), { secret: broker.providerSecret("mcp-scada") });
        scadaProvider(transport);
        const opened = new Promise<void>((resolve) => (transport.onOpen = resolve));
        transport.connect();
        await opened;
        await transport.broker.declare({ version: "1", domain: "scada", namespace: { resource: "/production/site1" }, capabilities: ["scada.control"] });

        expect(await callTool("scada", "operator")).toBe("allow");
        expect(await callTool("scada", "visitor")).toBe("deny");
        transport.close();
    });

    it("lets every caller do everything when no policy is given", async () => {
        broker = await startTestBroker({ callers: { anyone: {} }, providers: { p: { allowedResources: ["/p/**"] } } });
        const transport = new DirectTransport(broker.providerUrl("p"), { secret: broker.providerSecret("p") });
        transport.onMessage = (raw) => {
            const msg = JSON.parse(raw) as { id?: string };
            if (msg.id !== undefined) transport.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }));
        };
        const opened = new Promise<void>((resolve) => (transport.onOpen = resolve));
        transport.connect();
        await opened;
        expect(await callTool("p", "anyone")).toBe("ok");
        transport.close();
    });

    it("names what you forgot to declare", async () => {
        broker = await startTestBroker({ callers: { a: {} } });
        expect(() => broker!.bearer("b")).toThrow(/no caller named "b". Declared callers: a/);
        expect(() => broker!.providerSecret("x")).toThrow(/no provider identity "x"/);
    });

    it("captures provider spans in memory when telemetry is enabled", async () => {
        broker = await startTestBroker({ telemetry: true });
        const transport = new DirectTransport(broker.providerUrl("modbus"));
        const opened = new Promise<void>((resolve) => (transport.onOpen = resolve));
        transport.connect();
        await opened;
        transport.broker.span({
            traceId: "0123456789abcdef0123456789abcdef",
            spanId: "0123456789abcdef",
            name: "modbus.read",
            startTimeUnixNano: "1",
            endTimeUnixNano: "2",
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        expect(broker.spans).toHaveLength(1);
        expect(broker.spans[0]).toMatchObject({ slot: "modbus", span: { name: "modbus.read" } });
        transport.close();
    });
});
