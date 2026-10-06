import { compileResourceLimits, intersectLimits, type IResourceLimitRule, type LimitPatternIndex } from "./resource.limits";
import type { LimitController } from "../limits/controller";
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

/** A provider reports what happened after a decision (a notification). */
export const BROKER_AUDIT_RESULT_METHOD = "broker/audit/result";

/**
 * The `params._meta` key under which the broker hands a declaring provider a
 * reference to the caller of the request it is serving. Removed from every
 * client frame before anything else, so only the broker ever writes it.
 */
export const CALLER_META_KEY = "io.cyanmycelium/caller";

/**
 * The `params._meta` key under which the broker tells its own `_broker` tools
 * who is calling them (`{ subjects, policy }`), for the ones that act and must
 * audit their operator. Stripped from every client frame like the caller key.
 */
export const OPERATOR_META_KEY = "io.cyanmycelium/operator";

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
    /** W3C trace id propagated with the client request. */
    readonly traceId: string;
    /** `Date.now()` at issue; a reference older than the maximum age is refused. */
    readonly issuedAt: number;
}

/** A decision kept until its result is reported, or until it ages out. */
interface IDecisionRecord {
    readonly event: IAuthorizationAuditEvent;
    readonly providerPrincipalId: string;
    /** The provider promised a result for this one (`resultsRequired`). */
    readonly awaited: boolean;
    readonly issuedAt: number;
}

/** A decision whose result was promised and has not come. */
export interface IOverdueDecision {
    readonly decisionId: string;
    readonly slot: string;
    readonly capability?: string;
    readonly resource?: string;
    readonly correlationId?: string;
    readonly ageMs: number;
}

/** What `getAuthorityInfo` reports, for `broker_diagnose` and `broker_info`. */
export interface IBrokerAuthorityInfo {
    readonly resourceLimits?: readonly { id: string; pattern: string; where?: Readonly<Record<string, string>>; limits?: import("./declaration").IResourceLimits }[];
    readonly limitProblems?: readonly { slot: string; reason: "empty-limits" | "invalid-limit-pattern"; sources?: readonly string[]; errors?: readonly string[] }[];
    readonly limits?: ReturnType<LimitController["info"]>;
    readonly policyVersion: string;
    readonly protectedSlots: readonly { readonly slot: string; readonly declaredBy: string; readonly publishedBy: string; readonly confirmed: boolean }[];
    readonly declarations: readonly {
        readonly principalId: string;
        readonly slot: string;
        readonly domain: string;
        readonly version: string;
        readonly policyVersion: string;
        readonly acceptedAt: string;
        readonly capabilities: readonly string[];
        readonly resourceCount: number;
        readonly resourcePatterns?: readonly ReturnType<import("./resource.limits").LimitPattern["info"]>[];
        readonly protects: readonly string[];
    }[];
    /** Domain-prefixed capabilities the policy grants that no accepted declaration covers. */
    readonly undeclaredCapabilities: readonly string[];
    readonly liveCallerRefs: number;
    /** `broker/audit/result` bookkeeping. */
    readonly results: {
        readonly resultTimeoutMs: number;
        /** Results received and linked to their decision. */
        readonly reported: number;
        /** Results naming no decision this broker still holds for that provider. */
        readonly unmatched: number;
        /** Decisions dropped from tracking before any result: too old, or past the tracking bound. */
        readonly expired: number;
        /** Promised results still awaited, overdue or not. */
        readonly awaited: number;
        /** The oldest overdue ones, at most 20. */
        readonly overdue: readonly IOverdueDecision[];
    };
}

export interface IBrokerAuthorityOptions {
    readonly resourceLimits?: readonly IResourceLimitRule[];
    readonly protectedSlots?: Readonly<Record<string, IProtectedSlot>>;
    readonly slotResources: ISlotResourceResolver;
    readonly authorization: IPolicyAuthorization | null;
    /** Identifies the security configuration the broker started with (a hash of the security file). */
    readonly securityVersion?: string;
    readonly authorizeBatchLimit?: number;
    /** Provider principals known from configuration, for the subjects of a protected slot's declarer. */
    readonly knownPrincipals?: readonly IProviderPrincipal[];
    /** Longest a caller reference stays usable, even while its request is pending. @default 600000 */
    readonly callerRefMaxAgeMs?: number;
    /** A promised `broker/audit/result` not received within this delay is reported as overdue. @default 60000 */
    readonly resultTimeoutMs?: number;
    /** How long a decision is kept to receive its result. @default 600000 */
    readonly decisionRetentionMs?: number;
    /** Upper bound on decisions kept for their result; the oldest go first. @default 10000 */
    readonly maxTrackedDecisions?: number;
}

