import { McpAdapterBase, McpToolResults } from "@cyanmycelium/mcp-core";
import type { McpResourceContent, McpToolResult } from "@cyanmycelium/mcp-core";
import { BROKER_GUIDES, BROKER_GUIDE_MIME_TYPE, BROKER_GUIDE_TOPICS, brokerGuide, brokerGuideIndex, brokerGuideTopicFromUri } from "../broker.guides";
import type { IBrokerContext } from "../broker.context";

/**
 * Serves the broker's own integration documentation, so an agent that can
 * reach this slot never has to find a README.
 *
 * The prose lives in `broker.guides.ts` and is static, which is what makes it
 * safe to cache and to re-export to the markdown docs. What is NOT static is
 * the deployment it describes: port, scheme and URL paths are per-instance.
 * Rather than templating the guides, the adapter appends one short block of
 * effective values to every page, so a reader never has to guess whether the
 * defaults in the prose are the values in force here.
 */
export class BrokerGuideAdapter extends McpAdapterBase {
    constructor(private readonly _context: IBrokerContext) {
        super("broker");
    }

    public async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        const topic = brokerGuideTopicFromUri(uri);
        if (!topic) return undefined;
        const guide = brokerGuide(topic);
        if (!guide) return undefined;
        return {
            uri: guide.uri,
            mimeType: BROKER_GUIDE_MIME_TYPE,
            text: this._render(guide.content),
        };
    }

    public async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        if (toolName !== "broker_guide") {
            return McpToolResults.error(`Unknown tool: ${toolName}`);
        }

        const raw = args["topic"];
        if (raw === undefined || raw === null || raw === "") {
            // No topic is the discovery call: hand back the index page itself,
            // not a list of links, so a single call is already useful.
            const index = brokerGuide("index");
            return McpToolResults.text(this._render(index ? index.content : BROKER_GUIDES.map((g) => `- ${g.topic}: ${g.summary}`).join("\n")));
        }
        if (typeof raw !== "string") {
            return McpToolResults.error(`Invalid argument "topic": expected a string, got ${typeof raw}. Valid topics: ${BROKER_GUIDE_TOPICS.join(", ")}.`);
        }

        const guide = brokerGuide(raw.trim());
        if (!guide) {
            return McpToolResults.error(
                `Unknown guide topic "${raw}". Valid topics: ${BROKER_GUIDE_TOPICS.join(", ")}. ` +
                    `Call broker_guide with no argument for the index, which says which one to read.`
            );
        }
        return McpToolResults.text(this._render(guide.content));
    }

    /**
     * Machine-readable form of the index, for a caller that wants to plan its
     * reads without parsing a Markdown table. Exposed for the behavior's tool
     * schema documentation and for tests.
     */
    public index(): ReturnType<typeof brokerGuideIndex> {
        return brokerGuideIndex();
    }

    /**
     * Appends the effective configuration of THIS broker to a guide page.
     *
     * Everything in the block is read live from the context, so a deployment
     * that moved a path or enabled TLS does not silently contradict the prose
     * above it.
     */
    private _render(content: string): string {
        const c = this._context;
        const paths = c.paths;
        const scheme = c.tls ? "https" : "http";
        const wsScheme = c.tls ? "wss" : "ws";
        const authority = `${c.host && c.host !== "0.0.0.0" ? c.host : "localhost"}:${c.port}`;

        const block = [
            "",
            "---",
            "",
            "## Effective configuration of this broker",
            "",
            "The prose above uses the default paths. These are the values actually in",
            "force on the instance you are talking to.",
            "",
            "| what | value |",
            "|---|---|",
            `| broker | \`${c.name}\` ${c.version} |`,
            `| listening | \`${scheme}://${authority}\`${c.tls ? " (TLS on: providers use `wss://`, browser origins are `https://`)" : ""} |`,
            `| provider, dedicated socket | \`${wsScheme}://${authority}${paths.provider}/<slot>\` |`,
            `| provider, shared socket | \`${wsScheme}://${authority}${paths.providers}\` |`,
            `| client, Streamable HTTP | \`${scheme}://${authority}/<slot>${paths.mcp}\` |`,
            `| client, legacy SSE | \`${scheme}://${authority}/<slot>${paths.sse}\` + \`${scheme}://${authority}/<slot>${paths.messages}\` |`,
            `| client, raw WebSocket | \`${wsScheme}://${authority}/<slot>\` |`,
            "",
            "Call `broker_diagnose()` for the live state and the problems this broker can",
            "detect about its own wiring.",
        ].join("\n");

        return content + "\n" + block + "\n";
    }
}
