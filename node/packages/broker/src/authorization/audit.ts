import type { IAuthorizationAuditEvent, IAuthorizationDecision, IAuthorizationSubject } from "./policy.types";
import type { ResourcePath } from "./resource.path";

export interface IAuditContext {
    readonly subject: IAuthorizationSubject;
    readonly slot: string;
    readonly resource?: ResourcePath;
    readonly capability?: string;
    readonly provider?: string;
    readonly tool?: string;
}

export function makeAuthorizationAuditEvent(context: IAuditContext, decision: IAuthorizationDecision): IAuthorizationAuditEvent {
    const clientId = context.subject.ids.find((id) => id.startsWith("client:"))?.slice("client:".length);
    return {
        timestamp: new Date().toISOString(),
        allowed: decision.allowed,
        subjectIds: context.subject.ids,
        clientId,
        slot: context.slot,
        resource: context.resource?.value,
        capability: context.capability,
        provider: context.provider,
        tool: context.tool,
        reason: decision.reason,
        matchedPolicies: decision.matchedPolicies,
    };
}

export function writeAuthorizationAuditEvent(event: IAuthorizationAuditEvent): void {
    console.error(`[broker] authorization ${JSON.stringify(event)}`);
}

/** @deprecated Use {@link IAuditContext}. */
export type AuditContext = IAuditContext;
