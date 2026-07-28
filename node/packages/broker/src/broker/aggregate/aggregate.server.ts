import type { IMessageTransport } from "@cyanmycelium/mcp-core";
import type { IInternalClient } from "../../ws/ws.interfaces";
import type { AggregateScopeFilter, IPrincipal } from "../../auth/index";
import {
    SubjectMappingError,
    makeAuthorizationAuditEvent,
    writeAuthorizationAuditEvent,
    type IAuthorizationDecision,
    type IAuthorizationSubject,
    type IMcpOperation,
    type IPolicyAuthorization,
} from "../../authorization/index";
import { AggregateCatalog } from "./aggregate.catalog";
import { ProviderClientSession } from "./provider.client.session";

/** MCP protocol version advertised by the aggregate server. */
const PROTOCOL_VERSION = "2024-11-05";

/** Opens an in-process client to a named provider slot. Supplied by WsTunnel. */
export type InternalClientFactory = (providerName: string) => IInternalClient;

interface IClientMessage {
    id?: string | number | null;
    method?: string;
    params?: unknown;
}

interface ICallParams {
    name?: string;
    arguments?: Record<string, unknown>;
}

/**
 * The `_all` aggregate MCP server. Presents the union of every opted-in
 * provider's tools and prompts as a single MCP server, reachable on the
 * reserved `_all` slot.
 *
 * It implements {@link IMessageTransport} so it can be registered on the
 * WsTunnel as a loopback provider: `send` receives client requests, `onMessage`
 * (assigned by the tunnel) carries responses and notifications back to clients.
 */
export class AggregateServer implements IMessageTransport {
    /** Reserved provider slot the aggregate is published on. */
    static readonly SLOT = "_all";

    private readonly _catalog = new AggregateCatalog();
    private readonly _sessions = new Map<string, ProviderClientSession>();
    private readonly _openClient: InternalClientFactory;
    private _running = false;
    /** Per-caller provider visibility filter; `null` ⇒ every caller sees all. */
    private _scopeFilter: AggregateScopeFilter | null = null;
    /** Provider-aware hierarchical authorization, absent in legacy mode. */
    private _authorization: IPolicyAuthorization | null = null;

    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    constructor(openClient: InternalClientFactory) {
        this._openClient = openClient;
    }

    get isOpen(): boolean {
        return this._running;
    }

    /** Number of providers currently in the aggregate. */
    get providerCount(): number {
        return this._sessions.size;
    }

    /** Marks the aggregate transport open. Call before registering it. */
    start(): void {
        this._running = true;
    }

    /** Sets the per-caller provider visibility filter. `null` disables filtering. */
    setScopeFilter(filter: AggregateScopeFilter | null): void {
        this._scopeFilter = filter;
    }

    /** Sets the compiled hierarchical policy runtime. */
    setPolicyAuthorization(authorization: IPolicyAuthorization | null): void {
        this._authorization = authorization;
    }

    /** WsTunnel hands a client request for the `_all` slot here (no principal). */
    send(data: string): void {
        void this._handleClientMessage(data, null);
    }

    /**
     * Like {@link send}, but carries the authenticated caller so the aggregate
     * narrows the catalog and routing to the providers the caller may see.
     */
    sendAs(data: string, principal: IPrincipal | null): void {
        void this._handleClientMessage(data, principal);
    }

    /** Closes every provider session and the aggregate transport. */
    close(): void {
        if (!this._running) return;
        this._running = false;
        for (const session of this._sessions.values()) session.close();
        this._sessions.clear();
        this.onClose?.();
    }

    /**
     * Adds a provider to the aggregate: opens an internal client, runs the
     * session handshake, and merges the provider's catalog. A no-op for an
     * already-aggregated provider or the reserved `_all` slot itself.
     */
    async addProvider(name: string): Promise<void> {
        if (name === AggregateServer.SLOT || this._sessions.has(name)) return;

        const session = new ProviderClientSession(name, this._openClient(name));
        this._sessions.set(name, session);

        session.onCatalogChanged = (): void => {
            this._catalog.setProvider(name, { tools: session.tools, prompts: session.prompts });
            this._emitListChanged();
        };
        session.onClosed = (): void => this.removeProvider(name);

        try {
            await session.initialize();
        } catch {
            this.removeProvider(name);
        }
    }

    /** Removes a provider from the aggregate. */
    removeProvider(name: string): void {
        const session = this._sessions.get(name);
        if (!session) return;
        this._sessions.delete(name);
        session.close();
        this._catalog.removeProvider(name);
        this._emitListChanged();
    }

    private _subjectFor(principal: IPrincipal | null): IAuthorizationSubject {
        if (principal?.subject) return principal.subject;
        if (!principal) return { ids: [] };
        try {
            return (
                this._authorization?.subjectMapper.map(principal.claims) ?? {
                    ids: [],
                    claims: principal.claims,
                }
            );
        } catch (error) {
            if (!(error instanceof SubjectMappingError)) {
                console.error("[broker] aggregate authorization subject mapping failed.");
            }
            return { ids: [], claims: principal.claims };
        }
    }

