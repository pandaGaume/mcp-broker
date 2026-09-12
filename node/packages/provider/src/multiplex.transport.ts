import type { IMessageTransport } from "@cyanmycelium/mcp-core";
import { decodeEnvelope, encodeEnvelope, encodeRegisterEnvelope, envelopeFrame, tunnelErrorOf } from "./protocol/index";
import { describeFrame, PendingFrames, ThrottledNotice, truncate, warnIfSlotScopedPath } from "./transport.support";

/** The diagnostics one socket may repeat, counted per socket so each is said once in full. */
interface ISocketNotices {
    /** A frame arrived that is not an envelope at all, the classic framing mismatch. */
    readonly notEnvelope: ThrottledNotice;

    /** An envelope arrived for a slot no transport on this socket publishes. */
    readonly unknownProvider: ThrottledNotice;

    /** The broker refused something and said so in an error envelope. */
    readonly tunnelError: ThrottledNotice;
}

// ---------------------------------------------------------------------------
// MultiplexSocket, shared WebSocket singleton (internal)
// ---------------------------------------------------------------------------

/**
 * Manages a single WebSocket connection shared by multiple {@link MultiplexTransport}
 * instances. All traffic goes through the tunnel envelope protocol, whose
 * definition lives in `./protocol` and is shared with the broker.
 *
 * Reconnection is handled centrally here, individual transports do not reconnect.
 * Use {@link getOrCreate} to obtain a per-URL singleton.
 */
class MultiplexSocket {
    /** Per-URL cache so all transports targeting the same tunnel share one socket. */
    private static readonly _instances = new Map<string, MultiplexSocket>();

    private readonly _wsUrl: string;
    private readonly _transports = new Map<string, MultiplexTransport>();

    /** Aggregate opt-in per slot, absent when the caller did not express one. */
    private readonly _aggregates = new Map<string, boolean>();

    /** Frames written while the socket is connecting, reconnecting or backing off. */
    private readonly _pending: PendingFrames;

    private _ws: WebSocket | null = null;
    private _reconnectAttempts = 0;
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _stopped = false;

    /** Set once the last transport left and this instance gave up its URL. */
    private _dead = false;

    /** The URL guard is about the URL, not the socket, so it is said once. */
    private _pathWarned = false;

    /** Throttles the "wrote to a closed tunnel" line, which repeats per frame. */
    private readonly _afterStopNotice = new ThrottledNotice();

    private constructor(wsUrl: string) {
        this._wsUrl = wsUrl;
        this._pending = new PendingFrames(`MultiplexSocket ${wsUrl}`);
    }

    /** Returns (or creates) the singleton socket for a given tunnel URL. */
    static getOrCreate(wsUrl: string): MultiplexSocket {
        let instance = MultiplexSocket._instances.get(wsUrl);
        if (!instance) {
            instance = new MultiplexSocket(wsUrl);
            MultiplexSocket._instances.set(wsUrl, instance);
        }
        return instance;
    }

    get isOpen(): boolean {
        return this._ws?.readyState === WebSocket.OPEN;
    }

    // ── Registration ────────────────────────────────────────────────────────

    register(name: string, transport: MultiplexTransport, aggregate?: boolean): void {
        if (this._dead) this._revive();

        this._transports.set(name, transport);
        if (aggregate !== undefined) this._aggregates.set(name, aggregate);

        // If the shared socket is already open, announce the new provider and
        // notify the transport immediately.
        if (this.isOpen) {
            this._announceProvider(name);
            transport.onOpen?.();
        } else if (!this._ws) {
            // First registration, open the connection. A reconnect may already
            // be armed from an earlier teardown, and letting it fire as well
            // would open a rival socket that the broker refuses.
            this._cancelReconnect();
            this._stopped = false;
            this._connect();
        }
    }

