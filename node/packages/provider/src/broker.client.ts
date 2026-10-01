/**
 * Talks to the broker itself, over the provider's own socket: declaring an
 * authorization domain, and asking for decisions.
 *
 * Requires broker 1.5.0 or later. An older broker does not know these methods:
 * from 1.4.1 it refuses them at once with `-32601`; 1.4.0 and earlier drop
 * them and never answer, which is why {@link IBrokerClientOptions.requestTimeoutMs}
 * exists, off by default.
 */

/** The `params._meta` key under which the broker passes the caller reference with each request. */
export const CALLER_META_KEY = "io.cyanmycelium/caller";

/** W3C Trace Context carrier used by MCP requests. */
export const TRACEPARENT_META_KEY = "traceparent";

/** Provider-to-broker telemetry notification. */
export const TELEMETRY_NOTIFICATION_METHOD = "broker/telemetry";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const UNIX_NANO = /^(0|[1-9][0-9]{0,19})$/;

export interface ITraceParent {
    readonly version: "00";
    readonly traceId: string;
    readonly parentId: string;
    readonly traceFlags: string;
}

export type TelemetryAttributeValue = string | number | boolean;

export interface ITelemetryEvent {
    readonly name: string;
    readonly timeUnixNano: string;
    readonly attributes?: Readonly<Record<string, TelemetryAttributeValue>>;
}

export interface ITelemetrySpan {
    readonly traceId: string;
    readonly spanId: string;
    readonly parentSpanId?: string;
    readonly name: string;
    readonly kind?: number;
    readonly startTimeUnixNano: string;
    readonly endTimeUnixNano: string;
    readonly attributes?: Readonly<Record<string, TelemetryAttributeValue>>;
    readonly events?: readonly ITelemetryEvent[];
    readonly status?: { readonly code: number; readonly message?: string };
}

/** Parses the W3C version 00 traceparent representation used in MCP metadata. */
export function parseTraceparent(value: unknown): ITraceParent | undefined {
    if (typeof value !== "string") return undefined;
    const match = TRACEPARENT.exec(value);
    if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return undefined;
    return { version: "00", traceId: match[1]!, parentId: match[2]!, traceFlags: match[3]! };
}

export function formatTraceparent(context: ITraceParent): string {
    return `${context.version}-${context.traceId}-${context.parentId}-${context.traceFlags}`;
}

/** Reads `params._meta.traceparent`, returning `undefined` when it is malformed. */
export function traceparentOf(meta: Readonly<Record<string, unknown>> | undefined): ITraceParent | undefined {
    return parseTraceparent(meta?.[TRACEPARENT_META_KEY]);
}

/** Returns a metadata copy carrying the supplied validated trace context. */
export function withTraceparent(meta: Readonly<Record<string, unknown>> | undefined, context: ITraceParent): Readonly<Record<string, unknown>> {
    const encoded = formatTraceparent(context);
    if (!parseTraceparent(encoded)) throw new TypeError("traceparent must be a valid W3C version 00 context");
    return { ...(meta ?? {}), [TRACEPARENT_META_KEY]: encoded };
}

/** Continues a trace using the caller's span as the new W3C parent id. */
export function childTraceparent(parent: ITraceParent, spanId: string): ITraceParent {
    if (!SPAN_ID.test(spanId) || /^0+$/.test(spanId)) throw new TypeError("spanId must be 16 lowercase hexadecimal characters and not all zero");
    return { ...parent, parentId: spanId };
}

function validAttributes(attributes: Readonly<Record<string, TelemetryAttributeValue>> | undefined): boolean {
    if (attributes === undefined) return true;
    const entries = Object.entries(attributes);
    return (
        entries.length <= 64 &&
        entries.every(
            ([key, value]) =>
                key.length > 0 &&
                key.length <= 128 &&
                (typeof value === "boolean" || (typeof value === "string" && value.length <= 4096) || (typeof value === "number" && Number.isFinite(value)))
        )
    );
}

