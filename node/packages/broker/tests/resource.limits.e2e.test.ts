import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { startTestBroker } from "../src/testing";
import { mcpCall } from "./streamable.helper";

if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
}

it("accepts provider patterns and policy.resourceLimits through the real test broker", async () => {
    const broker = await startTestBroker({
        callers: { ops: {} },
        providers: { scada: { subjects: ["service:scada"], allowedResources: ["/nord/**"] } },
        policy: {
            slotResources: { scada: "/nord/scada" },
            roles: { all: { capabilities: ["*"] } },
            assignments: [
                { subject: "service:scada", role: "all", resource: "/nord/**" },
                { subject: "user:ops", role: "all", resource: "/_system/broker" },
            ],
            resourceLimits: [{ id: "maintenance", pattern: "/nord/valves/{id}", limits: { maxValue: 80 } }],
        },
    });
    const transport = new DirectTransport(broker.providerUrl("scada"), { secret: broker.providerSecret("scada") });
    try {
        const opened = new Promise<void>((resolve) => (transport.onOpen = resolve));
        transport.connect();
        await opened;
        await transport.broker.declare({
            version: "1",
            domain: "scada",
            namespace: { resource: "/nord" },
            capabilities: ["scada.write"],
            resources: [{ resourcePattern: "/nord/valves/{id}", limits: { minValue: 0, maxValue: 100 } }],
        });
        const response = await transport.broker.authorize({
            principal: { type: "provider" },
            checks: [{ capability: "scada.write", resource: "valve:1", resourcePath: "/nord/valves/1" }],
        });
        expect(response.decisions[0]).toMatchObject({ effect: "allow-with-constraints", obligations: { constraints: { minValue: 0, maxValue: 80 } } });
        const read = await mcpCall(
            broker.url,
            "_broker",
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "broker://authority" } }),
            broker.bearer("ops")
        );
        const reply = (await read.json()) as { result: { contents: { text: string }[] } };
        expect(JSON.parse(reply.result.contents[0].text)).toMatchObject({
            resourceLimits: [{ id: "maintenance", limits: { maxValue: 80 } }],
            declarations: [{ resourcePatterns: [{ pattern: "/nord/valves/{id}" }] }],
        });
    } finally {
        transport.close();
        await broker.stop();
    }
});
