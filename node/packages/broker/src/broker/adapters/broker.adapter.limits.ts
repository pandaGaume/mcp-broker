import { McpAdapterBase, McpToolResults } from "@cyanmycelium/mcp-core";
import type { IMcpRequestContext, McpResourceContent, McpToolResult } from "@cyanmycelium/mcp-core";
import { OPERATOR_META_KEY } from "../../authority/broker.authority";
import type { IBrokerContext } from "../broker.context";

/**
 * Runs `broker_limits_release`: an operator frees the execution-limit slots a
 * stuck call still holds, after checking its native work stopped.
 *
 * The only way to do this from a running CLI broker. Without it, a few lost
 * answers on a slot with a `concurrency` limit would lock that slot until
 * someone wrote code against the embedding API.
 *
 * Who may call it is decided before the frame gets here, by the policy
 * (`broker.limits.admin` on the `_broker` resource). Who did call it comes
 * from the broker itself, in `_meta`, and goes into the audit. A broker with
 * no policy at all refuses: anyone reaching it could release slots.
 */
export class BrokerLimitsAdapter extends McpAdapterBase {
    constructor(private readonly _context: IBrokerContext) {
        super("broker");
    }

    public async readResourceAsync(_uri: string): Promise<McpResourceContent | undefined> {
        return undefined;
    }

    public async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>, request?: IMcpRequestContext): Promise<McpToolResult> {
        if (toolName !== "broker_limits_release") return McpToolResults.error(`Unknown tool: ${toolName}`);

        const operator = request?.meta?.[OPERATOR_META_KEY] as { subjects?: unknown; policy?: unknown } | undefined;
        if (!operator || operator.policy !== true) {
            return McpToolResults.error(
                "broker_limits_release needs an authorization policy: grant broker.limits.admin on /_system/broker to the operators who may release slots. " +
                    "A broker without a policy lets anyone reach it, so it refuses rather than let anyone release."
            );
        }
        const slot = args["slot"];
        const requestId = args["requestId"];
        if (typeof slot !== "string" || slot.length === 0 || typeof requestId !== "string" || requestId.length === 0) {
            return McpToolResults.error('Both "slot" and "requestId" are required, as broker_diagnose lists the held call.');
        }
        const by = Array.isArray(operator.subjects) ? operator.subjects.filter((s): s is string => typeof s === "string") : [];
        const released = this._context.releaseLimitCall?.(slot, requestId, by) ?? false;
        if (!released) {
            return McpToolResults.error(
                `No held call "${requestId}" on slot "${slot}". It may have been answered or released already; broker_diagnose lists the calls still held.`
            );
        }
        return McpToolResults.json({ released: true, slot, requestId, by, note: "Slots released. No quota was refunded." });
    }
}
