import { createRemoteJWKSet, jwtVerify, errors, type JWTVerifyGetKey } from "jose";
import { AuthError, type IAccessTokenClaims, type ITokenValidator } from "./auth.types";

/**
 * Options for {@link JwtTokenValidator}. `jwksUri` points at the authorization
 * server's JWKS endpoint; `issuer` (when set) is checked against the token `iss`.
 */
export interface IJwtValidatorOptions {
    /** URL of the authorization server's JWKS document. */
    jwksUri: string;
    /** Expected token issuer(s). When omitted, the `iss` claim is not checked. */
    issuer?: string | string[];
    /** Leeway in seconds for `exp`/`nbf` checks. Defaults to jose's `0`. */
    clockToleranceSec?: number;
}

/**
 * An {@link ITokenValidator} that verifies JWT access tokens **statelessly** by
 * checking the signature against the authorization server's JWKS and validating
 * the standard claims. This is the default validator for a public deployment:
 * no per-request round-trip to the AS, no shared introspection secret.
 *
 * Audience binding (RFC 8707) is enforced by passing the per-request canonical
 * resource URI as the required `audience`, so a token minted for another slot ,
 * or another service, is rejected.
 *
 * The JWKS is fetched lazily and cached (with rotation/cooldown) by
 * `jose.createRemoteJWKSet`.
 */
export class JwtTokenValidator implements ITokenValidator {
    private readonly _jwks: JWTVerifyGetKey;
    private readonly _issuer?: string | string[];
    private readonly _clockTolerance: number;

    constructor(options: IJwtValidatorOptions) {
        this._jwks = createRemoteJWKSet(new URL(options.jwksUri));
        this._issuer = options.issuer;
        this._clockTolerance = options.clockToleranceSec ?? 0;
    }

    async validate(token: string, resource: string): Promise<IAccessTokenClaims> {
        try {
            const { payload } = await jwtVerify(token, this._jwks, {
                audience: resource,
                issuer: this._issuer,
                clockTolerance: this._clockTolerance,
            });
            return payload as IAccessTokenClaims;
        } catch (err) {
            // Token-level failures (bad signature, wrong audience/issuer, expired,
            // no matching key) are JOSEError subclasses ⇒ a genuine 401. Anything
            // else (JWKS endpoint unreachable, malformed config) is infrastructure:
            // rethrow so the caller surfaces a 500 instead of a misleading 401.
            if (err instanceof errors.JOSEError) {
                throw new AuthError(401, "invalid_token", err.message);
            }
            throw err;
        }
    }
}

/** @deprecated Use {@link IJwtValidatorOptions}. */
export type JwtValidatorOptions = IJwtValidatorOptions;
