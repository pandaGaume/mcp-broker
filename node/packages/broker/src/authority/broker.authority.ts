import { randomBytes } from "crypto";
import type { IProviderPrincipal } from "../auth/provider.auth";
import { writeAuthorizationAuditEvent } from "../authorization/audit";
import type { IAuthorizationAuditEvent, IAuthorizationDecision, IAuthorizationSubject } from "../authorization/policy.types";
import type { ResourcePath } from "../authorization/resource.path";
import type { IPolicyAuthorization } from "../authorization/runtime";
import type { ISlotResourceResolver } from "../authorization/slot.resource";
import { isWithinNamespace, parseProviderResourcePath, validateDeclaration, type IProtectedSlot, type IProviderDeclaration } from "./declaration";

/** Prefix of every method a provider sends to the broker itself. Never relayed. */
export const BROKER_METHOD_PREFIX = "broker/";

/** A provider declares its resources, capabilities and protected slots. */
export const BROKER_DECLARE_METHOD = "broker/authorization/declare";

/** A provider asks for one or more decisions. */
export const BROKER_AUTHORIZE_METHOD = "broker/authorize";

/**
 * The `params._meta` key under which the broker hands a declaring provider a
 * reference to the caller of the request it is serving. Removed from every
 * client frame before anything else, so only the broker ever writes it.
 */
export const CALLER_META_KEY = "io.cyanmycelium/caller";

/** Default cap on the number of checks in one `broker/authorize`. */
export const DEFAULT_AUTHORIZE_BATCH_LIMIT = 256;

/** The JSON-RPC answer to a `broker/*` request, before the id is attached. */
export type BrokerMethodOutcome = { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };

/** Where a `broker/*` request came from. */
export interface IBrokerMethodOrigin {
    /** The slot the frame arrived on. */
    readonly slot: string;
    /** The provider principal behind that slot, `null` when anonymous. */
    readonly principal: IProviderPrincipal | null;
}

/** One live caller reference. */
interface ICallerRef {
    readonly slot: string;
    readonly brokerId: string;
    readonly providerPrincipalId: string;
    readonly subject: IAuthorizationSubject;
    readonly correlationId: string;
}

/** What `getAuthorityInfo` reports, for `broker_diagnose` and `broker_info`. */
export interface IBrokerAuthorityInfo {
    readonly policyVersion: string;
    readonly protectedSlots: readonly { readonly slot: string; readonly declaredBy: string; readonly publishedBy: string; readonly confirmed: boolean }[];
    readonly declarations: readonly {
        readonly principalId: string;
        readonly domain: string;
        readonly version: string;
        readonly policyVersion: string;
        readonly acceptedAt: string;
        readonly capabilities: readonly string[];
        readonly resourceCount: number;
        readonly protects: readonly string[];
    }[];
    /** Domain-prefixed capabilities the policy grants that no accepted declaration covers. */
    readonly undeclaredCapabilities: readonly string[];
    readonly liveCallerRefs: number;
}

export interface IBrokerAuthorityOptions {
    readonly protectedSlots?: Readonly<Record<string, IProtectedSlot>>;
    readonly slotResources: ISlotResourceResolver;
    readonly authorization: IPolicyAuthorization | null;
    /** Identifies the security configuration the broker started with (a hash of the security file). */
    readonly securityVersion?: string;
    readonly authorizeBatchLimit?: number;
    /** Provider principals known from configuration, for the subjects of a protected slot's declarer. */
    readonly knownPrincipals?: readonly IProviderPrincipal[];
}

/** Keys of an attribute map that are masked in the audit, whatever their value. */
const SENSITIVE_KEY = /secret|password|passwd|token|credential|authorization|api[-_]?key|private/i;

const REF_PATTERN = /^cr_[A-Za-z0-9_-]{8,64}$/;