    unregister(name: string): void {
        this._transports.delete(name);
        this._aggregates.delete(name);

        // Tear down the shared socket when no transports remain.
        if (this._transports.size === 0) {
            this._stopped = true;
            this._cancelReconnect();
            this._pending.clear();
            this._ws?.close();
            this._ws = null;

            // Marked dead as well as evicted: a MultiplexTransport captures its
            // socket at construction, so one built before the teardown can still
            // call `register()` on this instance long after `getOrCreate` started
            // handing out a different one. Without the flag that reactivation
            // silently opens a second socket to the same URL, and the broker
            // refuses whichever of the two loses the race.
            this._dead = true;
            MultiplexSocket._instances.delete(this._wsUrl);
        }
    }

    /**
     * Brings a torn-down instance back into service when a transport that
     * captured it is reactivated.
     *
     * Reclaims the URL when nothing else holds it. When another instance already
     * does, the two would race for the same slot names, so this says exactly that
     * rather than letting the loser fail with a refusal nobody reads.
     */
    private _revive(): void {
        this._dead = false;
        this._stopped = false;

        const live = MultiplexSocket._instances.get(this._wsUrl);
        if (!live) {
            MultiplexSocket._instances.set(this._wsUrl, this);
            return;
        }
        if (live !== this) {
            console.warn(
                `[mcp-provider] MultiplexSocket ${this._wsUrl}: a transport built before this tunnel was closed is being reactivated, so it will open a second socket to the same URL. ` +
                    `The broker admits one socket per slot and refuses the other. Rebuild the transport with MultiplexTransport.create(name, url) instead of reusing one you closed.`
            );
        }
    }

    /**
     * Claims the slot for `name` so the broker eagerly creates its provider
     * state before any MCP client connects. Without it the broker only learns
     * about a provider on its first real message, and a client connecting in
     * between is told the provider is not connected.
     *
     * Carries the aggregate opt-in when the caller expressed one, which is why
     * it must go out before any traffic: the broker runs `initialize` against a
     * newly aggregated provider straight away.
     */
    private _announceProvider(name: string): void {
        if (this._ws?.readyState !== WebSocket.OPEN) return;

        const aggregate = this._aggregates.get(name);
        this._ws.send(aggregate === undefined ? encodeRegisterEnvelope(name) : encodeRegisterEnvelope(name, { aggregate }));
    }

    // ── Sending ─────────────────────────────────────────────────────────────

    send(provider: string, data: string): void {
        const frame = encodeEnvelope(provider, data);

        if (this._ws?.readyState === WebSocket.OPEN) {
            this._ws.send(frame);
            return;
        }

        // The tunnel was closed on purpose, so nothing will ever flush a queue.
        if (this._stopped) {
            if (this._afterStopNotice.hit()) {
                console.warn(
                    `[mcp-provider] MultiplexSocket ${this._wsUrl}: dropping a frame for provider "${provider}" written after the tunnel was closed (${describeFrame(frame)}). ` +
                        `Call connect() on a transport to reopen it.${this._afterStopNotice.suffix()}`
                );
            }
            return;
        }

        // Connecting, or waiting out a reconnect back-off of up to 30 seconds.
        // Dropping here is what makes a provider look alive while answering
        // nothing, so the frame waits for the socket instead.
        this._pending.push(frame);
    }

    // ── Connection lifecycle ────────────────────────────────────────────────

