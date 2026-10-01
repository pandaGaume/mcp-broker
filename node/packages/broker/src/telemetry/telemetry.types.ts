/** JSON-RPC notification consumed by the broker telemetry extension. */
export const TELEMETRY_NOTIFICATION_METHOD = "notifications/telemetry";

/** Attribute values intentionally match the scalar subset shared by MCP JSON and OTLP. */
export type TelemetryAttributeValue = string | number | boolean;

export interface ITelemetryEvent {
    name: string;
    timeUnixNano: string;
    attributes?: Readonly<Record<string, TelemetryAttributeValue>>;
}

/**
 * Compact OTLP-compatible span sent by a provider.
 *
 * IDs use W3C Trace Context representation. Timestamps are decimal strings so
 * nanosecond precision survives JSON on runtimes whose numbers are IEEE-754.
 */
export interface ITelemetrySpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind?: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes?: Readonly<Record<string, TelemetryAttributeValue>>;
    events?: readonly ITelemetryEvent[];
    status?: {
        code: number;
        message?: string;
    };
}

/** One validated span enriched with broker-side slot identity and receipt time. */
export interface IProviderTelemetryRecord {
    slot: string;
    receivedAtUnixNano: string;
    span: ITelemetrySpan;
}

/** Destination for validated telemetry batches. Implementations may use OTLP, a file, or a test sink. */
export interface IProviderTelemetryExporter {
    export(records: readonly IProviderTelemetryRecord[]): void | Promise<void>;
    flush?(): void | Promise<void>;
    close?(): void | Promise<void>;
}

export interface IProviderTelemetryOptions {
    exporter: IProviderTelemetryExporter;
    /** Maximum notification size accepted from a provider. @default 65536 */
    maxFrameBytes?: number;
    /** Maximum queued spans. New spans are dropped when full. @default 256 */
    queueCapacity?: number;
    /** Maximum spans passed to one exporter call. @default 32 */
    batchSize?: number;
    /** Maximum attributes on a span or event. @default 64 */
    maxAttributes?: number;
    /** Maximum events on a span. @default 32 */
    maxEvents?: number;
    /** Called after an exporter failure. The failed batch is dropped. */
    onExportError?: (error: unknown) => void;
}

export interface IProviderTelemetryStats {
    enabled: boolean;
    accepted: number;
    exported: number;
    droppedInvalid: number;
    droppedOversize: number;
    droppedQueueFull: number;
    droppedExporter: number;
    exportErrors: number;
    queued: number;
}