/** Short random identifier, URL-safe. */
function randomId(prefix: string, bytes = 12): string {
    return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

function maskAttributes(value: unknown, depth = 0): unknown {
    if (depth > 4) return "[depth]";
    if (Array.isArray(value)) return value.slice(0, 64).map((item) => maskAttributes(item, depth + 1));
    if (typeof value !== "object" || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 64)) out[key] = SENSITIVE_KEY.test(key) ? "***" : maskAttributes(item, depth + 1);
    return out;
}

function invalidParams(message: string, data?: unknown): BrokerMethodOutcome {
    return { error: { code: -32602, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * The broker as the single decision point for providers that declare their
 * own authorization domain (SCADA being the first).
 *
 * Owns three things, all of them in memory:
 *
 * - **Declarations**, keyed by provider principal. A declaration describes
 *   (namespace, capabilities, resources, protected slots) and grants nothing.
 * - **Caller references**: opaque tokens handed to a declaring provider with
 *   each request, so it can ask "may the caller of this request do X?" without
 *   ever learning who the caller is, and without being able to ask about
 *   anybody else. A reference is valid exactly as long as its request is
 *   pending at the broker.
 * - **Protected slots**: configured by the operators, confirmed by a
 *   declaration, enforced from startup whether or not it was confirmed yet.
 *
 * It decides; the tunnel enforces. Nothing here touches a socket.
 */
export class BrokerAuthority {
    private readonly _protectedSlots: Readonly<Record<string, IProtectedSlot>>;
    private readonly _slotResources: ISlotResourceResolver;
    private readonly _authorization: IPolicyAuthorization | null;
    private readonly _securityVersion: string;
    private readonly _batchLimit: number;

    private readonly _declarations = new Map<string, IProviderDeclaration>();
    private readonly _refs = new Map<string, ICallerRef>();
    private readonly _principals = new Map<string, IProviderPrincipal>();
    private _declarationCount = 0;

    constructor(options: IBrokerAuthorityOptions) {
        this._protectedSlots = Object.freeze({ ...(options.protectedSlots ?? {}) });
        this._slotResources = options.slotResources;
        this._authorization = options.authorization;
        this._securityVersion = options.securityVersion ?? "config";
        this._batchLimit = Math.max(1, options.authorizeBatchLimit ?? DEFAULT_AUTHORIZE_BATCH_LIMIT);
        for (const principal of options.knownPrincipals ?? []) this._principals.set(principal.id, principal);
    }

    /** The version every decision is stamped with: the security configuration, then the declarations accepted since. */
    get policyVersion(): string {
        return `${this._securityVersion}.${this._declarationCount}`;
    }

    // -------------------------------------------------------------------------
    // Provider principals
    // -------------------------------------------------------------------------

    /**
     * Records a provider principal seen at a handshake. A custom authenticator
     * may return principals the configuration never listed; their subjects are
     * needed to admit callers of the slots they protect.
     */
    notePrincipal(principal: IProviderPrincipal): void {
        this._principals.set(principal.id, principal);
    }

    // -------------------------------------------------------------------------
    // Protected slots
    // -------------------------------------------------------------------------

    /** The protection configured for `slot`, or `undefined`. */
    protectionOf(slot: string): IProtectedSlot | undefined {
        return Object.prototype.hasOwnProperty.call(this._protectedSlots, slot) ? this._protectedSlots[slot] : undefined;
    }

    get protectedSlotNames(): readonly string[] {
        return Object.keys(this._protectedSlots);
    }

    /**
     * Whether a client with this subject may reach `slot`. Unprotected slots
     * are none of this class's business and always pass.
     *
     * A protected slot admits a client whose subjects intersect the subjects
     * of the declaring provider's principal: the client is that provider,
     * acting as a client. Fails closed: no known subjects, nobody admitted.
     */
    clientMayReach(slot: string, subject: IAuthorizationSubject): boolean {
        const protection = this.protectionOf(slot);
        if (!protection) return true;
        const declarer = this._principals.get(protection.declaredBy);
        const allowed = new Set(declarer?.subjects ?? []);
        return subject.ids.some((id) => allowed.has(id));
    }

    /** Whether `principal` may publish into `slot`. Unprotected slots always pass here. */
    mayPublish(slot: string, principal: IProviderPrincipal | null): boolean {
        const protection = this.protectionOf(slot);
        if (!protection) return true;
        return principal !== null && principal.id === protection.publishedBy;
    }

    // -------------------------------------------------------------------------
    // Declarations
    // -------------------------------------------------------------------------

    /** The accepted declaration of a provider principal, if any. */
    declarationOf(principalId: string | undefined | null): IProviderDeclaration | undefined {
        return principalId ? this._declarations.get(principalId) : undefined;
    }

    /** Handles `broker/authorization/declare`. */
    declare(params: unknown, origin: IBrokerMethodOrigin): BrokerMethodOutcome {
        const policyVersion = `${this._securityVersion}.${this._declarationCount + 1}`;
        const outcome = validateDeclaration(params, { principal: origin.principal, protectedSlots: this._protectedSlots, slotResources: this._slotResources }, policyVersion);
        if (!outcome.ok) {
            console.warn(
                `[broker] authorization declaration from slot "${origin.slot}" (principal "${origin.principal?.id ?? "(anonymous)"}") refused: ${outcome.errors.join("; ")}`
            );
            return invalidParams(`Declaration refused: ${outcome.errors.length} problem(s). Nothing changed; the previous declaration, if any, stays in force.`, {
                errors: outcome.errors,
            });
        }
        const declaration = outcome.declaration;
        if (origin.principal) this.notePrincipal(origin.principal);
        this._declarations.set(declaration.principalId, declaration);
        this._declarationCount += 1;
        console.info(
            `[broker] authorization declaration accepted: principal "${declaration.principalId}", domain "${declaration.domain}", version "${declaration.version}", ` +
                `${declaration.capabilities.size} capabilities, ${declaration.resources.size} resources, protects [${declaration.protects.join(", ")}], policyVersion ${declaration.policyVersion}`
        );
        return { result: { accepted: true, version: declaration.version, policyVersion: declaration.policyVersion } };
    }

    // -------------------------------------------------------------------------
    // Caller references
    // -------------------------------------------------------------------------

    /** Issues a reference to the caller of one pending request. */
    issueRef(slot: string, brokerId: string, providerPrincipalId: string, subject: IAuthorizationSubject): { readonly ref: string; readonly correlationId: string } {
        const ref = randomId("cr_");
        const correlationId = randomId("corr_", 9);
        this._refs.set(ref, { slot, brokerId, providerPrincipalId, subject, correlationId });
        return { ref, correlationId };
    }

    /** Forgets a reference; its request was answered or abandoned. */
    releaseRef(ref: string | undefined): void {
        if (ref) this._refs.delete(ref);
    }

    /** Drops every reference whose request is no longer pending. */
    sweepRefs(isPending: (slot: string, brokerId: string) => boolean): void {
        for (const [ref, entry] of this._refs) if (!isPending(entry.slot, entry.brokerId)) this._refs.delete(ref);
    }

    get liveCallerRefs(): number {
        return this._refs.size;
    }

    // -------------------------------------------------------------------------
    // broker/authorize
    // -------------------------------------------------------------------------

    /**
     * Handles `broker/authorize`.
     *
     * A malformed request, an unknown `principal` form, or a reference that is
     * not live on this socket refuses the whole request (`-32602`): those are
     * protocol faults, not policy outcomes. Each well-formed check then gets
     * its own decision, audited, with a `decisionId`.
     */
    authorize(params: unknown, origin: IBrokerMethodOrigin, isPending: (slot: string, brokerId: string) => boolean): BrokerMethodOutcome {
        const principal = origin.principal;
        const declaration = this.declarationOf(principal?.id);
        if (!principal || !declaration) {
            return { error: { code: -32003, message: "No accepted authorization declaration for this provider: send broker/authorization/declare first." } };
        }
        if (typeof params !== "object" || params === null || Array.isArray(params)) return invalidParams("params must be an object");
        const p = params as Record<string, unknown>;
        for (const key of Object.keys(p)) if (key !== "principal" && key !== "correlationId" && key !== "checks") return invalidParams(`unknown key "${key}"`);

        // On whose behalf. Two forms, nothing else, and never an identity.
        const asked = p.principal;
        if (typeof asked !== "object" || asked === null || Array.isArray(asked))
            return invalidParams('principal must be { "type": "caller-ref", "ref": "..." } or { "type": "provider" }');
        const a = asked as Record<string, unknown>;
        let subject: IAuthorizationSubject;
        let onBehalfOf: "caller" | "provider";
        let correlationId: string;
        if (a.type === "caller-ref") {
            if (Object.keys(a).some((key) => key !== "type" && key !== "ref")) {
                return invalidParams(
                    'principal of type "caller-ref" carries only "ref". An identity is never accepted here: the broker resolves the reference to the subjects it derived itself.'
                );
            }
            if (typeof a.ref !== "string" || !REF_PATTERN.test(a.ref)) return invalidParams("principal.ref is not a caller reference issued by this broker");
            const entry = this._refs.get(a.ref);
            if (!entry || entry.slot !== origin.slot || entry.providerPrincipalId !== principal.id) {
                return invalidParams(
                    "principal.ref is unknown, expired, or was issued for another slot or provider. A reference is valid only on the slot it came with, until the request it came with is answered."
                );
            }
            if (!isPending(entry.slot, entry.brokerId)) {
                this._refs.delete(a.ref);
                return invalidParams("principal.ref has expired: the request it came with was already answered or abandoned.");
            }
            subject = entry.subject;
            onBehalfOf = "caller";
            correlationId = entry.correlationId;
        } else if (a.type === "provider") {
            if (Object.keys(a).some((key) => key !== "type")) return invalidParams('principal of type "provider" carries nothing else');
            subject = { ids: [...(principal.subjects ?? [])] };
            onBehalfOf = "provider";
            correlationId = typeof p.correlationId === "string" && p.correlationId.length > 0 && p.correlationId.length <= 128 ? p.correlationId : randomId("corr_", 9);
        } else {
            return invalidParams('principal.type must be "caller-ref" or "provider"');
        }

        const checks = p.checks;
        if (!Array.isArray(checks) || checks.length === 0) return invalidParams("checks must be a non-empty array");
        if (checks.length > this._batchLimit) return invalidParams(`checks: at most ${this._batchLimit} per request; split the batch`);

        const decisions: unknown[] = [];
        for (const [index, raw] of checks.entries()) {
            if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return invalidParams(`checks[${index}] must be an object`);
            const check = raw as Record<string, unknown>;
            for (const key of Object.keys(check)) {
                if (key !== "capability" && key !== "resource" && key !== "resourcePath" && key !== "attributes") return invalidParams(`checks[${index}]: unknown key "${key}"`);
            }
            if (typeof check.capability !== "string" || check.capability.length === 0) return invalidParams(`checks[${index}].capability must be a non-empty string`);
            if (typeof check.resource !== "string" || check.resource.length === 0) return invalidParams(`checks[${index}].resource must be a non-empty string`);
            if (check.attributes !== undefined && (typeof check.attributes !== "object" || check.attributes === null || Array.isArray(check.attributes))) {
                return invalidParams(`checks[${index}].attributes must be an object`);
            }
            decisions.push(this._decide(check, subject, onBehalfOf, correlationId, declaration, origin.slot));
        }
        return { result: { policyVersion: this.policyVersion, decisions } };
    }

    /** One check, already well-formed, to one audited decision. */
    private _decide(
        check: Record<string, unknown>,
        subject: IAuthorizationSubject,
        onBehalfOf: "caller" | "provider",
        correlationId: string,
        declaration: IProviderDeclaration,
        slot: string
    ): unknown {
        const capability = check.capability as string;
        const nativeResource = check.resource as string;
        const decisionId = randomId("dec_");
        const policyVersion = this.policyVersion;

        let decision: IAuthorizationDecision;
        let resourcePath: ResourcePath | undefined;
        const parsed = parseProviderResourcePath(check.resourcePath, "resourcePath");
        if (!declaration.capabilities.has(capability)) {
            decision = { allowed: false, reason: "undeclared-capability" };
        } else if (typeof parsed === "string" || !isWithinNamespace(declaration.namespace, parsed)) {
            decision = { allowed: false, reason: "undeclared-resource" };
        } else if (declaration.resources.has(nativeResource) && declaration.resources.get(nativeResource)!.resourcePath.value !== parsed.value) {
            // The same native identifier under another path would escape the
            // limits declared for it.
            decision = { allowed: false, reason: "undeclared-resource" };
        } else if (!this._authorization) {
            resourcePath = parsed;
            decision = { allowed: false, reason: "no-policy" };
        } else {
            resourcePath = parsed;
            try {
                decision = this._authorization.engine.authorize({ subject, capability, resource: parsed, provider: slot });
            } catch (error) {
                console.error(`[broker] broker/authorize: policy evaluation threw for capability "${capability}" on "${parsed.value}": ${(error as Error).message}. Denied.`);
                decision = { allowed: false, reason: "evaluation-error" };
            }
        }

        const event: IAuthorizationAuditEvent = {
            timestamp: new Date().toISOString(),
            allowed: decision.allowed,
            subjectIds: subject.ids,
            slot,
            resource: resourcePath?.value ?? (typeof parsed === "string" ? undefined : parsed.value),
            capability,
            provider: slot,
            reason: decision.reason,
            matchedPolicies: decision.matchedPolicies,
            decisionId,
            correlationId,
            policyVersion,
            onBehalfOf,
            nativeResource,
            ...(check.attributes !== undefined ? { attributes: maskAttributes(check.attributes) as Record<string, unknown> } : {}),
        };
        writeAuthorizationAuditEvent(event);

        return {
            decisionId,
            effect: decision.allowed ? "allow" : "deny",
            allowed: decision.allowed,
            reason: decision.reason,
            ...(decision.matchedPolicies ? { policies: decision.matchedPolicies } : {}),
        };
    }

    // -------------------------------------------------------------------------
    // Introspection
    // -------------------------------------------------------------------------

    /** Live state for `broker_diagnose`. `policyCapabilities` are the capabilities the policy grants or denies. */
    info(policyCapabilities: ReadonlySet<string> = new Set()): IBrokerAuthorityInfo {
        const declaredBy = new Map<string, IProviderDeclaration>();
        for (const declaration of this._declarations.values()) for (const slot of declaration.protects) declaredBy.set(slot, declaration);

        const declaredCapabilities = new Set<string>();
        const domains = new Set<string>();
        for (const declaration of this._declarations.values()) {
            domains.add(declaration.domain);
            for (const capability of declaration.capabilities) declaredCapabilities.add(capability);
        }
        // A capability "looks domain-prefixed" when its first segment is not the
        // broker's own (`mcp`, `broker`): those are the ones a declaration must cover.
        const undeclared = [...policyCapabilities]
            .filter((c) => c !== "*" && !c.startsWith("mcp.") && !c.startsWith("broker.") && c.includes(".") && !declaredCapabilities.has(c))
            .sort();

        return {
            policyVersion: this.policyVersion,
            protectedSlots: Object.entries(this._protectedSlots).map(([slot, p]) => ({
                slot,
                declaredBy: p.declaredBy,
                publishedBy: p.publishedBy,
                confirmed: declaredBy.get(slot)?.principalId === p.declaredBy,
            })),
            declarations: [...this._declarations.values()].map((d) => ({
                principalId: d.principalId,
                domain: d.domain,
                version: d.version,
                policyVersion: d.policyVersion,
                acceptedAt: d.acceptedAt,
                capabilities: [...d.capabilities].sort(),
                resourceCount: d.resources.size,
                protects: d.protects,
            })),
            undeclaredCapabilities: undeclared,
            liveCallerRefs: this._refs.size,
        };
    }
}
