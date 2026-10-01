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
    /** Engineering limits; they can only narrow a decision, never widen it. */
    readonly limits?: Readonly<Record<string, unknown>>;
}

/** An accepted declaration, as the broker holds it. */
export interface IProviderDeclaration {
    /** Provider principal id the declaration belongs to; the key it is stored under. */
    readonly principalId: string;
    /** The version string the provider sent. */
    readonly version: string;
    /** Capability prefix: every declared capability is `<domain>.<name>`. */
    readonly domain: string;
    /** The subtree every resource of this declaration lives in. */
    readonly namespace: ResourcePath;
    readonly capabilities: ReadonlySet<string>;
    /** Declared resources, keyed by native identifier. */
    readonly resources: ReadonlyMap<string, IDeclaredResource>;
    /** Slots this declaration confirms as protected. */
    readonly protects: readonly string[];
    /** Policy version produced by accepting it. */
    readonly policyVersion: string;
    /** When the broker accepted it. */
    readonly acceptedAt: string;
}

/** What the validator needs to know beyond the frame itself. */
export interface IDeclarationContext {
    /** The provider that sent the declaration, `null` when it is anonymous. */
    readonly principal: IProviderPrincipal | null;
    readonly protectedSlots: Readonly<Record<string, IProtectedSlot>>;
    readonly slotResources: ISlotResourceResolver;
}

/** Keys a declaration may carry. Anything else refuses it. */
const DECLARATION_KEYS = new Set(["version", "domain", "namespace", "capabilities", "resources", "protects"]);

/** Keys that would grant rights. Named in the refusal, since that is the whole point of refusing them. */
const RIGHTS_KEYS = new Set(["assignments", "roles", "denies"]);

const RESOURCE_KEYS = new Set(["resource", "resourcePath", "effect", "limits"]);

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

    // Namespace: a resource path the principal may publish into.
    let namespace: ResourcePath | undefined;
    if (!isObject(params.namespace)) {
        errors.push('namespace must be an object: { "resource": "/<path>" }');
    } else {
        for (const key of Object.keys(params.namespace)) if (key !== "resource") errors.push(`namespace: unknown key "${key}"`);
        const parsed = parseProviderResourcePath(params.namespace.resource, "namespace.resource");
        if (typeof parsed === "string") errors.push(parsed);
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
                if (raw.limits !== undefined && !isObject(raw.limits)) errors.push(`${label}.limits must be an object`);
                if (resources.has(native)) {
                    errors.push(`${label}.resource "${native}" is declared twice`);
                    continue;
                }
                resources.set(native, {
                    resource: native,
                    resourcePath: path,
                    ...(typeof raw.effect === "string" ? { effect: raw.effect } : {}),
                    ...(isObject(raw.limits) ? { limits: Object.freeze({ ...raw.limits }) } : {}),
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

    if (errors.length > 0 || !namespace) return { ok: false, errors: errors.length > 0 ? errors : ["namespace is missing"] };

    return {
        ok: true,
        declaration: Object.freeze({
            principalId: principal.id,
            version: version as string,
            domain: domain as string,
            namespace,
            capabilities,
            resources,
            protects: Object.freeze(protects),
            policyVersion,
            acceptedAt: new Date().toISOString(),
        }),
    };
}
