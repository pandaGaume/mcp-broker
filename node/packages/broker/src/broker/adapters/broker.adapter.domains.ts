import { McpAdapterBase, McpToolResults } from "@cyanmycelium/mcp-core";
import type { IMcpRequestContext, McpResourceContent, McpToolResult } from "@cyanmycelium/mcp-core";
import { OPERATOR_META_KEY } from "../../authority/broker.authority";
import type { IBrokerContext } from "../broker.context";

/** URI of the resource listing every authorization domain and the owner of each subtree. */
export const BROKER_DOMAINS_URI = "broker://domains";

/**
 * Serves `broker://domains`: which provider, on which slot, decides for which
 * subtree of each domain. A client reads it to find the slot that serves
 * `/production/site2`.
 *
 * Filtered per caller: a subtree is listed only to a caller the policy grants
 * at least one of the domain's capabilities on it, or `broker.authorization.admin`
 * on `_broker`. Who is reading comes from the broker itself, in `_meta`.
 */
export class BrokerDomainsAdapter extends McpAdapterBase {
    constructor(private readonly _context: IBrokerContext) {
        super("broker");
    }

    public async readResourceAsync(uri: string, request?: IMcpRequestContext): Promise<McpResourceContent | undefined> {
        if (uri !== BROKER_DOMAINS_URI) return undefined;
        const operator = request?.meta?.[OPERATOR_META_KEY] as { subjects?: unknown; policy?: unknown } | undefined;
        // No policy: `_broker` is open to whoever reaches it, and so is this list.
        // A policy but no operator key: the frame did not come through the
        // broker's own routing, so nothing is known about the reader.
        const subjects =
            operator?.policy === true
                ? Array.isArray(operator.subjects)
                    ? operator.subjects.filter((s): s is string => typeof s === "string")
                    : []
                : operator?.policy === false
                  ? null
                  : [];
        const domains = this._context.getDomainsInfo?.(subjects) ?? [];
        return { uri, mimeType: "application/json", text: JSON.stringify({ domains }) };
    }

    public async executeToolAsync(_uri: string, toolName: string): Promise<McpToolResult> {
        return McpToolResults.error(`Unknown tool: ${toolName}`);
    }
}
