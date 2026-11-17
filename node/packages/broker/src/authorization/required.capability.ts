import { ResourcePath, ResourcePathPattern } from "./resource.path";

export interface IMcpOperation {
    readonly method?: string;
    readonly id?: unknown;
    readonly params?: unknown;
}

/** The capability a caller must hold for one MCP operation, and the tool it names. */
export interface IRequiredCapability {
    readonly capability: string;
    readonly tool?: string;
}

/**
 * Answers one question: which capability must a caller hold to send this MCP
 * operation to this slot? It decides nothing; the policy engine then checks
 * whether the caller holds that capability on the slot's resource.
 *
 * `undefined` means "no capability required": only for responses, the
 * methods every session needs ({@link FREE_METHODS}) and notifications the
 * table does not name.
 */
export interface IRequiredCapabilityResolver {
    resolve(operation: IMcpOperation, resource: ResourcePath, provider?: string): IRequiredCapability | undefined;
}

/**
 * The capability an unknown request needs. Nothing grants it unless the
 * operator does, so a method the broker does not know (a new MCP extension, a
 * provider's own method) is refused until someone classifies it in
 * `authorization.methodCapabilities` or grants this capability on purpose.
 */
export const UNCLASSIFIED_METHOD_CAPABILITY = "mcp.unclassified-method";

interface IProviderMapping {
    readonly pattern: ResourcePathPattern;
    readonly tools: Readonly<Record<string, string>>;
}

const STATIC_CAPABILITIES: Readonly<Record<string, string>> = {
    "resources/list": "mcp.resources.read",
    "resources/read": "mcp.resources.read",
    "resources/templates/list": "mcp.resources.read",
    // Subscribing is reading over time. Unsubscribing is free (FREE_METHODS):
    // a client whose grant was revoked must still be able to drop what it holds.
    "resources/subscribe": "mcp.resources.read",
    // MCP Skills extension (io.modelcontextprotocol/skills). A skill is served
    // through resources, so enumerating skills or reading a directory of skill
    // files is a resource read.
    "skills/list": "mcp.resources.read",
    "skills/get": "mcp.resources.read",
    "resources/directory/read": "mcp.resources.read",
    "tools/list": "mcp.tools.list",
    "prompts/list": "mcp.prompts.read",
    "prompts/get": "mcp.prompts.read",
    "completion/complete": "mcp.completion.use",
    // Changes the provider's log level for every client of the slot.
    "logging/setLevel": "mcp.logging.configure",
    "notifications/resources/list_changed": "mcp.resources.read",
    "notifications/resources/updated": "mcp.resources.read",
    "notifications/tools/list_changed": "mcp.tools.list",
    "notifications/prompts/list_changed": "mcp.prompts.read",
};

/**
 * Requests every session needs whatever its grants: opening it (`initialize`,
 * or `server/discover`, its stateless counterpart since 2026-07-28, which
 * hosts such as Claude Code send first as a probe), keeping it alive, and
 * letting go of a subscription.
 */
const FREE_METHODS: ReadonlySet<string> = new Set(["initialize", "server/discover", "ping", "resources/unsubscribe"]);

const BROKER_READ_TOOLS = new Set(["broker_info", "providers_list", "provider_status"]);

/**
 * Methods that only read broker state. On `_broker` they all need
 * `broker.providers.read`, the capability its tools need, rather than the
 * generic `mcp.resources.read`: otherwise a caller could read the list and
 * not subscribe to it, or the reverse.
 */
const BROKER_READ_METHODS = new Set([
    "tools/list",
    "resources/list",
    "resources/read",
    "resources/templates/list",
    "resources/subscribe",
    "resources/directory/read",
    "skills/list",
    "skills/get",
    "notifications/resources/updated",
]);

function toolNameFrom(params: unknown): string | undefined {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
    const name = (params as Readonly<Record<string, unknown>>)["name"];
    return typeof name === "string" && name ? name : undefined;
}

/** A request expects an answer: it carries an `id`, `null` excluded (JSON-RPC 2.0, section 4). */
function isRequest(operation: IMcpOperation): boolean {
    return operation.id !== undefined && operation.id !== null;
}

export function validateCapability(capability: string, label = "capability"): void {
    if (typeof capability !== "string" || (capability !== "*" && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(capability))) {
        throw new Error(`authorization ${label}: "${capability}" is malformed.`);
    }
}

