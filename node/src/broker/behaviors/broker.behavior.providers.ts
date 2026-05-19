import { McpBehavior } from "@cyanmycelium/mcp-core";
import type { McpResource, McpResourceTemplate, McpTool } from "@cyanmycelium/mcp-core";
import { BrokerProvidersAdapter, PROVIDERS_URI, PROVIDER_URI_TEMPLATE } from "../adapters/broker.adapter.providers.js";
import {
    brokerBaselinePropertyDescription,
    brokerBaselineResourceDescription,
    brokerBaselineResourceName,
    brokerBaselineResourceTemplateDescription,
    brokerBaselineResourceTemplateName,
    brokerBaselineToolDescription,
} from "../broker.grammars.js";
import type { BrokerContext } from "../broker.context.js";

/**
 * Exposes the broker's provider slots so an MCP agent can discover what is
 * currently routable behind the broker, with two tools:
 *
 * - `providers_list` — every slot (including disconnected ones).
 * - `provider_status({ name })` — detail on one slot.
 *
 * Plus matching resources at `broker://providers` and `broker://providers/<name>`.
 */
export class BrokerProvidersBehavior extends McpBehavior {
    public static readonly NAMESPACE = "broker_providers";

    constructor(context: BrokerContext) {
        super(new BrokerProvidersAdapter(context), {
            namespace: BrokerProvidersBehavior.NAMESPACE,
        });
    }

    protected override _buildResources(): McpResource[] {
        return [
            {
                uri: PROVIDERS_URI,
                name: brokerBaselineResourceName(PROVIDERS_URI),
                mimeType: "application/json",
                description: brokerBaselineResourceDescription(PROVIDERS_URI),
            },
        ];
    }

    protected override _buildTemplate(): McpResourceTemplate[] {
        return [
            {
                uriTemplate: PROVIDER_URI_TEMPLATE,
                name: brokerBaselineResourceTemplateName(PROVIDER_URI_TEMPLATE),
                mimeType: "application/json",
                description: brokerBaselineResourceTemplateDescription(PROVIDER_URI_TEMPLATE),
            },
        ];
    }

    protected override _buildTools(): McpTool[] {
        return [
            {
                name: "providers_list",
                description: brokerBaselineToolDescription("providers_list"),
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
            },
            {
                name: "provider_status",
                description: brokerBaselineToolDescription("provider_status"),
                inputSchema: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            description: brokerBaselinePropertyDescription("provider_status", "name"),
                        },
                    },
                    required: ["name"],
                    additionalProperties: false,
                },
            },
        ];
    }
}
