/**
 * app-host: the application IS the provider, and the broker is what serves it.
 *
 * The difference from ../../browser-provider/ is the topology, not the API:
 * there, a page you load publishes a demo server; here, the application's own
 * live state (a counter that the UI and an MCP tool both mutate) is exposed to
 * MCP clients as a matter of course, and it does so on load with no button.
 *
 * THE ORDERING DEPENDENCY IS GONE, and that is the whole argument for this
 * topology. The usual browser-provider deployment has two things to start, in
 * order: a broker, and then a static server or dev server for the page. Get the
 * order wrong, or point the page at the wrong port, and the socket never opens.
 * Here there is one process. The page cannot exist before the broker, because
 * the broker served it, and the broker's address cannot be wrong, because it is
 * `location.host`.
 */
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";

const SLOT = "counter-app";

const statusEl = document.getElementById("status");
const counterEl = document.getElementById("counter");
const logEl = document.getElementById("log");

const log = (text, level = "") => {
    const line = document.createElement("div");
    line.className = level;
    line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
    logEl.prepend(line);
};

const setStatus = (text, level = "") => {
    statusEl.textContent = text;
    statusEl.className = level;
};

// ── Application state, the thing worth exposing ─────────────────────────────

let count = 0;

function render() {
    counterEl.textContent = String(count);
}

function bump(by = 1) {
    count += by;
    render();
    return count;
}

document.getElementById("bump").addEventListener("click", () => {
    log(`UI: increment -> ${bump()}`);
});

// ── MCP surface over that state ─────────────────────────────────────────────

const TOOLS = [
    {
        name: "read_counter",
        description: "Reads the application's live counter.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "increment",
        description: "Increments the application's live counter and returns the new value. The page updates immediately.",
        inputSchema: {
            type: "object",
            properties: { by: { type: "number", description: "Amount to add. Default 1." } },
            additionalProperties: false,
        },
    },
];

function handle(frame) {
    const { id, method, params = {} } = frame;
    if (id === undefined || id === null) return undefined;

    const result = (value) => ({ jsonrpc: "2.0", id, result: value });
    const text = (t) => result({ content: [{ type: "text", text: t }] });

    if (method === "initialize") {
        return result({
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "counter-app", version: "1.0.0" },
        });
    }
    if (method === "tools/list") return result({ tools: TOOLS });
    if (method === "tools/call") {
        const args = params.arguments ?? {};
        if (params.name === "read_counter") return text(String(count));
        if (params.name === "increment") {
            const next = bump(Number.isFinite(Number(args.by)) ? Number(args.by) : 1);
            log(`MCP: increment -> ${next}`, "ok");
            return text(String(next));
        }
        return result({ content: [{ type: "text", text: `Unknown tool: ${params.name}` }], isError: true });
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── Publish, on load ────────────────────────────────────────────────────────

const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/provider/${SLOT}`;

// `aggregate: true` so an MCP host pointed at `_all` sees this app appear the
// moment the tab opens, and see it go when the tab closes, without being
// reconfigured. Sent as the first frame on open; see ../../browser-provider/.
const transport = new DirectTransport(wsUrl, { aggregate: true });

// Handlers before connect(). Always.
transport.onMessage = (raw) => {
    const response = handle(JSON.parse(raw));
    if (response) transport.send(JSON.stringify(response));
};

transport.onOpen = () => {
    setStatus(`Published on "${SLOT}". An MCP client can drive this page now.`, "ok");
    log(`provider: socket open on ${wsUrl}`, "ok");
};

transport.onError = (err) => {
    setStatus(err.message, "err");
    log(err.message, "err");
};

transport.onClose = () => {
    setStatus("Disconnected. Reload to publish again.", "err");
    log("provider: socket closed, the slot is free");
};

// Release the slot before the page goes away, so a reload is not refused with
// close code 1008 by its own predecessor. See ../../provider-lifecycle/.
window.addEventListener("pagehide", () => transport.close());

render();
setStatus("connecting…");
transport.connect();
