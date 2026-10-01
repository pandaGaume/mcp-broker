/**
 * `@cyanmycelium/mcp-broker/testing`: a real broker for tests, with callers
 * that need no authorization server.
 *
 * Everything below the token is the production code path: the same subject
 * mapping, policy engine, caller references, protected slots and provider
 * identities. Only the token check is replaced: a caller's token is its name,
 * and {@link TestTokenValidator} turns that name into the claims you wrote.
 *
 * TEST ONLY. The broker binds 127.0.0.1 on a free port and accepts tokens
 * anybody can guess. Nothing in the CLI reaches this module.
 *
 * @example
 * ```ts
 * import { startTestBroker } from "@cyanmycelium/mcp-broker/testing";
 *
 * const broker = await startTestBroker({
 *     callers: { operator: { groups: ["operators-line1"] }, scada: { service: "mcp-scada" } },
 *     providers: { "mcp-scada": { subjects: ["service:mcp-scada"], allowedResources: ["/production/site1/**"] } },
 * });
 * // a provider:  new DirectTransport(broker.providerUrl("scada"), { secret: broker.providerSecret("mcp-scada") })
 * // a client:    fetch(broker.mcpUrl("scada"), { headers: { ...broker.bearer("operator"), ... } })
 * await broker.stop();
 * ```
 */
import type { AddressInfo } from "net";
import { AuthError, type IAccessTokenClaims, type IResolvedAuth, type ITokenValidator } from "../auth/auth.types";
import type { IProviderCredential } from "../auth/provider.auth";
import { compileAuthorizationPolicy } from "../authorization/runtime";
import type { IAuthorizationPolicyConfig } from "../authorization/policy.types";
import type { IProtectedSlot } from "../authority/declaration";
import { WsTunnelBuilder } from "../ws/ws.tunnel.builder";
import type { WsTunnel } from "../ws/ws.tunnel";

/** Issuer written into every test token. `.invalid` is reserved and resolves nowhere. */
export const TEST_ISSUER = "https://test-broker.invalid";

/**
 * Who a test caller is. Each field becomes a claim, and the broker maps it
 * to a subject exactly as it would a real token's:
 *
 * | field     | claim        | subject              |
 * |-----------|--------------|----------------------|
 * | `user`    | `sub`        | `user:<user>`        |
 * | `groups`  | `groups`     | `group:<each>`       |
 * | `service` | `service`    | `service:<service>`  |
 * | `client`  | `client_id`  | `client:<client>`    |
 *
 * `user` defaults to the caller's name, so every caller has at least
 * `user:<name>`.
 */
export interface ITestCaller {
    readonly user?: string;
    readonly groups?: readonly string[];
    readonly service?: string;
    readonly client?: string;
    /** OAuth scopes on the token. Only matter if `configure` sets required scopes. */
    readonly scopes?: readonly string[];
}

/** A provider identity: what the security file's `providers` table would say, minus the secret, which the kit makes up. */
export interface ITestProvider {
    readonly subjects?: readonly string[];
    readonly allowedResources?: readonly string[];
}

export interface ITestBrokerOptions {
    /** Callers by name. The name is the token: `Authorization: Bearer <name>`. */
    readonly callers?: Readonly<Record<string, ITestCaller>>;

    /** Provider identities by id. Each gets the secret `broker.providerSecret(id)`. */
    readonly providers?: Readonly<Record<string, ITestProvider>>;

    /**
     * Roles, assignments, denies, slot resources: the security file's `auth`
     * policy keys. Absent, every caller may do everything everywhere, which
     * is enough to test a happy path; pass one to test a refusal.
     * `subjectMapping` is fixed by the kit (see {@link ITestCaller}).
     */
    readonly policy?: Omit<IAuthorizationPolicyConfig, "subjectMapping">;

    /** Protected slots, as in the security file. Needs `providers`. */
    readonly protectedSlots?: Readonly<Record<string, IProtectedSlot>>;

    /** Last word on the builder, for anything the options above do not cover. */
    readonly configure?: (builder: WsTunnelBuilder) => void;
}

/** A running test broker and the addresses and credentials to reach it. */
export interface ITestBroker {
    readonly tunnel: WsTunnel;
    /** `http://127.0.0.1:<port>` */
    readonly url: string;
    /** `ws://127.0.0.1:<port>` */
    readonly wsUrl: string;
    /** Streamable HTTP endpoint of a slot: `http://127.0.0.1:<port>/<slot>/mcp`. */
    mcpUrl(slot: string): string;
    /** Dedicated provider socket of a slot (`DirectTransport`): `ws://127.0.0.1:<port>/provider/<slot>`. */
    providerUrl(slot: string): string;
    /** Shared provider socket (`MultiplexTransport`): `ws://127.0.0.1:<port>/providers`. */
    readonly providersUrl: string;
    /** `{ authorization: "Bearer <caller>" }`. Throws for a caller you did not declare. */
    bearer(caller: string): { authorization: string };
    /** The secret of a provider identity, for the transport's `secret` option. */
    providerSecret(id: string): string;
    stop(): Promise<void>;
}

