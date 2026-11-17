import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { startTestBroker, type ITestBroker } from "../src/testing/index";
import { mcpCall } from "./streamable.helper";

if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

/**
 * With authorization on, a request the broker does not classify is refused
 * unless the operator classifies it: a new MCP extension, or a provider's own
 * method, is closed until someone decides who may call it.
 */

let broker: ITestBroker | null = null;
afterEach(async () => {
    await broker?.stop();
    broker = null;
});

/** Answers every request with an empty result, so a refusal can only come from the broker. */
function echoProvider(transport: DirectTransport): void {
    transport.onMessage = (raw) => {
        const msg = JSON.parse(raw) as { id?: string | number; method?: string };
        if (msg.id === undefined) return;
        if (msg.method === "initialize") {
            transport.send(
                JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "device", version: "1" }, capabilities: {} } })
            );
            return;
        }
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method } }));
    };
}

async function startWith(methodCapabilities?: Record<string, string>): Promise<void> {
    broker = await startTestBroker({
        callers: { reader: {} },
        policy: {
            slotResources: { device: "/plant/device" },
            roles: { reader: { capabilities: ["mcp.resources.read", "acme.custom.use"] } },
            assignments: [{ id: "readers", subject: "user:reader", role: "reader", resource: "/plant/**" }],
            ...(methodCapabilities ? { methodCapabilities } : {}),
        },
    });
    const transport = new DirectTransport(broker.providerUrl("device"));
    echoProvider(transport);
    const opened = new Promise<void>((resolve) => (transport.onOpen = resolve));
    transport.connect();
    await opened;
}

async function call(method: string): Promise<{ result?: { echoed?: string }; error?: { code: number } }> {
    const response = await mcpCall(broker!.url, "device", JSON.stringify({ jsonrpc: "2.0", id: 9, method, params: {} }), broker!.bearer("reader"));
    return (await response.json()) as { result?: { echoed?: string }; error?: { code: number } };
}

describe("unknown request methods under authorization", () => {
    it("refuses an unclassified request and lets a classified one through", async () => {
        await startWith();
        expect((await call("acme/custom")).error?.code).toBe(-32001);
        expect((await call("tasks/get")).error?.code).toBe(-32001);
        expect((await call("skills/list")).result?.echoed).toBe("skills/list");
        expect((await call("ping")).result?.echoed).toBe("ping");
    });

    it("lets the operator classify a provider's own method", async () => {
        await startWith({ "acme/custom": "acme.custom.use" });
        expect((await call("acme/custom")).result?.echoed).toBe("acme/custom");
    });
});
