import { timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";
import { ResourcePath, ResourcePathPattern } from "../authorization/index";

export interface IProviderPrincipal {
    readonly id: string;
    readonly subjects?: readonly string[];
    readonly allowedResources?: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ProviderAuthenticationResult = { readonly authenticated: true; readonly principal: IProviderPrincipal } | { readonly authenticated: false; readonly reason?: string };

export type ProviderAuthenticatorReturn = boolean | ProviderAuthenticationResult;

/**
 * Authenticates a **provider** (the engine that connects _into_ the broker to
 * serve a slot) at the WebSocket upgrade handshake. This is a distinct concern
 * from the OAuth 2.1 resource-server layer that guards *clients*: a provider is
 * not an OAuth client acting for a resource owner, it is the backend claiming a
 * slot. Authenticating it is what stops a stranger from occupying a free slot
 * (`ws://host/provider/<slot>`) and impersonating the real engine.
 */
export interface IProviderAuthenticator {
    /**
     * Returns a structured result, or a legacy boolean for backward
     * compatibility. `slot` is the dedicated slot name for
     * `/provider/<slot>`, or `undefined` for the multiplexed `/providers`
     * socket, which is authenticated before any provider name is known.
     */
    authenticate(req: IncomingMessage, slot: string | undefined): ProviderAuthenticatorReturn | Promise<ProviderAuthenticatorReturn>;
}

export function normalizeProviderAuthentication(result: ProviderAuthenticatorReturn, fallbackId = "legacy-provider"): ProviderAuthenticationResult {
    if (typeof result === "boolean") {
        return result ? { authenticated: true, principal: { id: fallbackId, allowedResources: ["**"] } } : { authenticated: false };
    }
    if (!result.authenticated) return result;
    if (!result.principal.id) return { authenticated: false, reason: "provider principal id is empty" };
    return result;
}

/** Wording shared by every "this pattern is not valid" diagnostic. */
const PATTERN_SYNTAX_HINT = 'Resource patterns are absolute and segment-based: "/enterprise/**", "/enterprise/*/line-3", "/enterprise/site-a/asset", or "**" for everything.';

/**
 * Compiled `allowedResources` patterns, keyed by the exact pattern string, with
 * the compile failure cached alongside the successes.
 *
 * {@link providerMayPublish} runs on every provider WebSocket upgrade, and the
 * previous per-call `ResourcePathPattern.parse` inside a `try` meant a single
 * typo re-threw on every registration and was mapped to a bare `false`. Caching
 * the outcome makes the parse happen once per distinct pattern and gives the
 * failure a stable identity we can report exactly once.
 */
const compiledPatterns = new Map<string, ResourcePathPattern | Error>();

/** Malformed-pattern reports already emitted, so a wedged config logs once. */
const reportedMalformedPatterns = new Set<string>();

/** Parses one pattern, memoizing both the success and the failure. */
function compilePattern(pattern: string): ResourcePathPattern | Error {
    const cached = compiledPatterns.get(pattern);
    if (cached !== undefined) return cached;
    let compiled: ResourcePathPattern | Error;
    try {
        compiled = ResourcePathPattern.parse(pattern);
    } catch (error) {
        compiled = error instanceof Error ? error : new Error(String(error));
    }
    compiledPatterns.set(pattern, compiled);
    return compiled;
}

/** Why a provider was refused a slot. `undefined` when it was allowed. */
export type ProviderPublishDenialReason = "no-allowed-resources" | "out-of-namespace" | "malformed-pattern";

/** The outcome of a provider namespace check, with the cause when it denies. */
export interface IProviderPublishDecision {
    readonly allowed: boolean;
    /** Machine-readable cause, present only when `allowed` is `false`. */
    readonly reason?: ProviderPublishDenialReason;
    /** Operator-facing explanation that already names the fix. */
    readonly detail?: string;
}

/**
 * Compiles a principal's `allowedResources`, throwing on the first malformed
 * pattern with the offending pattern quoted in the message.
 *
 * Call this wherever a provider principal is *built* (config load, a custom
 * authenticator's constructor) so a typo fails the broker at startup instead of
 * silently 403-ing every provider on that principal forever.
 * {@link providerPublishDecision} deliberately does not throw: it runs inside the
 * WebSocket upgrade, where the only safe answer to "is this pattern valid?" is
 * to deny loudly.
 */
export function compileProviderAllowedResources(allowed: readonly string[], label = "provider allowedResources"): readonly ResourcePathPattern[] {
    return allowed.map((pattern) => {
        const compiled = compilePattern(pattern);
        if (compiled instanceof Error) {
            throw new Error(`${label}: "${pattern}" is not a valid resource pattern: ${compiled.message} ${PATTERN_SYNTAX_HINT}`);
        }
        return compiled;
    });
}

/**
 * Decides whether a provider principal may claim `resource`, and says why when
 * it may not.
 *
 * Every denial here surfaces to the provider as a bare 403 at the WebSocket
 * handshake, which a browser reports as a contentless error event. The reason is
 * therefore the only thing an operator (or an agent wiring this up) has to work
 * from, so it is returned to the caller for the registration log and, for the
 * configuration-fault case, logged here as well.
 */
export function providerPublishDecision(principal: IProviderPrincipal, resource: ResourcePath): IProviderPublishDecision {
    const allowed = principal.allowedResources;
    if (allowed === undefined) return { allowed: true };
    if (allowed.length === 0) {
        return {
            allowed: false,
            reason: "no-allowed-resources",
            detail:
                `Provider principal "${principal.id}" has an empty allowedResources list, which forbids every slot. ` +
                `Remove the key entirely to allow all slots, or list the namespaces this principal may publish, for example ["/enterprise/**"].`,
        };
    }

    const patterns: ResourcePathPattern[] = [];
    const malformed: string[] = [];
    for (const pattern of allowed) {
        const compiled = compilePattern(pattern);
        if (compiled instanceof Error) malformed.push(`"${pattern}" (${compiled.message})`);
        else patterns.push(compiled);
    }

    if (malformed.length > 0) {
        const detail =
            `Provider principal "${principal.id}" carries ${malformed.length} malformed allowedResources pattern(s): ${malformed.join("; ")} ` +
            `Every provider registration on this principal is refused with 403 until they are fixed, whatever slot it asks for. ${PATTERN_SYNTAX_HINT}`;
        // Loud, but once per (principal, bad pattern set): this is a
        // startup-class configuration fault the broker can never honor, and its
        // request-time symptom is a 403 that names nothing.
        const key = `${principal.id}|${malformed.join("|")}`;
        if (!reportedMalformedPatterns.has(key)) {
            reportedMalformedPatterns.add(key);
            console.error(`[broker] provider auth: ${detail}`);
        }
        return { allowed: false, reason: "malformed-pattern", detail };
    }

    if (patterns.some((pattern) => pattern.matches(resource))) return { allowed: true };
    return {
        allowed: false,
        reason: "out-of-namespace",
        detail:
            `Provider principal "${principal.id}" may not publish resource "${resource.value}": it is outside allowedResources [${allowed.join(", ")}]. ` +
            `Either connect the provider to a slot inside one of those namespaces, or widen allowedResources for this principal.`,
    };
}

/**
 * Boolean form of {@link providerPublishDecision}, kept for callers that only
 * need the verdict. Prefer the decision form so the refusal can be logged with
 * its cause.
 */
export function providerMayPublish(principal: IProviderPrincipal, resource: ResourcePath): boolean {
    return providerPublishDecision(principal, resource).allowed;
}

/** Constant-time string comparison; `false` on any length mismatch. */
function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

/**
 * Reads the secret a provider presents, from either the `X-Provider-Token`
 * header or an `Authorization: Bearer <secret>` header.
 */
function presentedSecret(req: IncomingMessage): string | null {
    const xheader = req.headers["x-provider-token"];
    if (typeof xheader === "string" && xheader.trim()) return xheader.trim();

    const auth = req.headers["authorization"];
    if (typeof auth === "string") {
        const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
        if (match) return match[1].trim();
    }
    return null;
}

/**
 * The default {@link IProviderAuthenticator}: every provider connection must
 * present a single shared secret (via `X-Provider-Token` or `Authorization:
 * Bearer`). Compared in constant time. Suitable when the broker and its
 * providers are operated by the same party; swap in a custom authenticator for
 * per-slot secrets, mTLS, or a signed handshake.
 */
export class SharedSecretProviderAuthenticator implements IProviderAuthenticator {
    private readonly _secret: string;

    constructor(secret: string) {
        if (!secret) {
            throw new Error("provider auth: a non-empty shared secret is required.");
        }
        this._secret = secret;
    }

    authenticate(req: IncomingMessage): ProviderAuthenticationResult {
        const presented = presentedSecret(req);
        if (!presented || !safeEqual(presented, this._secret)) {
            return { authenticated: false };
        }
        return {
            authenticated: true,
            principal: {
                id: "shared-secret",
                allowedResources: ["**"],
            },
        };
    }
}

/** @deprecated Use {@link IProviderPrincipal}. */
export type ProviderPrincipal = IProviderPrincipal;
/** @deprecated Use {@link IProviderAuthenticator}. */
export type ProviderAuthenticator = IProviderAuthenticator;
