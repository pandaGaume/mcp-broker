import { ResourcePath } from "../authorization/resource.path";
import { DOMAIN_PATTERN, RESERVED_DOMAINS, namespacesOverlap, parseProviderResourcePath, type IConfiguredDomainOwner } from "./declaration";

/** One owner the security file assigns to a domain, compiled. */
export interface ICompiledDomainOwner {
    readonly owner: string;
    readonly namespace: ResourcePath;
}

/** `authorization.domains`, compiled: domain to its configured owners. */
export type ConfiguredDomains = ReadonlyMap<string, readonly ICompiledDomainOwner[]>;

/** The principal id the legacy shared secret yields: it names no one in particular. */
const SHARED_SECRET_PRINCIPAL = "shared-secret";

/**
 * Compiles `authorization.domains` from the security file, or lists every
 * problem. A listed domain may only be declared by the identities and on the
 * subtrees listed; two different owners of one domain must hold disjoint
 * subtrees, otherwise one resource would have two decision makers, and the
 * broker refuses to start.
 *
 * `knownPrincipals`, when given, are the provider ids of the providers table:
 * an owner outside it could never authenticate.
 */
export function compileConfiguredDomains(
    raw: Readonly<Record<string, readonly IConfiguredDomainOwner[]>> | undefined,
    knownPrincipals?: ReadonlySet<string>
): { readonly domains: ConfiguredDomains; readonly problems: readonly string[] } {
    const domains = new Map<string, ICompiledDomainOwner[]>();
    const problems: string[] = [];
    if (raw === undefined) return { domains, problems };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { domains, problems: ['"authorization.domains" must be an object keyed by domain'] };

    for (const [domain, entries] of Object.entries(raw)) {
        const label = `authorization.domains["${domain}"]`;
        if (!DOMAIN_PATTERN.test(domain)) {
            problems.push(`${label}: a domain is lowercase letters, digits and "-", starting with a letter`);
            continue;
        }
        if (RESERVED_DOMAINS.has(domain)) {
            problems.push(`${label}: "${domain}" is reserved for the broker's own capabilities`);
            continue;
        }
        if (!Array.isArray(entries) || entries.length === 0) {
            problems.push(`${label} must be a non-empty array of { "owner": "<provider id>", "namespace": "/<path>" }`);
            continue;
        }
        const owners: ICompiledDomainOwner[] = [];
        for (const [index, entry] of entries.entries()) {
            const at = `${label}[${index}]`;
            if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
                problems.push(`${at} must be { "owner": "<provider id>", "namespace": "/<path>" }`);
                continue;
            }
            for (const key of Object.keys(entry)) if (key !== "owner" && key !== "namespace") problems.push(`${at}: unknown key "${key}"`);
            const owner = (entry as { owner?: unknown }).owner;
            if (typeof owner !== "string" || owner.length === 0) {
                problems.push(`${at}.owner must name a provider principal`);
                continue;
            }
            if (owner === SHARED_SECRET_PRINCIPAL) {
                problems.push(`${at}.owner cannot be "shared-secret", which every holder of the legacy secret shares`);
                continue;
            }
            if (knownPrincipals && !knownPrincipals.has(owner)) problems.push(`${at}.owner "${owner}" is not in the providers table`);
            const namespace = parseProviderResourcePath((entry as { namespace?: unknown }).namespace, `${at}.namespace`);
            if (typeof namespace === "string") {
                problems.push(namespace);
                continue;
            }
            if (namespace.segments.length === 0) {
                problems.push(`${at}.namespace cannot be "/": give each owner the subtree it serves`);
                continue;
            }
            for (const other of owners) {
                if (other.owner !== owner && namespacesOverlap(other.namespace, namespace)) {
                    problems.push(
                        `${label}: "${namespace.value}" (${owner}) overlaps "${other.namespace.value}" (${other.owner}). Two owners of one domain need disjoint subtrees, or one resource would have two decision makers`
                    );
                }
            }
            owners.push({ owner, namespace });
        }
        domains.set(domain, owners);
    }
    return { domains, problems };
}
