import type { ResourcePath } from "./resource.path";

export interface IAuthorizationSubject {
    readonly ids: readonly string[];
    readonly claims?: Readonly<Record<string, unknown>>;
}

export interface IAuthorizationRequest {
    readonly subject: IAuthorizationSubject;
    readonly capability: string;
    readonly resource: ResourcePath;
    readonly provider?: string;
    readonly tool?: string;
}

/**
 * Why a decision came out the way it did, as written to the audit log.
 *
 * The distinction between a policy outcome and a fault is load-bearing: the
 * audit log is what an operator actually reads, and reporting a fault as
 * `"no-matching-grant"` sends them off writing grants that can never help.
 *
 * - `explicit-deny`      a deny policy matched.
 * - `role-grant`         an assignment matched; the only allowing reason.
 * - `no-matching-grant`  no policy matched. A genuine policy outcome.
 * - `invalid-resource`   the request carried no resource at all.
 * - `unknown-resource`   the slot maps to no configured resource path.
 * - `invalid-capability` the requested capability string is malformed, so no
 *                        grant could ever match it. A configuration fault.
 * - `evaluation-error`   evaluation threw. Nothing was decided; the request is
 *                        denied because that is the safe answer. A fault.
 */
export type AuthorizationDecisionReason =
    | "explicit-deny"
    | "role-grant"
    | "no-matching-grant"
    | "invalid-resource"
    | "unknown-resource"
    | "invalid-capability"
    | "evaluation-error";

export interface IAuthorizationDecision {
    readonly allowed: boolean;
    readonly reason: AuthorizationDecisionReason;
    readonly matchedPolicies?: readonly string[];
}

export interface IPolicyEngine {
    authorize(request: IAuthorizationRequest): IAuthorizationDecision;
}

export interface IRoleDefinition {
    readonly inherits?: readonly string[];
    readonly capabilities: readonly string[];
}

export interface IPolicyAssignment {
    readonly id?: string;
    readonly subject: string;
    readonly role: string;
    readonly resource: string;
}

export interface IDenyPolicy {
    readonly id?: string;
    readonly subject: string;
    readonly effect?: "deny";
    readonly capabilities: readonly string[];
    readonly resource: string;
}

export interface ISubjectMappingConfig {
    readonly userClaim?: string;
    readonly groupClaims?: readonly string[];
    readonly clientClaim?: string;
    readonly serviceClaims?: readonly string[];
}

export interface IAuthorizationAuditConfig {
    readonly logAllowed?: boolean;
}

export interface IAuthorizationPolicyConfig {
    readonly roles?: Readonly<Record<string, IRoleDefinition>>;
    readonly assignments?: readonly IPolicyAssignment[];
    readonly denies?: readonly IDenyPolicy[];
    readonly subjectMapping?: ISubjectMappingConfig;
    readonly slotResources?: Readonly<Record<string, string>>;
    readonly toolCapabilities?: Readonly<Record<string, string>>;
    readonly providerToolCapabilities?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly audit?: IAuthorizationAuditConfig;
}

export interface IAuthorizationAuditEvent {
    readonly timestamp: string;
    readonly allowed: boolean;
    readonly subjectIds: readonly string[];
    readonly clientId?: string;
    readonly slot: string;
    readonly resource?: string;
    readonly capability?: string;
    readonly provider?: string;
    readonly tool?: string;
    readonly reason: AuthorizationDecisionReason;
    readonly matchedPolicies?: readonly string[];
}

/** @deprecated Use {@link IAuthorizationSubject}. */
export type AuthorizationSubject = IAuthorizationSubject;
/** @deprecated Use {@link IAuthorizationRequest}. */
export type AuthorizationRequest = IAuthorizationRequest;
/** @deprecated Use {@link IAuthorizationDecision}. */
export type AuthorizationDecision = IAuthorizationDecision;
/** @deprecated Use {@link IPolicyEngine}. */
export type PolicyEngine = IPolicyEngine;
/** @deprecated Use {@link IRoleDefinition}. */
export type RoleDefinition = IRoleDefinition;
/** @deprecated Use {@link IPolicyAssignment}. */
export type PolicyAssignment = IPolicyAssignment;
/** @deprecated Use {@link IDenyPolicy}. */
export type DenyPolicy = IDenyPolicy;
/** @deprecated Use {@link ISubjectMappingConfig}. */
export type SubjectMappingConfig = ISubjectMappingConfig;
/** @deprecated Use {@link IAuthorizationAuditConfig}. */
export type AuthorizationAuditConfig = IAuthorizationAuditConfig;
/** @deprecated Use {@link IAuthorizationPolicyConfig}. */
export type AuthorizationPolicyConfig = IAuthorizationPolicyConfig;
/** @deprecated Use {@link IAuthorizationAuditEvent}. */
export type AuthorizationAuditEvent = IAuthorizationAuditEvent;
