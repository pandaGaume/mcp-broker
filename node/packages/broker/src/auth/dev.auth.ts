/**
 * Development authorization: the hierarchical policy without an authorization
 * server.
 *
 * Client OAuth is the only way the broker learns who a caller is, and without
 * a caller there is no policy: every decision ends `no-matching-grant`. That
 * makes a bench, a demo or a lab pay for an authorization server before a
 * single deny can be shown. Development mode closes that gap with static
 * bearer tokens, one per caller, each bound to the subjects the policy
 * reasons about. The policy engine, the subject mapper, the denies and the
 * audit are the production ones; only the token check differs.
 *
 * Two limits keep it a development tool:
 *
 *  - a token is read from an environment variable the security file names,
 *    never written in a file;
 *  - a token is accepted from a loopback client only (`127.0.0.0/8`, `::1`).
 *    A request from anywhere else is refused before its token is read, so a
 *    broker bound to `0.0.0.0` for its providers (a board on the LAN) still
 *    authenticates no remote client with a development token.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AuthError, type IAccessTokenClaims, type IResolvedAuth, type ITokenValidator } from "./auth.types";
import { compileAuthorizationPolicy, hasAuthorizationPolicies, type IAuthorizationPolicyConfig } from "../authorization/index";

/** Issuer stamped on the claims of a development token. Never a real authorization server. */
export const DEV_ISSUER = "urn:mcp-broker:dev";

/** The shortest token accepted: a guessable token would turn the policy into decoration. */
export const DEV_TOKEN_MIN_LENGTH = 16;

/** One caller of the development mode, as the security file declares it. */
export interface IDevCaller {
    /** Caller id, unique: names the caller in errors and is its user subject unless `user` is given. */
    readonly id: string;
    /** Name of the environment variable holding this caller's token. */
    readonly tokenEnv: string;
    /** User subject (`user:<user>`). Defaults to `id`. */
    readonly user?: string;
    /** Group subjects (`group:<g>`). */
    readonly groups?: readonly string[];
    /** Service subject (`service:<s>`). */
    readonly service?: string;
    /** Client subject (`client:<c>`). */
    readonly client?: string;
    /** OAuth scopes the token carries, for `requiredScopes` and `perSlotScopes`. */
    readonly scopes?: readonly string[];
}

/** The `auth.dev` block of the security file. */
export interface IDevAuthConfig {
    readonly callers: readonly IDevCaller[];
}

/** A development caller with its token resolved from the environment. */
export interface IResolvedDevCaller extends IDevCaller {
    readonly token: string;
}

/** Options of {@link buildDevAuth}: the callers, the policy, and the scope settings the JWT setup also takes. */
export interface IDevAuthOptions extends Omit<IAuthorizationPolicyConfig, "subjectMapping"> {
    readonly callers: readonly IResolvedDevCaller[];
    /** Origin used in resource URIs and challenges. Defaults to `http://localhost`. */
    readonly publicBaseUrl?: string;
    readonly scopesSupported?: string[];
    readonly requiredScopes?: string[];
    readonly perSlotScopes?: Record<string, string[]>;
}

/** The subject claims a development token maps to, fixed so the policy file stays the only thing to write. */
const DEV_SUBJECT_MAPPING = { userClaim: "sub", groupClaims: ["groups"], serviceClaims: ["service"], clientClaim: "client_id" } as const;

const CALLER_KEYS = new Set(["id", "tokenEnv", "user", "groups", "service", "client", "scopes"]);

const digest = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/**
 * Checks an `auth.dev` block and resolves each caller's token from `env`.
 * Returns the problems found, phrased for the operator, and the callers that
 * resolved. The caller fails closed on any problem.
 */
