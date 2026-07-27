/**
 * Core contracts for the broker's OAuth 2.1 **resource server** layer.
 *
 * The broker never acts as an authorization server: it only validates the
 * access tokens minted by an external AS and advertises that AS through
 * Protected Resource Metadata (RFC 9728). These types are the seam every other
 * auth module builds on, so a host can drop in a custom {@link ITokenValidator}
 * (e.g. RFC 7662 introspection) without touching the enforcement code.
 */
import type { IAuthorizationSubject, IPolicyAuthorization, ISlotResourceResolver } from "../authorization/index.js";

/**
 * The subset of OAuth 2.1 / RFC 9068 access-token claims a resource server
 * cares about. `aud` carries the audience binding (RFC 8707), `scope` the
 * space-delimited granted scopes; some authorization servers emit `scopes` as
 * an array instead. Unknown claims are preserved via the index signature.
 */
export interface IAccessTokenClaims {
    /** Subject — the principal the token was issued for. */
    sub?: string;
    /** Intended audience(s). MUST include the slot's canonical resource URI. */
    aud?: string | string[];
    /** Issuer (the authorization server). */
    iss?: string;
    /** Expiry, seconds since the epoch. */
    exp?: number;
    /** Space-delimited granted scopes (RFC 8693). */
    scope?: string;
    /** Array-form granted scopes, emitted by some authorization servers. */
    scopes?: string[];
    [claim: string]: unknown;
}

/**
 * Validates a bearer access token for a specific resource. Implementations MUST
 * verify the token's signature/validity **and** that it was issued for
 * `resource` (audience binding, RFC 8707). On any failure they MUST throw an
 * {@link AuthError} with status `401` and code `invalid_token`; unexpected
 * infrastructure failures (e.g. JWKS unreachable) should throw a plain error so
 * the caller can surface a `500` rather than a misleading `401`.
 */
export interface ITokenValidator {
    validate(token: string, resource: string): Promise<IAccessTokenClaims>;
}

/** OAuth 2.1 error codes the broker emits in `WWW-Authenticate` challenges. */
export type AuthErrorCode = "invalid_token" | "insufficient_scope" | "invalid_request";

/**
 * A thrown authorization failure carrying the HTTP status and OAuth error code
 * the enforcement point should surface. `scope` is set for `insufficient_scope`
 * challenges to advertise the scope(s) the resource requires.
 */
export class AuthError extends Error {
    readonly status: 401 | 403 | 400;
    readonly code: AuthErrorCode;
    readonly description?: string;
    readonly scope?: string;

    constructor(status: 401 | 403 | 400, code: AuthErrorCode, description?: string, scope?: string) {
        super(description ?? code);
        this.name = "AuthError";
        this.status = status;
        this.code = code;
        this.description = description;
        this.scope = scope;
    }
}

/**
 * The authenticated caller, produced once a token passes validation and the
 * required scopes are satisfied. Threaded through the request so downstream
 * components (e.g. the `_all` aggregate) can make scope-aware decisions.
 */
export interface IPrincipal {
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
 * Extracts the effective set of granted scopes from token claims, unioning the
 * space-delimited `scope` string and the array-form `scopes` claim.
 */
export function scopesOf(claims: IAccessTokenClaims): Set<string> {
    const set = new Set<string>();
    if (typeof claims.scope === "string") {
        for (const s of claims.scope.split(/\s+/)) if (s) set.add(s);
    }
    if (Array.isArray(claims.scopes)) {
        for (const s of claims.scopes) if (typeof s === "string" && s) set.add(s);
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
