const WILDCARD = "*";
const RECURSIVE_WILDCARD = "**";

function assertString(value: string, label: string): void {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label}: a non-empty string is required.`);
    }
}

function splitAbsolutePath(value: string, label: string): readonly string[] {
    assertString(value, label);
    if (!value.startsWith("/")) {
        throw new Error(`${label}: "${value}" must start with "/".`);
    }
    if (value === "/") return [];

    const withoutTrailingSlash = value.endsWith("/") ? value.slice(0, -1) : value;
    const segments = withoutTrailingSlash.slice(1).split("/");
    for (const segment of segments) {
        if (!segment) {
            throw new Error(`${label}: "${value}" contains an empty path segment.`);
        }
        if (segment === "." || segment === "..") {
            throw new Error(`${label}: "${value}" contains a forbidden "${segment}" segment.`);
        }
    }
    return segments;
}

function normalizedValue(segments: readonly string[]): string {
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * A normalized, case-sensitive hierarchical resource path.
 *
 * Parsing is deliberately independent from URLs and transports. A path is a
 * stable resource identity, not a network address.
 */
export class ResourcePath {
    readonly value: string;
    readonly segments: readonly string[];

    private constructor(segments: readonly string[]) {
        this.segments = Object.freeze([...segments]);
        this.value = normalizedValue(this.segments);
    }

    static parse(value: string): ResourcePath {
        const segments = splitAbsolutePath(value, "resource path");
        for (const segment of segments) {
            if (segment === WILDCARD || segment === RECURSIVE_WILDCARD) {
                throw new Error(`resource path: wildcards are not allowed in "${value}".`);
            }
        }
        return new ResourcePath(segments);
    }

    static tryParse(value: string): ResourcePath | undefined {
        try {
            return ResourcePath.parse(value);
        } catch {
            return undefined;
        }
    }

    toString(): string {
        return this.value;
    }
}

/**
 * A compiled resource expression supporting exact segments, `*` for one
 * segment, and a final `**` for zero or more trailing segments.
 */
export class ResourcePathPattern {
    readonly value: string;
    readonly segments: readonly string[];
    readonly specificity: number;

    private constructor(segments: readonly string[]) {
        this.segments = Object.freeze([...segments]);
        this.value = normalizedValue(this.segments);
        this.specificity = this.segments.reduce((score, segment) => {
            if (segment === RECURSIVE_WILDCARD) return score;
            if (segment === WILDCARD) return score + 1;
            return score + 4;
        }, this.segments.length);
    }

    static parse(value: string): ResourcePathPattern {
        const canonical = value === RECURSIVE_WILDCARD ? `/${RECURSIVE_WILDCARD}` : value;
        const segments = splitAbsolutePath(canonical, "resource pattern");
        let recursiveSeen = false;
        for (let index = 0; index < segments.length; index += 1) {
            const segment = segments[index];
            if (segment === RECURSIVE_WILDCARD) {
                if (index !== segments.length - 1) {
                    throw new Error(`resource pattern: "**" must be the final segment in "${value}".`);
                }
                recursiveSeen = true;
            } else if (recursiveSeen) {
                throw new Error(`resource pattern: no segment may follow "**" in "${value}".`);
            } else if (segment !== WILDCARD && segment.includes(WILDCARD)) {
                throw new Error(`resource pattern: wildcards must occupy a complete segment in "${value}".`);
            }
        }
        return new ResourcePathPattern(segments);
    }

    matches(path: ResourcePath): boolean {
        const pattern = this.segments;
        const target = path.segments;
        for (let index = 0; index < pattern.length; index += 1) {
            const segment = pattern[index];
            if (segment === RECURSIVE_WILDCARD) return true;
            if (index >= target.length) return false;
            if (segment !== WILDCARD && segment !== target[index]) return false;
        }
        return target.length === pattern.length;
    }

    toString(): string {
        return this.value;
    }
}