export function resolveDevCallers(dev: unknown, env: NodeJS.ProcessEnv): { callers: IResolvedDevCaller[]; problems: string[] } {
    const problems: string[] = [];
    const callers: IResolvedDevCaller[] = [];
    if (typeof dev !== "object" || dev === null || Array.isArray(dev)) return { callers, problems: ['"auth.dev" must be an object: { "callers": [...] }'] };
    for (const key of Object.keys(dev)) if (key !== "callers") problems.push(`auth.dev: unknown key "${key}"`);
    const list = (dev as { callers?: unknown }).callers;
    if (!Array.isArray(list) || list.length === 0) {
        problems.push('"auth.dev.callers" must be a non-empty array');
        return { callers, problems };
    }
    const ids = new Set<string>();
    const tokens = new Map<string, string>();
    for (const [index, entry] of list.entries()) {
        const label = `auth.dev.callers[${index}]`;
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            problems.push(`${label} must be an object`);
            continue;
        }
        const caller = entry as Record<string, unknown>;
        for (const key of Object.keys(caller)) {
            if (key === "token") problems.push(`${label}: "token" would put a secret in clear in the file; name the environment variable that holds it in "tokenEnv"`);
            else if (!CALLER_KEYS.has(key)) problems.push(`${label}: unknown key "${key}"`);
        }
        const id = caller["id"];
        if (typeof id !== "string" || id.length === 0) {
            problems.push(`${label}: "id" must be a non-empty string`);
            continue;
        }
        if (ids.has(id)) problems.push(`${label}: the id "${id}" is declared twice`);
        ids.add(id);
        for (const key of ["user", "service", "client"] as const) {
            if (caller[key] !== undefined && (typeof caller[key] !== "string" || caller[key] === "")) problems.push(`${label} ("${id}"): "${key}" must be a non-empty string`);
        }
        for (const key of ["groups", "scopes"] as const) {
            const v = caller[key];
            if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === "")))
                problems.push(`${label} ("${id}"): "${key}" must be an array of non-empty strings`);
        }
        const tokenEnv = caller["tokenEnv"];
        if (typeof tokenEnv !== "string" || tokenEnv.length === 0) {
            problems.push(`${label} ("${id}"): "tokenEnv" must name the environment variable holding this caller's token`);
            continue;
        }
        const token = env[tokenEnv];
        if (!token) {
            problems.push(`${label} ("${id}"): the environment variable ${tokenEnv} is not set`);
            continue;
        }
        if (token.length < DEV_TOKEN_MIN_LENGTH) {
            problems.push(`${label} ("${id}"): the token in ${tokenEnv} is shorter than ${DEV_TOKEN_MIN_LENGTH} characters`);
            continue;
        }
        const seen = tokens.get(digest(token));
        if (seen !== undefined) {
            problems.push(`${label} ("${id}"): its token is also "${seen}"'s; one token, one caller`);
            continue;
        }
        tokens.set(digest(token), id);
        callers.push({ ...(caller as unknown as IDevCaller), token });
    }
    return { callers, problems };
}

/** True when the request comes from this machine. An unknown address is not loopback. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
    const address = req.socket?.remoteAddress;
    if (!address) return false;
    const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
    return v4.startsWith("127.") || address === "::1";
}

/**
 * Validates development tokens: a token is one of the callers' tokens, its
 * claims the subjects declared for that caller. Any other token is refused
 * with `401`, as a bad real one would be. Tokens are compared by digest.
 */
export class DevTokenValidator implements ITokenValidator {
    private readonly _byDigest: Map<string, IResolvedDevCaller>;

    constructor(callers: readonly IResolvedDevCaller[]) {
        this._byDigest = new Map(callers.map((c) => [digest(c.token), c] as const));
    }

    async validate(token: string, resource: string): Promise<IAccessTokenClaims> {
        const caller = this._byDigest.get(digest(token));
        if (!caller) throw new AuthError(401, "invalid_token", "unknown development token");
        return {
            iss: DEV_ISSUER,
            sub: caller.user ?? caller.id,
            aud: resource,
            ...(caller.groups ? { groups: [...caller.groups] } : {}),
            ...(caller.service ? { service: caller.service } : {}),
            ...(caller.client ? { client_id: caller.client } : {}),
            ...(caller.scopes ? { scope: caller.scopes.join(" ") } : {}),
        } as IAccessTokenClaims;
    }
}

/**
 * Builds an {@link IResolvedAuth} for development mode: {@link DevTokenValidator},
 * loopback clients only, the hierarchical policy compiled exactly as for JWT.
 */
export function buildDevAuth(options: IDevAuthOptions): IResolvedAuth {
    if (options.callers.length === 0) throw new Error("auth.dev: at least one caller is required.");
    const publicBaseUrl = (options.publicBaseUrl ?? "http://localhost").replace(/\/$/, "");
    const resolved: IResolvedAuth = {
        publicBaseUrl,
        authorizationServers: [DEV_ISSUER],
        validator: new DevTokenValidator(options.callers),
        loopbackOnly: true,
    };
    if (options.scopesSupported) resolved.scopesSupported = options.scopesSupported;
    if (options.requiredScopes) resolved.requiredScopes = options.requiredScopes;
    if (options.perSlotScopes) resolved.perSlotScopes = options.perSlotScopes;
    const { roles, assignments, denies, slotResources, toolCapabilities, providerToolCapabilities, audit } = options;
    const policy: IAuthorizationPolicyConfig = {
        roles,
        assignments,
        denies,
        slotResources,
        toolCapabilities,
        providerToolCapabilities,
        audit,
        subjectMapping: DEV_SUBJECT_MAPPING,
    };
    if (hasAuthorizationPolicies(policy)) {
        resolved.authorization = compileAuthorizationPolicy(policy);
        resolved.slotResourceResolver = resolved.authorization.slotResourceResolver;
    }
    return resolved;
}
