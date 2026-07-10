import { timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";

/**
 * Authenticates a **provider** (the engine that connects _into_ the broker to
 * serve a slot) at the WebSocket upgrade handshake. This is a distinct concern
 * from the OAuth 2.1 resource-server layer that guards *clients*: a provider is
 * not an OAuth client acting for a resource owner, it is the backend claiming a
 * slot. Authenticating it is what stops a stranger from occupying a free slot
 * (`ws://host/provider/<slot>`) and impersonating the real engine.
 */
export interface ProviderAuthenticator {
    /**
     * Returns `true` to accept the provider connection. `slot` is the dedicated
     * slot name for `/provider/<slot>`, or `undefined` for the multiplexed
     * `/providers` socket (which is authenticated at the socket level, before
     * any provider name is known).
     */
    authenticate(req: IncomingMessage, slot: string | undefined): boolean | Promise<boolean>;
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
 * The default {@link ProviderAuthenticator}: every provider connection must
 * present a single shared secret (via `X-Provider-Token` or `Authorization:
 * Bearer`). Compared in constant time. Suitable when the broker and its
 * providers are operated by the same party; swap in a custom authenticator for
 * per-slot secrets, mTLS, or a signed handshake.
 */
export class SharedSecretProviderAuthenticator implements ProviderAuthenticator {
    private readonly _secret: string;

    constructor(secret: string) {
        if (!secret) {
            throw new Error("provider auth: a non-empty shared secret is required.");
        }
        this._secret = secret;
    }

    authenticate(req: IncomingMessage): boolean {
        const presented = presentedSecret(req);
        if (!presented) return false;
        return safeEqual(presented, this._secret);
    }
}
