import { LimitPattern, LimitPatternIndex } from "./resource.limits";
import { providerPublishDecision, type IProviderPrincipal } from "../auth/provider.auth";
import { validateCapability } from "../authorization/capability.classifier";
import { ResourcePath } from "../authorization/resource.path";
import type { ISlotResourceResolver } from "../authorization/slot.resource";

/**
 * A slot only one provider may call, and only one may publish into.
 *
 * Written by the broker's operators, in the security file, never by a
 * provider: a declaration may confirm a protection, not create one, because a
 * protection created at runtime would vanish on the next broker restart and
 * leave the slot open until the declaring provider reconnected.
 */
export interface IProtectedSlot {
    /** Provider principal id whose declaration confirms the protection, and whose subjects may call the slot. */
    readonly declaredBy: string;
    /** Provider principal id that alone may publish into the slot. */
    readonly publishedBy: string;
}

/** One resource of a declaration: its native identifier, and the path the broker evaluates. */
export interface IDeclaredResource {
    /** The provider's own identifier (`uns://...`). Never interpreted by the broker. */
    readonly resource: string;
    /** Where the policy engine looks it up. Inside the declaration's namespace. */
    readonly resourcePath: ResourcePath;
    /** What acting on it does, e.g. `"physical-action"`. Descriptive only. */
    readonly effect?: string;
    /**
     * Engineering limits, returned with every allow on this resource as
     * `obligations.constraints`. They can only narrow a decision, never widen it.
     */
    readonly limits?: IResourceLimits;
}

/**
 * Engineering limits of one resource: the process range of a setpoint, the
 * values a mode accepts, the levels a value may be written to. They hold for
 * every caller, which is what separates them from a policy: they describe the
 * equipment, not who may act on it.
 */
export interface IResourceLimits {
    readonly minValue?: number;
    readonly maxValue?: number;
    /** JSON scalars the value must be one of. */
    readonly allowedValues?: readonly (string | number | boolean | null)[];
    /** Provider-defined levels the operation may target (`device`, `source`, ...). */
    readonly destinations?: readonly string[];
}

/** An accepted declaration, as the broker holds it. */
export interface IProviderDeclaration {
    /** Provider principal id the declaration belongs to. */
    readonly principalId: string;
    /** Slot from which this declaration was accepted. Chosen by the broker. */
    readonly slot: string;
    /** The version string the provider sent. */
    readonly version: string;
    /** Capability prefix: every declared capability is `<domain>.<name>`. */
    readonly domain: string;
    /** The subtree every resource of this declaration lives in. */
    readonly namespace: ResourcePath;
    readonly capabilities: ReadonlySet<string>;
    readonly budgetUnits: readonly string[];
    /** Declared resources, keyed by native identifier. */
    readonly resources: ReadonlyMap<string, IDeclaredResource>;
    readonly resourcePatterns: LimitPatternIndex;
    /** Slots this declaration confirms as protected. */
    readonly protects: readonly string[];
    /**
     * Capabilities whose allowed decisions the provider promises to report
     * with `broker/audit/result`. One still waiting past the result timeout is
     * shown by `broker_diagnose`.
     */
    readonly resultsRequired: ReadonlySet<string>;
    /** Policy version produced by accepting it. */
    readonly policyVersion: string;
    /** When the broker accepted it. */
    readonly acceptedAt: string;
}

/** What the validator needs to know beyond the frame itself. */
export interface IDeclarationContext {
    readonly slot: string;
    /** The provider that sent the declaration, `null` when it is anonymous. */
    readonly principal: IProviderPrincipal | null;
    readonly protectedSlots: Readonly<Record<string, IProtectedSlot>>;
    readonly slotResources: ISlotResourceResolver;
    /** The principal whose accepted declaration holds `domain`, if any. */
    readonly domainOwner?: (domain: string) => string | undefined;
}

/** Domains the broker's own capabilities live in (`mcp.tools.call`, `broker.providers.read`). No provider may declare them. */
const RESERVED_DOMAINS: ReadonlySet<string> = new Set(["mcp", "broker"]);

