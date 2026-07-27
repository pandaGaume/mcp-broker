/**
 * toolbox-server.js — the demo MCP server.
 *
 * A generic "toolbox" MCP server built with the official
 * `@modelcontextprotocol/sdk`. It is plain MCP: nothing here knows about the
 * broker. `app.js` wires it to a `BrokerTunnelTransport` to tunnel it through.
 *
 * Tool and resource definitions are exported as data (`TOOLS`, `RESOURCES`)
 * so the UI can render a catalog from the same source the server advertises.
 *
 * Pinned to an exact SDK version: the CDN-served build of newer releases
 * trips a zod resolution bug. Bump deliberately after testing.
 */
import { Server } from "https://esm.sh/@modelcontextprotocol/sdk@1.12.3/server/index.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from "https://esm.sh/@modelcontextprotocol/sdk@1.12.3/types.js";

/** Tool catalog — advertised by `tools/list` and rendered by the UI. */
export const TOOLS = [
    {
        name: "echo",
        description: "Returns the text it was given, unchanged.",
        inputSchema: {
            type: "object",
            properties: { text: { type: "string", description: "Text to echo back." } },
            required: ["text"],
            additionalProperties: false,
        },
    },
    {
        name: "add",
        description: "Adds two numbers and returns the sum.",
        inputSchema: {
            type: "object",
            properties: {
                a: { type: "number", description: "First addend." },
                b: { type: "number", description: "Second addend." },
            },
            required: ["a", "b"],
            additionalProperties: false,
        },
    },
    {
        name: "random",
        description: "Returns a random number in the half-open interval [min, max).",
        inputSchema: {
            type: "object",
            properties: {
                min: { type: "number", description: "Lower bound (default 0)." },
                max: { type: "number", description: "Upper bound (default 1)." },
            },
            additionalProperties: false,
        },
    },
    {
        name: "note_set",
        description: "Stores a string value under a key in the in-memory note store.",
        inputSchema: {
            type: "object",
            properties: {
                key: { type: "string", description: "Note key." },
                value: { type: "string", description: "Note value." },
            },
            required: ["key", "value"],
            additionalProperties: false,
        },
    },
    {
        name: "note_get",
        description: "Reads back the value previously stored under a key.",
        inputSchema: {
            type: "object",
            properties: { key: { type: "string", description: "Note key to read." } },
            required: ["key"],
            additionalProperties: false,
        },
    },
    {
        name: "note_list",
        description: "Lists every key currently in the note store.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
];

/** Resource catalog — advertised by `resources/list` and rendered by the UI. */
export const RESOURCES = [
    {
        uri: "demo://clock",
        name: "Server clock",
        mimeType: "text/plain",
        description: "The provider's current wall-clock time, ISO-8601.",
    },
    {
        uri: "demo://notes",
        name: "Note store",
        mimeType: "application/json",
        description: "Every stored note as a JSON object of key/value pairs.",
    },
];

const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

/**
 * Builds the demo toolbox MCP server. Each call gets its own note store.
 *
 * @param {object} opts
 * @param {string} opts.name                                Server / slot name.
 * @param {(msg: string, level?: string) => void} [opts.onActivity]
 *        Called on each tool call, resource read, and on the initialize
 *        handshake — lets the UI log tunnel traffic without this module
 *        depending on the DOM.
 * @returns {import("https://esm.sh/@modelcontextprotocol/sdk@1.12.3/server/index.js").Server}
 */
export function createToolboxServer({ name, onActivity = () => {} }) {
    /** In-memory note store, shared by the note_* tools and demo://notes. */
    const notes = new Map();

    const server = new Server({ name, version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name: tool, arguments: args = {} } = req.params;
        onActivity(`tools/call → ${tool}(${JSON.stringify(args)})`, "info");

        switch (tool) {
            case "echo":
                return ok(String(args.text ?? ""));
            case "add": {
                const a = Number(args.a);
                const b = Number(args.b);
                if (!Number.isFinite(a) || !Number.isFinite(b)) {
                    return fail("add: 'a' and 'b' must both be numbers.");
                }
                return ok(String(a + b));
            }
            case "random": {
                const min = Number.isFinite(Number(args.min)) ? Number(args.min) : 0;
                const max = Number.isFinite(Number(args.max)) ? Number(args.max) : 1;
                return ok(String(min + Math.random() * (max - min)));
            }
            case "note_set": {
                const key = String(args.key ?? "");
                if (!key) return fail("note_set: 'key' is required.");
                notes.set(key, String(args.value ?? ""));
                return ok(`Stored note "${key}".`);
            }
            case "note_get": {
                const key = String(args.key ?? "");
                if (!notes.has(key)) return fail(`note_get: no note named "${key}".`);
                return ok(notes.get(key));
            }
            case "note_list":
                return ok(JSON.stringify([...notes.keys()]));
            default:
                return fail(`Unknown tool: ${tool}`);
        }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        const { uri } = req.params;
        onActivity(`resources/read → ${uri}`, "info");
        if (uri === "demo://clock") {
            return { contents: [{ uri, mimeType: "text/plain", text: new Date().toISOString() }] };
        }
        if (uri === "demo://notes") {
            return {
                contents: [{ uri, mimeType: "application/json", text: JSON.stringify(Object.fromEntries(notes)) }],
            };
        }
        throw new Error(`Unknown resource: ${uri}`);
    });

    // Fires when an MCP client finishes the initialize handshake through the
    // tunnel — proof the broker relayed a real client end to end.
    server.oninitialized = () => onActivity("An MCP client completed the initialize handshake.", "ok");

    return server;
}
