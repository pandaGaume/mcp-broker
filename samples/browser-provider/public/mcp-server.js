/**
 * A tiny MCP server, written by hand in plain JSON-RPC.
 *
 * NOTHING IN THIS FILE KNOWS ABOUT THE BROKER. That is the point: an MCP server
 * is a function from a JSON-RPC request frame to a response frame, and the
 * broker tunnel is just the pipe those frames travel through. Swap this module
 * for `@cyanmycelium/mcp-core`'s `McpServer`, or for the official
 * `@modelcontextprotocol/sdk` `Server`, and `app.js` does not change: both
 * expose the same two hooks the transport needs, "here is a frame from the
 * peer" and "send this frame to the peer".
 *
 * It answers the four methods a broker slot actually needs:
 *   initialize                → the handshake, sent by every client AND by the
 *                               broker itself when the provider joins `_all`
 *   notifications/initialized → acknowledged by staying silent (it has no id)
 *   tools/list                → the catalog
 *   tools/call                → the work
 *
 * Anything else gets -32601, which is the correct answer and is what the
 * broker's aggregate expects for, say, `prompts/list` on a tools-only provider.
 */

/** MCP revision this server speaks. */
const PROTOCOL_VERSION = "2025-06-18";

/** The catalog. Exported so the page can render it from the same source it serves. */
export const TOOLS = [
    {
        name: "page_title",
        description: "Returns the document title of the browser tab hosting this MCP server.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "echo",
        description: "Returns the text it was given, unchanged. The simplest possible end-to-end proof.",
        inputSchema: {
            type: "object",
            properties: { text: { type: "string", description: "Text to echo back." } },
            required: ["text"],
            additionalProperties: false,
        },
    },
    {
        name: "viewport",
        description: "Reports the live size of the browser viewport hosting this provider. Data a server-side MCP server cannot have.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
];

const ok = (text) => ({ content: [{ type: "text", text }] });

/**
 * Builds the server.
 *
 * @param {object} options
 * @param {string} options.name                        Server name reported at initialize.
 * @param {(line: string, level?: string) => void} [options.onActivity]
 *        Called for every frame handled, so the page can show the traffic.
 * @returns {{ handle(frame: object): object | undefined }}
 *          `handle` returns the response frame, or `undefined` for a
 *          notification (a frame with no `id`), which must never be answered.
 */
export function createServer({ name, onActivity = () => {} }) {
    const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
    const failure = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

    return {
        handle(frame) {
            const { id, method, params = {} } = frame ?? {};

            // A notification has no id and MUST NOT be answered. Answering one
            // puts an unmatched response on the wire, which the broker logs as
            // "provider sent a response nobody asked for".
            if (id === undefined || id === null) {
                onActivity(`← ${method} (notification)`);
                return undefined;
            }

            onActivity(`← ${method}`);

            switch (method) {
                case "initialize":
                    return result(id, {
                        protocolVersion: PROTOCOL_VERSION,
                        // Declare only what you implement. Claiming `prompts` here
                        // and then answering -32601 makes the broker's aggregate
                        // log a catalog error on every refresh.
                        capabilities: { tools: {} },
                        serverInfo: { name, version: "1.0.0" },
                    });

                case "tools/list":
                    return result(id, { tools: TOOLS });

                case "tools/call": {
                    const tool = params.name;
                    const args = params.arguments ?? {};
                    onActivity(`  tools/call → ${tool}(${JSON.stringify(args)})`, "ok");

                    if (tool === "page_title") return result(id, ok(document.title));
                    if (tool === "echo") return result(id, ok(String(args.text ?? "")));
                    if (tool === "viewport") {
                        return result(id, ok(JSON.stringify({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }, null, 2)));
                    }

                    // An unknown TOOL is a tool-level error, not a protocol
                    // error: it comes back as a successful result carrying
                    // isError, so the model can read and recover from it.
                    return result(id, { content: [{ type: "text", text: `Unknown tool: ${tool}` }], isError: true });
                }

                default:
                    // An unknown METHOD is a protocol error. -32601 is expected
                    // and harmless; the broker aggregate treats it as "this
                    // provider does not offer that surface".
                    return failure(id, -32601, `Method not found: ${method}`);
            }
        },
    };
}
