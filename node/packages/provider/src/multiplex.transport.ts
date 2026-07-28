import type { IMessageTransport } from "@cyanmycelium/mcp-core";
import { decodeEnvelope, encodeEnvelope, encodeRegisterEnvelope, envelopeFrame, tunnelErrorOf } from "./protocol/index";

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
    private _ws: WebSocket | null = null;
    private _reconnectAttempts = 0;
    private _stopped = false;

    private constructor(wsUrl: string) {
        this._wsUrl = wsUrl;
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

    register(name: string, transport: MultiplexTransport): void {
        this._transports.set(name, transport);

        // If the shared socket is already open, announce the new provider and
        // notify the transport immediately.
        if (this.isOpen) {
            this._announceProvider(name);
            transport.onOpen?.();
        } else if (!this._ws) {
            // First registration, open the connection.
            this._stopped = false;
            this._connect();
        }
    }

    unregister(name: string): void {
        this._transports.delete(name);

        // Tear down the shared socket when no transports remain.
        if (this._transports.size === 0) {
            this._stopped = true;
            this._ws?.close();
            this._ws = null;
            MultiplexSocket._instances.delete(this._wsUrl);
        }
    }

    /**
     * Claims the slot for `name` so the broker eagerly creates its provider
     * state before any MCP client connects. Without it the broker only learns
     * about a provider on its first real message, and a client connecting in
     * between is told the provider is not connected.
     */
    private _announceProvider(name: string): void {
        if (this._ws?.readyState !== WebSocket.OPEN) return;
        this._ws.send(encodeRegisterEnvelope(name));
    }

    // ── Sending ─────────────────────────────────────────────────────────────

    send(provider: string, data: string): void {
        if (this._ws?.readyState !== WebSocket.OPEN) return;
        this._ws.send(encodeEnvelope(provider, data));
    }

    // ── Connection lifecycle ────────────────────────────────────────────────

    private _connect(): void {
        const ws = new WebSocket(this._wsUrl);

        // Held from construction, not from `onopen`: a transport registering
        // while the handshake is still in flight must find this socket rather
        // than open a second one. Readiness is decided by `readyState`, so a
        // connecting socket is never mistaken for a usable one.
        this._ws = ws;

        ws.onopen = () => {
            this._reconnectAttempts = 0;
            // Announce all registered providers to the broker so it eagerly
            // creates their slots before any MCP client connects.
            for (const name of this._transports.keys()) {
                this._announceProvider(name);
            }
            for (const transport of this._transports.values()) {
                transport.onOpen?.();
            }
        };

        ws.onerror = () => {
            for (const transport of this._transports.values()) {
                transport.onError?.(new Error(`MultiplexSocket: WebSocket error on ${this._wsUrl}`));
            }
        };

        ws.onclose = () => {
            this._ws = null;
            for (const transport of this._transports.values()) {
                transport.onClose?.();
            }
            if (!this._stopped) {
                this._scheduleReconnect();
            }
        };

        ws.onmessage = (event: MessageEvent<string>) => {
            this._routeIncoming(event.data);
        };
    }

    private _routeIncoming(raw: string): void {
        const envelope = decodeEnvelope(raw);
        if (!envelope) return; // malformed, drop silently

        const transport = this._transports.get(envelope.provider);
        if (!transport) return;

        // A tunnel-level refusal (a rejected slot, an unavailable provider)
        // carries no request id. Handing it to an MCP server would get it
        // classified as an unknown notification and dropped without a word, so
        // surface it as a transport error instead.
        const payload = envelope.payload as { id?: unknown } | null;
        if (payload !== null && (payload.id === null || payload.id === undefined)) {
            const error = tunnelErrorOf(envelope.payload);
            if (error) {
                transport.onError?.(new Error(`Tunnel error ${error.code} on provider "${envelope.provider}": ${error.message}`));
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
        setTimeout(() => {
            if (!this._stopped) this._connect();
        }, delay);
    }
}

// ---------------------------------------------------------------------------
// MultiplexTransport, per-server transport (public)
// ---------------------------------------------------------------------------

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
    private _registered = false;

    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    constructor(name: string, socket: MultiplexSocket) {
        this._name = name;
        this._socket = socket;
    }

    /**
     * Convenience factory: creates a {@link MultiplexTransport} backed by a
     * shared {@link MultiplexSocket} for the given tunnel URL.
     *
     * Transports targeting the same `wsUrl` automatically share one WebSocket.
     */
    static create(name: string, wsUrl: string): MultiplexTransport {
        return new MultiplexTransport(name, MultiplexSocket.getOrCreate(wsUrl));
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
            this._socket.register(this._name, this);
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