/**
 * Resolves the capability an MCP operation requires, without deriving
 * privilege from arbitrary tool names.
 *
 * - `tools/call`: provider-qualified mapping, then global mapping, then `mcp.tools.call`.
 * - A known method: its built-in capability, or the operator's `methodCapabilities` entry.
 * - `initialize`, `ping`, `resources/unsubscribe`, responses: nothing required.
 * - Any other request: {@link UNCLASSIFIED_METHOD_CAPABILITY}, so it is refused by default.
 * - Any other notification: nothing required. A notification gets no answer,
 *   so an unknown one cannot read anything back; the notifications that carry
 *   provider data out to clients are all in the table.
 */
export class RequiredCapabilityResolver implements IRequiredCapabilityResolver {
    private readonly _globalTools: Readonly<Record<string, string>>;
    private readonly _providerMappings: readonly IProviderMapping[];
    private readonly _methods: Readonly<Record<string, string>>;

    constructor(
        toolCapabilities: Readonly<Record<string, string>> = {},
        providerToolCapabilities: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
        methodCapabilities: Readonly<Record<string, string>> = {}
    ) {
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

        for (const [method, capability] of Object.entries(methodCapabilities)) {
            if (!method) throw new Error("authorization methodCapabilities: method names must not be empty.");
            // Reclassifying a built-in method could only weaken it (or make it
            // contradict the docs): the table above is the contract.
            if (method === "tools/call" || method in STATIC_CAPABILITIES || FREE_METHODS.has(method)) {
                throw new Error(`authorization methodCapabilities["${method}"]: "${method}" is classified by the broker itself and cannot be reclassified.`);
            }
            validateCapability(capability, `methodCapabilities["${method}"]`);
        }
        this._methods = Object.freeze({ ...methodCapabilities });
    }

    resolve(operation: IMcpOperation, resource: ResourcePath, provider?: string): IRequiredCapability | undefined {
        const method = operation.method;
        // A response, or a frame that is not JSON-RPC at all: nothing to authorize here.
        if (!method) return undefined;

        if (provider === "_broker") {
            if (BROKER_READ_METHODS.has(method)) {
                return { capability: "broker.providers.read" };
            }
            if (method === "tools/call") {
                const tool = toolNameFrom(operation.params);
                if (tool && BROKER_READ_TOOLS.has(tool)) return { capability: "broker.providers.read", tool };
                // Acts on execution limits: never the generic mcp.tools.call.
                if (tool === "broker_limits_release") return { capability: "broker.limits.admin", tool };
                // Frees an authorization domain: never the generic mcp.tools.call either.
                if (tool === "broker_declaration_withdraw") return { capability: "broker.authorization.admin", tool };
            }
        }

        if (method === "tools/call") {
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

        const capability = STATIC_CAPABILITIES[method] ?? this._methods[method];
        if (capability) return { capability };
        if (FREE_METHODS.has(method) || !isRequest(operation)) return undefined;
        return { capability: UNCLASSIFIED_METHOD_CAPABILITY };
    }
}

/** @deprecated Use {@link IRequiredCapability}. */
export type IClassifiedCapability = IRequiredCapability;
/** @deprecated Use {@link IRequiredCapability}. */
export type ClassifiedCapability = IRequiredCapability;
/** @deprecated Use {@link IMcpOperation}. */
export type McpOperation = IMcpOperation;

/** @deprecated Use {@link IRequiredCapabilityResolver}; `classify` is now `resolve`. */
export interface ICapabilityClassifier {
    classify(operation: IMcpOperation, resource: ResourcePath, provider?: string): IRequiredCapability | undefined;
}
/** @deprecated Use {@link IRequiredCapabilityResolver}. */
export type CapabilityClassifier = ICapabilityClassifier;

/**
 * @deprecated Use {@link RequiredCapabilityResolver}; `classify` is now
 * `resolve`. Kept so code written against 1.13 still compiles. It shares the
 * new behavior: an unknown request now needs {@link UNCLASSIFIED_METHOD_CAPABILITY}.
 */
export class ConfiguredCapabilityClassifier extends RequiredCapabilityResolver implements ICapabilityClassifier {
    classify(operation: IMcpOperation, resource: ResourcePath, provider?: string): IRequiredCapability | undefined {
        return this.resolve(operation, resource, provider);
    }
}

/** Wraps a 1.13-style classifier so it can stand where a resolver is expected. */
export function resolverFromClassifier(classifier: ICapabilityClassifier): IRequiredCapabilityResolver {
    return { resolve: (operation, resource, provider) => classifier.classify(operation, resource, provider) };
}
