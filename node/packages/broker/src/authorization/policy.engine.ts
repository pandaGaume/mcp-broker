import { validateCapability } from "./capability.classifier";
import type { IAuthorizationDecision, IAuthorizationRequest, IDenyPolicy, IPolicyAssignment, IPolicyEngine, IRoleDefinition } from "./policy.types";
import { ResourcePathPattern } from "./resource.path";

interface ICompiledAssignment {
    readonly id: string;
    readonly subject: string;
    readonly capabilities: ReadonlySet<string>;
    readonly resource: ResourcePathPattern;
}

interface ICompiledDeny {
    readonly id: string;
    readonly subject: string;
    readonly capabilities: ReadonlySet<string>;
    readonly resource: ResourcePathPattern;
}

function validateName(value: string, label: string): void {
    if (typeof value !== "string" || !value || value.trim() !== value || value.includes("/")) {
        throw new Error(`authorization ${label}: "${value}" is invalid.`);
    }
}

function validateSubject(subject: string, label: string): void {
    if (typeof subject !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*:.+$/.test(subject)) {
        throw new Error(`authorization ${label}: subject "${subject}" must use a non-empty extensible prefix such as "user:alice".`);
    }
}

function validatePolicyId(id: string, label: string): void {
    if (typeof id !== "string" || !id || id.trim() !== id) {
        throw new Error(`authorization ${label}: policy ids must be non-empty and must not contain surrounding whitespace.`);
    }
}

function expandRoles(roles: Readonly<Record<string, IRoleDefinition>>): ReadonlyMap<string, ReadonlySet<string>> {
    const expanded = new Map<string, ReadonlySet<string>>();
    const visiting: string[] = [];

    for (const [name, role] of Object.entries(roles)) {
        validateName(name, "role");
        for (const key of Object.keys(role)) {
            if (key !== "inherits" && key !== "capabilities") {
                throw new Error(`authorization role "${name}": unsupported field "${key}"; roles contain capabilities, not resource paths.`);
            }
        }
        if (!Array.isArray(role.capabilities)) {
            throw new Error(`authorization role "${name}": capabilities must be an array.`);
        }
        if (role.inherits !== undefined && !Array.isArray(role.inherits)) {
            throw new Error(`authorization role "${name}": inherits must be an array.`);
        }
        for (const capability of role.capabilities) validateCapability(capability, `role "${name}" capability`);
        for (const inherited of role.inherits ?? []) {
            validateName(inherited, `role "${name}" inheritance`);
            if (!roles[inherited]) {
                throw new Error(`authorization role "${name}": inherited role "${inherited}" is not defined.`);
            }
        }
    }

    const visit = (name: string): ReadonlySet<string> => {
        const cached = expanded.get(name);
        if (cached) return cached;

        const cycleStart = visiting.indexOf(name);
        if (cycleStart >= 0) {
            const cycle = [...visiting.slice(cycleStart), name].join(" -> ");
            throw new Error(`authorization roles: inheritance cycle detected: ${cycle}.`);
        }

        const role = roles[name];
        if (!role) throw new Error(`authorization roles: role "${name}" is not defined.`);
        visiting.push(name);
        const capabilities = new Set<string>();
        for (const inherited of role.inherits ?? []) {
            for (const capability of visit(inherited)) capabilities.add(capability);
        }
        for (const capability of role.capabilities) capabilities.add(capability);
        visiting.pop();
        const frozen = Object.freeze(capabilities);
        expanded.set(name, frozen);
        return frozen;
    };

    for (const name of Object.keys(roles)) visit(name);
    return expanded;
}

function indexBySubject<T extends { readonly subject: string }>(entries: readonly T[]): ReadonlyMap<string, readonly T[]> {
    const mutable = new Map<string, T[]>();
    for (const entry of entries) {
        const bucket = mutable.get(entry.subject);
        if (bucket) bucket.push(entry);
        else mutable.set(entry.subject, [entry]);
    }
    const result = new Map<string, readonly T[]>();
    for (const [subject, bucket] of mutable) result.set(subject, Object.freeze(bucket));
    return result;
}

function grants(capabilities: ReadonlySet<string>, requested: string): boolean {
    return capabilities.has("*") || capabilities.has(requested);
}