/** Keys a declaration may carry. Anything else refuses it. */
const DECLARATION_KEYS = new Set(["version", "domain", "namespace", "capabilities", "resources", "protects", "resultsRequired", "budgetUnits"]);

/** Keys that would grant rights. Named in the refusal, since that is the whole point of refusing them. */
const RIGHTS_KEYS = new Set(["assignments", "roles", "denies"]);

const RESOURCE_KEYS = new Set(["resource", "resourcePath", "resourcePattern", "where", "effect", "limits"]);

const LIMIT_KEYS = new Set(["minValue", "maxValue", "allowedValues", "destinations"]);

/** Upper bounds, so one frame cannot make the broker hold an unbounded amount of state. */
export const DECLARATION_LIMITS = Object.freeze({
    maxCapabilities: 64,
    maxResources: 10_000,
    maxProtects: 256,
    maxIdentifierLength: 2048,
});

const DOMAIN_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/** The principal id the legacy shared secret yields: it names no one in particular. */
const SHARED_SECRET_PRINCIPAL = "shared-secret";

const LIMITS_MAX_LIST = 256;

/**
 * Reads the engineering limits of one resource. Strict on purpose: the broker
 * now returns them as constraints, so a key it does not know, or a value of
 * the wrong type, would be a limit silently not enforced.
 */
export function parseLimits(raw: unknown, label: string, errors: string[]): IResourceLimits | undefined {
    if (!isObject(raw)) {
        errors.push(`${label} must be an object`);
        return undefined;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) {
        if (!LIMIT_KEYS.has(key)) errors.push(`${label}: unknown limit "${key}"; the broker enforces minValue, maxValue, allowedValues and destinations`);
    }
    const number = (key: "minValue" | "maxValue"): number | undefined => {
        const value = raw[key];
        if (value === undefined) return undefined;
        if (typeof value !== "number" || !Number.isFinite(value)) {
            errors.push(`${label}.${key} must be a finite number`);
            return undefined;
        }
        return value;
    };
    const minValue = number("minValue");
    const maxValue = number("maxValue");
    if (minValue !== undefined && maxValue !== undefined && minValue > maxValue) errors.push(`${label}: minValue ${minValue} is greater than maxValue ${maxValue}`);

    let allowedValues: (string | number | boolean | null)[] | undefined;
    if (raw.allowedValues !== undefined) {
        const list = raw.allowedValues;
        if (!Array.isArray(list) || list.length === 0 || list.length > LIMITS_MAX_LIST)
            errors.push(`${label}.allowedValues must be a non-empty array of at most ${LIMITS_MAX_LIST} values`);
        else if (!list.every((v) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))))
            errors.push(`${label}.allowedValues may only hold strings, finite numbers, booleans and null`);
        else allowedValues = [...list];
    }

    let destinations: string[] | undefined;
    if (raw.destinations !== undefined) {
        const list = raw.destinations;
        if (!Array.isArray(list) || list.length === 0 || list.length > LIMITS_MAX_LIST || !list.every((d) => typeof d === "string" && d.length > 0 && d.length <= 64))
            errors.push(`${label}.destinations must be a non-empty array of short strings`);
        else destinations = [...list];
    }

    if (errors.length > before) return undefined;
    const limits: IResourceLimits = {
        ...(minValue !== undefined ? { minValue } : {}),
        ...(maxValue !== undefined ? { maxValue } : {}),
        ...(allowedValues ? { allowedValues: Object.freeze(allowedValues) } : {}),
        ...(destinations ? { destinations: Object.freeze(destinations) } : {}),
    };
    return Object.keys(limits).length > 0 ? Object.freeze(limits) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a resource path a provider sent, with the one rule `ResourcePath`
 * does not apply itself: a segment may not carry an encoded `/`, which would
 * let two spellings name one resource and slip past a prefix comparison
 * somewhere downstream.
 */
