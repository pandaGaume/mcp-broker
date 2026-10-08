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
 *  - a token is accepted from a loopback client (`127.0.0.0/8`, `::1`) and
 *    from the networks the security file names in `auth.dev.networks`: the
 *    keyword `"lan"` (every private and link-local range, for a tablet or a
 *    second screen on the bench's network) or CIDR networks. A request from
 *    anywhere else is refused before its token is read, so a broker bound to
 *    `0.0.0.0` authenticates no client from the internet with one.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
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
    /**
     * Where else than loopback (always accepted) a development token may come
     * from: `"lan"` for every private and link-local range ({@link DEV_LAN_NETWORKS}),
     * and CIDR networks (`192.168.4.0/24`, `fd00::/8`) or single addresses.
     * Absent: loopback only.
     */
    readonly networks?: readonly string[];
}

/**
 * What `"lan"` stands for in `auth.dev.networks`: the private ranges of RFC
 * 1918 and RFC 4193 and the link-local ranges, whatever address a bench's
 * router hands out. Never a public address.
 */
export const DEV_LAN_NETWORKS: readonly string[] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fc00::/7", "fe80::/10"];

/** A development caller with its token resolved from the environment. */
export interface IResolvedDevCaller extends IDevCaller {
    readonly token: string;
}

/** Options of {@link buildDevAuth}: the callers, the policy, and the scope settings the JWT setup also takes. */
export interface IDevAuthOptions extends Omit<IAuthorizationPolicyConfig, "subjectMapping"> {
    readonly callers: readonly IResolvedDevCaller[];
    /** Where else than loopback a token may come from, as in {@link IDevAuthConfig.networks}. */
    readonly networks?: readonly string[];
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
    for (const key of Object.keys(dev)) if (key !== "callers" && key !== "networks") problems.push(`auth.dev: unknown key "${key}"`);
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

/** A network of `auth.dev.networks`, parsed. */
interface IDevNetwork {
    readonly address: string;
    readonly prefix: number;
    readonly family: "ipv4" | "ipv6";
}

/**
 * Parses one CIDR network or single address. Returns the network, or the
 * problem with it. A zero-length prefix (`0.0.0.0/0`, `::/0`) is refused: it
 * would accept every client, which is what OAuth is for.
 */
function parseNetwork(entry: string): IDevNetwork | string {
    const [address, prefixText, extra] = entry.trim().split("/");
    const version = isIP(address);
    if (version === 0 || extra !== undefined) return `"${entry}" is not "lan", an IPv4 or IPv6 address, or a CIDR network`;
    const max = version === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? max : /^[0-9]{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
    if (!Number.isInteger(prefix) || prefix > max) return `"${entry}": the prefix length must be an integer from 1 to ${max}`;
    if (prefix === 0) return `"${entry}" would accept every client, the internet included; write "lan" for the bench's network, or use OAuth`;
    return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

/**
 * Expands and checks `auth.dev.networks`: `"lan"` becomes {@link DEV_LAN_NETWORKS},
 * every other entry must be a CIDR network or an address. Returns the
 * networks, normalized, and the problems.
 */
export function resolveDevNetworks(networks: unknown): { networks: string[]; problems: string[] } {
    if (networks === undefined) return { networks: [], problems: [] };
    if (!Array.isArray(networks)) return { networks: [], problems: ['"auth.dev.networks" must be an array, e.g. ["lan"] or ["192.168.4.0/24"]'] };
    const out: string[] = [];
    const problems: string[] = [];
    for (const [index, entry] of networks.entries()) {
        if (typeof entry !== "string" || entry.trim() === "") {
            problems.push(`auth.dev.networks[${index}] must be a non-empty string`);
            continue;
        }
        for (const one of entry.trim().toLowerCase() === "lan" ? DEV_LAN_NETWORKS : [entry]) {
            const parsed = parseNetwork(one);
            if (typeof parsed === "string") problems.push(`auth.dev.networks[${index}]: ${parsed}`);
            else if (!out.includes(`${parsed.address}/${parsed.prefix}`)) out.push(`${parsed.address}/${parsed.prefix}`);
        }
    }
    return { networks: out, problems };
}

/**
 * The clients the development mode accepts: loopback, plus the networks
 * given (`"lan"` included). Built once; `allows` answers per request. An
 * unknown address is refused.
 *
 * @throws if a network does not parse.
 */
export class DevClientFilter {
    private readonly _list = new BlockList();
    readonly networks: readonly string[];

    constructor(networks: readonly string[] = []) {
        const resolved = resolveDevNetworks(networks);
        if (resolved.problems.length > 0) throw new Error(resolved.problems.join("; "));
        for (const n of resolved.networks) {
            const parsed = parseNetwork(n) as IDevNetwork;
            this._list.addSubnet(parsed.address, parsed.prefix, parsed.family);
        }
        this.networks = resolved.networks;
    }

    allows(req: IncomingMessage): boolean {
        if (isLoopbackRequest(req)) return true;
        const address = req.socket?.remoteAddress;
        if (!address || this.networks.length === 0) return false;
        const plain = address.startsWith("::ffff:") ? address.slice(7) : address;
        const version = isIP(plain);
        return version !== 0 && this._list.check(plain, version === 4 ? "ipv4" : "ipv6");
    }
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
 * loopback clients and the networks given only, the hierarchical policy
 * compiled exactly as for JWT.
 *
 * @throws if no caller is given, or a network does not parse.
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
    const networks = new DevClientFilter(options.networks).networks;
    if (networks.length > 0) resolved.clientNetworks = networks;
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
