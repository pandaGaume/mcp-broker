import { JwtTokenValidator } from "./jwt.validator";
import type { AggregateScopeFilter, IResolvedAuth } from "./auth.types";
import { compileAuthorizationPolicy, DefaultSlotResourceResolver, hasAuthorizationPolicies, type IAuthorizationPolicyConfig } from "../authorization/index";

/**
 * High-level options for the default JWT/JWKS resource-server setup. Mirrors the
 * `auth` block of the broker JSON config and is turned into a fully
 * {@link IResolvedAuth} (with a {@link JwtTokenValidator}) by {@link buildJwtAuth}.
 */
export interface IJwtAuthOptions extends IAuthorizationPolicyConfig {
    /** Public origin the broker is reached at (e.g. `https://mcp.example.com`). */
    publicBaseUrl: string;
    /** Authorization server issuer URL(s) advertised in the PRM. At least one. */
    authorizationServers: string[];
    /** URL of the authorization server's JWKS document. */
    jwksUri: string;
    /** Expected token issuer(s). Defaults to the sole authorization server. */
    issuer?: string | string[];
    /** Scopes advertised in the PRM `scopes_supported`. */
    scopesSupported?: string[];
    /** Baseline scope(s) required to reach any slot. */
    requiredScopes?: string[];
    /** Per-slot required-scope overrides (e.g. an admin scope for `_broker`). */
    perSlotScopes?: Record<string, string[]>;
    /**
     * Per-provider scope requirements for the `_all` aggregate. A caller sees a
     * provider in `_all` only if it holds at least one of the listed scopes.
     * Providers not listed here stay visible to every authenticated caller.
     * Turned into an {@link AggregateScopeFilter} automatically.
     */
    providerScopes?: Record<string, string[]>;
    /** Leeway in seconds for token `exp`/`nbf` checks. */
    clockToleranceSec?: number;
}

/** Builds the default aggregate filter from a per-provider scope map. */
function makeProviderScopeFilter(providerScopes: Record<string, string[]>): AggregateScopeFilter {
    return (principal, providerName) => {
        const required = providerScopes[providerName];
        if (!required || required.length === 0) return true; // unlisted ⇒ visible to all
        return required.some((scope) => principal.scopes.has(scope));
    };
}

/** Removes a single trailing slash so resource URIs concatenate cleanly. */
function stripTrailingSlash(url: string): string {
    return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Builds an {@link IResolvedAuth} backed by a {@link JwtTokenValidator}. Validates
 * the required inputs up front and throws a descriptive error on misconfig, so
 * an operator sees the problem at boot rather than as opaque `401`s later.
 */
export function buildJwtAuth(options: IJwtAuthOptions): IResolvedAuth {
    if (!options.publicBaseUrl) {
        throw new Error("auth: publicBaseUrl is required.");
    }
    if (!options.authorizationServers || options.authorizationServers.length === 0) {
        throw new Error("auth: at least one authorizationServers entry is required.");
    }
    if (!options.jwksUri) {
        throw new Error("auth: jwksUri is required.");
    }

    const publicBaseUrl = stripTrailingSlash(options.publicBaseUrl);
    const issuer = options.issuer ?? (options.authorizationServers.length === 1 ? options.authorizationServers[0] : undefined);

    const validator = new JwtTokenValidator({
        jwksUri: options.jwksUri,
        issuer,
        clockToleranceSec: options.clockToleranceSec,
    });

    const resolved: IResolvedAuth = {
        publicBaseUrl,
        authorizationServers: options.authorizationServers,
        validator,
    };
    if (options.scopesSupported) resolved.scopesSupported = options.scopesSupported;
    if (options.requiredScopes) resolved.requiredScopes = options.requiredScopes;
    if (options.perSlotScopes) resolved.perSlotScopes = options.perSlotScopes;
    if (options.providerScopes && Object.keys(options.providerScopes).length > 0) {
        console.warn("[mcp-broker] auth.providerScopes is deprecated; migrate to roles and hierarchical assignments.");
        resolved.aggregateScopeFilter = makeProviderScopeFilter(options.providerScopes);
    }
    if (options.slotResources && Object.keys(options.slotResources).length > 0) {
        resolved.slotResourceResolver = new DefaultSlotResourceResolver(options.slotResources);
    }
    if (hasAuthorizationPolicies(options)) {
        resolved.authorization = compileAuthorizationPolicy(options);
        resolved.slotResourceResolver = resolved.authorization.slotResourceResolver;
    }
    return resolved;
}

/** @deprecated Use {@link IJwtAuthOptions}. */
export type JwtAuthOptions = IJwtAuthOptions;