    private _scopeAllows(principal: IPrincipal | null, provider: string): boolean {
        const filter = this._scopeFilter;
        return !filter || !principal || filter(principal, provider);
    }

    private _policyAllows(principal: IPrincipal | null, provider: string, operation: IMcpOperation): boolean {
        const authorization = this._authorization;
        if (!authorization) return true;

        const subject = this._subjectFor(principal);
        const resource = authorization.slotResourceResolver.resolve(provider);
        if (!resource) {
            const decision: IAuthorizationDecision = { allowed: false, reason: "unknown-resource" };
            writeAuthorizationAuditEvent(makeAuthorizationAuditEvent({ subject, slot: AggregateServer.SLOT, provider }, decision));
            return false;
        }

        try {
            const classified = authorization.capabilityClassifier.classify(operation, resource, provider);
            if (!classified) return true;
            const decision = authorization.engine.authorize({
                subject,
                capability: classified.capability,
                resource,
                provider,
                tool: classified.tool,
            });
            if (!decision.allowed || authorization.audit.logAllowed) {
                writeAuthorizationAuditEvent(
                    makeAuthorizationAuditEvent(
                        {
                            subject,
                            slot: AggregateServer.SLOT,
                            resource,
                            capability: classified.capability,
                            provider,
                            tool: classified.tool,
                        },
                        decision
                    )
                );
            }
            return decision.allowed;
        } catch {
            console.error("[broker] aggregate policy evaluation failed.");
            const decision: IAuthorizationDecision = { allowed: false, reason: "no-matching-grant" };
            writeAuthorizationAuditEvent(
                makeAuthorizationAuditEvent(
                    {
                        subject,
                        slot: AggregateServer.SLOT,
                        resource,
                        provider,
                    },
                    decision
                )
            );
            return false;
        }
    }

    private _allows(principal: IPrincipal | null, provider: string, operation: IMcpOperation): boolean {
        return this._scopeAllows(principal, provider) && this._policyAllows(principal, provider, operation);
    }

    private async _handleClientMessage(data: string, principal: IPrincipal | null): Promise<void> {
        let msg: IClientMessage;
        try {
            msg = JSON.parse(data) as IClientMessage;
        } catch {
            return;
        }
        const id = msg.id;
        if (id == null) return; // client notification: nothing to answer

        switch (msg.method) {
            case "initialize":
                this._reply(id, {
                    result: {
                        protocolVersion: PROTOCOL_VERSION,
                        serverInfo: { name: AggregateServer.SLOT, version: "0" },
                        capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
                    },
                });
                break;
            case "ping":
                this._reply(id, { result: {} });
                break;
            case "tools/list":
                this._reply(id, {
                    result: {
                        tools: this._catalog.toolsFor((provider) => this._allows(principal, provider, { method: "tools/list" })),
                    },
                });
                break;
            case "prompts/list":
                this._reply(id, {
                    result: {
                        prompts: this._catalog.promptsFor((provider) => this._allows(principal, provider, { method: "prompts/list" })),
                    },
                });
                break;
            case "tools/call":
                await this._route(id, msg.params, "tool", principal);
                break;
            case "prompts/get":
                await this._route(id, msg.params, "prompt", principal);
                break;
            default:
                this._reply(id, { error: { code: -32601, message: `Method not found: ${msg.method ?? "(none)"}` } });
        }
    }

    private async _route(id: string | number, params: unknown, kind: "tool" | "prompt", principal: IPrincipal | null): Promise<void> {
        const p = (params ?? {}) as ICallParams;
        const route = p.name ? (kind === "tool" ? this._catalog.resolveTool(p.name) : this._catalog.resolvePrompt(p.name)) : undefined;
        // Treat a provider the caller may not see as if it did not exist, do not
        // leak its presence through a distinct "forbidden" error.
        const operation: IMcpOperation | undefined = route
            ? kind === "tool"
                ? { method: "tools/call", params: { name: route.original } }
                : { method: "prompts/get", params: { name: route.original } }
            : undefined;
        if (!route || !operation || !this._allows(principal, route.provider, operation)) {
            this._reply(id, { error: { code: -32602, message: `Unknown aggregated ${kind}: ${p.name ?? "(none)"}` } });
            return;
        }
        const session = this._sessions.get(route.provider);
        if (!session) {
            this._reply(id, { error: { code: -32000, message: `Provider "${route.provider}" is no longer connected` } });
            return;
        }
        const args = p.arguments ?? {};
        const outcome = kind === "tool" ? await session.callTool(route.original, args) : await session.getPrompt(route.original, args);
        this._reply(id, outcome.error !== undefined ? { error: outcome.error } : { result: outcome.result });
    }

    private _reply(id: string | number, body: { result?: unknown; error?: unknown }): void {
        this.onMessage?.(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
    }

    private _emitListChanged(): void {
        if (!this._running) return;
        this.onMessage?.(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
        this.onMessage?.(JSON.stringify({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" }));
    }
}
