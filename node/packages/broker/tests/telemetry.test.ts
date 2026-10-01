import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { OtlpHttpTraceExporter, ProviderTelemetryDispatcher, WsTunnelBuilder, diagnoseBroker, type IProviderTelemetryExporter, type IProviderTelemetryRecord } from "../src/index";
import type { WsTunnel } from "../src/ws/ws.tunnel";

const span = {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    name: "modbus.read",
    kind: 3,
    startTimeUnixNano: "1720000000000000000",
    endTimeUnixNano: "1720000000001000000",
    attributes: { "modbus.function_code": 3, "network.transport": "tcp" },
    events: [{ name: "pdu.rx", timeUnixNano: "1720000000000900000", attributes: { bytes: 9 } }],
    status: { code: 1 },
} as const;

const notification = {
    jsonrpc: "2.0",
    method: "broker/telemetry",
    params: { version: 1, signal: "traces", span },
};

let tunnel: WsTunnel | null = null;
const sockets: WebSocket[] = [];

async function open(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
    });
    return ws;
}

afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    await tunnel?.stop();
    tunnel = null;
});

describe("provider telemetry routing", () => {
    it("exports an enriched span without broadcasting it to MCP clients", async () => {
        const records: IProviderTelemetryRecord[] = [];
        const exported = new Promise<void>((resolve) => {
            const exporter: IProviderTelemetryExporter = {
                export(batch) {
                    records.push(...batch);
                    resolve();
                },
            };
            tunnel = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1").withTelemetry({ exporter }).build();
        });
        await tunnel!.start();
        const address = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer.address();
        const provider = await open(`ws://127.0.0.1:${address.port}/provider/motor1`);
        const client = await open(`ws://127.0.0.1:${address.port}/motor1`);
        const clientMessage = vi.fn();
        client.on("message", clientMessage);

        provider.send(JSON.stringify(notification));
        await exported;
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(records).toHaveLength(1);
        expect(records[0]?.slot).toBe("motor1");
        expect(records[0]?.span).toEqual(span);
        expect(clientMessage).not.toHaveBeenCalled();
        expect(tunnel!.getTelemetryStats()).toMatchObject({ accepted: 1, exported: 1, droppedInvalid: 0 });
    });

    it("drops malformed telemetry and never hands it to the exporter", async () => {
        const exporter: IProviderTelemetryExporter = { export: vi.fn() };
        const dispatcher = new ProviderTelemetryDispatcher({ exporter });

        expect(dispatcher.enqueue("bad", { version: 1, signal: "traces", span: { ...span, traceId: "wrong" } }, 200)).toBe("invalid");
        await dispatcher.close();

        expect(exporter.export).not.toHaveBeenCalled();
        expect(dispatcher.stats).toMatchObject({ droppedInvalid: 1, accepted: 0 });
    });

    it("drops new spans when its fixed queue is full", async () => {
        let release: (() => void) | undefined;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const exporter: IProviderTelemetryExporter = { export: () => blocked };
        const dispatcher = new ProviderTelemetryDispatcher({ exporter, queueCapacity: 1, batchSize: 1 });

        expect(dispatcher.enqueue("one", notification.params, 200)).toBe("accepted");
        expect(dispatcher.enqueue("two", notification.params, 200)).toBe("queue-full");
        release?.();
        await dispatcher.close();

        expect(dispatcher.stats).toMatchObject({ accepted: 1, exported: 1, droppedQueueFull: 1 });
    });

    it("surfaces exporter failures through broker_diagnose", async () => {
        let attempted!: () => void;
        const attempt = new Promise<void>((resolve) => {
            attempted = resolve;
        });
        tunnel = new WsTunnelBuilder()
            .withPort(0)
            .withHost("127.0.0.1")
            .withTelemetry({
                exporter: {
                    export() {
                        attempted();
                        throw new Error("collector unavailable");
                    },
                },
            })
            .build();
        await tunnel.start();
        const address = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer.address();
        const provider = await open(`ws://127.0.0.1:${address.port}/provider/motor1`);
        provider.send(JSON.stringify(notification));
        await attempt;

        const diagnosis = diagnoseBroker(tunnel)!;
        expect(diagnosis.telemetry).toMatchObject({ exportErrors: 1, droppedExporter: 1 });
        expect(diagnosis.problems).toContainEqual(expect.objectContaining({ id: "telemetry-export-failures" }));
    });
});

describe("OTLP/HTTP exporter", () => {
    it("maps compact provider spans to an OTLP JSON request", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
        const exporter = new OtlpHttpTraceExporter({ endpoint: "http://collector:4318/v1/traces", fetch: fetchMock });

        await exporter.export([{ slot: "spoony01", principal: "mcp-modbus", receivedAtUnixNano: "1720000000002000000", span }]);

        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("http://collector:4318/v1/traces");
        const body = JSON.parse(String(init?.body)) as {
            resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> }; scopeSpans: Array<{ spans: unknown[] }> }>;
        };
        expect(body.resourceSpans[0]?.resource.attributes).toContainEqual({ key: "mcp.provider.slot", value: { stringValue: "spoony01" } });
        expect(body.resourceSpans[0]?.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "mcp-modbus" } });
        expect(body.resourceSpans[0]?.resource.attributes).toContainEqual({ key: "mcp.provider.principal", value: { stringValue: "mcp-modbus" } });
        expect((body.resourceSpans[0]?.scopeSpans[0] as { spans: Array<{ attributes: unknown[] }> }).spans[0]?.attributes).toContainEqual({
            key: "modbus.function_code",
            value: { intValue: "3" },
        });
        expect(body.resourceSpans[0]?.scopeSpans[0]?.spans).toHaveLength(1);
    });
});
