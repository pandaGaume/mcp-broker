import { McpAdapterBase, McpToolResults } from "@cyanmycelium/mcp-core";
import type { McpResourceContent, McpToolResult } from "@cyanmycelium/mcp-core";
import type { BrokerContext, BrokerProviderInfo } from "../broker.context.js";

/** URI of the static resource that lists every provider slot. */
export const PROVIDERS_URI = "broker://providers";

/** RFC 6570 URI template for one specific provider slot. */
export const PROVIDER_URI_TEMPLATE = "broker://providers/{name}";

/**
 * Adapter that exposes the broker's current provider slots, both as a list
 * (read of `broker://providers`) and individually (`broker://providers/<name>`).
 */
export class BrokerProvidersAdapter extends McpAdapterBase {
    constructor(private readonly _context: BrokerContext) {
        super("broker");
    }

    public async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        if (uri === PROVIDERS_URI) {
            return {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(this._listSnapshot()),
            };
        }

        // broker://providers/<name>
        const match = /^broker:\/\/providers\/([^/]+)$/.exec(uri);
        if (match) {
            const name = decodeURIComponent(match[1]);
            const info = this._context.getProviderInfo(name);
            if (!info) return undefined;
            return {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(info),
            };
        }

        return undefined;
    }

    public async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        switch (toolName) {
            case "providers_list":
                return McpToolResults.json(this._listSnapshot());

            case "provider_status": {
                const name = typeof args.name === "string" ? args.name : "";
                if (!name) return McpToolResults.error('Missing required argument: "name" (string).');
                const info = this._context.getProviderInfo(name);
                if (!info) return McpToolResults.error(`Unknown provider: "${name}".`);
                return McpToolResults.json(info);
            }

            default:
                return McpToolResults.error(`Unknown tool: ${toolName}`);
        }
    }

    private _listSnapshot(): { count: number; providers: BrokerProviderInfo[] } {
        const providers = this._context.getProvidersInfo();
        return { count: providers.length, providers };
    }
}
