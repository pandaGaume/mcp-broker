import { RE2JS } from "re2js";
import { ResourcePath, ResourcePathPattern } from "../authorization/resource.path";
import { parseLimits, type IResourceLimits } from "./declaration";

export interface IResourceLimitRule {
    readonly id: string;
    readonly pattern: string;
    readonly where?: Readonly<Record<string, string>>;
    readonly limits: IResourceLimits;
}

/** Compiles operator-supplied regexes without V8 backtracking. */
export function compileRegex(pattern: string, flags = ""): RE2JS {
    if (typeof pattern !== "string" || typeof flags !== "string" || new Set(flags).size !== flags.length) throw new Error("RE2 requires a string pattern and unique flags");
    let options = 0;
    for (const flag of flags) {
        if (flag === "i") options |= RE2JS.CASE_INSENSITIVE;
        else if (flag === "m") options |= RE2JS.MULTILINE;
        else if (flag === "s") options |= RE2JS.DOTALL;
        else if (flag !== "u" && flag !== "g" && flag !== "y") throw new Error(`Unsupported RE2 flag "${flag}"`);
    }
    try {
        return RE2JS.compile(flags.includes("y") ? `\\A(?:${pattern})` : pattern, options);
    } catch (error) {
        throw new Error(`RE2 refused expression ${JSON.stringify(pattern)}: ${(error as Error).message}`);
    }
}

export class LimitPattern {
    readonly segments: readonly string[];
    readonly prefix: readonly string[];
    private readonly _where = new Map<number, RE2JS>();

    constructor(
        readonly pattern: string,
        readonly limits: IResourceLimits | undefined,
        readonly source: string,
        readonly where?: Readonly<Record<string, string>>
    ) {
        if (typeof pattern !== "string" || pattern.length > 2048) throw new Error("resourcePattern must be a path of at most 2048 characters");
        this.segments = ResourcePathPattern.parse(pattern).segments;
        const names = new Map<string, number>();
        let prefixLength = this.segments.length;
        for (const [index, segment] of this.segments.entries()) {
            if (segment.toLowerCase().includes("%2f")) throw new Error("resourcePattern contains an encoded slash");
            if (segment.startsWith("{") && segment.endsWith("}")) {
                const name = segment.slice(1, -1);
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) throw new Error(`Invalid or repeated named segment ${segment}`);
                names.set(name, index);
                prefixLength = Math.min(prefixLength, index);
            } else if (segment.includes("{") || segment.includes("}")) throw new Error(`Invalid named segment ${segment}`);
            else if (segment === "*" || segment === "**") prefixLength = Math.min(prefixLength, index);
        }
        this.prefix = this.segments.slice(0, prefixLength);
        if (where !== undefined) {
            if (typeof where !== "object" || where === null || Array.isArray(where)) throw new Error("where must be an object of named segment RE2 expressions");
            for (const [name, expression] of Object.entries(where)) {
                const index = names.get(name);
                if (index === undefined || typeof expression !== "string" || expression.length > 2048)
                    throw new Error(`where.${name} must name a segment and contain an RE2 expression of at most 2048 characters`);
                this._where.set(index, compileRegex(expression));
            }
            this.where = Object.freeze({ ...where });
        }
    }

    matches(path: ResourcePath): boolean {
        for (const [index, segment] of this.segments.entries()) {
            if (segment === "**") return true;
            const target = path.segments[index];
            if (target === undefined) return false;
            if (segment === "*" || segment.startsWith("{")) {
                if (this._where.has(index) && !this._where.get(index)!.matcher(target).matches()) return false;
            } else if (segment !== target) return false;
        }
        return this.segments.length === path.segments.length;
    }

    /** A declaration cannot describe paths outside its publisher's configured subtree. */
    isCoveredBy(allowedResources: readonly string[]): boolean {
        return allowedResources.some((value) => {
            const allowed = ResourcePathPattern.parse(value).segments;
            for (const [index, segment] of allowed.entries()) {
                if (segment === "**") return true;
                const own = this.segments[index];
                if (own === undefined || own === "**") return false;
                if (segment !== "*" && segment !== own) return false;
            }
            return allowed.length === this.segments.length;
        });
    }

    info(): { pattern: string; where?: Readonly<Record<string, string>>; limits?: IResourceLimits } {
        return { pattern: this.pattern, ...(this.where ? { where: this.where } : {}), ...(this.limits ? { limits: this.limits } : {}) };
    }
}

