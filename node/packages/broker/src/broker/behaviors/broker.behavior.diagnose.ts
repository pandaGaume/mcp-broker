import { McpBehavior } from "@cyanmycelium/mcp-core";
import type { McpTool } from "@cyanmycelium/mcp-core";
import { BrokerDiagnoseAdapter } from "../adapters/broker.adapter.diagnose";
import { brokerBaselinePropertyDescription, brokerBaselineToolDescription } from "../broker.grammars";
import type { IBrokerContext } from "../broker.context";

/**
 * Exposes `broker_diagnose({ slot? })`: the live state of the broker plus the
 * problems it can prove about its own wiring, each with a symptom, the
 * evidence, and a fix.
 *
 * It exists because the raw counters were not enough. `provider_status`
 * already reported `pendingCount`, and that number is what located a
 * transport/path mismatch in the field, but only after someone thought to
 * correlate it with the transport kind. That correlation is mechanical, so
 * the broker does it here instead of leaving it to the reader.
 *
 * Tool-only, no resource: a diagnosis must never be served from a cache.
 */
export class BrokerDiagnoseBehavior extends McpBehavior {
    public static readonly NAMESPACE = "broker_diagnostics";

    constructor(context: IBrokerContext) {
        super(new BrokerDiagnoseAdapter(context), {
            namespace: BrokerDiagnoseBehavior.NAMESPACE,
        });
    }

    protected override _buildTools(): McpTool[] {
        return [
            {
                name: "broker_diagnose",
                description: brokerBaselineToolDescription("broker_diagnose"),
                inputSchema: {
                    type: "object",
                    properties: {
                        slot: {
                            type: "string",
                            description: brokerBaselinePropertyDescription("broker_diagnose", "slot"),
                        },
                    },
                    additionalProperties: false,
                },
            },
        ];
    }
}