/**
 * Validates test tokens: the token is a caller name, the claims are the ones
 * declared for it. Any other token is refused with 401, like a bad real one.
 */
export class TestTokenValidator implements ITokenValidator {
    constructor(private readonly _callers: Readonly<Record<string, ITestCaller>>) {}

    async validate(token: string, resource: string): Promise<IAccessTokenClaims> {
        const caller = Object.prototype.hasOwnProperty.call(this._callers, token) ? this._callers[token] : undefined;
        if (!caller) throw new AuthError(401, "invalid_token", `unknown test caller "${token}"`);
        return {
            iss: TEST_ISSUER,
            sub: caller.user ?? token,
            aud: resource,
            ...(caller.groups ? { groups: [...caller.groups] } : {}),
            ...(caller.service ? { service: caller.service } : {}),
            ...(caller.client ? { client_id: caller.client } : {}),
            ...(caller.scopes ? { scope: caller.scopes.join(" ") } : {}),
        } as IAccessTokenClaims;
    }
}

/** The subjects the broker derives for a test caller. */
function subjectsOf(name: string, caller: ITestCaller): string[] {
    return [
        `user:${caller.user ?? name}`,
        ...(caller.groups ?? []).map((g) => `group:${g}`),
        ...(caller.service ? [`service:${caller.service}`] : []),
        ...(caller.client ? [`client:${caller.client}`] : []),
    ];
}

/**
 * Starts a broker for a test, on 127.0.0.1 and a free port.
 *
 * Client OAuth is on, with {@link TestTokenValidator}; provider identities
 * are on when `providers` is given. Call `stop()` in your teardown.
 */
export async function startTestBroker(options: ITestBrokerOptions = {}): Promise<ITestBroker> {
    const callers = options.callers ?? {};
    const providers = options.providers ?? {};

    const policy: IAuthorizationPolicyConfig = {
        ...(options.policy ?? {
            roles: { "test-everything": { capabilities: ["*"] } },
            assignments: Object.entries(callers).map(([name, caller]) => ({
                id: `test-everything:${name}`,
                subject: subjectsOf(name, caller)[0],
                role: "test-everything",
                resource: "/**",
            })),
        }),
        subjectMapping: { userClaim: "sub", groupClaims: ["groups"], serviceClaims: ["service"], clientClaim: "client_id" },
    };
    const authorization = compileAuthorizationPolicy(policy);
    const auth: IResolvedAuth = {
        publicBaseUrl: "http://127.0.0.1",
        authorizationServers: [TEST_ISSUER],
        validator: new TestTokenValidator(callers),
        authorization,
        slotResourceResolver: authorization.slotResourceResolver,
    };

    const secrets = new Map(Object.keys(providers).map((id) => [id, `test-secret-${id}`] as const));
    const credentials: IProviderCredential[] = Object.entries(providers).map(([id, p]) => ({
        id,
        secret: secrets.get(id)!,
        ...(p.subjects ? { subjects: [...p.subjects] } : {}),
        ...(p.allowedResources ? { allowedResources: [...p.allowedResources] } : {}),
    }));

    const builder = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1").withAuth(auth);
    if (credentials.length > 0) builder.withProviderPrincipals(credentials);
    if (options.protectedSlots) builder.withProtectedSlots(options.protectedSlots);
    options.configure?.(builder);

    const tunnel = builder.build();
    await tunnel.start();
    const port = ((tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}`;

    return {
        tunnel,
        url,
        wsUrl,
        mcpUrl: (slot) => `${url}/${encodeURIComponent(slot)}/mcp`,
        providerUrl: (slot) => `${wsUrl}/provider/${encodeURIComponent(slot)}`,
        providersUrl: `${wsUrl}/providers`,
        bearer: (caller) => {
            if (!Object.prototype.hasOwnProperty.call(callers, caller)) {
                throw new Error(`startTestBroker: no caller named "${caller}". Declared callers: ${Object.keys(callers).join(", ") || "(none)"}.`);
            }
            return { authorization: `Bearer ${caller}` };
        },
        providerSecret: (id) => {
            const secret = secrets.get(id);
            if (!secret) throw new Error(`startTestBroker: no provider identity "${id}". Declared providers: ${[...secrets.keys()].join(", ") || "(none)"}.`);
            return secret;
        },
        stop: () => tunnel.stop(),
    };
}
