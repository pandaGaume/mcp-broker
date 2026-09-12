import { McpAdapterBase, McpToolResults } from "@cyanmycelium/mcp-core";
import type { McpResourceContent, McpToolResult } from "@cyanmycelium/mcp-core";
import { diagnoseBroker } from "../broker.diagnostics";
import type { IBrokerContext } from "../broker.context";

/**
 * Runs the broker's self-diagnosis on demand.
 *
 * Deliberately tool-only, with no backing resource: the answer is a snapshot
 * of live state, and a resource read can be served from the behavior's content
 * cache, which would hand a caller a stale diagnosis at exactly the moment it
 * matters. `broker://providers` is the resource for state you want cached;
 * this is the one you want fresh.
 */
export class BrokerDiagnoseAdapter extends McpAdapterBase {
    constructor(private readonly _context: IBrokerContext) {
        super("broker");
    }

    public async readResourceAsync(_uri: string): Promise<McpResourceContent | undefined> {
        return undefined;
    }

    public async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        if (toolName !== "broker_diagnose") {
            return McpToolResults.error(`Unknown tool: ${toolName}`);
        }

        const raw = args["slot"];
        if (raw !== undefined && raw !== null && typeof raw !== "string") {
            return McpToolResults.error(`Invalid argument "slot": expected a string, got ${typeof raw}. Omit it to diagnose the whole broker.`);
        }

        const slot = typeof raw === "string" && raw !== "" ? raw : undefined;
        const diagnosis = diagnoseBroker(this._context, slot);
        if (!diagnosis) {
            return McpToolResults.error(
                `Unknown slot: "${slot}". The broker has never seen that name. ` +
                    `Call providers_list to see the slots that exist, and note that slot names are case-sensitive. ` +
                    `Omit the argument to diagnose the whole broker.`
            );
        }
        return McpToolResults.json(diagnosis);
    }
}
