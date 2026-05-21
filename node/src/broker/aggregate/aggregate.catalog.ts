/**
 * AggregateCatalog — merges the tool and prompt catalogs of several providers
 * into a single namespaced view, and routes aggregated names back to their
 * origin provider.
 *
 * Aggregated names use the `<provider>-<original>` shape. Routing never parses
 * that string back: a forward lookup table is the single source of truth, so
 * the `-` separator stays safe even when provider or tool names contain dashes.
 */

/** Minimal shape of an MCP tool entry. Extra fields are preserved as-is. */
export interface CatalogTool {
    name: string;
    description?: string;
    [key: string]: unknown;
}

/** Minimal shape of an MCP prompt entry. Extra fields are preserved as-is. */
export interface CatalogPrompt {
    name: string;
    title?: string;
    description?: string;
    [key: string]: unknown;
}

/** One provider's raw contribution to the aggregate. */
export interface ProviderEntry {
    tools: CatalogTool[];
    prompts: CatalogPrompt[];
}

/** Where an aggregated name routes back to. */
export interface Route {
    provider: string;
    original: string;
}

/** Separator between the provider prefix and the original name. */
const SEPARATOR = "-";

/** Anthropic API tool-name limit; aggregated tool names must fit inside it. */
const MAX_TOOL_NAME_LENGTH = 64;

export class AggregateCatalog {
    private readonly _providers = new Map<string, ProviderEntry>();
    private _tools: CatalogTool[] = [];
    private _prompts: CatalogPrompt[] = [];
    private _toolRoutes = new Map<string, Route>();
    private _promptRoutes = new Map<string, Route>();

    /** Number of providers currently contributing to the aggregate. */
    get providerCount(): number {
        return this._providers.size;
    }

    /** The merged, namespaced tool list. */
    get tools(): CatalogTool[] {
        return this._tools;
    }

    /** The merged, namespaced prompt list. */
    get prompts(): CatalogPrompt[] {
        return this._prompts;
    }

    /** Adds or replaces a provider's contribution, then rebuilds the merged view. */
    setProvider(provider: string, entry: ProviderEntry): void {
        this._providers.set(provider, entry);
        this._rebuild();
    }

    /** Drops a provider from the aggregate, then rebuilds. */
    removeProvider(provider: string): void {
        if (this._providers.delete(provider)) this._rebuild();
    }

    /** Resolves an aggregated tool name to its origin, or `undefined` if unknown. */
    resolveTool(name: string): Route | undefined {
        return this._toolRoutes.get(name);
    }

    /** Resolves an aggregated prompt name to its origin, or `undefined` if unknown. */
    resolvePrompt(name: string): Route | undefined {
        return this._promptRoutes.get(name);
    }

    private _rebuild(): void {
        const tools: CatalogTool[] = [];
        const prompts: CatalogPrompt[] = [];
        const toolRoutes = new Map<string, Route>();
        const promptRoutes = new Map<string, Route>();

        for (const [provider, entry] of this._providers) {
            for (const tool of entry.tools) {
                const name = unique(capToolName(prefixed(provider, tool.name)), toolRoutes);
                toolRoutes.set(name, { provider, original: tool.name });
                tools.push({ ...tool, name, description: tag(provider, tool.description) });
            }
            for (const prompt of entry.prompts) {
                const name = unique(prefixed(provider, prompt.name), promptRoutes);
                promptRoutes.set(name, { provider, original: prompt.name });
                prompts.push({ ...prompt, name, description: tag(provider, prompt.description) });
            }
        }

        this._tools = tools;
        this._prompts = prompts;
        this._toolRoutes = toolRoutes;
        this._promptRoutes = promptRoutes;
    }
}

function prefixed(provider: string, original: string): string {
    return `${provider}${SEPARATOR}${original}`;
}

/** Tags a description with the origin provider so the model and user see the source. */
function tag(provider: string, description: string | undefined): string {
    const label = `[${provider}]`;
    return description ? `${label} ${description}` : label;
}

/** Caps a tool name to the API limit, replacing the overflow with a stable hash. */
function capToolName(name: string): string {
    if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
    const hash = djb2(name);
    return name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1) + SEPARATOR + hash;
}

/** Disambiguates a name already present in `taken` by appending `-2`, `-3`, ... */
function unique(candidate: string, taken: ReadonlyMap<string, unknown>): string {
    if (!taken.has(candidate)) return candidate;
    let n = 2;
    while (taken.has(`${candidate}${SEPARATOR}${n}`)) n++;
    return `${candidate}${SEPARATOR}${n}`;
}

/** Small deterministic string hash rendered as 8 base-36 characters. */
function djb2(input: string): string {
    let h = 5381;
    for (let i = 0; i < input.length; i++) {
        h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
    }
    return h.toString(36).padStart(8, "0").slice(-8);
}
