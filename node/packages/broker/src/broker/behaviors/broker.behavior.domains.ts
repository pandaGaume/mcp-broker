import { McpBehavior } from "@cyanmycelium/mcp-core";
import type { IMcpRequestContext, McpResource, McpResourceContent, McpTool } from "@cyanmycelium/mcp-core";
import { BROKER_DOMAINS_URI, BrokerDomainsAdapter } from "../adapters/broker.adapter.domains";
import { brokerBaselineResourceDescription, brokerBaselineResourceName } from "../broker.grammars";
import type { IBrokerContext } from "../broker.context";

/**
 * Exposes `broker://domains`: each authorization domain, its vocabulary and
 * the owner of each subtree, filtered by what the reader may see.
 * Resource-only.
 */
export class BrokerDomainsBehavior extends McpBehavior {
    public static readonly NAMESPACE = "broker_domains";

    constructor(context: IBrokerContext) {
        super(new BrokerDomainsAdapter(context), {
            namespace: BrokerDomainsBehavior.NAMESPACE,
        });
    }

    /** Always reads live, and per reader: never the cached root content. */
    public override readResourceAsync(uri: string, request?: IMcpRequestContext): Promise<McpResourceContent | undefined> {
        return this.adapter.readResourceAsync(uri, request);
    }

    protected override _buildResources(): McpResource[] {
        return [
            {
                uri: BROKER_DOMAINS_URI,
                name: brokerBaselineResourceName(BROKER_DOMAINS_URI),
                mimeType: "application/json",
                description: brokerBaselineResourceDescription(BROKER_DOMAINS_URI),
            },
        ];
    }

    protected override _buildTools(): McpTool[] {
        return [];
    }
}
