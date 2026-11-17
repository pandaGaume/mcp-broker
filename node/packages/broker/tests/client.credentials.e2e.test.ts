import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { startTestBroker, type ITestBroker } from "../src/testing/index";
import { mcpCall } from "./streamable.helper";

if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

/**
 * OAuth client credentials (`io.modelcontextprotocol/oauth-client-credentials`):
 * a machine client, with no user behind it, is authorized through its
 * `client:<client_id>` subject. An RFC 9068 access token from that grant
 * carries `client_id`, and `sub` names the client too.
 */

let broker: ITestBroker | null = null;
afterEach(async () => {
    await broker?.stop();
    broker = null;
});

function provider(transport: DirectTransport): void {
    transport.onMessage = (raw) => {
        const msg = JSON.parse(raw) as { id?: string | number; method?: string };
        if (msg.id === undefined) return;
        const result =
            msg.method === "initialize"
                ? { protocolVersion: "2025-06-18", serverInfo: { name: "historian", version: "1" }, capabilities: { tools: {} } }
                : { content: [{ type: "text", text: "archived" }] };
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };
}

async function callAs(caller: string): Promise<{ result?: unknown; error?: { code: number } }> {
    const response = await mcpCall(
        broker!.url,
        "historian",
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "archive", arguments: {} } }),
        broker!.bearer(caller)
    );
    return (await response.json()) as { result?: unknown; error?: { code: number } };
}

describe("machine clients (OAuth client credentials)", () => {
    it("authorizes a client by its client_id subject, and refuses another client", async () => {
        broker = await startTestBroker({
            callers: {
                // Token of a client_credentials grant: sub and client_id both name the client.
                historian: { user: "plant-historian", client: "plant-historian" },
                intruder: { user: "other-app", client: "other-app" },
            },
            policy: {
                slotResources: { historian: "/plant/historian" },
                roles: { archiver: { capabilities: ["mcp.tools.call"] } },
                assignments: [{ id: "historian-service", subject: "client:plant-historian", role: "archiver", resource: "/plant/**" }],
            },
        });
        const transport = new DirectTransport(broker.providerUrl("historian"));
        provider(transport);
        const opened = new Promise<void>((resolve) => (transport.onOpen = resolve));
        transport.connect();
        await opened;

        expect((await callAs("historian")).result).toEqual({ content: [{ type: "text", text: "archived" }] });
        expect((await callAs("intruder")).error?.code).toBe(-32001);
    });
});
