import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpGrammar } from "@cyanmycelium/mcp-core";

// ---------------------------------------------------------------------------
// Open string types — extensibility by convention
// ---------------------------------------------------------------------------

/**
 * Locale identifier used to look up a grammar JSON file under
 * `<userAgent>/<locale>.json`. Open string: a host application can use any
 * value its grammar resources support.
 *
 * The broker registers each `(userAgent, locale)` pair found on disk as a
 * separate `McpGrammar` keyed by {@link brokerGrammarKey}. The actual
 * resolution of "which key to use for this session" is delegated to
 * `@cyanmycelium/mcp-core@0.3.0`'s `grammarResolverFromOptions`, which
 * handles BCP-47 narrowing (`fr-CA` → `fr` → `en`), agent-family fallback,
 * and the optional version dimension natively.
 */
export type BrokerLocale = string;

/**
 * User-agent family identifier used to look up a grammar JSON file under
 * `<userAgent>/<locale>.json`. Open string. Conventional values follow
 * the defaults emitted by `grammarResolverFromOptions`: `claude`, `gpt`,
 * `mistral`, `copilot`, plus the universal `default`. Custom families
 * are supported by passing a custom `agents` map in
 * `StartBrokerServerOptions.grammarResolverOptions`.
 */
export type BrokerUserAgent = string;

// ---------------------------------------------------------------------------
// Canonical grammar key
// ---------------------------------------------------------------------------

/**
 * Builds the canonical grammar key for the `(userAgent, locale, version?)`
 * matrix the broker registers on disk.
 *
 * Pattern:
 *   - `"<userAgent>:<locale>"` (no version) — e.g. `"claude:fr"`, `"default:en"`
 *   - `"<userAgent>:<locale>@<version>"` (versioned) — e.g. `"claude:fr@v2"`
 *
 * The colon separator is reserved for the `<ua>:<locale>` composition; the
 * `@` separator is reserved for the optional version suffix. Neither
 * character is allowed inside the identifier segments. This matches the
 * default `composeKey` of `grammarResolverFromOptions` exactly, so a
 * broker-loaded grammar at `claude/fr@v2.json` is automatically picked up
 * when a Claude session resolves to the `claude:fr@v2` candidate.
 */
export function brokerGrammarKey(userAgent: BrokerUserAgent, locale: BrokerLocale, version?: string): string {
    const base = `${userAgent}:${locale}`;
    return version ? `${base}@${version}` : base;
}

/**
 * Parses a grammar JSON filename of the form `<locale>.json` or
 * `<locale>@<version>.json` (without the `.json` suffix) into its
 * components. The first `@` (if any) separates locale from version; any
 * additional `@` is folded into the version string.
 *
 * Returns `null` when the input cannot be split into a usable locale.
 */
export function parseBrokerGrammarStem(stem: string): { locale: BrokerLocale; version?: string } | null {
    const at = stem.indexOf("@");
    if (at < 0) return stem.length > 0 ? { locale: stem } : null;
    const locale = stem.slice(0, at);
    const version = stem.slice(at + 1);
    if (locale.length === 0 || version.length === 0) return null;
    return { locale, version };
}

// ---------------------------------------------------------------------------
// JSON resource loading
// ---------------------------------------------------------------------------

/**
 * Absolute path of the directory holding the grammar JSON resources.
 *
 * Layout (one folder per user-agent family, one JSON file per locale):
 * ```
 * <GRAMMARS_DIR>/
 * ├── default/
 * │   ├── en.json
 * │   ├── fr.json
 * │   └── zh.json
 * └── claude/
 *     ├── en.json
 *     └── fr.json
 * ```
 *
 * JSON files live alongside this module in `src/broker/grammars/` during
 * development and are mirrored under `dist/broker/grammars/` at build time
 * by `scripts/copy-assets.mjs`. Adding a new `(userAgent, locale)` pair is
 * just a matter of dropping a new JSON file — no code change required.
 */
const GRAMMARS_DIR = join(dirname(fileURLToPath(import.meta.url)), "grammars");

const _cache = new Map<string, McpGrammar>();

/**
 * Loads and caches the grammar for a given `(userAgent, locale, version?)`
 * combination. Returns `undefined` (instead of throwing) when the resource
 * file is missing, so the caller can implement a fallback chain.
 *
 * Filename convention on disk:
 *   - `<userAgent>/<locale>.json` (no version)
 *   - `<userAgent>/<locale>@<version>.json` (versioned)
 */
export function loadBrokerGrammar(userAgent: BrokerUserAgent, locale: BrokerLocale, version?: string): McpGrammar | undefined {
    const key = brokerGrammarKey(userAgent, locale, version);
    const cached = _cache.get(key);
    if (cached) return cached;

    const filename = version ? `${locale}@${version}.json` : `${locale}.json`;
    const path = join(GRAMMARS_DIR, userAgent, filename);
    if (!existsSync(path)) return undefined;

    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    const grammar = McpGrammar.fromJSON(data);
    _cache.set(key, grammar);
    return grammar;
}

/**
 * Walks a grammars directory and yields every `(userAgent, locale)` pair
 * found on disk. The directory must follow the layout
 * `<dir>/<userAgent>/<locale>.json`.
 *
 * Used by the broker server at startup to bulk-register both the packaged
 * grammars and any local overrides. No hard-coded list of supported
 * user-agents or locales — adding a new grammar is dropping a JSON file.
 */
