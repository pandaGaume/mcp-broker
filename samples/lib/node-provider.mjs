/**
 * A provider in Node, in one function.
 *
 * Same shape as the browser page in `samples/browser-provider/`, and for the
 * same reason: `@cyanmycelium/mcp-broker-provider` is isomorphic, so the wiring
 * is identical on both sides. Used by the samples that need a provider to exist
 * without a browser open.
 *
 * The three rules the browser sample marks as WRONG CHOICE apply here too:
 *   1. DirectTransport goes with `/provider/<slot>` and plain frames.
 *   2. Assign `onMessage` before calling `connect()`.
 *   3. Call `close()` when the process goes away, or the slot stays occupied.
 */
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";

if (typeof globalThis.WebSocket !== "function") {
    throw new Error(
        "This Node build has no global WebSocket, which the provider transports use. " +
            "Node 22 has it by default; Node 20 needs --experimental-websocket, e.g. " +
            'NODE_OPTIONS="--experimental-websocket" node <script>. Alternatively assign a ws-based ' +
            "polyfill to globalThis.WebSocket before importing @cyanmycelium/mcp-broker-provider."
    );
}

/**
 * Publishes a small MCP server on `slot` and resolves once the socket is open.
 *
 * @param {object} options
 * @param {string}  options.brokerUrl  Broker HTTP base, e.g. "http://localhost:3000".
 * @param {string}  options.slot       Slot to claim.
 * @param {boolean} [options.aggregate] Join `_all` as well. Default false.
 * @param {Array}   [options.tools]     Tool definitions; defaults to one `ping` tool.
 * @param {(name: string, args: object) => string} [options.call]
 *        Runs a tool and returns its text. Defaults to a timestamped pong.
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ close(): void, slot: string, url: string }>}
 */
export function publishProvider(options) {
    const { brokerUrl, slot, aggregate = false, log = () => {} } = options;

    const tools = options.tools ?? [
        {
            name: "ping",
            description: `Answers with a timestamp. Proves the "${slot}" slot is live.`,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
    ];

    const call = options.call ?? (() => `pong from "${slot}" at ${new Date().toISOString()}`);

    // http -> ws, https -> wss. Same host, same port: the broker serves both on
    // one listener, which is why this topology needs exactly one process.
    const url = `${brokerUrl.replace(/^http/, "ws").replace(/\/$/, "")}/provider/${encodeURIComponent(slot)}`;

    const transport = new DirectTransport(url, { aggregate });

    // RULE 2: handlers first, connect() last. The broker sends `initialize` to a
    // newly aggregated provider immediately and silently drops it from `_all` if
    // the handshake times out, so a handler assigned after connect() races that
    // frame.
    transport.onMessage = (raw) => {
        let frame;
        try {
            frame = JSON.parse(raw);
        } catch {
            log(`[${slot}] non-JSON frame from broker: ${raw.slice(0, 120)}`);
            return;
        }
        const response = handle(frame);
        if (response) transport.send(JSON.stringify(response));
    };

    transport.onError = (err) => log(`[${slot}] ${err.message}`);
    transport.onClose = () => log(`[${slot}] socket closed, the slot is free`);

    const handle = (frame) => {
        const { id, method, params = {} } = frame ?? {};
        if (id === undefined || id === null) return undefined; // notification: never answer

        if (method === "initialize") {
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: `node-provider (${slot})`, version: "1.0.0" },
                },
            };
        }
        if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };
        if (method === "tools/call") {
            return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: call(params.name, params.arguments ?? {}) }] } };
        }
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    };

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Provider "${slot}" did not open a socket to ${url} within 10s.`)), 10_000);

        transport.onOpen = () => {
            clearTimeout(timer);
            log(`[${slot}] published on ${url}${aggregate ? " (joining _all)" : ""}`);
            resolve({
                slot,
                url,
                // RULE 3: an explicit release. Without it the slot stays claimed
                // until the broker's heartbeat reaps the socket, and the next
                // process to ask for the slot is refused with close code 1008.
                close: () => transport.close(),
            });
        };

        transport.connect();
    });
}
