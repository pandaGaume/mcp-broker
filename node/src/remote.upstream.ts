import type { Upstream } from "./upstream.js";
import { createRemoteTransport, detectTransport, type RemoteTransport, type RemoteTransportKind } from "./remote.transports.js";

export interface RemoteUpstreamConfig {
    /** Provider slot name this upstream is bound to. */
    name: string;
    /** URL of the remote MCP server. */
    url: string;
    /** Transport to use. Auto-detected from the URL scheme/path when omitted. */
    transport?: RemoteTransportKind;
    /** Extra HTTP / WebSocket headers (e.g. an `Authorization` header). */
    headers?: Record<string, string>;
    /** When `true`, this upstream joins the `_all` aggregate slot once connected. */
    aggregate?: boolean;
}

/**
 * Bridges a remote MCP server (reachable by URL) into a broker provider slot.
 *
 * The broker-facing contract is identical to {@link StdioUpstream}: the broker
 * muxes the slot's clients onto this single upstream. The only difference is
 * the transport — Streamable HTTP / SSE / WebSocket instead of a child process.
 */
export class RemoteUpstream implements Upstream {
    readonly name: string;

    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    private readonly _config: RemoteUpstreamConfig;
    private _transport: RemoteTransport | null = null;
    private _open = false;

    constructor(config: RemoteUpstreamConfig) {
        this.name = config.name;
        this._config = config;
    }

    get isOpen(): boolean {
        return this._open;
    }

    connect(): void {
        const kind = this._config.transport ?? detectTransport(this._config.url);
        const transport = createRemoteTransport(this._config.url, kind, this._config.headers ?? {});
        this._transport = transport;

        transport.onOpen = (): void => {
            this._open = true;
            this.onOpen?.();
        };
        transport.onMessage = (data: string): void => this.onMessage?.(data);
        transport.onClose = (): void => {
            this._open = false;
            this.onClose?.();
        };
        transport.onError = (err: Error): void => {
            this.onError?.(new Error(`RemoteUpstream "${this.name}": ${err.message}`));
        };

        transport.connect();
    }

    send(data: string): void {
        this._transport?.send(data);
    }

    close(): void {
        this._open = false;
        this._transport?.close();
        this._transport = null;
    }
}
