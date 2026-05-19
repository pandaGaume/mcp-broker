import { McpAdapterBase, McpToolResults } from "@cyanmycelium/mcp-core";
import type { McpResourceContent, McpToolResult } from "@cyanmycelium/mcp-core";
import type { BrokerContext } from "../broker.context.js";

/** URI of the static resource backing the `broker_info` snapshot. */
export const BROKER_INFO_URI = "broker://info";

/**
 * Read-only adapter that produces a snapshot of the broker's identity and
 * configuration. Backed by the live {@link BrokerContext}.
 */
export class BrokerInfoAdapter extends McpAdapterBase {
    constructor(private readonly _context: BrokerContext) {
        super("broker");
    }

    public async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        if (uri !== BROKER_INFO_URI) return undefined;
        return {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(this._snapshot()),
        };
    }

    public async executeToolAsync(_uri: string, toolName: string, _args: Record<string, unknown>): Promise<McpToolResult> {
        if (toolName !== "broker_info") {
            return McpToolResults.error(`Unknown tool: ${toolName}`);
        }
        return McpToolResults.json(this._snapshot());
    }

    private _snapshot() {
        const c = this._context;
        return {
            name: c.name,
            version: c.version,
            startedAt: c.startedAt?.toISOString() ?? null,
            uptimeSeconds: c.uptimeSeconds,
            host: c.host ?? "0.0.0.0",
            port: c.port,
            tls: c.tls,
            paths: c.paths,
        };
    }
}
