import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import {
    MCP_META,
    McpClient,
    McpEventLog,
    McpEventsClient,
    McpEventsExtension,
    McpServerBuilder,
    type IMcpBehavior,
    type IMcpRequestContext,
    type IMcpServer,
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
 * Protocol 2026-07-28 through the broker: a POST outside any session carries
 * one request. The broker relays it as it is to a provider that speaks that
 * revision, and in a session of its own to one that does not.
 */

const REVISION = "2026-07-28";
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

let broker: ITestBroker | null = null;
const servers: IMcpServer[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
    await broker?.stop();
    broker = null;
});

class ValveBehavior implements IMcpBehavior {
    readonly namespace = "valve";
    getResources(): McpResource[] {
        return [{ uri: "valve://state", name: "state", mimeType: "text/plain" }];
    }
    getResourceTemplates(): McpResourceTemplate[] {
        return [];
    }
    getTools(): McpTool[] {
        return [
            { name: "open_valve", inputSchema: { type: "object" } },
            { name: "flush_line", inputSchema: { type: "object" } },
        ];
    }
    async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        return uri === "valve://state" ? { uri, mimeType: "text/plain", text: "open" } : undefined;
    }
    async executeToolAsync(_uri: string, name: string, _args: Record<string, unknown>, request?: IMcpRequestContext): Promise<McpToolResult> {
        if (name === "flush_line") {
            // Logs at two levels and reports progress, as a long tool would.
            request?.log?.("info", "flushing");
            request?.log?.("warning", "pressure high");
            const token = request?.meta?.progressToken;
            if (typeof token === "string" || typeof token === "number") request?.notify?.("notifications/progress", { progressToken: token, progress: 1, total: 2 });
            await settle(20);
            return { content: [{ type: "text", text: "flushed" }] };
        }
        return { content: [{ type: "text", text: "opened" }] };
    }
}

function alarmLog(): McpEventLog {
    return new McpEventLog({ capacity: 100 }).define({
        name: "alarm",
        description: "Process alarms",
        inputSchema: { type: "object", properties: { area: { type: "string" } } },
        matches: (args, data) => args["area"] === undefined || args["area"] === data["area"],
    });
}

/** Attaches an mcp-core provider to `slot`. `handshakeOnly` turns its stateless serving off, like a provider older than mcp-core 1.6. */
async function attachProvider(slot: string, options: { handshakeOnly?: boolean; events?: McpEventLog } = {}): Promise<IMcpServer> {
    const transport = new DirectTransport(broker!.providerUrl(slot));
    const builder = new McpServerBuilder().withName("valves").withTransport(transport).register(new ValveBehavior());
    builder.withOptions({ logging: true, ...(options.handshakeOnly ? { statelessProtocolVersions: [] } : {}) });
    if (options.events) builder.withExtension(new McpEventsExtension(options.events));
    const server = builder.build();
    await server.start();
    servers.push(server);
    await settle();
    return server;
}

function statelessClient(slot: string): McpClient {
    return new McpClient({ name: "host", version: "1" }, new StreamableHttpTransport(broker!.mcpUrl(slot), { headers: broker!.bearer("host") }), 5_000, {
        protocol: "stateless",
    });
}

/**
 * POSTs one stateless request by hand, with the headers 2026-07-28 requires.
 * `body` is the answer; `notifications` what the response stream carried before it.
 */
async function post(
    slot: string,
    method: string,
    params: Record<string, unknown> = {},
    name?: string,
    meta: Record<string, unknown> = {}
): Promise<{ status: number; body: Record<string, unknown>; notifications: Record<string, unknown>[] }> {
    const response = await fetch(broker!.mcpUrl(slot), {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": REVISION,
            "mcp-method": method,
            ...(name !== undefined ? { "mcp-name": name } : {}),
            ...broker!.bearer("host"),
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method,
            params: { ...params, _meta: { ...meta, [MCP_META.protocolVersion]: REVISION, [MCP_META.clientCapabilities]: {} } },
        }),
    });
    const text = await response.text();
    // A JSON answer, or an SSE stream whose last event is the answer.
    const frames = response.headers.get("content-type")?.includes("text/event-stream")
        ? text
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
        : [JSON.parse(text) as Record<string, unknown>];
    return { status: response.status, body: frames[frames.length - 1]!, notifications: frames.slice(0, -1) };
}

