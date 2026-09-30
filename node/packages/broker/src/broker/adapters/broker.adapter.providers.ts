import { McpAdapterBase, McpToolResults } from "@cyanmycelium/mcp-core";
import type { McpResourceContent, McpToolResult } from "@cyanmycelium/mcp-core";
import type { IBrokerContext, IBrokerProviderInfo } from "../broker.context";

/** URI of the static resource that lists every provider slot. */
export const PROVIDERS_URI = "broker://providers";

/** RFC 6570 URI template for one specific provider slot. */
export const PROVIDER_URI_TEMPLATE = "broker://providers/{name}";

/**
 * The URI of one slot's resource, as the `broker://providers/{name}` template
 * expands it. The name is percent-encoded, so a slot such as `a/b` is
 * `broker://providers/a%2Fb`; a subscription must use that exact string.
 */
export function providerUri(name: string): string {
    return `broker://providers/${encodeURIComponent(name)}`;
}

/**
 * Adapter that exposes the broker's current provider slots, both as a list
 * (read of `broker://providers`) and individually (`broker://providers/<name>`).
 */
export class BrokerProvidersAdapter extends McpAdapterBase {
    constructor(private readonly _context: IBrokerContext) {
        super("broker");

        // Each batch of slot changes updates the list once, and each slot's
        // own resource once. The server delivers them only to a session that
        // subscribed to that exact URI.
        _context.onProvidersChanged?.subscribe((names) => {
            if (names.length === 0) return;
            this._forwardResourceContentChanged(PROVIDERS_URI);
            for (const name of new Set(names)) this._forwardResourceContentChanged(providerUri(name));
        });
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

    private _listSnapshot(): { count: number; providers: IBrokerProviderInfo[] } {
        const providers = this._context.getProvidersInfo();
        return { count: providers.length, providers };
    }
}
