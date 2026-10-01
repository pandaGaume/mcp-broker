import type { IProviderTelemetryExporter, IProviderTelemetryRecord, ITelemetrySpan, TelemetryAttributeValue } from "./telemetry.types";

export interface IOtlpHttpTraceExporterOptions {
    /** Full OTLP/HTTP traces endpoint, usually http://collector:4318/v1/traces. */
    endpoint: string;
    headers?: Readonly<Record<string, string>>;
    /** Abort one export after this duration. @default 5000 */
    timeoutMs?: number;
    /** Resource service.namespace value. @default "mcp-broker.provider" */
    serviceNamespace?: string;
    /** Test or platform injection point. Defaults to global fetch. */
    fetch?: typeof fetch;
}

interface IOtlpAnyValue {
    stringValue?: string;
    boolValue?: boolean;
    doubleValue?: number;
    intValue?: string;
}

function anyValue(value: TelemetryAttributeValue): IOtlpAnyValue {
    if (typeof value === "string") return { stringValue: value };
    if (typeof value === "boolean") return { boolValue: value };
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function keyValues(attributes: Readonly<Record<string, TelemetryAttributeValue>> | undefined): Array<{ key: string; value: IOtlpAnyValue }> {
    return Object.entries(attributes ?? {}).map(([key, value]) => ({ key, value: anyValue(value) }));
}

function otlpSpan(span: ITelemetrySpan): Record<string, unknown> {
    return {
        traceId: span.traceId,
        spanId: span.spanId,
        ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
        name: span.name,
        kind: span.kind ?? 0,
        startTimeUnixNano: span.startTimeUnixNano,
        endTimeUnixNano: span.endTimeUnixNano,
        attributes: keyValues(span.attributes),
        events: (span.events ?? []).map((event) => ({
            name: event.name,
            timeUnixNano: event.timeUnixNano,
            attributes: keyValues(event.attributes),
        })),
        ...(span.status === undefined ? {} : { status: span.status }),
    };
}

/** Minimal dependency-free OTLP/HTTP JSON trace exporter for provider telemetry. */
export class OtlpHttpTraceExporter implements IProviderTelemetryExporter {
    private readonly _endpoint: string;
    private readonly _timeoutMs: number;
    private readonly _fetch: typeof fetch;
    private readonly _headers: Readonly<Record<string, string>>;
    private readonly _serviceNamespace: string;

    constructor(options: IOtlpHttpTraceExporterOptions) {
        this._endpoint = new URL(options.endpoint).toString();
        this._timeoutMs = options.timeoutMs ?? 5000;
        if (!Number.isSafeInteger(this._timeoutMs) || this._timeoutMs <= 0) throw new RangeError("timeoutMs must be a positive safe integer");
        this._fetch = options.fetch ?? fetch;
        this._headers = options.headers ?? {};
        this._serviceNamespace = options.serviceNamespace ?? "mcp-broker.provider";
    }

    async export(records: readonly IProviderTelemetryRecord[]): Promise<void> {
        if (records.length === 0) return;
        const byResource = new Map<string, IProviderTelemetryRecord[]>();
        for (const record of records) {
            const key = `${record.principal ?? ""}\u0000${record.slot}`;
            const group = byResource.get(key) ?? [];
            group.push(record);
            byResource.set(key, group);
        }
        const body = {
            resourceSpans: [...byResource.values()].map((spans) => {
                const first = spans[0]!;
                return {
                    resource: {
                        attributes: [
                            { key: "service.name", value: { stringValue: first.principal ?? first.slot } },
                            { key: "service.namespace", value: { stringValue: this._serviceNamespace } },
                            { key: "service.instance.id", value: { stringValue: first.slot } },
                            { key: "mcp.provider.slot", value: { stringValue: first.slot } },
                            ...(first.principal ? [{ key: "mcp.provider.principal", value: { stringValue: first.principal } }] : []),
                        ],
                    },
                    scopeSpans: [
                        {
                            scope: { name: "@cyanmycelium/mcp-broker.telemetry" },
                            spans: spans.map((record) => otlpSpan(record.span)),
                        },
                    ],
                };
            }),
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._timeoutMs);
        timer.unref?.();
        try {
            const response = await this._fetch(this._endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", ...this._headers },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!response.ok) {
                const detail = (await response.text()).slice(0, 512);
                throw new Error(`OTLP/HTTP export failed with ${response.status}${detail ? `: ${detail}` : ""}`);
            }
        } finally {
            clearTimeout(timer);
        }
    }
}
