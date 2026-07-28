/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * Each slot exposed over HTTP is an independent resource server; its metadata
 * document tells an MCP client which authorization server(s) issue tokens for
 * that slot and which bearer methods it accepts. Served (unauthenticated, it is
 * public discovery data) at
 * `<publicBaseUrl>/.well-known/oauth-protected-resource/<slot>/<mcp>`.
 */

import { buildProtectedResourceMetadata, type IProtectedResourceMetadata } from "@cyanmycelium/mcp-core";

/** The RFC 9728 metadata document for a single protected resource. */
export type { IProtectedResourceMetadata } from "@cyanmycelium/mcp-core";

/**
 * Builds the RFC 9728 metadata document for one slot.
 *
 * The document itself is shaped by `mcp-core`: it is defined by the MCP
 * specification, identically for every server. What is broker-specific is only
 * which resource a slot maps to, and that is decided by the caller.
 * `bearer_methods_supported` comes out fixed to `["header"]`, matching the
 * broker's refusal to read a token from anywhere but the header (OAuth 2.1 §5).
 */
export function buildResourceMetadata(params: { resource: string; authorizationServers: string[]; scopesSupported?: string[] }): IProtectedResourceMetadata {
    return buildProtectedResourceMetadata({
        resource: params.resource,
        authorizationServers: params.authorizationServers,
        scopesSupported: params.scopesSupported,
    });
}

/** @deprecated Use {@link IProtectedResourceMetadata}. */
export type ProtectedResourceMetadata = IProtectedResourceMetadata;
