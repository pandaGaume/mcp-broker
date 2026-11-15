import { McpBehavior } from "@cyanmycelium/mcp-core";
import type { McpTool } from "@cyanmycelium/mcp-core";
import { BrokerDeclarationsAdapter } from "../adapters/broker.adapter.declarations";
import { brokerBaselinePropertyDescription, brokerBaselineToolDescription } from "../broker.grammars";
import type { IBrokerContext } from "../broker.context";

/**
 * Exposes `broker_declaration_withdraw({ principal, slot? })`, registered when
 * the host can withdraw declarations. Tool-only: it acts, it does not describe.
 */
export class BrokerDeclarationsBehavior extends McpBehavior {
    public static readonly NAMESPACE = "broker_declarations";

    constructor(context: IBrokerContext) {
        super(new BrokerDeclarationsAdapter(context), {
            namespace: BrokerDeclarationsBehavior.NAMESPACE,
        });
    }

    protected override _buildTools(): McpTool[] {
        return [
            {
                name: "broker_declaration_withdraw",
                description: brokerBaselineToolDescription("broker_declaration_withdraw"),
                inputSchema: {
                    type: "object",
                    properties: {
                        principal: { type: "string", description: brokerBaselinePropertyDescription("broker_declaration_withdraw", "principal") },
                        slot: { type: "string", description: brokerBaselinePropertyDescription("broker_declaration_withdraw", "slot") },
                    },
                    required: ["principal"],
                    additionalProperties: false,
                },
            },
        ];
    }
}
