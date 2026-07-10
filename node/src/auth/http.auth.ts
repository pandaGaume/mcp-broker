import type { IncomingMessage, ServerResponse } from "http";
import { AuthError, scopesOf, type Principal, type ResolvedAuth } from "./auth.types.js";
import { buildResourceMetadata, type ProtectedResourceMetadata } from "./resource.metadata.js";

/** Well-known prefix under which per-slot Protected Resource Metadata is served. */
const PRM_PREFIX = "/.well-known/oauth-protected-resource/";

/** Extracts the bearer token from an `Authorization` header, or `null`. */
function extractBearer(header: string | string[] | undefined): string | null {
    if (typeof header !== "string") return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : null;
}

/** Strips characters that would break (or inject into) an HTTP header value. */
function headerSafe(value: string): string {
    return value.replace(/[\r\n"]/g, " ").trim();
}

/**
 * The HTTP enforcement point for the resource-server layer. Wraps a
 * {@link ResolvedAuth} plus the configured `/mcp` path suffix and turns it into
 * the three operations the transport needs: serve Protected Resource Metadata,
 * authorize a request, and write an RFC 9728 `401`/`403` challenge.
 *
 * A slot's **canonical resource URI** is `<publicBaseUrl>/<slot>/<mcp>` and is
 * used uniformly across all of that slot's HTTP endpoints (`/mcp`, `/sse`,
 * `/messages`) so a single token audience covers the whole slot.
 */
export class HttpAuthGuard {
    private readonly _auth: ResolvedAuth;
    /** The `/mcp` suffix without a leading slash, e.g. `"mcp"`. */
    private readonly _mcpSuffix: string;

    constructor(auth: ResolvedAuth, mcpSuffix: string) {
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
    metadataFor(slot: string): ProtectedResourceMetadata {
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
     * and enforces the slot's required scopes. Resolves to the {@link Principal}
     * on success; rejects with an {@link AuthError} (`401` missing/invalid token,
     * `403` insufficient scope) otherwise.
     */
    async authorize(req: IncomingMessage, slot: string): Promise<Principal> {
        const token = extractBearer(req.headers["authorization"]);
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

        return { claims, scopes };
    }

    /**
     * Writes an RFC 9728 §5.1 `WWW-Authenticate` challenge and the matching
     * status. Always points the client at the slot's metadata URL so it can
     * discover the authorization server and retry.
     */
    writeChallenge(res: ServerResponse, slot: string, err: AuthError): void {
        const params = [`resource_metadata="${this.metadataUrlFor(slot)}"`, `error="${err.code}"`];
        if (err.description) params.push(`error_description="${headerSafe(err.description)}"`);
        if (err.scope) params.push(`scope="${headerSafe(err.scope)}"`);

        res.setHeader("WWW-Authenticate", `Bearer ${params.join(", ")}`);
        res.writeHead(err.status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.code, error_description: err.description }));
    }
}