function validSpan(span: ITelemetrySpan): boolean {
    return (
        TRACE_ID.test(span.traceId) &&
        !/^0+$/.test(span.traceId) &&
        SPAN_ID.test(span.spanId) &&
        !/^0+$/.test(span.spanId) &&
        (span.parentSpanId === undefined || (SPAN_ID.test(span.parentSpanId) && !/^0+$/.test(span.parentSpanId))) &&
        span.name.length > 0 &&
        span.name.length <= 256 &&
        UNIX_NANO.test(span.startTimeUnixNano) &&
        UNIX_NANO.test(span.endTimeUnixNano) &&
        (span.kind === undefined || (Number.isInteger(span.kind) && span.kind >= 0 && span.kind <= 5)) &&
        validAttributes(span.attributes) &&
        (span.events === undefined ||
            (span.events.length <= 32 &&
                span.events.every((event) => event.name.length > 0 && event.name.length <= 256 && UNIX_NANO.test(event.timeUnixNano) && validAttributes(event.attributes)))) &&
        (span.status === undefined ||
            (Number.isInteger(span.status.code) && span.status.code >= 0 && span.status.code <= 2 && (span.status.message === undefined || span.status.message.length <= 1024)))
    );
}

/** What the broker hands a declaring provider with each request, under {@link CALLER_META_KEY}. */
export interface ICallerReference {
    /** Opaque. Valid on this slot, while the request it came with is pending. */
    readonly ref: string;
    /** Ties the decisions and the eventual report to the client request. */
    readonly correlationId: string;
    /** W3C trace id carried by the MCP request. */
    readonly traceId?: string;
}

/**
 * Reads the caller reference out of a request's `params._meta`, or
 * `undefined` when there is none (the broker only adds it once a declaration
 * was accepted). With mcp-core 1.4.0, pass `request?.meta` from the context
 * an adapter receives.
 */
export function callerReferenceOf(meta: Readonly<Record<string, unknown>> | undefined): ICallerReference | undefined {
    const value = meta?.[CALLER_META_KEY];
    if (typeof value !== "object" || value === null) return undefined;
    const { ref, correlationId, traceId } = value as { ref?: unknown; correlationId?: unknown; traceId?: unknown };
    return typeof ref === "string" && typeof correlationId === "string" ? { ref, correlationId, ...(typeof traceId === "string" ? { traceId } : {}) } : undefined;
}

/** One resource of a declaration: the provider's own identifier, and the path the broker evaluates. */
export interface IDeclaredResource {
    readonly resource: string;
    readonly resourcePath: string;
    readonly effect?: string;
    readonly limits?: Readonly<Record<string, unknown>>;
}

/** `broker/authorization/declare` parameters. Describes; grants nothing. */
export interface IAuthorizationDeclaration {
    readonly version: string;
    readonly domain: string;
    readonly namespace: { readonly resource: string };
    readonly capabilities: readonly string[];
    readonly resources?: readonly IDeclaredResource[];
    readonly protects?: readonly string[];
}

export interface IDeclarationAccepted {
    readonly accepted: true;
    readonly version: string;
    readonly policyVersion: string;
}

/** One question: may (the caller) do `capability` on this resource? */
export interface IAuthorizationCheck {
    readonly capability: string;
    readonly resource: string;
    readonly resourcePath: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
}

/** `broker/authorize` parameters. */
export interface IAuthorizationQuery {
    /** On whose behalf: the caller of a pending request, or the provider itself. Never an identity. */
    readonly principal: { readonly type: "caller-ref"; readonly ref: string } | { readonly type: "provider" };
    /** Only for `{ type: "provider" }`; a caller reference carries its own. */
    readonly correlationId?: string;
    /** Optional W3C trace id for provider-initiated work. */
    readonly traceId?: string;
    readonly checks: readonly IAuthorizationCheck[];
}

export interface IAuthorizationDecision {
    readonly decisionId: string;
    readonly effect: "allow" | "deny";
    readonly allowed: boolean;
    readonly reason: string;
    readonly policies?: readonly string[];
}

export interface IAuthorizationAnswer {
    readonly policyVersion: string;
    /** One per check, in the same order. */
    readonly decisions: readonly IAuthorizationDecision[];
}

/** The broker refused a request, or never answered it. */
export class BrokerRequestError extends Error {
    constructor(
        message: string,
        /** JSON-RPC error code; `undefined` for a timeout or a closed socket. */
        public readonly code?: number,
        /** The error's `data`, e.g. `{ errors: [...] }` for a refused declaration. */
        public readonly data?: unknown
    ) {
        super(message);
        this.name = "BrokerRequestError";
    }
}

export interface IBrokerClientOptions {
    /**
     * Rejects a request the broker did not answer within this many ms. Off by
     * default: a broker from 1.4.1 on answers every request at once, refusals
     * included, so waiting is never the normal path. Set it only to talk to an
     * older broker, which drops what it does not know.
     */
    readonly requestTimeoutMs?: number;
}