export interface BrokerGrammarEntry {
    userAgent: BrokerUserAgent;
    locale: BrokerLocale;
    /** Set only for filenames carrying an `@<version>` suffix. */
    version?: string;
    /** Composed via {@link brokerGrammarKey} from the three segments above. */
    key: string;
    grammar: McpGrammar;
}

export function* iterBrokerGrammarsFrom(grammarsDir: string): Generator<BrokerGrammarEntry> {
    if (!existsSync(grammarsDir)) return;

    const userAgents = readdirSync(grammarsDir).sort();
    for (const userAgent of userAgents) {
        const uaDir = join(grammarsDir, userAgent);
        if (!statSync(uaDir).isDirectory()) continue;

        const files = readdirSync(uaDir).sort();
        for (const file of files) {
            if (!file.endsWith(".json")) continue;
            const stem = file.slice(0, -".json".length);
            const parsed = parseBrokerGrammarStem(stem);
            if (!parsed) {
                process.stderr.write(`[mcp-broker] Skipping unparseable grammar filename ${file} in ${uaDir}\n`);
                continue;
            }
            const { locale, version } = parsed;
            const path = join(uaDir, file);
            try {
                const raw = readFileSync(path, "utf-8");
                const data = JSON.parse(raw);
                const grammar = McpGrammar.fromJSON(data);
                yield {
                    userAgent,
                    locale,
                    version,
                    key: brokerGrammarKey(userAgent, locale, version),
                    grammar,
                };
            } catch (err) {
                process.stderr.write(`[mcp-broker] Failed to load grammar ${path}: ${(err as Error).message}\n`);
            }
        }
    }
}

/**
 * Walks the **packaged** grammars directory (the one shipped with the
 * mcp-broker package). Equivalent to `iterBrokerGrammarsFrom(<packaged-dir>)`.
 *
 * For local user overrides, see {@link iterBrokerGrammarsFrom} with a custom
 * directory — typically `.mcp-broker/grammars/` next to the config file.
 */
export function* iterAvailableBrokerGrammars(): Generator<BrokerGrammarEntry> {
    yield* iterBrokerGrammarsFrom(GRAMMARS_DIR);
}

// ---------------------------------------------------------------------------
// Baseline helpers (used by behaviors to source their inline descriptions)
// ---------------------------------------------------------------------------

/**
 * Returns the baseline grammar used by the broker behaviors as their
 * source-of-truth for inline tool / property descriptions.
 *
 * Conventionally this is `default:en`. Session-specific grammars selected by
 * the resolver override individual entries on top of this baseline.
 *
 * Throws if the JSON resource is missing — the broker behaviors cannot be
 * built without baseline descriptions.
 */
export function brokerBaselineGrammar(): McpGrammar {
    const g = loadBrokerGrammar("default", "en");
    if (!g) {
        throw new Error(`Required baseline broker grammar "default:en" is missing — expected at ${join(GRAMMARS_DIR, "default", "en.json")}.`);
    }
    return g;
}

/**
 * Convenience accessor for a baseline tool description. Throws when the
 * tool is not listed in the baseline grammar — i.e. the JSON file is missing
 * an entry for a tool the code knows about.
 */
export function brokerBaselineToolDescription(toolName: string): string {
    const desc = brokerBaselineGrammar().getToolDescription(toolName);
    if (!desc) {
        throw new Error(`Missing baseline description for tool "${toolName}" in default/en.json.`);
    }
    return desc;
}

/**
 * Convenience accessor for a baseline property description. Throws when the
 * property is not listed under the tool in the baseline grammar.
 */
export function brokerBaselinePropertyDescription(toolName: string, propertyName: string): string {
    const desc = brokerBaselineGrammar().getPropertyDescription(toolName, propertyName);
    if (!desc) {
        throw new Error(`Missing baseline description for property "${propertyName}" of tool "${toolName}" in default/en.json.`);
    }
    return desc;
}

/**
 * Convenience accessor for a baseline resource name. Throws when the resource
 * URI has no entry in the baseline grammar.
 */
export function brokerBaselineResourceName(uri: string): string {
    const name = brokerBaselineGrammar().getResourceName(uri);
    if (!name) {
        throw new Error(`Missing baseline name for resource "${uri}" in default/en.json.`);
    }
    return name;
}

/**
 * Convenience accessor for a baseline resource description. Throws when the
 * resource URI has no entry in the baseline grammar.
 */
export function brokerBaselineResourceDescription(uri: string): string {
    const desc = brokerBaselineGrammar().getResourceDescription(uri);
    if (!desc) {
        throw new Error(`Missing baseline description for resource "${uri}" in default/en.json.`);
    }
    return desc;
}

/**
 * Convenience accessor for a baseline resource template name. Throws when the
 * template URI has no entry in the baseline grammar.
 */
export function brokerBaselineResourceTemplateName(uriTemplate: string): string {
    const name = brokerBaselineGrammar().getResourceTemplateName(uriTemplate);
    if (!name) {
        throw new Error(`Missing baseline name for resource template "${uriTemplate}" in default/en.json.`);
    }
    return name;
}

/**
 * Convenience accessor for a baseline resource template description. Throws
 * when the template URI has no entry in the baseline grammar.
 */
export function brokerBaselineResourceTemplateDescription(uriTemplate: string): string {
    const desc = brokerBaselineGrammar().getResourceTemplateDescription(uriTemplate);
    if (!desc) {
        throw new Error(`Missing baseline description for resource template "${uriTemplate}" in default/en.json.`);
    }
    return desc;
}
