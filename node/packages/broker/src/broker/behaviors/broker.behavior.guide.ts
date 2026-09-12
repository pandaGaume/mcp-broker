import { McpBehavior } from "@cyanmycelium/mcp-core";
import type { McpResource, McpResourceTemplate, McpTool } from "@cyanmycelium/mcp-core";
import { BrokerGuideAdapter } from "../adapters/broker.adapter.guide";
import { BROKER_GUIDES, BROKER_GUIDE_MIME_TYPE, BROKER_GUIDE_TOPICS, BROKER_GUIDE_URI_TEMPLATE } from "../broker.guides";
import {
    brokerBaselinePropertyDescription,
    brokerBaselineResourceDescription,
    brokerBaselineResourceName,
    brokerBaselineResourceTemplateDescription,
    brokerBaselineResourceTemplateName,
    brokerBaselineToolDescription,
} from "../broker.grammars";
import type { IBrokerContext } from "../broker.context";

/**
 * Teaches an agent how to integrate with this broker, from inside the broker.
 *
 * Every page is exposed twice: as a resource (`broker://guide/<topic>`, plus
 * the `broker://guide/{topic}` template) and through the `broker_guide` tool,
 * because a fair number of MCP clients implement tools and ignore resources
 * entirely. Both return the same text.
 *
 * This is the answer to "an agent asked to embed mcp-broker has to find and
 * read several READMEs across two packages": it does not, it reads this.
 */
export class BrokerGuideBehavior extends McpBehavior {
    public static readonly NAMESPACE = "broker_guide";

    constructor(context: IBrokerContext) {
        super(new BrokerGuideAdapter(context), {
            namespace: BrokerGuideBehavior.NAMESPACE,
        });
    }

    protected override _buildResources(): McpResource[] {
        // Every page is listed individually rather than hidden behind the
        // template: a client that only reads `resources/list` must be able to
        // see that a troubleshooting page exists without guessing its name.
        return BROKER_GUIDES.map((guide) => ({
            uri: guide.uri,
            name: brokerBaselineResourceName(guide.uri),
            mimeType: BROKER_GUIDE_MIME_TYPE,
            description: brokerBaselineResourceDescription(guide.uri),
        }));
    }

    protected override _buildTemplate(): McpResourceTemplate[] {
        return [
            {
                uriTemplate: BROKER_GUIDE_URI_TEMPLATE,
                name: brokerBaselineResourceTemplateName(BROKER_GUIDE_URI_TEMPLATE),
                mimeType: BROKER_GUIDE_MIME_TYPE,
                description: brokerBaselineResourceTemplateDescription(BROKER_GUIDE_URI_TEMPLATE),
            },
        ];
    }

    protected override _buildTools(): McpTool[] {
        return [
            {
                name: "broker_guide",
                description: brokerBaselineToolDescription("broker_guide"),
                inputSchema: {
                    type: "object",
                    properties: {
                        topic: {
                            type: "string",
                            // Enumerated in the schema so a client cannot invent
                            // a topic: the valid set is small and closed.
                            enum: [...BROKER_GUIDE_TOPICS],
                            description: brokerBaselinePropertyDescription("broker_guide", "topic"),
                        },
                    },
                    additionalProperties: false,
                },
            },
        ];
    }
}