interface IIndexNode {
    rules: LimitPattern[];
    children: Map<string, IIndexNode>;
}

/** Only visits rules beneath a matching literal prefix. */
export class LimitPatternIndex {
    private readonly _root: IIndexNode = { rules: [], children: new Map() };
    constructor(readonly patterns: readonly LimitPattern[]) {
        for (const pattern of patterns) {
            let node = this._root;
            for (const segment of pattern.prefix) {
                if (!node.children.has(segment)) node.children.set(segment, { rules: [], children: new Map() });
                node = node.children.get(segment)!;
            }
            node.rules.push(pattern);
        }
    }
    matching(path: ResourcePath): LimitPattern[] {
        const result: LimitPattern[] = [];
        let node: IIndexNode | undefined = this._root;
        let depth = 0;
        while (node) {
            for (const pattern of node.rules) if (pattern.limits && pattern.matches(path)) result.push(pattern);
            node = node.children.get(path.segments[depth++]);
        }
        return result;
    }
}

export function compileResourceLimits(raw: unknown): LimitPatternIndex {
    if (raw === undefined) return new LimitPatternIndex([]);
    if (!Array.isArray(raw) || raw.length > 10000) throw new Error("authorization.resourceLimits must be an array of at most 10000 rules");
    const ids = new Set<string>();
    return new LimitPatternIndex(
        raw.map((entry, index) => {
            const label = `authorization.resourceLimits[${index}]`;
            if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${label} must be an object`);
            for (const key of Object.keys(entry)) if (!["id", "pattern", "where", "limits"].includes(key)) throw new Error(`${label}: unknown key ${key}`);
            if (typeof entry.id !== "string" || !entry.id || entry.id.length > 128 || ids.has(entry.id))
                throw new Error(`${label}.id must be a unique non-empty string of at most 128 characters`);
            ids.add(entry.id);
            const errors: string[] = [];
            const limits = parseLimits(entry.limits, `${label}.limits`, errors);
            if (errors.length || !limits) throw new Error(errors.join("; ") || `${label}.limits must not be empty`);
            return new LimitPattern(entry.pattern, limits, `security:${entry.id}`, entry.where);
        })
    );
}

export function intersectLimits(entries: readonly { limits: IResourceLimits; source: string }[]): { limits?: IResourceLimits; empty: boolean; sources: string[] } {
    let minValue: number | undefined;
    let maxValue: number | undefined;
    let allowedValues: IResourceLimits["allowedValues"];
    let destinations: IResourceLimits["destinations"];
    for (const { limits } of entries) {
        if (limits.minValue !== undefined) minValue = Math.max(minValue ?? -Infinity, limits.minValue);
        if (limits.maxValue !== undefined) maxValue = Math.min(maxValue ?? Infinity, limits.maxValue);
        if (limits.allowedValues) allowedValues = allowedValues ? allowedValues.filter((v) => limits.allowedValues!.includes(v)) : [...limits.allowedValues];
        if (limits.destinations) destinations = destinations ? destinations.filter((v) => limits.destinations!.includes(v)) : [...limits.destinations];
    }
    if (allowedValues && (minValue !== undefined || maxValue !== undefined))
        allowedValues = allowedValues.filter((v) => typeof v === "number" && v >= (minValue ?? -Infinity) && v <= (maxValue ?? Infinity));
    const empty = (minValue !== undefined && maxValue !== undefined && minValue > maxValue) || allowedValues?.length === 0 || destinations?.length === 0;
    const limits = {
        ...(minValue !== undefined ? { minValue } : {}),
        ...(maxValue !== undefined ? { maxValue } : {}),
        ...(allowedValues ? { allowedValues: [...new Set(allowedValues)].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : {}),
        ...(destinations ? { destinations: [...new Set(destinations)].sort() } : {}),
    };
    return { limits: Object.keys(limits).length ? limits : undefined, empty, sources: [...new Set(entries.map((e) => e.source))].sort() };
}
