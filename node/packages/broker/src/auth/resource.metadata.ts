/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * Each slot exposed over HTTP is an independent resource server; its metadata
 * document tells an MCP client which authorization server(s) issue tokens for
 * that slot and which bearer methods it accepts. Served (unauthenticated, it is
 * public discovery data) at
 * `<publicBaseUrl>/.well-known/oauth-protected-resource/<slot>/<mcp>`.
 */

/** The RFC 9728 metadata document for a single protected resource. */
export interface IProtectedResourceMetadata {
    /** Canonical resource identifier (RFC 8707) — the slot's `/mcp` endpoint. */
    resource: string;
    /** Authorization server issuer URLs; MUST contain at least one. */
    authorization_servers: string[];
    /** Scopes the resource understands, when advertised. */
    scopes_supported?: string[];
    /** How bearer tokens may be presented. The broker only reads the header. */
    bearer_methods_supported: string[];
}

/**
 * Builds the RFC 9728 metadata document for one slot. `bearer_methods_supported`
 * is fixed to `["header"]` because the broker rejects tokens passed any other
 * way (never the query string, per OAuth 2.1 §5).
 */
export function buildResourceMetadata(params: { resource: string; authorizationServers: string[]; scopesSupported?: string[] }): IProtectedResourceMetadata {
    const doc: IProtectedResourceMetadata = {
        resource: params.resource,
        authorization_servers: params.authorizationServers,
        bearer_methods_supported: ["header"],
    };
    if (params.scopesSupported && params.scopesSupported.length > 0) {
        doc.scopes_supported = params.scopesSupported;
    }
    return doc;
}

/** @deprecated Use {@link IProtectedResourceMetadata}. */
export type ProtectedResourceMetadata = IProtectedResourceMetadata;