export function parseProviderResourcePath(value: unknown, label: string): ResourcePath | string {
    if (typeof value !== "string" || value.length === 0) return `${label} must be a non-empty string`;
    if (value.length > DECLARATION_LIMITS.maxIdentifierLength) return `${label} is longer than ${DECLARATION_LIMITS.maxIdentifierLength} characters`;
    let path: ResourcePath;
    try {
        path = ResourcePath.parse(value);
    } catch (error) {
        return `${label} ${JSON.stringify(value)} is not a valid resource path: ${(error as Error).message}`;
    }
    if (path.segments.some((segment) => /%2f/i.test(segment))) return `${label} ${JSON.stringify(value)} contains an encoded "/" (%2F)`;
    return path;
}

/** `true` when `path` is `namespace` itself or lies below it. */
export function isWithinNamespace(namespace: ResourcePath, path: ResourcePath): boolean {
    if (path.segments.length < namespace.segments.length) return false;
    return namespace.segments.every((segment, index) => path.segments[index] === segment);
}

/**
 * Validates a `broker/authorization/declare` request and builds the
 * declaration to store, or returns every problem found.
 *
 * All-or-nothing: one problem refuses the whole declaration, and the previous
 * one (if any) stays in force. Every problem is reported at once, so a
 * provider author fixes them in one round instead of one per restart.
 */