/**
 * Immutable, indexed in-memory policy engine. Role inheritance and resource
 * expressions are fully compiled in the constructor.
 */
export class ConfigPolicyEngine implements IPolicyEngine {
    private readonly _assignmentsBySubject: ReadonlyMap<string, readonly ICompiledAssignment[]>;
    private readonly _deniesBySubject: ReadonlyMap<string, readonly ICompiledDeny[]>;

    constructor(roles: Readonly<Record<string, IRoleDefinition>>, assignments: readonly IPolicyAssignment[], denies: readonly IDenyPolicy[]) {
        const expandedRoles = expandRoles(roles);
        const policyIds = new Set<string>();

        const reserveId = (id: string, label: string): void => {
            validatePolicyId(id, label);
            if (policyIds.has(id)) throw new Error(`authorization policies: duplicate policy id "${id}".`);
            policyIds.add(id);
        };

        const compiledAssignments = assignments.map((assignment, index): ICompiledAssignment => {
            const id = assignment.id ?? `assignment:${index}`;
            reserveId(id, `assignment ${index}`);
            validateSubject(assignment.subject, `assignment "${id}"`);
            validateName(assignment.role, `assignment "${id}" role`);
            const capabilities = expandedRoles.get(assignment.role);
            if (!capabilities) {
                throw new Error(`authorization assignment "${id}": role "${assignment.role}" is not defined.`);
            }
            if (!assignment.resource) throw new Error(`authorization assignment "${id}": resource must not be empty.`);
            return {
                id,
                subject: assignment.subject,
                capabilities,
                resource: ResourcePathPattern.parse(assignment.resource),
            };
        });

        const compiledDenies = denies.map((deny, index): ICompiledDeny => {
            const id = deny.id ?? `deny:${index}`;
            reserveId(id, `deny ${index}`);
            validateSubject(deny.subject, `deny "${id}"`);
            if (deny.effect !== undefined && deny.effect !== "deny") {
                throw new Error(`authorization deny "${id}": effect must be "deny".`);
            }
            if (!Array.isArray(deny.capabilities) || deny.capabilities.length === 0) {
                throw new Error(`authorization deny "${id}": at least one capability is required.`);
            }
            const capabilities = new Set<string>();
            for (const capability of deny.capabilities) {
                validateCapability(capability, `deny "${id}" capability`);
                capabilities.add(capability);
            }
            if (!deny.resource) throw new Error(`authorization deny "${id}": resource must not be empty.`);
            return {
                id,
                subject: deny.subject,
                capabilities: Object.freeze(capabilities),
                resource: ResourcePathPattern.parse(deny.resource),
            };
        });

        this._assignmentsBySubject = indexBySubject(compiledAssignments);
        this._deniesBySubject = indexBySubject(compiledDenies);
    }

    authorize(request: IAuthorizationRequest): IAuthorizationDecision {
        if (!request.resource) return { allowed: false, reason: "invalid-resource" };
        try {
            validateCapability(request.capability, "request capability");
        } catch {
            return { allowed: false, reason: "no-matching-grant" };
        }

        const matchingDenies = new Set<string>();
        for (const subject of request.subject.ids) {
            for (const deny of this._deniesBySubject.get(subject) ?? []) {
                if (deny.resource.matches(request.resource) && grants(deny.capabilities, request.capability)) {
                    matchingDenies.add(deny.id);
                }
            }
        }
        if (matchingDenies.size > 0) {
            return {
                allowed: false,
                reason: "explicit-deny",
                matchedPolicies: Object.freeze([...matchingDenies].sort()),
            };
        }

        const matchingGrants = new Set<string>();
        for (const subject of request.subject.ids) {
            for (const assignment of this._assignmentsBySubject.get(subject) ?? []) {
                if (assignment.resource.matches(request.resource) && grants(assignment.capabilities, request.capability)) {
                    matchingGrants.add(assignment.id);
                }
            }
        }
        if (matchingGrants.size > 0) {
            return {
                allowed: true,
                reason: "role-grant",
                matchedPolicies: Object.freeze([...matchingGrants].sort()),
            };
        }
        return { allowed: false, reason: "no-matching-grant" };
    }
}
