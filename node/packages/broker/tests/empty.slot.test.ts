import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import {
    McpClient,
    McpServerBuilder,
    type IMcpBehavior,
    type McpResource,
    type McpResourceContent,
    type McpResourceTemplate,
    type McpTool,
    type McpToolResult,
} from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";
import { startTestBroker, type ITestBroker } from "../src/testing/index";

if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

/**
 * Connection by slot is the primary path: a client may open a session on a
 * slot before any provider is there. The broker answers `initialize` and the
 * lists itself, then, when the provider attaches, handshakes it and sends
 * list_changed so the client re-reads.
 */

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

let broker: ITestBroker | null = null;
afterEach(async () => {
    await broker?.stop();
    broker = null;
});

class ValveBehavior implements IMcpBehavior {
    readonly namespace = "valve";
    getResources(): McpResource[] {
        return [];
    }
    getResourceTemplates(): McpResourceTemplate[] {
        return [];
    }
    getTools(): McpTool[] {
        return [{ name: "open_valve", inputSchema: { type: "object" } }];
    }
    async readResourceAsync(): Promise<McpResourceContent | undefined> {
        return undefined;
    }
    async executeToolAsync(): Promise<McpToolResult> {
        return { content: [{ type: "text", text: "opened" }] };
    }
}

function clientOf(slot: string): McpClient {
    return new McpClient({ name: "host", version: "1" }, new StreamableHttpTransport(broker!.mcpUrl(slot), { headers: broker!.bearer("host") }), 5_000);
}

async function attachProvider(slot: string): Promise<void> {
    const transport = new DirectTransport(broker!.providerUrl(slot));
    const server = new McpServerBuilder().withName("valves").withTransport(transport).register(new ValveBehavior()).build();
    await server.start();
}

describe("a slot with no provider yet", () => {
    it("opens the session, lists nothing, and refuses calls until the provider comes", async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        const client = clientOf("plant");
        const opened = await client.connect();
        expect(opened.serverInfo.name).toBe("plant");
        expect(opened.capabilities.tools?.listChanged).toBe(true);
        expect(opened.instructions).toMatch(/no provider yet/);
        expect(await client.listTools()).toEqual([]);
        await expect(client.callTool("open_valve", {})).rejects.toThrow(/not connected/);
        client.disconnect();
    });

    it("tells the client to re-read when the provider attaches, and the provider serves it", async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        const client = clientOf("plant");
        await client.connect();
        let changed = 0;
        client.onToolsChanged?.subscribe(() => changed++);
        expect(await client.listTools()).toEqual([]);

        await attachProvider("plant");
        await settle(200);
        expect(changed).toBeGreaterThanOrEqual(1);
        expect((await client.listTools()).map((tool) => tool.name)).toEqual(["open_valve"]);
        expect((await client.callTool("open_valve", {})).content[0]).toEqual({ type: "text", text: "opened" });
        client.disconnect();
    });
});

/** Sends one frame on a client WebSocket of `slot` and resolves with the answer. */
function askOverWebSocket(slot: string, frame: object): Promise<{ error?: { code: number; message: string } }> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`${broker!.wsUrl}/${slot}`, { headers: broker!.bearer("host") });
        socket.on("open", () => socket.send(JSON.stringify(frame)));
        socket.on("message", (raw: Buffer) => {
            resolve(JSON.parse(raw.toString()) as { error?: { code: number; message: string } });
            socket.close();
        });
        socket.on("error", reject);
    });
}

describe("the 2026-07-28 probe", () => {
    const probe = {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } },
    };

    it("is answered -32601 by the broker, with or without a provider, so a dual-era host falls back to initialize", async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        const empty = await askOverWebSocket("plant", probe);
        expect(empty.error?.code).toBe(-32601);
        expect(empty.error?.message).toMatch(/initialize/);

        await attachProvider("plant");
        await settle();
        expect((await askOverWebSocket("plant", probe)).error?.code).toBe(-32601);
    });
});

describe("dual-era clients through the broker", () => {
    it('a protocol "auto" client (mcp-core 1.6) goes stateless over Streamable HTTP, on an empty slot too', async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        const client = new McpClient({ name: "host", version: "1" }, new StreamableHttpTransport(broker.mcpUrl("plant"), { headers: broker.bearer("host") }), 5_000, {
            protocol: "auto",
        });
        const opened = await client.connect();
        expect(client.isStateless).toBe(true);
        expect(opened.protocolVersion).toBe("2026-07-28");
        expect(await client.listTools()).toEqual([]);

        await attachProvider("plant");
        await settle(200);
        expect((await client.listTools()).map((tool) => tool.name)).toEqual(["open_valve"]);
        client.disconnect();
    });
});
