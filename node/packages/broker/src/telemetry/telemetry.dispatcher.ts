import type { IProviderTelemetryOptions, IProviderTelemetryRecord, IProviderTelemetryStats, ITelemetryEvent, ITelemetrySpan, TelemetryAttributeValue } from "./telemetry.types";

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const UNIX_NANO = /^(0|[1-9][0-9]{0,19})$/;

const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_QUEUE_CAPACITY = 256;
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_MAX_ATTRIBUTES = 64;
const DEFAULT_MAX_EVENTS = 32;

interface ILimits {
    maxFrameBytes: number;
    queueCapacity: number;
    batchSize: number;
    maxAttributes: number;
    maxEvents: number;
}

type EnqueueResult = "accepted" | "invalid" | "oversize" | "queue-full" | "closed";

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${name} must be a positive safe integer`);
    return resolved;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attributesOf(value: unknown, maxAttributes: number): Readonly<Record<string, TelemetryAttributeValue>> | undefined | null {
    if (value === undefined) return undefined;
    if (!isObject(value)) return null;
    const entries = Object.entries(value);
    if (entries.length > maxAttributes) return null;
    const attributes: Record<string, TelemetryAttributeValue> = {};
    for (const [key, attribute] of entries) {
        if (key.length === 0 || key.length > 128) return null;
        if (typeof attribute !== "string" && typeof attribute !== "number" && typeof attribute !== "boolean") return null;
        if (typeof attribute === "string" && attribute.length > 4096) return null;
        if (typeof attribute === "number" && !Number.isFinite(attribute)) return null;
        attributes[key] = attribute;
    }
    return attributes;
}

function eventOf(value: unknown, maxAttributes: number): ITelemetryEvent | null {
    if (!isObject(value) || typeof value.name !== "string" || value.name.length === 0 || value.name.length > 256) return null;
    if (typeof value.timeUnixNano !== "string" || !UNIX_NANO.test(value.timeUnixNano)) return null;
    const attributes = attributesOf(value.attributes, maxAttributes);
    if (attributes === null) return null;
    return {
        name: value.name,
        timeUnixNano: value.timeUnixNano,
        ...(attributes === undefined ? {} : { attributes }),
    };
}

function spanOf(params: unknown, limits: ILimits): ITelemetrySpan | null {
    if (!isObject(params) || params.version !== 1 || params.signal !== "traces" || !isObject(params.span)) return null;
    const span = params.span;
    if (typeof span.traceId !== "string" || !TRACE_ID.test(span.traceId) || /^0+$/.test(span.traceId)) return null;
    if (typeof span.spanId !== "string" || !SPAN_ID.test(span.spanId) || /^0+$/.test(span.spanId)) return null;
    if (span.parentSpanId !== undefined && (typeof span.parentSpanId !== "string" || !SPAN_ID.test(span.parentSpanId) || /^0+$/.test(span.parentSpanId))) return null;
    if (typeof span.name !== "string" || span.name.length === 0 || span.name.length > 256) return null;
    if (typeof span.startTimeUnixNano !== "string" || !UNIX_NANO.test(span.startTimeUnixNano)) return null;
    if (typeof span.endTimeUnixNano !== "string" || !UNIX_NANO.test(span.endTimeUnixNano)) return null;
    if (span.kind !== undefined && (!Number.isInteger(span.kind) || (span.kind as number) < 0 || (span.kind as number) > 5)) return null;

    const attributes = attributesOf(span.attributes, limits.maxAttributes);
    if (attributes === null) return null;

    let events: ITelemetryEvent[] | undefined;
    if (span.events !== undefined) {
        if (!Array.isArray(span.events) || span.events.length > limits.maxEvents) return null;
        events = [];
        for (const candidate of span.events) {
            const event = eventOf(candidate, limits.maxAttributes);
            if (!event) return null;
            events.push(event);
        }
    }

    let status: ITelemetrySpan["status"];
    if (span.status !== undefined) {
        if (!isObject(span.status) || !Number.isInteger(span.status.code) || (span.status.code as number) < 0 || (span.status.code as number) > 2) return null;
        if (span.status.message !== undefined && (typeof span.status.message !== "string" || span.status.message.length > 1024)) return null;
        status = {
            code: span.status.code as number,
            ...(span.status.message === undefined ? {} : { message: span.status.message as string }),
        };
    }

    return {
        traceId: span.traceId,
        spanId: span.spanId,
        ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
        name: span.name,
        ...(span.kind === undefined ? {} : { kind: span.kind as number }),
        startTimeUnixNano: span.startTimeUnixNano,
        endTimeUnixNano: span.endTimeUnixNano,
        ...(attributes === undefined ? {} : { attributes }),
        ...(events === undefined ? {} : { events }),
        ...(status === undefined ? {} : { status }),
    };
}

/** Bounded, asynchronous boundary between provider traffic and an exporter. */
export class ProviderTelemetryDispatcher {
    private readonly _limits: ILimits;
    private readonly _queue: IProviderTelemetryRecord[] = [];
    private _drainPromise: Promise<void> | null = null;
    private _drainScheduled = false;
    private _closed = false;
    private readonly _stats = {
        accepted: 0,
        exported: 0,
        droppedInvalid: 0,
        droppedOversize: 0,
        droppedQueueFull: 0,
        droppedExporter: 0,
        exportErrors: 0,
    };

    constructor(private readonly _options: IProviderTelemetryOptions) {
        this._limits = {
            maxFrameBytes: positiveInteger(_options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, "maxFrameBytes"),
            queueCapacity: positiveInteger(_options.queueCapacity, DEFAULT_QUEUE_CAPACITY, "queueCapacity"),
            batchSize: positiveInteger(_options.batchSize, DEFAULT_BATCH_SIZE, "batchSize"),
            maxAttributes: positiveInteger(_options.maxAttributes, DEFAULT_MAX_ATTRIBUTES, "maxAttributes"),
            maxEvents: positiveInteger(_options.maxEvents, DEFAULT_MAX_EVENTS, "maxEvents"),
        };
    }

    enqueue(slot: string, params: unknown, frameBytes: number): EnqueueResult {
        if (this._closed) return "closed";
        if (frameBytes > this._limits.maxFrameBytes) {
            this._stats.droppedOversize++;
            return "oversize";
        }
        const span = spanOf(params, this._limits);
        if (!span) {
            this._stats.droppedInvalid++;
            return "invalid";
        }
        if (this._queue.length >= this._limits.queueCapacity) {
            this._stats.droppedQueueFull++;
            return "queue-full";
        }
        this._queue.push({
            slot,
            receivedAtUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
            span,
        });
        this._stats.accepted++;
        this._scheduleDrain();
        return "accepted";
    }

    get stats(): IProviderTelemetryStats {
        return { enabled: true, ...this._stats, queued: this._queue.length };
    }

    async flush(): Promise<void> {
        while (this._queue.length > 0 || this._drainPromise) {
            this._scheduleDrain();
            const pending = this._drainPromise;
            if (pending) await pending;
            else await new Promise<void>((resolve) => queueMicrotask(resolve));
        }
        try {
            await this._options.exporter.flush?.();
        } catch (error) {
            this._reportExportError(error);
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.flush();
        try {
            await this._options.exporter.close?.();
        } catch (error) {
            this._reportExportError(error);
        }
    }

    private _scheduleDrain(): void {
        if (this._drainScheduled || this._drainPromise || this._queue.length === 0) return;
        this._drainScheduled = true;
        queueMicrotask(() => {
            this._drainScheduled = false;
            if (this._drainPromise || this._queue.length === 0) return;
            this._drainPromise = this._drain().finally(() => {
                this._drainPromise = null;
                this._scheduleDrain();
            });
        });
    }

    private async _drain(): Promise<void> {
        while (this._queue.length > 0) {
            const batch = this._queue.splice(0, this._limits.batchSize);
            try {
                await this._options.exporter.export(batch);
                this._stats.exported += batch.length;
            } catch (error) {
                this._stats.droppedExporter += batch.length;
                this._reportExportError(error);
            }
        }
    }

    private _reportExportError(error: unknown): void {
        this._stats.exportErrors++;
        try {
            this._options.onExportError?.(error);
        } catch {
            // Observability callbacks must never break the broker lifecycle.
        }
    }
}