interface IWaiting {
    readonly resolve: (result: unknown) => void;
    readonly reject: (error: BrokerRequestError) => void;
    readonly timer: ReturnType<typeof setTimeout> | null;
}

/** Ids of the provider's own requests; never confused with a client's, which the broker numbers `brk-N`. */
const ID_PREFIX = "provider-broker-";

/**
 * The `broker/*` methods of one provider slot. Reached as `transport.broker`
 * on {@link DirectTransport} and {@link MultiplexTransport}; the transport
 * routes the broker's answers here before anything reaches the MCP server.
 */
export class BrokerClient {
    private readonly _write: (frame: string) => void;
    private readonly _writeTelemetry: (frame: string) => boolean;
    private readonly _timeoutMs: number;
    private readonly _waiting = new Map<string, IWaiting>();
    private _next = 1;

    constructor(write: (frame: string) => void, options: IBrokerClientOptions = {}, writeTelemetry?: (frame: string) => boolean) {
        this._write = write;
        this._writeTelemetry =
            writeTelemetry ??
            ((frame) => {
                write(frame);
                return true;
            });
        this._timeoutMs = Math.max(0, options.requestTimeoutMs ?? 0);
    }

    /**
     * Declares this provider's authorization domain. Resolves when the broker
     * accepted it; rejects with a {@link BrokerRequestError} whose `data.errors`
     * lists every problem otherwise. Until it resolves, serve nothing that
     * needs a decision.
     */
    declare(declaration: IAuthorizationDeclaration): Promise<IDeclarationAccepted> {
        return this._request("broker/authorization/declare", declaration) as Promise<IDeclarationAccepted>;
    }

    /** Asks for one decision per check. */
    authorize(query: IAuthorizationQuery): Promise<IAuthorizationAnswer> {
        return this._request("broker/authorize", query) as Promise<IAuthorizationAnswer>;
    }

    /** Emits one complete provider span, or returns false when the link is down. */
    span(span: ITelemetrySpan): boolean {
        if (!validSpan(span)) throw new TypeError("span is not a valid broker telemetry span");
        return this._writeTelemetry(
            JSON.stringify({
                jsonrpc: "2.0",
                method: TELEMETRY_NOTIFICATION_METHOD,
                params: { version: 1, signal: "traces", span },
            })
        );
    }

    /** Number of requests still waiting for the broker. */
    get pendingCount(): number {
        return this._waiting.size;
    }

    /**
     * Consumes a frame when it answers one of this client's requests. Returns
     * `true` when it did, and the frame must not reach the MCP server.
     * @internal Called by the transports.
     */
    handleIncoming(frame: string): boolean {
        if (this._waiting.size === 0 || !frame.includes(ID_PREFIX)) return false;
        let message: { id?: unknown; method?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
        try {
            message = JSON.parse(frame) as typeof message;
        } catch {
            return false;
        }
        if (typeof message.id !== "string" || message.method !== undefined) return false;
        const waiting = this._waiting.get(message.id);
        if (!waiting) return false;
        this._waiting.delete(message.id);
        if (waiting.timer) clearTimeout(waiting.timer);
        if (message.error) {
            waiting.reject(
                new BrokerRequestError(String(message.error.message ?? "broker error"), typeof message.error.code === "number" ? message.error.code : undefined, message.error.data)
            );
        } else {
            waiting.resolve(message.result);
        }
        return true;
    }

    /**
     * Fails every waiting request: the socket they went out on is gone, and a
     * reconnected one will not carry their answers.
     * @internal Called by the transports.
     */
    rejectAll(reason: string): void {
        for (const [id, waiting] of this._waiting) {
            if (waiting.timer) clearTimeout(waiting.timer);
            waiting.reject(new BrokerRequestError(`${reason} (request ${id})`));
        }
        this._waiting.clear();
    }

    private _request(method: string, params: unknown): Promise<unknown> {
        const id = `${ID_PREFIX}${this._next++}`;
        return new Promise((resolve, reject) => {
            const timer =
                this._timeoutMs > 0
                    ? setTimeout(() => {
                          this._waiting.delete(id);
                          reject(
                              new BrokerRequestError(
                                  `The broker did not answer ${method} within ${this._timeoutMs}ms. A broker older than 1.4.1 drops methods it does not know; ${method} needs broker 1.5.0 or later.`
                              )
                          );
                      }, this._timeoutMs)
                    : null;
            this._waiting.set(id, { resolve, reject, timer });
            this._write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    }
}
