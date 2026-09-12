/**
 * embedded: the broker as a LIBRARY inside an existing Node application.
 *
 * No `npx`, no child process, no config file. You own the lifetime, the port and
 * the shutdown, and you get two things a standalone broker cannot give you:
 *
 *   registerLoopbackProvider(name, transport)
 *       publish an MCP server that lives in this process, on a slot, with NO
 *       SOCKET AT ALL. No WebSocket, no serialization over a network, no
 *       reconnect logic, no slot contention. Just a transport object.
 *
 *   openInternalClient(name)
 *       call any slot from inside this process, without going through HTTP.
 *       Works for slots backed by a browser page too.
 *
 * Run:
 *   node server.mjs            run the demo, then keep serving until Ctrl+C
 *   node server.mjs --once     run the demo and exit (what CI wants)
 *   node server.mjs --port 4000
 */
import { WsTunnelBuilder } from "@cyanmycelium/mcp-broker";
import { connectMcp, toolText } from "../lib/mcp-http-client.mjs";
import { publishProvider } from "../lib/node-provider.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const port = Number(arg("--port", "3500"));
const host = "127.0.0.1";
const base = `http://${host}:${port}`;
const once = argv.includes("--once");

// ---------------------------------------------------------------------------
// 1. An MCP server that lives in this process
// ---------------------------------------------------------------------------

/** Application state, the thing worth exposing over MCP. */
const jobs = new Map([
    ["job-1", { status: "running", progress: 0.42 }],
    ["job-2", { status: "queued", progress: 0 }],
]);

const TOOLS = [
    {
        name: "list_jobs",
        description: "Lists the jobs this application is running, with their live progress.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "cancel_job",
        description: "Cancels a job by id.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string", description: "Job id, e.g. \"job-1\"." } },
            required: ["id"],
            additionalProperties: false,
        },
    },
];

