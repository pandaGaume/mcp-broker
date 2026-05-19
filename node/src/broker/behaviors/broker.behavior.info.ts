import { McpBehavior } from "@cyanmycelium/mcp-core";
import type { McpResource, McpTool } from "@cyanmycelium/mcp-core";
import { BROKER_INFO_URI, BrokerInfoAdapter } from "../adapters/broker.adapter.info.js";
import { brokerBaselineResourceDescription, brokerBaselineResourceName, brokerBaselineToolDescription } from "../broker.grammars.js";
import type { BrokerContext } from "../broker.context.js";

/**
 * Exposes basic broker identity (name, version, uptime, listening config) as
 * one tool (`broker_info`) and one resource (`broker://info`).
 *
 * An MCP agent typically calls `broker_info` first to learn who it is talking to.
 */
export class BrokerInfoBehavior extends McpBehavior {
    public static readonly NAMESPACE = "broker";

    constructor(context: BrokerContext) {
        super(new BrokerInfoAdapter(context), {
            namespace: BrokerInfoBehavior.NAMESPACE,
        });
    }

    protected override _buildResources(): McpResource[] {
        return [
            {
                uri: BROKER_INFO_URI,
                name: brokerBaselineResourceName(BROKER_INFO_URI),
                mimeType: "application/json",
                description: brokerBaselineResourceDescription(BROKER_INFO_URI),
            },
        ];
    }

    protected override _buildTools(): McpTool[] {
        return [
            {
                name: "broker_info",
                description: brokerBaselineToolDescription("broker_info"),
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
            },
        ];
    }
}
