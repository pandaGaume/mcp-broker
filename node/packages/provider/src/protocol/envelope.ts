/**
 * The CyanMycelium tunnel envelope protocol.
 *
 * A multiplexed tunnel socket carries traffic for several providers at once, so
 * every JSON-RPC message is wrapped with the name of the provider slot it
 * belongs to. Both ends of the tunnel encode and decode with the helpers here:
 * the client transports that publish a provider, and the broker that routes
 * between providers and MCP clients.
 *
 * This module is the single definition of that wire format. It is deliberately
 * dependency-free and isomorphic, so the browser side and the Node broker share
 * exactly one implementation rather than two that drift apart.
 *
 * Wire format:
 * ```json
 * { "provider": "scene-1", "payload": { "jsonrpc": "2.0", "id": 1, "result": {} } }
 * ```
 */

/** One framed message on a multiplexed tunnel socket. */
export interface TunnelEnvelope {
    /** Name of the provider slot this message belongs to. */
    provider: string;

    /** The JSON-RPC message itself, already parsed. */
    payload: unknown;
}

/**
 * Notification a client sends to claim a provider slot as soon as the tunnel
 * opens, before any MCP client shows up.
 *
 * Without it the broker only discovers a provider name on its first real
 * message, so an MCP client connecting in between is told the provider is not
 * connected. It is a plain JSON-RPC notification, which any peer that does not
 * recognize it ignores.
 */
export const TUNNEL_REGISTER_METHOD = "notifications/register";

/** Options carried by the registration notification, as its `params`. */
export interface ITunnelRegisterOptions {
    /**
     * Join the broker's `_all` aggregate slot in addition to the provider's own
     * slot, so a single MCP client sees every opted-in provider's tools and
     * prompts through one connection.
     *
     * Opt-in on purpose: `_all` is a confidentiality boundary, and a provider
     * that never asks for it stays reachable only on its own slot.
     */
    aggregate?: boolean;
}

/**
 * Builds the registration notification as a plain JSON-RPC frame, for the
 * slot-scoped path `/provider/<name>`, which carries no envelope.
 *
 * The slot name is not in the frame: on that path the broker takes it from the
 * URL at connect time, before any frame exists.
 *
 * @param options When `aggregate` is set, it is carried as `params.aggregate`.
 *                Omitted entirely otherwise, which keeps the frame identical to
 *                the parameterless form older brokers already accept.
 */
export function encodeRegisterFrame(options?: ITunnelRegisterOptions): string {
    return JSON.stringify(registerMessage(options));
}

/** The registration notification body, shared by both encoders. */
function registerMessage(options?: ITunnelRegisterOptions): Record<string, unknown> {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method: TUNNEL_REGISTER_METHOD };
    if (options?.aggregate !== undefined) {
        message.params = { aggregate: options.aggregate };
    }
    return message;
}

/** JSON-RPC error codes the broker returns on the tunnel itself. */
export const TunnelErrorCodes = {
    /** The slot is taken by another upstream, or the provider is not connected. */
    ProviderUnavailable: -32000,

    /** The provider's credentials do not allow publishing on this slot. */
    RegistrationForbidden: -32001,
} as const;

export type TunnelErrorCode = (typeof TunnelErrorCodes)[keyof typeof TunnelErrorCodes];

/** A JSON-RPC error as carried inside an envelope payload. */
export interface TunnelError {
    code: number;
    message: string;
    data?: unknown;
}

/**
 * Wraps an already-serialized JSON-RPC frame for `provider`.
 *
 * @throws SyntaxError when `frame` is not valid JSON. Callers hold a frame they
 *         just serialized, so a failure here is a bug rather than bad input.
 */
export function encodeEnvelope(provider: string, frame: string): string {
    return encodeEnvelopeMessage(provider, JSON.parse(frame));
}

/** Wraps an already-parsed JSON-RPC message for `provider`. */
export function encodeEnvelopeMessage(provider: string, payload: unknown): string {
    const envelope: TunnelEnvelope = { provider, payload };
    return JSON.stringify(envelope);
}

/**
 * Parses a raw tunnel frame.
 *
 * Returns `undefined` for anything malformed rather than throwing: a tunnel
 * socket is a public surface, and a peer sending garbage must not take the
 * receiver down. Both ends drop such frames silently.
 */
export function decodeEnvelope(raw: string): TunnelEnvelope | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

    const { provider, payload } = parsed as Partial<TunnelEnvelope>;
    if (typeof provider !== "string" || provider.length === 0 || payload === undefined) return undefined;

    return { provider, payload };
}

/** Serializes an envelope's payload back into a plain JSON-RPC frame. */
export function envelopeFrame(envelope: TunnelEnvelope): string {
    return JSON.stringify(envelope.payload);
}

/**
 * Builds the registration notification that claims `provider`, wrapped for the
 * multiplexed tunnel.
 *
 * @param options When `aggregate` is set, it is carried as `params.aggregate`.
 *                Omitted entirely otherwise: the parameterless frame is the one
 *                brokers have always received here, and it stays byte-identical.
 */
export function encodeRegisterEnvelope(provider: string, options?: ITunnelRegisterOptions): string {
    return encodeEnvelopeMessage(provider, registerMessage(options));
}

/**
 * Builds the error envelope the broker returns when it refuses a slot.
 *
 * The id is `null` because the refusal answers no particular request: it
 * reacts to the registration itself.
 */
export function encodeErrorEnvelope(provider: string, code: TunnelErrorCode | number, message: string): string {
    return encodeEnvelopeMessage(provider, { jsonrpc: "2.0", id: null, error: { code, message } });
}

/**
 * Reads the JSON-RPC error out of an envelope payload, when there is one.
 *
 * Lets the client side notice a refused registration instead of handing an
 * `id: null` error frame to an MCP server, which would classify it as an
 * unknown notification and drop it without a word.
 */
export function tunnelErrorOf(payload: unknown): TunnelError | undefined {
    if (typeof payload !== "object" || payload === null) return undefined;

    const { error } = payload as { error?: unknown };
    if (typeof error !== "object" || error === null) return undefined;

    const { code, message } = error as Partial<TunnelError>;
    if (typeof code !== "number" || typeof message !== "string") return undefined;

    return error as TunnelError;
}
