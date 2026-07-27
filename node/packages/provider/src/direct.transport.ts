import type { IMessageTransport } from "@cyanmycelium/mcp-core";

/**
 * 1:1 WebSocket transport — wraps a single `WebSocket` connection to a broker
 * provider slot, typically `ws://<broker>/provider/<name>`.
 *
 * One server owns one socket. When an application publishes several servers
 * through the same broker, prefer {@link MultiplexTransport}, which shares a
 * single socket between them.
 *
 * Call {@link connect} after setting the event callbacks to open the socket.
 */
export class DirectTransport implements IMessageTransport {
    private readonly _wsUrl: string;
    private _ws: WebSocket | null = null;

    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    constructor(wsUrl: string) {
        this._wsUrl = wsUrl;
    }

    get isOpen(): boolean {
        return this._ws?.readyState === WebSocket.OPEN;
    }

    /**
     * Opens the WebSocket connection and wires its events to the transport
     * callbacks. Must be called after assigning `onOpen` / `onMessage` / etc.
     */
    connect(): void {
        const ws = new WebSocket(this._wsUrl);

        ws.onopen = () => {
            this._ws = ws;
            this.onOpen?.();
        };

        ws.onerror = () => {
            this.onError?.(new Error(`DirectTransport: WebSocket error on ${this._wsUrl}`));
        };

        ws.onclose = () => {
            this._ws = null;
            this.onClose?.();
        };

        ws.onmessage = (event: MessageEvent<string>) => {
            this.onMessage?.(event.data);
        };
    }

    send(data: string): void {
        if (this._ws?.readyState === WebSocket.OPEN) {
            this._ws.send(data);
        }
    }

    close(): void {
        this._ws?.close();
        this._ws = null;
    }
}