    private _connect(): void {
        if (!this._pathWarned) {
            this._pathWarned = true;
            warnIfSlotScopedPath(this._wsUrl);
        }

        const ws = new WebSocket(this._wsUrl);

        // Counted per socket so a mismatch reports itself once in full rather
        // than once per frame for the life of the page.
        const notices: ISocketNotices = {
            notEnvelope: new ThrottledNotice(),
            unknownProvider: new ThrottledNotice(),
            tunnelError: new ThrottledNotice(),
        };

        // Held from construction, not from `onopen`: a transport registering
        // while the handshake is still in flight must find this socket rather
        // than open a second one. Readiness is decided by `readyState`, so a
        // connecting socket is never mistaken for a usable one.
        this._ws = ws;

        // Every handler below starts by checking that this socket is still the
        // current one. An orphaned socket, one superseded by a reconnect or by a
        // reactivated transport, otherwise keeps speaking for the instance: its
        // `onclose` nulls `_ws` and fires `onClose` on every transport while a
        // newer socket is live, after which `isOpen` reads false, an MCP server
        // gates every send on it, and the provider goes silent on a working
        // tunnel with nothing logged anywhere.
        ws.onopen = () => {
            if (this._ws !== ws) return;

            this._reconnectAttempts = 0;
            // Announce all registered providers to the broker so it eagerly
            // creates their slots before any MCP client connects.
            for (const name of this._transports.keys()) {
                this._announceProvider(name);
            }
            // Then whatever was written while the socket was down, after the
            // registrations and before the transports are told they are open, so
            // the broker sees the slots claimed before any traffic on them.
            this._flush(ws);
            for (const transport of this._transports.values()) {
                transport.onOpen?.();
            }
        };

        ws.onerror = () => {
            if (this._ws !== ws) return;

            for (const transport of this._transports.values()) {
                transport.onError?.(new Error(`MultiplexSocket: WebSocket error on ${this._wsUrl}`));
            }
        };

        ws.onclose = () => {
            if (this._ws !== ws) return;

            this._ws = null;
            for (const transport of this._transports.values()) {
                transport.onClose?.();
            }
            if (!this._stopped) {
                this._scheduleReconnect();
            }
        };

        ws.onmessage = (event: MessageEvent<string>) => {
            if (this._ws !== ws) return;
            this._routeIncoming(event.data, notices);
        };
    }

    /** Writes out everything queued while the socket was down. */
    private _flush(ws: WebSocket): void {
        for (const frame of this._pending.drain()) {
            ws.send(frame);
        }
    }

    private _routeIncoming(raw: string, notices: ISocketNotices): void {
        const envelope = decodeEnvelope(raw);
        if (!envelope) {
            // The single most expensive silent failure in this stack, and the
            // one the field report lost a day to. The broker decides framing
            // from the endpoint the socket landed on, so a slot-scoped path
            // answers in plain JSON-RPC, which is not an envelope and used to be
            // dropped here without a word while the tunnel looked healthy.
            if (notices.notEnvelope.hit()) {
                console.error(
                    `[mcp-provider] MultiplexSocket ${this._wsUrl}: dropped an incoming frame that is not a tunnel envelope { provider, payload }: ${truncate(raw)}. ` +
                        `Only the broker's shared multiplex base (/providers) speaks envelopes. A slot-scoped path (/provider/<name>) carries plain JSON-RPC and needs new DirectTransport(url) instead. ` +
                        `If this URL is already the multiplex base, the frame came from something else writing on the socket, such as a proxy error page.${notices.notEnvelope.suffix()}`
                );
            }
            return;
        }

        const transport = this._transports.get(envelope.provider);
        if (!transport) {
            if (notices.unknownProvider.hit()) {
                const known = [...this._transports.keys()].map((name) => `"${name}"`).join(", ") || "none";
                console.error(
                    `[mcp-provider] MultiplexSocket ${this._wsUrl}: dropped an envelope for provider "${envelope.provider}", which no transport on this socket publishes. Registered here: ${known}. ` +
                        `Check that the slot name passed to MultiplexTransport.create matches the one the broker routes to.${notices.unknownProvider.suffix()}`
                );
            }
            return;
        }

        // A tunnel-level refusal (a rejected slot, an unavailable provider)
        // carries no request id. Handing it to an MCP server would get it
        // classified as an unknown notification and dropped without a word, so
        // surface it as a transport error instead.
        const payload = envelope.payload as { id?: unknown } | null;
        if (payload !== null && (payload.id === null || payload.id === undefined)) {
            const error = tunnelErrorOf(envelope.payload);
            if (error) {
                const message = `Tunnel error ${error.code} on provider "${envelope.provider}": ${error.message}`;
                transport.onError?.(new Error(message));

                // `onError` alone is not enough to be heard: an MCP server
                // overwrites it when it starts and only reports through it while
                // it is not yet running, and this socket reports itself open
                // before any refusal can arrive. So the console is the only place
                // a browser-hosted provider learns it was refused.
                if (notices.tunnelError.hit()) {
                    console.error(`[mcp-provider] ${message}${notices.tunnelError.suffix()}`);
                }
                return;
            }
        }

        transport.onMessage?.(envelopeFrame(envelope));
    }

