import { randomBytes } from "node:crypto";

/** W3C Trace Context carrier used inside MCP `params._meta`. */
export const TRACEPARENT_META_KEY = "traceparent";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface ITraceParent {
    readonly version: "00";
    readonly traceId: string;
    readonly parentId: string;
    readonly traceFlags: string;
}

/** Parses the W3C version 00 traceparent representation accepted by the broker. */
export function parseTraceparent(value: unknown): ITraceParent | undefined {
    if (typeof value !== "string") return undefined;
    const match = TRACEPARENT.exec(value);
    if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return undefined;
    return { version: "00", traceId: match[1]!, parentId: match[2]!, traceFlags: match[3]! };
}

/** Serializes one validated W3C version 00 trace context. */
export function formatTraceparent(context: ITraceParent): string {
    return `${context.version}-${context.traceId}-${context.parentId}-${context.traceFlags}`;
}

/** Creates a sampled root context when an MCP caller supplied none. */
export function createTraceparent(): ITraceParent {
    return {
        version: "00",
        traceId: randomBytes(16).toString("hex"),
        parentId: randomBytes(8).toString("hex"),
        traceFlags: "01",
    };
}

/**
 * Preserves a valid client context or replaces an absent or malformed one,
 * then writes the canonical representation into `params._meta.traceparent`.
 */
export function ensureTraceparent(message: Record<string, unknown>): ITraceParent {
    const params = typeof message.params === "object" && message.params !== null && !Array.isArray(message.params) ? (message.params as Record<string, unknown>) : {};
    const meta = typeof params._meta === "object" && params._meta !== null && !Array.isArray(params._meta) ? (params._meta as Record<string, unknown>) : {};
    const context = parseTraceparent(meta[TRACEPARENT_META_KEY]) ?? createTraceparent();
    meta[TRACEPARENT_META_KEY] = formatTraceparent(context);
    params._meta = meta;
    message.params = params;
    return context;
}
