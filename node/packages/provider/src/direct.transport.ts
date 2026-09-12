import type { IMessageTransport } from "@cyanmycelium/mcp-core";
import { encodeRegisterFrame } from "./protocol/index";
import { describeFrame, PendingFrames, ThrottledNotice, warnIfMultiplexPath } from "./transport.support";

/** Options accepted by {@link DirectTransport}. */
export interface IDirectTransportOptions {
    /**
     * Join the broker's `_all` aggregate slot as well as this provider's own
     * slot, by sending the registration notification
     * `{"jsonrpc":"2.0","method":"notifications/register","params":{"aggregate":true}}`
     * as the first frame on the socket.
     *
     * Opt-in on purpose: `_all` exposes this provider's tools and prompts to
     * every client of the aggregate slot, so a provider that does not ask for it
     * stays reachable only on its own slot.
     *
     * ORDERING: the broker runs `initialize` against a newly aggregated provider
     * immediately, and drops it from `_all` without a word if the handshake times
     * out. The frame therefore goes out on `open`, never from the constructor, so
     * assign `onMessage` (or hand this transport to an MCP server, which assigns
     * it for you) *before* calling {@link DirectTransport.connect}. Connecting
     * first and wiring the handler afterwards loses the broker's `initialize` and
     * the provider silently never appears in `_all`.
     */
    aggregate?: boolean;
}

/**
 * 1:1 WebSocket transport, wraps a single `WebSocket` connection to a broker
 * provider slot, typically `ws://<broker>/provider/<name>`.
 *
 * One server owns one socket. When an application publishes several servers
 * through the same broker, prefer {@link MultiplexTransport}, which shares a
 * single socket between them.
 *
 * This transport does **not** reconnect: when the socket closes, it stays
 * closed until the application calls {@link connect} again. Only
 * {@link MultiplexTransport}'s shared socket reconnects on its own.
 *
 * Call {@link connect} after setting the event callbacks to open the socket.
 */
export class DirectTransport implements IMessageTransport {
    private readonly _wsUrl: string;
    private readonly _aggregate: boolean | undefined;
    private readonly _pending: PendingFrames;

    /** Throttles the "wrote to a closed transport" line, which repeats per frame. */
    private readonly _afterCloseNotice = new ThrottledNotice();

    private _ws: WebSocket | null = null;
    private _closed = false;

    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    constructor(wsUrl: string, options?: IDirectTransportOptions) {
        this._wsUrl = wsUrl;
        this._aggregate = options?.aggregate;
        this._pending = new PendingFrames(`DirectTransport ${wsUrl}`);
    }

    get isOpen(): boolean {
        return this._ws?.readyState === WebSocket.OPEN;
    }

    /**
     * Opens the WebSocket connection and wires its events to the transport
     * callbacks. Must be called after assigning `onOpen` / `onMessage` / etc.
     */
    connect(): void {
        // Fires before the socket exists, so the mismatch is named even if the
        // handshake succeeds, which it does: the broker accepts the connection
        // and then drops every frame this transport writes.
        warnIfMultiplexPath(this._wsUrl);

        const ws = new WebSocket(this._wsUrl);

        this._closed = false;

        // Held from construction, not from `onopen`, the way MultiplexSocket
        // already does it: everything written between `connect()` and open is
        // otherwise sent to a `null` socket and discarded without a trace.
        // Readiness is decided by `readyState`, so a connecting socket is never
        // mistaken for a usable one.
        this._ws = ws;

        // Every handler below starts by checking that this socket is still the
        // current one. A second `connect()` supersedes the first, and a stale
        // socket's late `onclose` would otherwise null the live one out from
        // under the server, which then goes quiet with no error anywhere.
        ws.onopen = () => {
            if (this._ws !== ws) return;
            this._sendRegistration(ws);
            this._flush(ws);
            this.onOpen?.();
        };

        ws.onerror = () => {
            if (this._ws !== ws) return;
            this.onError?.(new Error(`DirectTransport: WebSocket error on ${this._wsUrl}`));
        };

        ws.onclose = (event?: CloseEvent) => {
            if (this._ws !== ws) return;
            this._ws = null;

            const discarded = this._pending.clear();

            // ORDER IS LOAD-BEARING: `onError` must fire before `onClose`.
            // An MCP server's `onClose` clears its running flag, after which it
            // treats a later `onError` as a pre-open failure and rejects an
            // already-settled promise, so the message is thrown away. Reporting
            // first is what makes a broker refusal (1008, with the reason in the
            // close frame) readable instead of an undifferentiated disconnect.
            const error = this._closeError(event, discarded);
            if (error) this.onError?.(new Error(error));

            this.onClose?.();
        };

        ws.onmessage = (event: MessageEvent<string>) => {
            this.onMessage?.(event.data);
        };
    }

    send(data: string): void {
        if (this._ws?.readyState === WebSocket.OPEN) {
            this._ws.send(data);
            return;
        }

        if (this._closed) {
            if (this._afterCloseNotice.hit()) {
                console.warn(
                    `[mcp-provider] DirectTransport ${this._wsUrl}: dropping a frame written after close() (${describeFrame(data)}). ` +
                        `This transport does not reconnect, call connect() again before sending.${this._afterCloseNotice.suffix()}`
                );
            }
            return;
        }

        // The socket is still connecting. Queue rather than drop: an MCP server
        // writes its handshake as soon as it is told to start, and the socket is
        // usually not open yet.
        this._pending.push(data);
    }

    close(): void {
        this._closed = true;

        const discarded = this._pending.clear();
        if (discarded > 0) {
            console.warn(`[mcp-provider] DirectTransport ${this._wsUrl}: closed with ${discarded} frame(s) still queued, they were never sent.`);
        }

        // `_ws` is deliberately left in place: the browser fires `onclose`
        // asynchronously, and clearing it here would make the handler's staleness
        // check reject its own socket and swallow `onClose`. The handler nulls it.
        this._ws?.close();
    }

    /**
     * Sends the registration notification when the caller asked for a specific
     * aggregate membership. The slot name is not in the frame: on the
     * slot-scoped path the broker takes it from the URL at connect time.
     */
    private _sendRegistration(ws: WebSocket): void {
        if (this._aggregate === undefined) return;
        ws.send(encodeRegisterFrame({ aggregate: this._aggregate }));
    }

    /** Writes out everything queued while the socket was connecting. */
    private _flush(ws: WebSocket): void {
        for (const frame of this._pending.drain()) {
            ws.send(frame);
        }
    }

    /**
     * Builds the message for a close worth reporting, or `undefined` when there
     * is nothing to say.
     *
     * A code of 1000 is a normal close and stays silent. An environment that
     * calls `onclose` with no event at all leaves nothing to distinguish a
     * refusal from a clean shutdown, so that stays silent too.
     */
    private _closeError(event: CloseEvent | undefined, discarded: number): string | undefined {
        const code = event?.code;
        if (code === undefined || code === 1000) return undefined;

        const reason = event?.reason ? `: "${event.reason}"` : " (no reason given)";
        const hint =
            code === 1008
                ? "Code 1008 is a policy refusal from the broker, not a network drop: the slot is already connected, is reserved, or provider authentication rejected it. The reason above is the broker's own wording."
                : "DirectTransport does not reconnect, call connect() again to retry.";
        const lost = discarded > 0 ? ` ${discarded} queued frame(s) were discarded.` : "";

        return `DirectTransport: the socket to ${this._wsUrl} closed with code ${code}${reason}. ${hint}${lost}`;
    }
}
