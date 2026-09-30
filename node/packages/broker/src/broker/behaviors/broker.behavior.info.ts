import { McpBehavior } from "@cyanmycelium/mcp-core";
import type { McpResource, McpResourceContent, McpTool } from "@cyanmycelium/mcp-core";
import { BROKER_INFO_URI, BrokerInfoAdapter } from "../adapters/broker.adapter.info";
import { brokerBaselineResourceDescription, brokerBaselineResourceName, brokerBaselineToolDescription } from "../broker.grammars";
import type { IBrokerContext } from "../broker.context";

/**
 * Exposes basic broker identity (name, version, uptime, listening config) as
 * one tool (`broker_info`) and one resource (`broker://info`).
 *
 * An MCP agent typically calls `broker_info` first to learn who it is talking to.
 */
export class BrokerInfoBehavior extends McpBehavior {
    public static readonly NAMESPACE = "broker";

    constructor(context: IBrokerContext) {
        super(new BrokerInfoAdapter(context), {
            namespace: BrokerInfoBehavior.NAMESPACE,
        });
    }

    /**
     * Always reads live. `McpBehavior` caches the content of its root
     * resource on first read and never refreshes it, which suits static
     * content but froze this snapshot at whatever the first reader saw.
     */
    public override readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        return this.adapter.readResourceAsync(uri);
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
