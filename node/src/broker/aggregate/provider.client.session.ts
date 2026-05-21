import type { InternalClient } from "../../ws.tunnel.js";
import type { CatalogTool, CatalogPrompt } from "./aggregate.catalog.js";

/** MCP protocol version the aggregate sessions negotiate with sub-providers. */
const PROTOCOL_VERSION = "2024-11-05";

/** Per-request timeout for sub-provider calls. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Outcome of a JSON-RPC request: exactly one of `result` / `error` is set. */
interface RpcOutcome {
    result?: unknown;
    error?: unknown;
}

interface PendingRequest {
    resolve: (outcome: RpcOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface IncomingMessage {
    id?: string | number | null;
    method?: string;
    result?: unknown;
    error?: unknown;
}

/**
 * A hand-rolled JSON-RPC client session to one aggregated provider, running
 * over an in-process {@link InternalClient}.
 *
 * Performs the MCP `initialize` handshake, caches the provider's `tools/list`
 * and `prompts/list`, and re-fetches them when the provider emits a
 * `list_changed` notification. `tools/call` and `prompts/get` are forwarded and
 * their raw result or error relayed back unchanged.
 */
export class ProviderClientSession {
    readonly provider: string;

    private readonly _client: InternalClient;
    private readonly _idPrefix: string;
    private readonly _pending = new Map<string, PendingRequest>();
    private _nextId = 0;
    private _tools: CatalogTool[] = [];
    private _prompts: CatalogPrompt[] = [];
    private _closed = false;

    /** Fires after the cached catalog changes (initial load or `list_changed`). */
    onCatalogChanged: (() => void) | null = null;

    /** Fires when the underlying provider slot disconnects. */
    onClosed: (() => void) | null = null;

    constructor(provider: string, client: InternalClient) {
        this.provider = provider;
        this._client = client;
        this._idPrefix = `agg-${provider}-`;
        client.onMessage = (data: string): void => this._handleMessage(data);
        client.onClose = (): void => {
            if (this._closed) return;
            this._rejectAll("provider disconnected");
            this.onClosed?.();
        };
    }

    get tools(): CatalogTool[] {
        return this._tools;
    }

    get prompts(): CatalogPrompt[] {
        return this._prompts;
    }

    /** Runs the `initialize` handshake and the first catalog fetch. */
    async initialize(): Promise<void> {
        await this._request("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "mcp-broker-aggregate", version: "0" },
        });
        this._client.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
        await this._refresh();
    }

    /** Forwards a `tools/call` to the provider, relaying the raw outcome. */
    callTool(name: string, args: Record<string, unknown>): Promise<RpcOutcome> {
        return this._request("tools/call", { name, arguments: args });
    }

    /** Forwards a `prompts/get` to the provider, relaying the raw outcome. */
    getPrompt(name: string, args: Record<string, unknown>): Promise<RpcOutcome> {
        return this._request("prompts/get", { name, arguments: args });
    }

    /** Detaches the session and its internal client. */
    close(): void {
        if (this._closed) return;
        this._closed = true;
        this._rejectAll("session closed");
        this._client.close();
    }

    private async _refresh(): Promise<void> {
        this._tools = await this._listAll<CatalogTool>("tools/list", "tools");
        this._prompts = await this._listAll<CatalogPrompt>("prompts/list", "prompts");
        this.onCatalogChanged?.();
    }

    /**
     * Calls a list method, following `nextCursor` pagination. A provider that
     * does not implement the primitive answers with an error, which is treated
     * as an empty list.
     */
    private async _listAll<T>(method: string, key: string): Promise<T[]> {
        const items: T[] = [];
        let cursor: string | undefined;
        do {
            const { result, error } = await this._request(method, cursor ? { cursor } : {});
            if (error) return [];
            const page = (result ?? {}) as Record<string, unknown>;
            const list = page[key];
            if (Array.isArray(list)) items.push(...(list as T[]));
            cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
        } while (cursor);
        return items;
    }

    private _request(method: string, params: unknown): Promise<RpcOutcome> {
        return new Promise<RpcOutcome>((resolve) => {
            if (this._closed) {
                resolve({ error: { code: -32000, message: "session closed" } });
                return;
            }
            const id = this._idPrefix + String(++this._nextId);
            const timer = setTimeout(() => {
                this._pending.delete(id);
                resolve({ error: { code: -32000, message: `request "${method}" timed out` } });
            }, REQUEST_TIMEOUT_MS);
            this._pending.set(id, { resolve, timer });
            this._client.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    }

    private _handleMessage(data: string): void {
        let msg: IncomingMessage;
        try {
            msg = JSON.parse(data) as IncomingMessage;
        } catch {
            return;
        }
        if (typeof msg.id === "string") {
            const pending = this._pending.get(msg.id);
            if (pending) {
                this._pending.delete(msg.id);
                clearTimeout(pending.timer);
                pending.resolve({ result: msg.result, error: msg.error });
            }
            return;
        }
        if (msg.id == null && (msg.method === "notifications/tools/list_changed" || msg.method === "notifications/prompts/list_changed")) {
            void this._refresh();
        }
    }

    private _rejectAll(reason: string): void {
        for (const pending of this._pending.values()) {
            clearTimeout(pending.timer);
            pending.resolve({ error: { code: -32000, message: reason } });
        }
        this._pending.clear();
    }
}