describe("a provider that speaks 2026-07-28", () => {
    it("gets stateless requests as they are, and answers them through the broker", async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        await attachProvider("plant");
        const client = statelessClient("plant");
        const opened = await client.connect();
        expect(client.isStateless).toBe(true);
        expect(opened.serverInfo.name).toBe("valves");
        expect((await client.listTools()).map((tool) => tool.name)).toEqual(["open_valve", "flush_line"]);
        expect((await client.callTool("open_valve", {})).content[0]).toEqual({ type: "text", text: "opened" });
        client.disconnect();
    });

    it("streams its events to a stateless client, and polls them", async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        const log = alarmLog();
        await attachProvider("plant", { events: log });
        const client = statelessClient("plant");
        await client.connect();
        const events = new McpEventsClient(client);
        expect(events.supported).toBe(true);

        const seen: string[] = [];
        const stream = events.stream("alarm", { area: "nord" }, { onEvent: (event) => seen.push(String(event.data["tag"])) }, { heartbeatMs: 5_000 });
        await settle(150);
        log.publish("alarm", { area: "sud", tag: "P-1" });
        log.publish("alarm", { area: "nord", tag: "P-2" });
        await settle(150);
        expect(seen).toEqual(["P-2"]);

        const polled = await events.poll("alarm", {}, "0");
        expect(polled.events.map((event) => event.data["tag"])).toEqual(["P-1", "P-2"]);
        stream.close();
        client.disconnect();
    });

    it("withdraws an event stream at the provider when the client closes it", async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        await attachProvider("plant", { events: alarmLog() });
        const client = statelessClient("plant");
        await client.connect();
        const stream = new McpEventsClient(client).stream("alarm", {}, { onEvent: () => undefined }, { heartbeatMs: 5_000, reconnect: false });
        await settle(150);
        expect(broker.tunnel.getProviderInfo("plant")?.pendingCount).toBeGreaterThanOrEqual(1);
        stream.close();
        client.disconnect();
        await settle(150);
        expect(broker.tunnel.getProviderInfo("plant")?.pendingCount).toBe(0);
    });
});

describe("a provider that speaks only the handshake revisions", () => {
    it("is spoken to in the broker's own session; the answers come back as a stateless server writes them", async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        await attachProvider("plant", { handshakeOnly: true });

        const discovered = await post("plant", "server/discover");
        const result = discovered.body.result as Record<string, unknown>;
        expect(result.supportedVersions).toContain(REVISION);
        expect(result.capabilities).toMatchObject({ tools: {} });
        expect((result._meta as Record<string, unknown>)[MCP_META.serverInfo]).toMatchObject({ name: "valves" });

        const listed = (await post("plant", "tools/list")).body.result as Record<string, unknown>;
        expect(listed).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
        expect((listed.tools as McpTool[]).map((tool) => tool.name)).toEqual(["open_valve", "flush_line"]);

        const missing = (await post("plant", "resources/read", { uri: "valve://nothing" }, "valve://nothing")).body.error as { code: number };
        expect(missing.code).toBe(-32602);

        const client = statelessClient("plant");
        await client.connect();
        expect((await client.callTool("open_valve", {})).content[0]).toEqual({ type: "text", text: "opened" });
        expect((await client.readResource("valve://state")).text).toBe("open");
        client.disconnect();
    });

    it("serves the listen itself: one subscription at the provider, updates tagged for each client", async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        const provider = await attachProvider("plant", { handshakeOnly: true });
        const first = statelessClient("plant");
        const second = statelessClient("plant");
        await first.connect();
        await second.connect();
        const updates: string[] = [];
        first.onResourceUpdated.subscribe((uri) => updates.push(`first ${uri}`));
        second.onResourceUpdated.subscribe((uri) => updates.push(`second ${uri}`));
        await first.subscribeResource("valve://state");
        await second.subscribeResource("valve://state");
        expect(broker.tunnel.getProviderInfo("plant")?.resourceSubscriptionCount).toBe(2);

        expect(provider.notifyResourceUpdated?.("valve://state")).toBe(true);
        await settle(150);
        expect(updates.sort()).toEqual(["first valve://state", "second valve://state"]);

        first.disconnect();
        second.disconnect();
        await settle(150);
        expect(broker.tunnel.getProviderInfo("plant")?.resourceSubscriptionCount).toBe(0);
    });
});