export function validateDeclaration(
    params: unknown,
    context: IDeclarationContext,
    policyVersion: string
): { readonly ok: true; readonly declaration: IProviderDeclaration } | { readonly ok: false; readonly errors: readonly string[] } {
    const errors: string[] = [];
    const principal = context.principal;

    if (!principal) {
        return { ok: false, errors: ["the provider is anonymous: only an authenticated provider (providers table in the security file) may declare authorization"] };
    }
    if (principal.id === SHARED_SECRET_PRINCIPAL) {
        return {
            ok: false,
            errors: [
                "the provider authenticated with the shared secret, which every provider holding it shares, so the declaration would belong to none of them in particular. Give it its own entry in the providers table",
            ],
        };
    }
    // A provider allowed to publish anywhere could otherwise declare the whole
    // tree and ask about its callers' rights on every other provider's slots.
    const allowedResources = principal.allowedResources;
    if (!allowedResources || allowedResources.length === 0 || allowedResources.some((pattern) => pattern === "**" || pattern === "/**")) {
        return {
            ok: false,
            errors: [
                `provider "${principal.id}" may publish anywhere (allowedResources absent or "**"). A provider that declares an authorization domain must be confined to its own subtree: give it explicit allowedResources, e.g. ["/production/site1/**"]`,
            ],
        };
    }
    if (!isObject(params)) return { ok: false, errors: ["params must be an object"] };

    for (const key of Object.keys(params)) {
        if (RIGHTS_KEYS.has(key))
            errors.push(`"${key}" is not accepted: a declaration describes resources and capabilities, it grants no right. Assignments are written by the broker's operators`);
        else if (!DECLARATION_KEYS.has(key)) errors.push(`unknown key "${key}"`);
    }

    const version = params.version;
    if (typeof version !== "string" || version.length === 0 || version.length > 128) errors.push("version must be a non-empty string of at most 128 characters");

    const domain = params.domain;
    const domainOk = typeof domain === "string" && DOMAIN_PATTERN.test(domain);
    if (!domainOk) errors.push('domain must be lowercase letters, digits and "-", starting with a letter (e.g. "scada")');
    else if (RESERVED_DOMAINS.has(domain as string)) errors.push(`domain "${String(domain)}" is reserved for the broker's own capabilities`);
    else {
        const owner = context.domainOwner?.(domain as string);
        if (owner !== undefined && owner !== principal.id) errors.push(`domain "${String(domain)}" is already declared by provider "${owner}"; a domain has one owner`);
    }

    // Namespace: a resource path the principal may publish into.
    let namespace: ResourcePath | undefined;
    if (!isObject(params.namespace)) {
        errors.push('namespace must be an object: { "resource": "/<path>" }');
    } else {
        for (const key of Object.keys(params.namespace)) if (key !== "resource") errors.push(`namespace: unknown key "${key}"`);
        const parsed = parseProviderResourcePath(params.namespace.resource, "namespace.resource");
        if (typeof parsed === "string") errors.push(parsed);
        else if (parsed.segments.length === 0) errors.push('namespace.resource cannot be "/": declare the subtree this provider serves');
        else {
            const decision = providerPublishDecision(principal, parsed);
            if (!decision.allowed) errors.push(`namespace.resource "${parsed.value}" is outside this provider's allowedResources: ${decision.detail ?? decision.reason}`);
            else namespace = parsed;
        }
    }

    // Capabilities: the domain's own vocabulary, nothing broader.
    const capabilities = new Set<string>();
    if (!Array.isArray(params.capabilities) || params.capabilities.length === 0) {
        errors.push("capabilities must be a non-empty array");
    } else if (params.capabilities.length > DECLARATION_LIMITS.maxCapabilities) {
        errors.push(`capabilities: at most ${DECLARATION_LIMITS.maxCapabilities} entries`);
    } else {
        for (const capability of params.capabilities) {
            if (typeof capability !== "string") {
                errors.push(`capability ${JSON.stringify(capability)} must be a string`);
                continue;
            }
            try {
                validateCapability(capability);
            } catch {
                errors.push(`capability "${capability}" is malformed`);
                continue;
            }
            if (capability === "*" || !domainOk || !capability.startsWith(`${domain as string}.`) || capability.length === (domain as string).length + 1) {
                errors.push(`capability "${capability}" is outside the declared domain: a "${String(domain)}" provider declares only "${String(domain)}.<name>"`);
                continue;
            }
            if (capabilities.has(capability)) errors.push(`capability "${capability}" is listed twice`);
            capabilities.add(capability);
        }
    }

    // Resources: both identifiers, the path inside the namespace.
    const resources = new Map<string, IDeclaredResource>();
    const patterns: LimitPattern[] = [];
    if (params.resources !== undefined) {
        if (!Array.isArray(params.resources)) errors.push("resources must be an array");
        else if (params.resources.length > DECLARATION_LIMITS.maxResources) errors.push(`resources: at most ${DECLARATION_LIMITS.maxResources} entries`);
        else {
            for (const [index, raw] of params.resources.entries()) {
                const label = `resources[${index}]`;
                if (!isObject(raw)) {
                    errors.push(`${label} must be an object`);
                    continue;
                }
                for (const key of Object.keys(raw)) if (!RESOURCE_KEYS.has(key)) errors.push(`${label}: unknown key "${key}"`);
                if (raw.resourcePattern !== undefined) {
                    if (raw.resource !== undefined || raw.resourcePath !== undefined || raw.effect !== undefined)
                        errors.push(`${label}: resourcePattern cannot be combined with resource, resourcePath or effect`);
                    const limits = raw.limits === undefined ? undefined : parseLimits(raw.limits, `${label}.limits`, errors);
                    try {
                        const pattern = new LimitPattern(
                            raw.resourcePattern as string,
                            limits,
                            `declaration:${String(raw.resourcePattern)}`,
                            raw.where as Record<string, string> | undefined
                        );
                        if (namespace && !namespace.segments.every((segment, index) => pattern.segments[index] === segment))
                            errors.push(`${label}.resourcePattern is outside the declared namespace`);
                        else if (!pattern.isCoveredBy(allowedResources)) errors.push(`${label}.resourcePattern is outside this provider's allowedResources`);
                        else patterns.push(pattern);
                    } catch (error) {
                        errors.push(`${label}: ${(error as Error).message}`);
                    }
                    continue;
                }
                if (raw.where !== undefined) errors.push(`${label}.where requires resourcePattern`);
                const native = raw.resource;
                if (typeof native !== "string" || native.length === 0 || native.length > DECLARATION_LIMITS.maxIdentifierLength) {
                    errors.push(`${label}.resource must be a non-empty string of at most ${DECLARATION_LIMITS.maxIdentifierLength} characters`);
                    continue;
                }
                const path = parseProviderResourcePath(raw.resourcePath, `${label}.resourcePath`);
                if (typeof path === "string") {
                    errors.push(path);
                    continue;
                }
                if (namespace && !isWithinNamespace(namespace, path)) {
                    errors.push(`${label}.resourcePath "${path.value}" is outside the declared namespace "${namespace.value}"`);
                    continue;
                }
                if (raw.effect !== undefined && (typeof raw.effect !== "string" || raw.effect.length === 0)) errors.push(`${label}.effect must be a non-empty string`);
                const limits = raw.limits === undefined ? undefined : parseLimits(raw.limits, `${label}.limits`, errors);
                if (resources.has(native)) {
                    errors.push(`${label}.resource "${native}" is declared twice`);
                    continue;
                }
                resources.set(native, {
                    resource: native,
                    resourcePath: path,
                    ...(typeof raw.effect === "string" ? { effect: raw.effect } : {}),
                    ...(limits ? { limits } : {}),
                });
            }
        }
    }

    // Protected slots: confirmed, never created.
    const protects: string[] = [];
    if (params.protects !== undefined) {
        if (!Array.isArray(params.protects)) errors.push("protects must be an array of slot names");
        else if (params.protects.length > DECLARATION_LIMITS.maxProtects) errors.push(`protects: at most ${DECLARATION_LIMITS.maxProtects} entries`);
        else {
            if (params.protects.length > 0 && (principal.subjects?.length ?? 0) === 0) {
                errors.push(
                    `this provider has no subjects in the providers table, so nobody could ever call a slot it protects, itself included. Add its client identity to "subjects" (e.g. "service:${principal.id}")`
                );
            }
            for (const slot of params.protects) {
                if (typeof slot !== "string" || slot.length === 0) {
                    errors.push(`protects: ${JSON.stringify(slot)} is not a slot name`);
                    continue;
                }
                const configured = context.protectedSlots[slot];
                if (!configured) {
                    errors.push(
                        `protects: slot "${slot}" is not listed in authorization.protectedSlots of the security file. A declaration confirms a protection the operators configured; it cannot create one`
                    );
                    continue;
                }
                if (configured.declaredBy !== principal.id) {
                    errors.push(`protects: slot "${slot}" is configured with declaredBy "${configured.declaredBy}", not "${principal.id}"`);
                    continue;
                }
                const resource = context.slotResources.resolve(slot);
                const decision = resource ? providerPublishDecision(principal, resource) : undefined;
                if (!resource || !decision?.allowed) {
                    errors.push(`protects: slot "${slot}" is outside this provider's allowedResources`);
                    continue;
                }
                if (!protects.includes(slot)) protects.push(slot);
            }
        }
    }

    const budgetUnits = params.budgetUnits ?? [];
    if (!Array.isArray(budgetUnits) || budgetUnits.length > 32 || !budgetUnits.every((u) => typeof u === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(u)))
        errors.push("budgetUnits must contain at most 32 valid units");

    // Results the provider promises to report: a subset of what it declared.
    const resultsRequired = new Set<string>();
    if (params.resultsRequired !== undefined) {
        if (!Array.isArray(params.resultsRequired)) errors.push("resultsRequired must be an array of declared capabilities");
        else {
            for (const capability of params.resultsRequired) {
                if (typeof capability !== "string" || !capabilities.has(capability)) {
                    errors.push(`resultsRequired: ${JSON.stringify(capability)} is not one of the declared capabilities`);
                    continue;
                }
                resultsRequired.add(capability);
            }
        }
    }

    if (errors.length > 0 || !namespace) return { ok: false, errors: errors.length > 0 ? errors : ["namespace is missing"] };

    return {
        ok: true,
        declaration: Object.freeze({
            principalId: principal.id,
            slot: context.slot,
            version: version as string,
            domain: domain as string,
            namespace,
            capabilities,
            budgetUnits: Object.freeze([...(budgetUnits as string[])]),
            resources,
            resourcePatterns: new LimitPatternIndex(patterns),
            protects: Object.freeze(protects),
            resultsRequired: Object.freeze(resultsRequired),
            policyVersion,
            acceptedAt: new Date().toISOString(),
        }),
    };
}
