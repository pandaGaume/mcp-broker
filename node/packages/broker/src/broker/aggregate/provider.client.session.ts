import type { IInternalClient } from "../../ws/ws.interfaces";
import type { ICatalogTool, ICatalogPrompt } from "./aggregate.catalog";

/** MCP protocol version the aggregate sessions negotiate with sub-providers. */
const PROTOCOL_VERSION = "2024-11-05";

/** Per-request timeout for sub-provider calls. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Outcome of a JSON-RPC request: exactly one of `result` / `error` is set. */
interface IRpcOutcome {
    result?: unknown;
    error?: unknown;
}

interface IPendingRequest {
    resolve: (outcome: IRpcOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * True for the JSON-RPC "method not found" error, the documented way a provider
 * says it does not implement a primitive. Expected, so it is never logged.
 */
function isMethodNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as Record<string, unknown>).code === -32601;
}

/** Renders a JSON-RPC error payload as a one-line message for a log or a throw. */
function describeRpcError(error: unknown): string {
    if (error && typeof error === "object" && !Array.isArray(error)) {
        const record = error as Record<string, unknown>;
        const message = typeof record.message === "string" ? record.message : JSON.stringify(error);
        return record.code === undefined ? message : `${message} (JSON-RPC code ${String(record.code)})`;
    }
    return typeof error === "string" ? error : JSON.stringify(error);
}

interface IIncomingMessage {
    id?: string | number | null;
    method?: string;
    result?: unknown;
    error?: unknown;
}

/**
 * A hand-rolled JSON-RPC client session to one aggregated provider, running
 * over an in-process {@link IInternalClient}.
 *
 * Performs the MCP `initialize` handshake, caches the provider's `tools/list`
 * and `prompts/list`, and re-fetches them when the provider emits a
 * `list_changed` notification. `tools/call` and `prompts/get` are forwarded and
 * their raw result or error relayed back unchanged.
 */
export class ProviderClientSession {
    readonly provider: string;

    private readonly _client: IInternalClient;
    private readonly _idPrefix: string;
    private readonly _pending = new Map<string, IPendingRequest>();
    private _nextId = 0;
    private _tools: ICatalogTool[] = [];
    private _prompts: ICatalogPrompt[] = [];
    private _closed = false;

    /** Fires after the cached catalog changes (initial load or `list_changed`). */
    onCatalogChanged: (() => void) | null = null;

    /** Fires when the underlying provider slot disconnects. */
    onClosed: (() => void) | null = null;

    constructor(provider: string, client: IInternalClient) {
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

    get tools(): ICatalogTool[] {
        return this._tools;
    }

    get prompts(): ICatalogPrompt[] {
        return this._prompts;
    }

    /**
     * Runs the `initialize` handshake and the first catalog fetch.
     *
     * Throws when the provider answers `initialize` with an error, times out, or
     * has already gone away. The outcome used to be discarded, which left a
     * provider that never completed the handshake registered in `_all` with an
     * empty catalog and produced no diagnostic anywhere.
     */
    async initialize(): Promise<void> {
        const outcome = await this._request("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "mcp-broker-aggregate", version: "0" },
        });
        if (outcome.error !== undefined) {
            throw new Error(`provider "${this.provider}" refused the aggregate handshake: initialize answered ${describeRpcError(outcome.error)}.`);
        }
        this._client.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
        await this._refresh();
    }

    /** Forwards a `tools/call` to the provider, relaying the raw outcome. */
    callTool(name: string, args: Record<string, unknown>): Promise<IRpcOutcome> {
        return this._request("tools/call", { name, arguments: args });
    }

    /** Forwards a `prompts/get` to the provider, relaying the raw outcome. */
    getPrompt(name: string, args: Record<string, unknown>): Promise<IRpcOutcome> {
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
        this._tools = await this._listAll<ICatalogTool>("tools/list", "tools");
        this._prompts = await this._listAll<ICatalogPrompt>("prompts/list", "prompts");
        this.onCatalogChanged?.();
    }

    /**
     * Refreshes the catalog without letting a failure escape, for the
     * notification path where there is no caller to hand a rejection to.
     */
    private _refreshSafely(): void {
        void this._refresh().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[broker] aggregate: refreshing the catalog of provider "${this.provider}" after a list_changed notification failed: ${message}`);
        });
    }

    /**
     * Calls a list method, following `nextCursor` pagination.
     *
     * An empty list is returned on any failure, because a provider that does not
     * implement the primitive legitimately answers `-32601`. Every other failure
     * (a timeout, a refusal) also lands here and silently produced a provider
     * with no tools, so anything that is not "method not found" is logged.
     */
    private async _listAll<T>(method: string, key: string): Promise<T[]> {
        const items: T[] = [];
        let cursor: string | undefined;
        do {
            let outcome: IRpcOutcome;
            try {
                outcome = await this._request(method, cursor ? { cursor } : {});
            } catch (error) {
                console.error(
                    `[broker] aggregate: provider "${this.provider}" did not answer "${method}", so it joins "_all" with no ${key}: ${error instanceof Error ? error.message : String(error)}`
                );
                return [];
            }
            if (outcome.error !== undefined) {
                // -32601 is the documented "I do not implement this primitive"
                // answer and is expected from most providers for prompts/list.
                if (!isMethodNotFound(outcome.error)) {
                    console.error(
                        `[broker] aggregate: provider "${this.provider}" answered "${method}" with an error, so it joins "_all" with no ${key}: ${describeRpcError(outcome.error)} ` +
                            `Clients of the "_all" slot will simply not see this provider's ${key}.`
                    );
                }
                return [];
            }
            const page = (outcome.result ?? {}) as Record<string, unknown>;
            const list = page[key];
            if (Array.isArray(list)) items.push(...(list as T[]));
            cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
        } while (cursor);
        return items;
    }

    /**
     * Sends one JSON-RPC request and settles on the provider's answer.
     *
     * **Rejects** on the request timeout. Resolving with a synthetic error there
     * made every caller treat a dead provider as a provider that answered, which
     * is how a hung `initialize` ended up registered in `_all` with no trace.
     */
    private _request(method: string, params: unknown): Promise<IRpcOutcome> {
        return new Promise<IRpcOutcome>((resolve, reject) => {
            if (this._closed) {
                resolve({ error: { code: -32000, message: "session closed" } });
                return;
            }
            const id = this._idPrefix + String(++this._nextId);
            const startedAt = Date.now();
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(
                    new Error(
                        `provider "${this.provider}" did not answer "${method}" within ${Date.now() - startedAt}ms (request id "${id}"). ` +
                            `The provider socket is connected but nothing replied: make sure the provider installs its MCP message handler before it registers the slot, ` +
                            `and that it echoes back the exact JSON-RPC id it received.`
                    )
                );
            }, REQUEST_TIMEOUT_MS);
            this._pending.set(id, { resolve, timer });
            this._client.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    }

    private _handleMessage(data: string): void {
        let msg: IIncomingMessage;
        try {
            msg = JSON.parse(data) as IIncomingMessage;
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
            this._refreshSafely();
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
