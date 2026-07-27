import type { IAuthorizationSubject, ISubjectMappingConfig } from "./policy.types.js";

export interface ISubjectMapper {
    map(claims: Readonly<Record<string, unknown>>): IAuthorizationSubject;
}

export class SubjectMappingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SubjectMappingError";
    }
}

interface IClaimRule {
    readonly prefix: string;
    readonly claim: string;
}

function claimAt(claims: Readonly<Record<string, unknown>>, claimName: string): unknown {
    const parts = claimName.split(".");
    let current: unknown = claims;
    for (const part of parts) {
        if (!part || typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
        current = (current as Readonly<Record<string, unknown>>)[part];
    }
    return current;
}

function valuesOf(value: unknown, claimName: string): readonly string[] {
    if (value === undefined || value === null) return [];
    if (typeof value === "string") return value ? [value] : [];
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    }
    throw new SubjectMappingError(`JWT subject claim "${claimName}" must be a string or an array of strings.`);
}

function validateClaimName(value: string, label: string): void {
    if (!value || value.split(".").some((part) => !part)) {
        throw new Error(`authorization subject mapping: ${label} contains an invalid claim name.`);
    }
}

/** Maps validated JWT claims to canonical, deduplicated authorization subjects. */
export class JwtSubjectMapper implements ISubjectMapper {
    private readonly _rules: readonly IClaimRule[];

    constructor(config: ISubjectMappingConfig = {}) {
        const userClaim = config.userClaim ?? "sub";
        const groupClaims = config.groupClaims ?? ["groups", "roles"];
        const clientClaim = config.clientClaim ?? "client_id";
        const serviceClaims = config.serviceClaims ?? [];

        if (!Array.isArray(groupClaims)) throw new Error("authorization subject mapping: groupClaims must be an array.");
        if (!Array.isArray(serviceClaims)) throw new Error("authorization subject mapping: serviceClaims must be an array.");
        validateClaimName(userClaim, "userClaim");
        validateClaimName(clientClaim, "clientClaim");
        for (const claim of groupClaims) validateClaimName(claim, "groupClaims");
        for (const claim of serviceClaims) validateClaimName(claim, "serviceClaims");

        this._rules = Object.freeze([
            { prefix: "user", claim: userClaim },
            ...groupClaims.map((claim) => ({ prefix: "group", claim })),
            { prefix: "client", claim: clientClaim },
            ...serviceClaims.map((claim) => ({ prefix: "service", claim })),
        ]);
    }

    map(claims: Readonly<Record<string, unknown>>): IAuthorizationSubject {
        const ids = new Set<string>();
        for (const rule of this._rules) {
            for (const value of valuesOf(claimAt(claims, rule.claim), rule.claim)) {
                ids.add(`${rule.prefix}:${value}`);
            }
        }
        return { ids: Object.freeze([...ids]), claims };
    }
}

/** @deprecated Use {@link ISubjectMapper}. */
export type SubjectMapper = ISubjectMapper;
