import type { IncomingMessage, ServerResponse } from "http";
import { bearerToken, buildChallengeHeader, PROTECTED_RESOURCE_METADATA_PREFIX } from "@cyanmycelium/mcp-core";
import { AuthError, scopesOf, type IPrincipal, type IResolvedAuth } from "./auth.types";
import { buildResourceMetadata, type IProtectedResourceMetadata } from "./resource.metadata";
import { SubjectMappingError } from "../authorization/index";

/**
 * Well-known prefix under which per-slot Protected Resource Metadata is served.
 *
 * Carries a trailing slash because every use here splits a slot off it, while
 * `mcp-core` exports the bare RFC 9728 prefix.
 */
const PRM_PREFIX = `${PROTECTED_RESOURCE_METADATA_PREFIX}/`;

/**
 * The HTTP enforcement point for the resource-server layer. Wraps a
 * {@link IResolvedAuth} plus the configured `/mcp` path suffix and turns it into
 * the three operations the transport needs: serve Protected Resource Metadata,
 * authorize a request, and write an RFC 9728 `401`/`403` challenge.
 *
 * A slot's **canonical resource URI** is `<publicBaseUrl>/<slot>/<mcp>` and is
 * used uniformly across all of that slot's HTTP endpoints (`/mcp`, `/sse`,
 * `/messages`) so a single token audience covers the whole slot.
 */
export class HttpAuthGuard {
    private readonly _auth: IResolvedAuth;
    /** The `/mcp` suffix without a leading slash, e.g. `"mcp"`. */
    private readonly _mcpSuffix: string;

    constructor(auth: IResolvedAuth, mcpSuffix: string) {
        this._auth = auth;
        this._mcpSuffix = mcpSuffix.replace(/^\//, "");
    }

    /** Canonical resource identifier for a slot (RFC 8707 §2). */
    resourceFor(slot: string): string {
        return `${this._auth.publicBaseUrl}/${encodeURIComponent(slot)}/${this._mcpSuffix}`;
    }

    /** RFC 9728 metadata URL for a slot, advertised in the `401` challenge. */
    metadataUrlFor(slot: string): string {
        return `${this._auth.publicBaseUrl}${PRM_PREFIX}${encodeURIComponent(slot)}/${this._mcpSuffix}`;
    }

    /** Required scope(s) for a slot: per-slot override, else the baseline. */
    requiredScopesFor(slot: string): string[] {
        return this._auth.perSlotScopes?.[slot] ?? this._auth.requiredScopes ?? [];
    }

    /** The RFC 9728 metadata document for a slot. */
    metadataFor(slot: string): IProtectedResourceMetadata {
        return buildResourceMetadata({
            resource: this.resourceFor(slot),
            authorizationServers: this._auth.authorizationServers,
            scopesSupported: this._auth.scopesSupported,
        });
    }

    /**
     * If `rawUrl` is a Protected Resource Metadata request
     * (`/.well-known/oauth-protected-resource/<slot>/<mcp>`), returns the slot;
     * otherwise `null`.
     */
    matchMetadataRequest(rawUrl: string): string | null {
        if (!rawUrl.startsWith(PRM_PREFIX)) return null;
        const parts = rawUrl.slice(PRM_PREFIX.length).split("/").filter(Boolean);
        if (parts.length !== 2 || parts[1] !== this._mcpSuffix) return null;
        return decodeURIComponent(parts[0]);
    }

    /**
     * Validates the request's bearer token against the slot's canonical resource
     * and enforces the slot's required scopes. Resolves to the {@link IPrincipal}
     * on success; rejects with an {@link AuthError} (`401` missing/invalid token,
     * `403` insufficient scope) otherwise.
     */
    async authorize(req: IncomingMessage, slot: string): Promise<IPrincipal> {
        const token = bearerToken(req.headers["authorization"]);
        if (!token) {
            throw new AuthError(401, "invalid_token", "Missing bearer token");
        }

        const claims = await this._auth.validator.validate(token, this.resourceFor(slot));
        const scopes = scopesOf(claims);

        const required = this.requiredScopesFor(slot);
        const missing = required.filter((s) => !scopes.has(s));
        if (missing.length > 0) {
            throw new AuthError(403, "insufficient_scope", `Missing required scope(s): ${missing.join(" ")}`, required.join(" "));
        }

        let subject: IPrincipal["subject"];
        try {
            subject = this._auth.authorization?.subjectMapper.map(claims);
        } catch (error) {
            if (error instanceof SubjectMappingError) {
                throw new AuthError(403, "insufficient_scope", "Malformed configured JWT subject claim");
            }
            throw error;
        }

        return subject ? { claims, scopes, subject } : { claims, scopes };
    }

    /**
     * Builds the RFC 9728 §5.1 `WWW-Authenticate` header value for a challenge.
     * Always points the client at the slot's metadata URL so it can discover the
     * authorization server and retry. Shared by the HTTP and WebSocket paths.
     */
    challengeHeader(slot: string, err: AuthError): string {
        return buildChallengeHeader({
            resourceMetadata: this.metadataUrlFor(slot),
            error: err.code,
            errorDescription: err.description,
            scope: err.scope,
        });
    }

    /**
     * Writes an RFC 9728 §5.1 `WWW-Authenticate` challenge and the matching
     * status to an HTTP response.
     */
    writeChallenge(res: ServerResponse, slot: string, err: AuthError): void {
        res.setHeader("WWW-Authenticate", this.challengeHeader(slot, err));
        res.writeHead(err.status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.code, error_description: err.description }));
    }
}
