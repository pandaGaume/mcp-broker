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

export function providerMayPublish(principal: IProviderPrincipal, resource: ResourcePath): boolean {
    const allowed = principal.allowedResources;
    if (allowed === undefined) return true;
    if (allowed.length === 0) return false;
    try {
        const patterns = allowed.map((pattern) => ResourcePathPattern.parse(pattern));
        return patterns.some((pattern) => pattern.matches(resource));
    } catch {
        return false;
    }
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