/** What a client may send as `X-Correlation-Id` and see reused in the audit. Anything else is replaced. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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
 * - **Declarations**, keyed by provider principal and slot. A declaration describes
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
    private readonly _resourceLimits: LimitPatternIndex;
    private readonly _limitProblems: { slot: string; reason: "empty-limits" | "invalid-limit-pattern"; sources?: readonly string[]; errors?: readonly string[] }[] = [];
    private readonly _protectedSlots: Readonly<Record<string, IProtectedSlot>>;
    private readonly _slotResources: ISlotResourceResolver;
    private readonly _authorization: IPolicyAuthorization | null;
    private readonly _securityVersion: string;
    private readonly _batchLimit: number;
    private readonly _refMaxAgeMs: number;
    private readonly _resultTimeoutMs: number;
    private readonly _decisionRetentionMs: number;
    private readonly _maxTrackedDecisions: number;
    private readonly _decisionRecords = new Map<string, IDecisionRecord>();
    private readonly _unmatchedResultWarned = new Set<string>();
    private _resultsReported = 0;
    private _resultsUnmatched = 0;
    private _decisionsExpired = 0;

    private readonly _declarations = new Map<string, Map<string, IProviderDeclaration>>();
    private readonly _domainOwners = new Map<string, string>();
    private readonly _refs = new Map<string, ICallerRef>();
    private readonly _principals = new Map<string, IProviderPrincipal>();
    private _declarationCount = 0;

    constructor(options: IBrokerAuthorityOptions) {
        this._resourceLimits = compileResourceLimits(options.resourceLimits);
        this._protectedSlots = Object.freeze({ ...(options.protectedSlots ?? {}) });
        this._slotResources = options.slotResources;
        this._authorization = options.authorization;
        this._securityVersion = options.securityVersion ?? "config";
        this._batchLimit = Math.max(1, options.authorizeBatchLimit ?? DEFAULT_AUTHORIZE_BATCH_LIMIT);
        this._refMaxAgeMs = Math.max(1, options.callerRefMaxAgeMs ?? 600_000);
        this._resultTimeoutMs = Math.max(1, options.resultTimeoutMs ?? 60_000);
        this._decisionRetentionMs = Math.max(this._resultTimeoutMs, options.decisionRetentionMs ?? 600_000);
        this._maxTrackedDecisions = Math.max(1, options.maxTrackedDecisions ?? 10_000);
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

    /** The accepted declaration on this slot. Without a slot, only an unambiguous single declaration is returned. */
    declarationOf(principalId: string | undefined | null, slot?: string): IProviderDeclaration | undefined {
        const declarations = principalId ? this._declarations.get(principalId) : undefined;
        if (slot !== undefined) return declarations?.get(slot);
        return declarations?.size === 1 ? declarations.values().next().value : undefined;
    }

    /** Handles `broker/authorization/declare`. */
    declare(params: unknown, origin: IBrokerMethodOrigin): BrokerMethodOutcome {
        const policyVersion = `${this._securityVersion}.${this._declarationCount + 1}`;
        const outcome = validateDeclaration(
            params,
            {
                principal: origin.principal,
                slot: origin.slot,
                protectedSlots: this._protectedSlots,
                slotResources: this._slotResources,
                domainOwner: (domain) => this._domainOwners.get(domain),
            },
            policyVersion
        );
        if (!outcome.ok) {
            if (outcome.errors.some((e) => e.includes("RE2"))) this._noteLimitProblem({ slot: origin.slot, reason: "invalid-limit-pattern", errors: outcome.errors });
            console.warn(
                `[broker] authorization declaration from slot "${origin.slot}" (principal "${origin.principal?.id ?? "(anonymous)"}") refused: ${outcome.errors.join("; ")}`
            );
            return invalidParams(`Declaration refused: ${outcome.errors.length} problem(s). Nothing changed; the previous declaration, if any, stays in force.`, {
                errors: outcome.errors,
            });
        }
        const declaration = outcome.declaration;
        if (origin.principal) this.notePrincipal(origin.principal);
        let declarations = this._declarations.get(declaration.principalId);
        if (!declarations) {
            declarations = new Map();
            this._declarations.set(declaration.principalId, declarations);
        }
        declarations.set(origin.slot, declaration);
        this._domainOwners.set(declaration.domain, declaration.principalId);
        this._declarationCount += 1;
        console.info(
            `[broker] authorization declaration accepted: principal "${declaration.principalId}", slot "${declaration.slot}", domain "${declaration.domain}", version "${declaration.version}", ` +
                `${declaration.capabilities.size} capabilities, ${declaration.resources.size} resources, protects [${declaration.protects.join(", ")}], policyVersion ${declaration.policyVersion}`
        );
        return { result: { accepted: true, version: declaration.version, policyVersion: declaration.policyVersion } };
    }

    // -------------------------------------------------------------------------
    // Caller references
    // -------------------------------------------------------------------------

    /** Issues a reference to the caller of one pending request. */
    issueRef(
        slot: string,
        brokerId: string,
        providerPrincipalId: string,
        subject: IAuthorizationSubject,
        traceId: string,
        clientCorrelationId?: string
    ): { readonly ref: string; readonly correlationId: string; readonly traceId: string } {
        const ref = randomId("cr_");
        // The client's own id when it sent a usable one (`X-Correlation-Id`),
        // so its logs and the broker audit share a key; otherwise the broker's.
        const correlationId = clientCorrelationId !== undefined && CORRELATION_ID_PATTERN.test(clientCorrelationId) ? clientCorrelationId : randomId("corr_", 9);
        this._refs.set(ref, { slot, brokerId, providerPrincipalId, subject, correlationId, traceId, issuedAt: Date.now() });
        return { ref, correlationId, traceId };
    }

    /** Forgets a reference; its request was answered or abandoned. */
    releaseRef(ref: string | undefined): void {
        if (ref) this._refs.delete(ref);
    }

    /** Drops every reference whose request is no longer pending. */
    sweepRefs(isPending: (slot: string, brokerId: string) => boolean): void {
        const oldest = Date.now() - this._refMaxAgeMs;
        for (const [ref, entry] of this._refs) if (entry.issuedAt < oldest || !isPending(entry.slot, entry.brokerId)) this._refs.delete(ref);
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
    authorize(params: unknown, origin: IBrokerMethodOrigin, isPending: (slot: string, brokerId: string) => boolean, trackResult = true): BrokerMethodOutcome {
        const principal = origin.principal;
        const declaration = this.declarationOf(principal?.id, origin.slot);
        if (!principal || !declaration) {
            return { error: { code: -32003, message: "No accepted authorization declaration for this provider: send broker/authorization/declare first." } };
        }
        if (typeof params !== "object" || params === null || Array.isArray(params)) return invalidParams("params must be an object");
        const p = params as Record<string, unknown>;
        for (const key of Object.keys(p)) if (key !== "principal" && key !== "correlationId" && key !== "traceId" && key !== "checks") return invalidParams(`unknown key "${key}"`);

        // On whose behalf. Two forms, nothing else, and never an identity.
        const asked = p.principal;
        if (typeof asked !== "object" || asked === null || Array.isArray(asked))
            return invalidParams('principal must be { "type": "caller-ref", "ref": "..." } or { "type": "provider" }');
        const a = asked as Record<string, unknown>;
        let subject: IAuthorizationSubject;
        let onBehalfOf: "caller" | "provider";
        let correlationId: string;
        let traceId: string | undefined;
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
            if (entry.issuedAt < Date.now() - this._refMaxAgeMs || !isPending(entry.slot, entry.brokerId)) {
                this._refs.delete(a.ref);
                return invalidParams("principal.ref has expired: the request it came with was already answered or abandoned.");
            }
            subject = entry.subject;
            onBehalfOf = "caller";
            correlationId = entry.correlationId;
            traceId = entry.traceId;
        } else if (a.type === "provider") {
            if (Object.keys(a).some((key) => key !== "type")) return invalidParams('principal of type "provider" carries nothing else');
            subject = { ids: [...(principal.subjects ?? [])] };
            onBehalfOf = "provider";
            correlationId = typeof p.correlationId === "string" && p.correlationId.length > 0 && p.correlationId.length <= 128 ? p.correlationId : randomId("corr_", 9);
            traceId = typeof p.traceId === "string" && /^[0-9a-f]{32}$/.test(p.traceId) && !/^0+$/.test(p.traceId) ? p.traceId : undefined;
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
            decisions.push(this._decide(check, subject, onBehalfOf, correlationId, traceId, declaration, origin.slot, trackResult));
        }
        return { result: { policyVersion: this.policyVersion, decisions } };
    }

    /** Reuses the caller-reference and declared authorization checks before reserving. */
    reserveBudget(params: unknown, origin: IBrokerMethodOrigin, isPending: (slot: string, id: string) => boolean, limits: LimitController): BrokerMethodOutcome {
        if (typeof params !== "object" || params === null || Array.isArray(params)) return invalidParams("budget params must be an object");
        const p = params as Record<string, unknown>;
        if (Object.keys(p).some((k) => !["principal", "capability", "resource", "resourcePath", "unit", "quantity", "idempotencyKey"].includes(k)))
            return invalidParams("unknown budget key");
        if (
            typeof p.idempotencyKey !== "string" ||
            !/^[A-Za-z0-9._:-]{1,128}$/.test(p.idempotencyKey) ||
            !Number.isSafeInteger(p.quantity) ||
            (p.quantity as number) <= 0 ||
            typeof p.unit !== "string"
        )
            return invalidParams("invalid budget quantity, unit or idempotencyKey");
        const asked = p.principal as { type?: string; ref?: string } | undefined;
        if (asked?.type !== "caller-ref") return invalidParams("budget reservations require a live caller-ref");
        const answer = this.authorize(
            { principal: p.principal, checks: [{ capability: p.capability, resource: p.resource, resourcePath: p.resourcePath }] },
            origin,
            isPending,
            false
        );
        if ("error" in answer) return answer;
        const decision = (answer.result as { decisions: { allowed: boolean; effect: string; decisionId: string; reason: string; obligations?: unknown }[] }).decisions[0]!;
        // A reservation is a debit, not a wider permission: an allow that comes
        // with engineering constraints reserves like any allow, and the
        // constraints travel with the grant for the provider to apply. Only a
        // deny refuses. `allowed` alone would refuse every resource that has
        // declared limits, which are the physical ones a budget exists for.
        if (decision.effect !== "allow" && decision.effect !== "allow-with-constraints")
            return { error: { code: -32003, message: "Budget authorization refused", data: decision } };
        const declaration = this.declarationOf(origin.principal!.id, origin.slot)!;
        if (!declaration.budgetUnits.includes(p.unit)) return invalidParams("unit not declared by this provider");
        const caller = this._refs.get(asked.ref!)!;
        const result = limits.reserve(
            {
                subjects: caller.subject.ids,
                provider: origin.slot,
                providerId: origin.principal!.id,
                requestId: caller.brokerId,
                correlationId: caller.correlationId,
                capability: p.capability as string,
                resource: p.resourcePath as string,
            },
            p.unit,
            p.quantity as number,
            p.idempotencyKey,
            decision.decisionId
        );
        if (!result.allowed) return { error: { code: -32029, message: "Budget reservation refused", data: result.error } };
        return { result: { ...result.value, effect: decision.effect, ...(decision.obligations ? { obligations: decision.obligations } : {}) } };
    }

    settleBudget(params: unknown, origin: IBrokerMethodOrigin, limits: LimitController): BrokerMethodOutcome {
        if (!origin.principal) return { error: { code: -32003, message: "Provider identity required" } };
        if (typeof params !== "object" || params === null || Array.isArray(params)) return invalidParams("settlement must be an object");
        const p = params as Record<string, unknown>;
        if (
            Object.keys(p).some((k) => !["reservationId", "used", "result"].includes(k)) ||
            typeof p.reservationId !== "string" ||
            !["success", "failure", "refused"].includes(p.result as string)
        )
            return invalidParams("invalid settlement");
        const result = limits.settle(origin.principal.id, origin.slot, p.reservationId, p.used as number, p.result as string);
        return result.allowed ? { result: result.value } : { error: { code: -32029, message: "Budget settlement refused", data: result.error } };
    }

    /** One check, already well-formed, to one audited decision. */
    private _decide(
        check: Record<string, unknown>,
        subject: IAuthorizationSubject,
        onBehalfOf: "caller" | "provider",
        correlationId: string,
        traceId: string | undefined,
        declaration: IProviderDeclaration,
        slot: string,
        trackResult: boolean
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

        // Engineering limits declared on the resource travel with every allow.
        // The provider applies them; `allowed` stays true only for an
        // unconditional allow, so a provider that reads `allowed` alone and
        // ignores obligations refuses rather than oversteps.
        const entries: { limits: import("./declaration").IResourceLimits; source: string }[] = [];
        if (decision.allowed && resourcePath) {
            const concrete = declaration.resources.get(nativeResource);
            if (concrete?.limits) entries.push({ limits: concrete.limits, source: `declaration:${nativeResource}` });
            for (const pattern of [...declaration.resourcePatterns.matching(resourcePath), ...this._resourceLimits.matching(resourcePath)])
                entries.push({ limits: pattern.limits!, source: pattern.source });
        }
        const intersection = intersectLimits(entries);
        if (decision.allowed && intersection.empty) {
            decision = { allowed: false, reason: "empty-limits", matchedPolicies: decision.matchedPolicies };
            this._noteLimitProblem({ slot, reason: "empty-limits", sources: intersection.sources });
        }
        const limits = decision.allowed ? intersection.limits : undefined;
        const effect: "allow" | "deny" | "allow-with-constraints" = !decision.allowed ? "deny" : limits ? "allow-with-constraints" : "allow";
        const obligations = limits ? { constraints: limits } : undefined;

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
            ...(traceId ? { traceId } : {}),
            policyVersion,
            onBehalfOf,
            nativeResource,
            domain: declaration.domain,
            ...(intersection.sources.length ? { limitSources: intersection.sources } : {}),
            ...(check.attributes !== undefined ? { attributes: maskAttributes(check.attributes) as Record<string, unknown> } : {}),
            phase: "decision",
            effect,
            ...(obligations ? { obligations } : {}),
        };
        writeAuthorizationAuditEvent(event);
        // Reservations track their outcome through the budget ledger and settlement.
        if (trackResult) this._trackDecision(event, declaration, decision.allowed && declaration.resultsRequired.has(capability));

        return {
            decisionId,
            effect,
            allowed: effect === "allow",
            reason: decision.reason,
            ...(decision.matchedPolicies ? { policies: decision.matchedPolicies } : {}),
            ...(obligations ? { obligations } : {}),
        };
    }

    // -------------------------------------------------------------------------
    // broker/audit/result
    // -------------------------------------------------------------------------

    /** Keeps a decision so its result can be linked to it. Bounded in age and count. */
    private _trackDecision(event: IAuthorizationAuditEvent, declaration: IProviderDeclaration, awaited: boolean): void {
        this._expireDecisions();
        while (this._decisionRecords.size >= this._maxTrackedDecisions) {
            const oldest = this._decisionRecords.keys().next().value as string;
            this._decisionRecords.delete(oldest);
            this._decisionsExpired += 1;
        }
        this._decisionRecords.set(event.decisionId!, { event, providerPrincipalId: declaration.principalId, awaited, issuedAt: Date.now() });
    }

    private _expireDecisions(): void {
        const oldest = Date.now() - this._decisionRetentionMs;
        // Insertion order is issue order: stop at the first one still young.
        for (const [id, record] of this._decisionRecords) {
            if (record.issuedAt >= oldest) break;
            this._decisionRecords.delete(id);
            this._decisionsExpired += 1;
        }
    }

    /**
     * Handles the `broker/audit/result` notification: links what the provider
     * says happened to the decision the broker made, in the same audit stream.
     *
     * A notification gets no answer, so a malformed or unmatched report is
     * counted and logged once per slot, never answered. A provider can only
     * report on decisions it was given: another provider's `decisionId` is
     * unmatched, exactly like a made-up one.
     */
    recordResult(params: unknown, origin: IBrokerMethodOrigin): void {
        const unmatched = (why: string): void => {
            this._resultsUnmatched += 1;
            if (this._unmatchedResultWarned.has(origin.slot)) return;
            this._unmatchedResultWarned.add(origin.slot);
            console.warn(`[broker] ${BROKER_AUDIT_RESULT_METHOD} from slot "${origin.slot}" ignored: ${why}. Further ones from this slot are counted, not logged.`);
        };
        if (typeof params !== "object" || params === null || Array.isArray(params)) return unmatched("params must be an object");
        const p = params as Record<string, unknown>;
        for (const key of Object.keys(p)) {
            if (key !== "decisionId" && key !== "result" && key !== "nativeStatus" && key !== "errorCode") return unmatched(`unknown key "${key}"`);
        }
        if (p.result !== "success" && p.result !== "failure" && p.result !== "refused") return unmatched('result must be "success", "failure" or "refused"');
        for (const key of ["nativeStatus", "errorCode"] as const) {
            const value = p[key];
            if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 256)) {
                return unmatched(`${key} must be a non-empty string of at most 256 characters`);
            }
        }
        this._expireDecisions();
        const record = typeof p.decisionId === "string" ? this._decisionRecords.get(p.decisionId) : undefined;
        if (!record || !origin.principal || record.providerPrincipalId !== origin.principal.id || record.event.slot !== origin.slot) {
            return unmatched("decisionId names no decision this broker still holds for this provider");
        }
        // One result per decision: a second report would rewrite history.
        this._decisionRecords.delete(p.decisionId as string);
        this._resultsReported += 1;
        writeAuthorizationAuditEvent({
            ...record.event,
            timestamp: new Date().toISOString(),
            phase: "result",
            result: p.result,
            ...(typeof p.nativeStatus === "string" ? { nativeStatus: p.nativeStatus } : {}),
            ...(typeof p.errorCode === "string" ? { errorCode: p.errorCode } : {}),
        });
    }

    // -------------------------------------------------------------------------
    // Introspection
    // -------------------------------------------------------------------------

    /** Live state for `broker_diagnose`. `policyCapabilities` are the capabilities the policy grants or denies. */
    info(policyCapabilities: ReadonlySet<string> = new Set()): IBrokerAuthorityInfo {
        const declarations = [...this._declarations.values()].flatMap((slots) => [...slots.values()]);
        const declaredBy = new Map<string, IProviderDeclaration>();
        for (const declaration of declarations) for (const slot of declaration.protects) declaredBy.set(slot, declaration);

        const declaredCapabilities = new Set<string>();
        const domains = new Set<string>();
        for (const declaration of declarations) {
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
            resourceLimits: this._resourceLimits.patterns.map((p) => ({ id: p.source.slice(9), ...p.info() })),
            limitProblems: [...this._limitProblems],
            protectedSlots: Object.entries(this._protectedSlots).map(([slot, p]) => ({
                slot,
                declaredBy: p.declaredBy,
                publishedBy: p.publishedBy,
                confirmed: declaredBy.get(slot)?.principalId === p.declaredBy,
            })),
            declarations: declarations.map((d) => ({
                principalId: d.principalId,
                slot: d.slot,
                domain: d.domain,
                version: d.version,
                policyVersion: d.policyVersion,
                acceptedAt: d.acceptedAt,
                capabilities: [...d.capabilities].sort(),
                resourceCount: d.resources.size,
                resourcePatterns: d.resourcePatterns.patterns.map((p) => p.info()),
                protects: d.protects,
            })),
            undeclaredCapabilities: undeclared,
            liveCallerRefs: this._refs.size,
            results: this._resultsInfo(),
        };
    }

    private _noteLimitProblem(problem: { slot: string; reason: "empty-limits" | "invalid-limit-pattern"; sources?: readonly string[]; errors?: readonly string[] }): void {
        this._limitProblems.push(problem);
        if (this._limitProblems.length > 20) this._limitProblems.shift();
    }

    private _resultsInfo(): IBrokerAuthorityInfo["results"] {
        this._expireDecisions();
        const now = Date.now();
        let awaited = 0;
        const overdue: IOverdueDecision[] = [];
        for (const [decisionId, record] of this._decisionRecords) {
            if (!record.awaited) continue;
            awaited += 1;
            const ageMs = now - record.issuedAt;
            if (ageMs > this._resultTimeoutMs && overdue.length < 20) {
                overdue.push({
                    decisionId,
                    slot: record.event.slot,
                    ...(record.event.capability ? { capability: record.event.capability } : {}),
                    ...(record.event.resource ? { resource: record.event.resource } : {}),
                    ...(record.event.correlationId ? { correlationId: record.event.correlationId } : {}),
                    ageMs,
                });
            }
        }
        return {
            resultTimeoutMs: this._resultTimeoutMs,
            reported: this._resultsReported,
            unmatched: this._resultsUnmatched,
            expired: this._decisionsExpired,
            awaited,
            overdue,
        };
    }
}