describe.each([
    { era: "a provider that speaks 2026-07-28", handshakeOnly: false },
    { era: "a handshake-only provider", handshakeOnly: true },
])("logs and progress, from $era", ({ handshakeOnly }) => {
    it("reach the request that asked, at its level, with the client's progress token", async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        await attachProvider("plant", { handshakeOnly });

        const discovered = (await post("plant", "server/discover")).body.result as Record<string, unknown>;
        expect(discovered.capabilities).toMatchObject({ logging: {} });

        const asked = await post("plant", "tools/call", { name: "flush_line", arguments: {} }, "flush_line", { [MCP_META.logLevel]: "warning", progressToken: "tok-1" });
        expect((asked.body.result as McpToolResult).content[0]).toEqual({ type: "text", text: "flushed" });
        const logs = asked.notifications.filter((frame) => frame.method === "notifications/message").map((frame) => (frame.params as { level: string }).level);
        expect(logs).toEqual(["warning"]);
        const progress = asked.notifications.filter((frame) => frame.method === "notifications/progress").map((frame) => frame.params);
        expect(progress).toEqual([{ progressToken: "tok-1", progress: 1, total: 2 }]);

        // Neither asked: nothing but the answer.
        const silent = await post("plant", "tools/call", { name: "flush_line", arguments: {} }, "flush_line");
        expect(silent.notifications).toEqual([]);
    });
});

describe("a slot with no provider yet", () => {
    it("answers discovery and the lists itself, then tells the stateless client to re-read when the provider attaches", async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        const client = statelessClient("plant");
        const opened = await client.connect();
        expect(client.isStateless).toBe(true);
        expect(opened.instructions).toMatch(/no provider yet/);
        expect(await client.listTools()).toEqual([]);
        let changed = 0;
        client.onToolsChanged?.subscribe(() => changed++);

        await attachProvider("plant");
        await settle(200);
        expect(changed).toBeGreaterThanOrEqual(1);
        expect((await client.listTools()).map((tool) => tool.name)).toEqual(["open_valve", "flush_line"]);
        client.disconnect();
    });

    it('lets a protocol "auto" client (Claude Code, mcp-core 1.6) go stateless', async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        const client = new McpClient({ name: "host", version: "1" }, new StreamableHttpTransport(broker.mcpUrl("plant"), { headers: broker.bearer("host") }), 5_000, {
            protocol: "auto",
        });
        await client.connect();
        expect(client.isStateless).toBe(true);
        client.disconnect();
    });
});

describe("what 2026-07-28 removed", () => {
    it("answers -32601 with HTTP 404, whatever the provider speaks", async () => {
        broker = await startTestBroker({ callers: { host: {} } });
        await attachProvider("plant", { handshakeOnly: true });
        const ping = await post("plant", "ping");
        expect(ping.status).toBe(404);
        expect((ping.body.error as { code: number }).code).toBe(-32601);
        const subscribe = await post("plant", "resources/subscribe", { uri: "valve://state" });
        expect((subscribe.body.error as { code: number }).code).toBe(-32601);
    });
});

describe("authorization", () => {
    it("needs mcp.events.read for the Events methods; discovery and the listen are free", async () => {
        broker = await startTestBroker({
            callers: { host: {} },
            policy: {
                slotResources: { plant: "/site/plant" },
                roles: { viewer: { capabilities: ["mcp.tools.list"] } },
                assignments: [{ id: "host", subject: "user:host", role: "viewer", resource: "/site/**" }],
            },
        });
        await attachProvider("plant", { events: alarmLog() });
        expect((await post("plant", "server/discover")).body.result).toBeDefined();
        expect((await post("plant", "tools/list")).body.result).toBeDefined();
        const poll = await post("plant", "events/poll", { name: "alarm", arguments: {}, cursor: null }, "alarm");
        expect(poll.body.error).toBeDefined();
        expect(poll.body.result).toBeUndefined();
    });
});
