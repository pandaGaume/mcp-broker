import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpClientInfo } from "@cyanmycelium/mcp-core";
import { McpGrammar } from "@cyanmycelium/mcp-core";

// ---------------------------------------------------------------------------
// Open string types — extensibility by convention
// ---------------------------------------------------------------------------

/**
 * Locale identifier used to look up a grammar JSON file under
 * `<userAgent>/<locale>.json`. Open string: an application can introduce any
 * value its custom resolver and JSON resources support.
 *
 * The {@link defaultBrokerLocaleResolver} returns the ISO 639-1 prefix of a
 * BCP-47 tag (`"fr-CA"` → `"fr"`, `"zh-Hans"` → `"zh"`).
 */
export type BrokerLocale = string;

/**
 * User-agent family identifier used to look up a grammar JSON file under
 * `<userAgent>/<locale>.json`. Open string. The {@link defaultBrokerUserAgentResolver}
 * recognizes the common LLM families and returns `"default"` for everything else.
 */
export type BrokerUserAgent = string;

// ---------------------------------------------------------------------------
// Resolver function types
// ---------------------------------------------------------------------------

/**
 * Picks an **ordered fallback chain** of {@link BrokerLocale} values from a raw
 * input. Typically the raw input is `process.env.MCP_BROKER_LOCALE`, but any
 * string source works (HTTP header, session metadata, etc.).
 *
 * The returned array is consumed by the broker server most-specific-first, so
 * the resolver controls the BCP-47 narrowing policy. The default resolver
 * follows the standard `lang-region` → `lang` → `en` shape:
 *
 * ```
 *   raw = "fr-CA"  →  ["fr-ca", "fr", "en"]
 *   raw = "en-US"  →  ["en-us", "en"]
 *   raw = "zh"     →  ["zh", "en"]
 *   raw = ""       →  ["en"]
 * ```
 *
 * A custom resolver may shape the chain however it wants — e.g. inject a
 * project-specific dialect first, skip the bare language prefix, or pull
 * candidates from a session config.
 */
export type BrokerLocaleResolver = (raw: string | undefined) => BrokerLocale[];

/**
 * Picks a {@link BrokerUserAgent} from the connecting client's identity. Called
 * by the embedded broker `McpServer` once per session, during the MCP
 * `initialize` handshake.
 */
export type BrokerUserAgentResolver = (clientInfo: McpClientInfo | undefined) => BrokerUserAgent;

// ---------------------------------------------------------------------------
// Default resolvers
// ---------------------------------------------------------------------------

/**
 * Default locale resolver — emits the BCP-47 narrowing chain for a raw locale
 * tag, from most specific to least specific, always ending with the universal
 * `"en"` fallback.
 *
 * Steps for an input `raw`:
 * 1. Lowercase the input.
 * 2. Push it as the most-specific candidate (only if non-empty).
 * 3. If it contains a `-` separator, push its bare language prefix next.
 * 4. Always push `"en"` last as the universal fallback.
 *
 * The broker server tries each candidate in turn against `<userAgent>/<locale>.json`
 * — so dropping a `claude/fr-ca.json` lets Canadian-French Claude clients
 * pick up that specific dialect, while clients with `fr` or `fr-FR` fall back
 * to `claude/fr.json` or `default/fr.json` automatically.
 *
 * Examples:
 * - `"fr-CA"`  → `["fr-ca", "fr", "en"]`
 * - `"fr"`     → `["fr", "en"]`
 * - `"zh-CN"`  → `["zh-cn", "zh", "en"]`
 * - `"en-US"`  → `["en-us", "en"]`
 * - `""` / `undefined` → `["en"]`
 */
export const defaultBrokerLocaleResolver: BrokerLocaleResolver = (raw) => {
    const a = [];
    if (raw) {
        const sep = "-";
        raw = raw.toLowerCase();
        a.push(raw);
        if (raw.indexOf(sep) !== -1) {
            a.push(raw.split(sep)[0]);
        }
    }
    a.push("en");
    return a;
};

/**
 * Default user-agent resolver — substring match on `clientInfo.name` against
 * a list of known LLM family hints. Unknown clients fall through to
 * `"default"` which is the universal baseline.
 *
 * This is intentionally a heuristic: MCP does not yet standardize an
 * agent-family field in `clientInfo`. Override the resolver in the broker
 * options if you need richer logic (header inspection, allow-list, etc.).
 */
export const defaultBrokerUserAgentResolver: BrokerUserAgentResolver = (clientInfo) => {
    const n = (clientInfo?.name ?? "").toLowerCase();
    if (n.includes("claude")) return "claude";
    if (n.includes("gpt") || n.includes("openai")) return "gpt";
    if (n.includes("mistral")) return "mistral";
    if (n.includes("copilot")) return "copilot";
    return "default";
};

/** @deprecated Use {@link defaultBrokerLocaleResolver}. Kept as backward-compat alias. */
export const resolveBrokerLocale = defaultBrokerLocaleResolver;
/** @deprecated Use {@link defaultBrokerUserAgentResolver}. Kept as backward-compat alias. */
export const resolveBrokerUserAgent: (clientName: string | undefined) => BrokerUserAgent = (clientName) => defaultBrokerUserAgentResolver({ name: clientName ?? "", version: "" });

// ---------------------------------------------------------------------------
// Canonical grammar key
// ---------------------------------------------------------------------------

/**
 * Builds the canonical grammar key for the `(userAgent, locale)` matrix.
 *
 * Pattern: `"<userAgent>:<locale>"` — e.g. `"claude:fr"`, `"default:en"`.
 * The colon separator is reserved for this composition and never appears in
 * user-agent or locale identifiers.
 */
export function brokerGrammarKey(userAgent: BrokerUserAgent, locale: BrokerLocale): string {
    return `${userAgent}:${locale}`;
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
 * Loads and caches the grammar for a given `(userAgent, locale)` combination.
 * Returns `undefined` (instead of throwing) when the resource file is missing,
 * so the caller can implement a fallback chain.
 */
export function loadBrokerGrammar(userAgent: BrokerUserAgent, locale: BrokerLocale): McpGrammar | undefined {
    const key = brokerGrammarKey(userAgent, locale);
    const cached = _cache.get(key);
    if (cached) return cached;

    const path = join(GRAMMARS_DIR, userAgent, `${locale}.json`);
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
export function* iterBrokerGrammarsFrom(grammarsDir: string): Generator<{
    userAgent: BrokerUserAgent;
    locale: BrokerLocale;
    key: string;
    grammar: McpGrammar;
}> {
    if (!existsSync(grammarsDir)) return;

    const userAgents = readdirSync(grammarsDir).sort();
    for (const userAgent of userAgents) {
        const uaDir = join(grammarsDir, userAgent);
        if (!statSync(uaDir).isDirectory()) continue;

        const files = readdirSync(uaDir).sort();
        for (const file of files) {
            if (!file.endsWith(".json")) continue;
            const locale = file.slice(0, -".json".length);
            const path = join(uaDir, file);
            try {
                const raw = readFileSync(path, "utf-8");
                const data = JSON.parse(raw);
                const grammar = McpGrammar.fromJSON(data);
                yield { userAgent, locale, key: brokerGrammarKey(userAgent, locale), grammar };
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
export function* iterAvailableBrokerGrammars(): Generator<{
    userAgent: BrokerUserAgent;
    locale: BrokerLocale;
    key: string;
    grammar: McpGrammar;
}> {
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
