/**
 * Core contracts for the broker's OAuth 2.1 **resource server** layer.
 *
 * The broker never acts as an authorization server: it only validates the
 * access tokens minted by an external AS and advertises that AS through
 * Protected Resource Metadata (RFC 9728). These types are the seam every other
 * auth module builds on, so a host can drop in a custom {@link ITokenValidator}
 * (e.g. RFC 7662 introspection) without touching the enforcement code.
 *
 * Everything the MCP specification itself defines comes from `mcp-core` and is
 * re-exported here under the broker's historical names: the claim shape, the
 * validator seam, the error carrying a challenge. What stays broker-owned is
 * what the spec does not define, namely a multi-slot resource server whose
 * principals feed a hierarchical policy engine.
 */
import { McpAuthError, scopesOf as mcpScopesOf, type IAccessTokenClaims, type IMcpPrincipal, type ITokenValidator } from "@cyanmycelium/mcp-core";
import type { IAuthorizationSubject, IPolicyAuthorization, ISlotResourceResolver } from "../authorization/index";

export type { IAccessTokenClaims, ITokenValidator } from "@cyanmycelium/mcp-core";

/** OAuth 2.1 error codes the broker emits in `WWW-Authenticate` challenges. */
export type AuthErrorCode = import("@cyanmycelium/mcp-core").McpAuthErrorCode;

/**
 * A thrown authorization failure carrying the HTTP status and OAuth error code
 * the enforcement point should surface. `scope` is set for `insufficient_scope`
 * challenges to advertise the scope(s) the resource requires.
 *
 * The broker's own name for `mcp-core`'s `McpAuthError`, kept so `instanceof`
 * checks and the published API survive the consolidation. There is one class at
 * runtime, so an error thrown by `mcp-core` is caught by the broker and the
 * other way round.
 */
export const AuthError = McpAuthError;
export type AuthError = McpAuthError;

/**
 * The authenticated caller, produced once a token passes validation and the
 * required scopes are satisfied. Threaded through the request so downstream
 * components (e.g. the `_all` aggregate) can make scope-aware decisions.
 *
 * Extends `mcp-core`'s principal with the subject the policy engine reasons
 * about, which the specification says nothing about and which therefore stays
 * here.
 */
export interface IPrincipal extends IMcpPrincipal {
    readonly claims: IAccessTokenClaims;
    readonly scopes: ReadonlySet<string>;
    /** Subjects derived exclusively from validated token claims. */
    readonly subject?: IAuthorizationSubject;
}

/**
 * Decides, per authenticated caller, whether a given provider is visible in the
 * `_all` aggregate. This is the content-confidentiality enforcement point: a
 * client only sees (and can call) tools/prompts from providers it is authorized
 * for. Return `true` to include the provider for this principal.
 */
export type AggregateScopeFilter = (principal: IPrincipal, providerName: string) => boolean;

/**
 * A fully resolved authorization configuration, ready for the enforcement
 * layer. Built either from JSON config (via `buildJwtAuth`) or supplied
 * directly by an embedder with a custom {@link ITokenValidator}.
 */
export interface IResolvedAuth {
    /**
     * Public origin the broker is reached at, used to build canonical resource
     * URIs and metadata URLs. No trailing slash (e.g. `https://mcp.example.com`).
     */
    publicBaseUrl: string;
    /** One or more authorization server issuer URLs, advertised in the PRM. */
    authorizationServers: string[];
    /** Optional list of scopes advertised in the PRM `scopes_supported`. */
    scopesSupported?: string[];
    /** The token validator (JWKS-backed by default). */
    validator: ITokenValidator;
    /** Baseline scope(s) required to reach any slot. Empty ⇒ any valid token. */
    requiredScopes?: string[];
    /** Per-slot required-scope overrides (e.g. an admin scope for `_broker`). */
    perSlotScopes?: Record<string, string[]>;
    /**
     * Per-caller filter for the `_all` aggregate. When set, a client's view of
     * `_all` is narrowed to the providers this returns `true` for. When absent,
     * every authenticated caller sees the full aggregate.
     */
    aggregateScopeFilter?: AggregateScopeFilter;
    /** Compiled hierarchical policy runtime, absent for legacy OAuth behavior. */
    authorization?: IPolicyAuthorization;
    /** Optional resolver usable for provider namespace checks without policies. */
    slotResourceResolver?: ISlotResourceResolver;
}

/**
 * Extracts the effective set of granted scopes from token claims.
 *
 * A deliberate superset of `mcp-core`'s: OAuth 2.1 only defines the
 * space-delimited `scope` string, which is what the spec-level helper reads,
 * but several authorization servers emit an array-form `scopes` claim instead.
 * Dropping that here would silently strip every scope for those deployments, so
 * the two are unioned. The `scope` half is parsed by `mcp-core` rather than
 * re-implemented.
 */
export function scopesOf(claims: IAccessTokenClaims): Set<string> {
    const set = new Set<string>(mcpScopesOf(claims));
    const arrayForm: unknown = claims["scopes"];
    if (Array.isArray(arrayForm)) {
        for (const scope of arrayForm) if (typeof scope === "string" && scope) set.add(scope);
    }
    return set;
}

/** @deprecated Use {@link IAccessTokenClaims}. */
export type AccessTokenClaims = IAccessTokenClaims;
/** @deprecated Use {@link ITokenValidator}. */
export type TokenValidator = ITokenValidator;
/** @deprecated Use {@link IPrincipal}. */
export type Principal = IPrincipal;
/** @deprecated Use {@link IResolvedAuth}. */
export type ResolvedAuth = IResolvedAuth;
