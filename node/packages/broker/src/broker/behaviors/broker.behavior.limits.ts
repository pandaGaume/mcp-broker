import { McpBehavior } from "@cyanmycelium/mcp-core";
import type { McpTool } from "@cyanmycelium/mcp-core";
import { BrokerLimitsAdapter } from "../adapters/broker.adapter.limits";
import { brokerBaselinePropertyDescription, brokerBaselineToolDescription } from "../broker.grammars";
import type { IBrokerContext } from "../broker.context";

/**
 * Exposes `broker_limits_release({ slot, requestId })`, registered only when
 * execution limits are configured. Tool-only: it acts, it does not describe.
 */
export class BrokerLimitsBehavior extends McpBehavior {
    public static readonly NAMESPACE = "broker_limits";

    constructor(context: IBrokerContext) {
        super(new BrokerLimitsAdapter(context), {
            namespace: BrokerLimitsBehavior.NAMESPACE,
        });
    }

    protected override _buildTools(): McpTool[] {
        return [
            {
                name: "broker_limits_release",
                description: brokerBaselineToolDescription("broker_limits_release"),
                inputSchema: {
                    type: "object",
                    properties: {
                        slot: { type: "string", description: brokerBaselinePropertyDescription("broker_limits_release", "slot") },
                        requestId: { type: "string", description: brokerBaselinePropertyDescription("broker_limits_release", "requestId") },
                    },
                    required: ["slot", "requestId"],
                    additionalProperties: false,
                },
            },
        ];
    }
}
