import { ConfiguredCapabilityClassifier, type ICapabilityClassifier } from "./capability.classifier.js";
import { ConfigPolicyEngine } from "./policy.engine.js";
import type { IAuthorizationAuditConfig, IAuthorizationPolicyConfig, IPolicyEngine } from "./policy.types.js";
import { DefaultSlotResourceResolver, type ISlotResourceResolver } from "./slot.resource.js";
import { JwtSubjectMapper, type ISubjectMapper } from "./subject.mapper.js";

export interface IPolicyAuthorization {
    readonly engine: IPolicyEngine;
    readonly subjectMapper: ISubjectMapper;
    readonly slotResourceResolver: ISlotResourceResolver;
    readonly capabilityClassifier: ICapabilityClassifier;
    readonly audit: Readonly<Required<IAuthorizationAuditConfig>>;
}

export function hasAuthorizationPolicies(config: IAuthorizationPolicyConfig): boolean {
    return Object.keys(config.roles ?? {}).length > 0 || (config.assignments?.length ?? 0) > 0 || (config.denies?.length ?? 0) > 0;
}

/** Compiles and validates the complete hierarchical authorization runtime. */
export function compileAuthorizationPolicy(config: IAuthorizationPolicyConfig): IPolicyAuthorization {
    if (config.audit?.logAllowed !== undefined && typeof config.audit.logAllowed !== "boolean") {
        throw new Error("authorization audit.logAllowed must be a boolean.");
    }
    const engine = new ConfigPolicyEngine(config.roles ?? {}, config.assignments ?? [], config.denies ?? []);
    const subjectMapper = new JwtSubjectMapper(config.subjectMapping);
    const slotResourceResolver = new DefaultSlotResourceResolver(config.slotResources);
    const capabilityClassifier = new ConfiguredCapabilityClassifier(config.toolCapabilities, config.providerToolCapabilities);
    return {
        engine,
        subjectMapper,
        slotResourceResolver,
        capabilityClassifier,
        audit: Object.freeze({ logAllowed: config.audit?.logAllowed ?? false }),
    };
}

export function authorizationWithEngine(
    engine: IPolicyEngine,
    overrides: {
        readonly subjectMapper?: ISubjectMapper;
        readonly slotResourceResolver?: ISlotResourceResolver;
        readonly capabilityClassifier?: ICapabilityClassifier;
        readonly audit?: IAuthorizationAuditConfig;
    } = {}
): IPolicyAuthorization {
    return {
        engine,
        subjectMapper: overrides.subjectMapper ?? new JwtSubjectMapper(),
        slotResourceResolver: overrides.slotResourceResolver ?? new DefaultSlotResourceResolver(),
        capabilityClassifier: overrides.capabilityClassifier ?? new ConfiguredCapabilityClassifier(),
        audit: Object.freeze({ logAllowed: overrides.audit?.logAllowed ?? false }),
    };
}

/** @deprecated Use {@link IPolicyAuthorization}. */
export type PolicyAuthorization = IPolicyAuthorization;