    private _scheduleReconnect(): void {
        const base = 1_000;
        const max = 30_000;
        const jitter = 0.5 + Math.random() * 0.5;
        const delay = Math.min(base * 2 ** this._reconnectAttempts, max) * jitter;

        this._reconnectAttempts++;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            // A registration during the back-off may already have opened a
            // socket. Reconnecting on top of it would leave two live sockets
            // announcing the same slots, one of which the broker refuses.
            if (this._stopped || this._ws) return;
            this._connect();
        }, delay);
    }

    /** Disarms a pending reconnect, so nothing opens a socket behind our back. */
    private _cancelReconnect(): void {
        if (this._reconnectTimer === null) return;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
    }
}

// ---------------------------------------------------------------------------
// MultiplexTransport, per-server transport (public)
// ---------------------------------------------------------------------------

/** Options accepted by {@link MultiplexTransport.create}. */
export interface IMultiplexTransportOptions {
    /**
     * Join the broker's `_all` aggregate slot as well as this provider's own
     * slot, by carrying `params: { aggregate: true }` on the registration
     * notification the shared socket sends when it claims the slot.
     *
     * Opt-in on purpose: `_all` exposes this provider's tools and prompts to
     * every client of the aggregate slot, so a provider that does not ask for it
     * stays reachable only on its own slot.
     *
     * ORDERING: the broker runs `initialize` against a newly aggregated provider
     * immediately, and drops it from `_all` without a word if the handshake times
     * out. The registration goes out from {@link MultiplexTransport.connect}, so
     * assign `onMessage` (or hand this transport to an MCP server, which assigns
     * it for you) *before* connecting. Connecting first and wiring the handler
     * afterwards loses the broker's `initialize`, and the provider silently never
     * appears in `_all`.
     */
    aggregate?: boolean;
}

/**
 * A transport that multiplexes multiple MCP servers over a single shared
 * WebSocket connection using the envelope protocol `{ provider, payload }`.
 *
 * Use the static {@link create} factory to obtain an instance:
 * ```typescript
 * const t1 = MultiplexTransport.create("scene-1", "ws://localhost:3000/providers");
 * const t2 = MultiplexTransport.create("scene-2", "ws://localhost:3000/providers");
 * // t1 and t2 share a single WebSocket under the hood.
 * ```
 */
export class MultiplexTransport implements IMessageTransport {
    private readonly _name: string;
    private readonly _socket: MultiplexSocket;
    private readonly _aggregate: boolean | undefined;
    private _registered = false;

    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    constructor(name: string, socket: MultiplexSocket, options?: IMultiplexTransportOptions) {
        this._name = name;
        this._socket = socket;
        this._aggregate = options?.aggregate;
    }

    /**
     * Convenience factory: creates a {@link MultiplexTransport} backed by a
     * shared {@link MultiplexSocket} for the given tunnel URL.
     *
     * Transports targeting the same `wsUrl` automatically share one WebSocket.
     *
     * @param wsUrl The broker's shared multiplex base, `ws://<broker>/providers`.
     *              A slot-scoped `/provider/<name>` URL belongs to
     *              {@link DirectTransport} and is warned about on connect.
     */
    static create(name: string, wsUrl: string, options?: IMultiplexTransportOptions): MultiplexTransport {
        return new MultiplexTransport(name, MultiplexSocket.getOrCreate(wsUrl), options);
    }

    get isOpen(): boolean {
        return this._socket.isOpen;
    }

    /**
     * Registers this transport with the shared socket.
     *
     * Safe to call multiple times, subsequent calls are no-ops.
     */
    activate(): void {
        if (!this._registered) {
            this._registered = true;
            this._socket.register(this._name, this, this._aggregate);
        }
    }

    /**
     * Opens the transport, the same way every other transport does.
     *
     * An alias of {@link activate} so callers never have to special-case this
     * class: an MCP server or client just calls `connect()` on whatever
     * transport it was handed.
     */
    connect(): void {
        this.activate();
    }

    send(data: string): void {
        this._socket.send(this._name, data);
    }

    close(): void {
        if (this._registered) {
            this._registered = false;
            this._socket.unregister(this._name);
        }
    }
}