function handleMcp(frame) {
    const { id, method, params = {} } = frame;
    if (id === undefined || id === null) return undefined; // notification, never answer

    const result = (value) => ({ jsonrpc: "2.0", id, result: value });
    const text = (t) => result({ content: [{ type: "text", text: t }] });

    if (method === "initialize") {
        return result({
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "job-runner", version: "1.0.0" },
        });
    }
    if (method === "tools/list") return result({ tools: TOOLS });
    if (method === "tools/call") {
        const args = params.arguments ?? {};
        if (params.name === "list_jobs") return text(JSON.stringify([...jobs].map(([k, v]) => ({ id: k, ...v })), null, 2));
        if (params.name === "cancel_job") {
            const job = jobs.get(args.id);
            if (!job) return result({ content: [{ type: "text", text: `No job "${args.id}".` }], isError: true });
            job.status = "cancelled";
            return text(`Cancelled ${args.id}.`);
        }
        return result({ content: [{ type: "text", text: `Unknown tool: ${params.name}` }], isError: true });
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

/**
 * The transport a loopback provider is registered with.
 *
 * READ THE DIRECTION CAREFULLY, it is the one thing that trips people up here.
 * This object sits between the broker and your MCP server, and both of its
 * halves face the broker:
 *
 *   send(frame)     the BROKER calls this to deliver a client's request to you.
 *                   Handle it and hand the answer back through `onMessage`.
 *   onMessage(frame) YOU call this to give the broker a frame from your server.
 *                   The broker assigns this property; never assign it yourself.
 *   isOpen          the broker refuses to route to a provider that is not open.
 *                   A loopback has no handshake, so it is open from the start.
 *
 * That is the whole `IMessageTransport` contract. `connect`, `close`, `onOpen`,
 * `onClose` and `onError` exist for socket-backed transports; a loopback keeps
 * them as no-ops, except `close`, which the broker uses to free the slot.
 */
function createLoopbackTransport() {
    const transport = {
        onMessage: null,
        onOpen: null,
        onClose: null,
        onError: null,
        isOpen: true,

        send(raw) {
            let frame;
            try {
                frame = JSON.parse(raw);
            } catch (err) {
                transport.onError?.(new Error(`loopback: unparseable frame from the broker: ${err.message}`));
                return;
            }
            const response = handleMcp(frame);
            // Deferred by a microtask so a synchronous answer cannot re-enter the
            // broker's own routing while it is still on the stack. Not required,
            // but it keeps the call graph honest and matches every real transport.
            if (response) queueMicrotask(() => transport.onMessage?.(JSON.stringify(response)));
        },

        connect() {},
        close() {
            transport.isOpen = false;
            transport.onClose?.();
        },
    };
    return transport;
}

// ---------------------------------------------------------------------------
// 2. Build the broker
// ---------------------------------------------------------------------------

const tunnel = new WsTunnelBuilder()
    .withPort(port)
    .withHost(host)

    // The six endpoint paths have sensible defaults and are shown here so you can
    // see what they are. Change one only if EVERY peer agrees: the pairing between
    // path and transport class is what the whole protocol rests on.
    .withProviderPath("/provider") //   ws, one provider per socket, plain frames  -> DirectTransport
    .withProvidersPath("/providers") // ws, many providers per socket, envelopes   -> MultiplexTransport
    .withClientPath("/") //             ws, raw WebSocket clients
    .withMcpPath("/mcp") //             http, Streamable HTTP:  /<slot>/mcp
    .withSsePath("/sse") //             http, legacy SSE stream: /<slot>/sse
    .withMessagesPath("/messages") //   http, legacy SSE posts:  /<slot>/messages

    // Browser origins allowed on the client HTTP surface. Omit the call and NO
    // browser origin passes, which is the safe default; requests carrying no
    // Origin header (any non-browser client) always pass either way.
    .withAllowedOrigins([`http://localhost:${port}`, `http://127.0.0.1:${port}`])

    // Provider liveness. These are the defaults, written out because an embedder
    // is exactly the person who has to tune them.
    .withProviderHeartbeat(30_000) //      ping each provider socket; 0 disables
    .withProviderRequestTimeout(60_000) // deadline for one provider answer; 0 disables
    .withProviderTakeover("liveness") //   reject | liveness | always

    .build();

// ---------------------------------------------------------------------------
// 3. Lifecycle
// ---------------------------------------------------------------------------

async function main() {
    // START CAN REJECT, and this try/catch is the reason to await it.
    //
    // `ws` mirrors the HTTP server's 'error' event onto its own WebSocketServer
    // from a listener installed inside its constructor, so an unhandled listen
    // failure used to surface as an uncaught exception outside any caller's
    // await. It now rejects, and the rejection carries a full diagnosis: for
    // EADDRINUSE, the address, the URL to attach to the broker already holding
    // the port, and the way to move this one.
    try {
        await tunnel.start();
    } catch (err) {
        console.error(`[app] the broker could not start: ${err.message}`);
        if (err.cause) console.error(`[app] underlying: ${err.cause.code ?? ""} ${err.cause.message}`);
        process.exit(1);
    }
    console.log(`[app] broker listening on ${base}`);

    // ── A provider with no socket ───────────────────────────────────────────
    // Throws if the name is already taken by a stdio upstream or another
    // loopback; it does NOT throw for a WebSocket provider on the same slot, so
    // pick names your application owns.
    const loopback = createLoopbackTransport();
    tunnel.registerLoopbackProvider("job-runner", loopback);
    console.log(`[app] registered the in-process provider on slot "job-runner" (no socket involved)`);

    // ── A client with no HTTP ───────────────────────────────────────────────
    console.log(`\n[app] calling it through openInternalClient(), in-process:`);
    const answer = await internalCall("job-runner", "tools/call", { name: "list_jobs", arguments: {} });
    console.log(indent(toolText(answer.result)));

    // ── The same slot, over HTTP, for anyone outside the process ────────────
    console.log(`\n[app] the same slot over Streamable HTTP at ${base}/job-runner/mcp:`);
    const http = await connectMcp(base, "job-runner");
    console.log(`      tools/list -> ${(await http.listTools()).tools.map((t) => t.name).join(", ")}`);
    console.log(`      tools/call cancel_job -> ${toolText(await http.callTool("cancel_job", { id: "job-2" }))}`);
    await http.close();

    // ── The `_all` caveat, and the way round it ─────────────────────────────
    // `registerLoopbackProvider` has no `aggregate` parameter, and the aggregate
    // server is not reachable from the public API, so a loopback provider does
    // NOT appear in `_all`. When an MCP host has to see it through the aggregate,
    // publish over a real socket to this broker's own loopback address instead:
    // the cost is one WebSocket to 127.0.0.1, and the registration frame that
    // carries the opt-in.
    const aggregated = await publishProvider({
        brokerUrl: base,
        slot: "also-aggregated",
        aggregate: true,
        log: (line) => console.log(`      ${line}`),
    });
    await new Promise((r) => setTimeout(r, 400));

    const all = await connectMcp(base, "_all");
    const allTools = (await all.listTools()).tools.map((t) => t.name);
    await all.close();
    console.log(`\n[app] tools on _all: ${allTools.join(", ")}`);
    console.log(`      note that "job-runner" is absent: a loopback provider cannot opt into the aggregate,`);
    console.log(`      while "also-aggregated", which connected over a socket with { aggregate: true }, is there.`);

    // ── Introspection without leaving the process ───────────────────────────
    console.log(`\n[app] tunnel.getProvidersInfo():`);
    for (const info of tunnel.getProvidersInfo()) {
        console.log(`      ${info.name.padEnd(18)} transport=${String(info.transport).padEnd(9)} connected=${info.connected}`);
    }

    if (once) {
        console.log(`\n[app] --once: shutting down.`);
        aggregated.close();
        await shutdown("done");
        return;
    }

    console.log(`\n[app] still serving. Try:`);
    console.log(`      curl -sS -X POST ${base}/job-runner/mcp -H "Accept: application/json, text/event-stream" \\`);
    console.log(`           -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'`);
    console.log(`      Ctrl+C to stop.`);
}

/** One request/response exchange over an in-process client. */
function internalCall(slot, method, params, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
        const client = tunnel.openInternalClient(slot);
        const timer = setTimeout(() => {
            client.close();
            reject(new Error(`No answer to ${method} on slot "${slot}" within ${timeoutMs}ms.`));
        }, timeoutMs);

        client.onMessage = (raw) => {
            const frame = JSON.parse(raw);
            // Notifications from the provider arrive here too; only the answer to
            // our own id ends the exchange.
            if (frame.id !== 1) return;
            clearTimeout(timer);
            client.close();
            if (frame.error) reject(new Error(`${method} failed: ${frame.error.message} (code ${frame.error.code})`));
            else resolve(frame);
        };

        // An internal client needs no handshake: the broker routes straight to
        // the slot. Sending to a slot with no provider answers synchronously
        // with a JSON-RPC error rather than hanging.
        client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    });
}

const indent = (text) =>
    text
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n");

// ── Shutdown ────────────────────────────────────────────────────────────────
// `stop()` closes every provider and client socket, clears the heartbeat and
// request-timeout timers, and closes the HTTP listener. AWAIT IT: without the
// await the process can exit with sockets half-closed, and in a test runner the
// next test then hits a port that is still bound.
let stopping = false;
async function shutdown(reason) {
    if (stopping) return;
    stopping = true;
    console.log(`[app] shutting down (${reason})`);
    await tunnel.stop();
    console.log(`[app] stopped cleanly`);
    process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch(async (err) => {
    console.error(`[app] FAILED: ${err.message}`);
    await tunnel.stop().catch(() => undefined);
    process.exit(1);
});
