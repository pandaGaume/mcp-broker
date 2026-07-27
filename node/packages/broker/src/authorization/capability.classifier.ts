import { ResourcePath, ResourcePathPattern } from "./resource.path.js";

export interface IMcpOperation {
    readonly method?: string;
    readonly params?: unknown;
}

export interface IClassifiedCapability {
    readonly capability: string;
    readonly tool?: string;
}

export interface ICapabilityClassifier {
    classify(operation: IMcpOperation, resource: ResourcePath, provider?: string): IClassifiedCapability | undefined;
}

interface IProviderMapping {
    readonly pattern: ResourcePathPattern;
    readonly tools: Readonly<Record<string, string>>;
}

const STATIC_CAPABILITIES: Readonly<Record<string, string>> = {
    "resources/list": "mcp.resources.read",
    "resources/read": "mcp.resources.read",
    "tools/list": "mcp.tools.list",
    "prompts/list": "mcp.prompts.read",
    "prompts/get": "mcp.prompts.read",
    "completion/complete": "mcp.completion.use",
    "notifications/resources/list_changed": "mcp.resources.read",
    "notifications/resources/updated": "mcp.resources.read",
    "notifications/tools/list_changed": "mcp.tools.list",
    "notifications/prompts/list_changed": "mcp.prompts.read",
};

const BROKER_READ_TOOLS = new Set(["broker_info", "providers_list", "provider_status"]);

function toolNameFrom(params: unknown): string | undefined {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
    const name = (params as Readonly<Record<string, unknown>>)["name"];
    return typeof name === "string" && name ? name : undefined;
}

export function validateCapability(capability: string, label = "capability"): void {
    if (typeof capability !== "string" || (capability !== "*" && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(capability))) {
        throw new Error(`authorization ${label}: "${capability}" is malformed.`);
    }
}

/**
 * Classifies MCP methods without deriving privilege from arbitrary tool names.
 * Provider-qualified mappings win over global mappings, then tools/call falls
 * back to `mcp.tools.call`.
 */
export class ConfiguredCapabilityClassifier implements ICapabilityClassifier {
    private readonly _globalTools: Readonly<Record<string, string>>;
    private readonly _providerMappings: readonly IProviderMapping[];

    constructor(toolCapabilities: Readonly<Record<string, string>> = {}, providerToolCapabilities: Readonly<Record<string, Readonly<Record<string, string>>>> = {}) {
        for (const [tool, capability] of Object.entries(toolCapabilities)) {
            if (!tool) throw new Error("authorization toolCapabilities: tool names must not be empty.");
            validateCapability(capability, `toolCapabilities["${tool}"]`);
        }
        this._globalTools = Object.freeze({ ...toolCapabilities });

        const mappings: IProviderMapping[] = [];
        for (const [patternValue, tools] of Object.entries(providerToolCapabilities)) {
            const pattern = ResourcePathPattern.parse(patternValue);
            for (const [tool, capability] of Object.entries(tools)) {
                if (!tool) throw new Error(`authorization providerToolCapabilities["${patternValue}"]: tool names must not be empty.`);
                validateCapability(capability, `providerToolCapabilities["${patternValue}"]["${tool}"]`);
            }
            mappings.push({ pattern, tools: Object.freeze({ ...tools }) });
        }
        mappings.sort((left, right) => right.pattern.specificity - left.pattern.specificity || left.pattern.value.localeCompare(right.pattern.value));
        this._providerMappings = Object.freeze(mappings);
    }

    classify(operation: IMcpOperation, resource: ResourcePath, provider?: string): IClassifiedCapability | undefined {
        const method = operation.method;
        if (!method) return undefined;

        if (provider === "_broker") {
            if (method === "tools/list" || method === "resources/list" || method === "resources/read") {
                return { capability: "broker.providers.read" };
            }
            if (method === "tools/call") {
                const tool = toolNameFrom(operation.params);
                if (tool && BROKER_READ_TOOLS.has(tool)) return { capability: "broker.providers.read", tool };
            }
        }

        if (method !== "tools/call") {
            const capability = STATIC_CAPABILITIES[method];
            return capability ? { capability } : undefined;
        }

        const tool = toolNameFrom(operation.params);
        if (!tool) return { capability: "mcp.tools.call" };
        for (const mapping of this._providerMappings) {
            if (mapping.pattern.matches(resource)) {
                const capability = mapping.tools[tool];
                if (capability) return { capability, tool };
            }
        }
        return { capability: this._globalTools[tool] ?? "mcp.tools.call", tool };
    }
}

/** @deprecated Use {@link IMcpOperation}. */
export type McpOperation = IMcpOperation;
/** @deprecated Use {@link IClassifiedCapability}. */
export type ClassifiedCapability = IClassifiedCapability;
/** @deprecated Use {@link ICapabilityClassifier}. */
export type CapabilityClassifier = ICapabilityClassifier;
