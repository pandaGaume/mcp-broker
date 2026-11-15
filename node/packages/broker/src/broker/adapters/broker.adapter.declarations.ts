import { McpAdapterBase, McpToolResults } from "@cyanmycelium/mcp-core";
import type { IMcpRequestContext, McpResourceContent, McpToolResult } from "@cyanmycelium/mcp-core";
import { OPERATOR_META_KEY } from "../../authority/broker.authority";
import type { IBrokerContext } from "../broker.context";

/**
 * Runs `broker_declaration_withdraw`: an operator removes the authorization
 * declarations of a provider that is gone and will not withdraw them itself
 * (`broker/authorization/withdraw`). Its domain becomes free to declare from
 * another identity; the protected slots of the security file stay closed.
 *
 * Who may call it is decided before the frame gets here, by the policy
 * (`broker.authorization.admin` on the `_broker` resource). Who did call it
 * comes from the broker itself, in `_meta`, and goes into the audit. A broker
 * with no policy at all refuses: anyone reaching it could free a domain.
 */
export class BrokerDeclarationsAdapter extends McpAdapterBase {
    constructor(private readonly _context: IBrokerContext) {
        super("broker");
    }

    public async readResourceAsync(_uri: string): Promise<McpResourceContent | undefined> {
        return undefined;
    }

    public async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>, request?: IMcpRequestContext): Promise<McpToolResult> {
        if (toolName !== "broker_declaration_withdraw") return McpToolResults.error(`Unknown tool: ${toolName}`);

        const operator = request?.meta?.[OPERATOR_META_KEY] as { subjects?: unknown; policy?: unknown } | undefined;
        if (!operator || operator.policy !== true) {
            return McpToolResults.error(
                "broker_declaration_withdraw needs an authorization policy: grant broker.authorization.admin on /_system/broker to the operators who may withdraw declarations. " +
                    "A broker without a policy lets anyone reach it, so it refuses rather than let anyone free a domain."
            );
        }
        const principal = args["principal"];
        const slot = args["slot"];
        if (typeof principal !== "string" || principal.length === 0) {
            return McpToolResults.error('"principal" is required: the provider identity whose declarations to withdraw, as broker_diagnose lists it (principalId).');
        }
        if (slot !== undefined && (typeof slot !== "string" || slot.length === 0)) return McpToolResults.error('"slot", when given, must be a non-empty slot name.');
        const by = Array.isArray(operator.subjects) ? operator.subjects.filter((s): s is string => typeof s === "string") : [];
        const withdrawn = this._context.withdrawDeclarations?.(principal, slot as string | undefined, by) ?? [];
        if (withdrawn.length === 0) {
            return McpToolResults.error(
                `No accepted declaration from provider "${principal}"${slot !== undefined ? ` on slot "${slot}"` : ""}. It may have been withdrawn already; broker_diagnose lists the declarations in force.`
            );
        }
        return McpToolResults.json({
            withdrawn,
            by,
            note: "Declarations withdrawn. Their domains are free to declare again; protected slots stay closed, as the security file configures them.",
        });
    }
}
