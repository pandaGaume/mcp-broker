/**
 * provider-lifecycle: the whole life of a provider socket, on purpose.
 *
 * Connect, register, serve a call, survive a broker restart, get refused with
 * 1008 by claiming a slot that is still held, then release properly and get in.
 *
 * Everything happens in one terminal, and the broker's own log is interleaved
 * with the narration, so you can see what the broker says at each step. That is
 * the deliverable: not "it works", but "here is the line the broker prints when
 * this goes wrong".
 *
 *   node run.mjs                    the full scenario, about 25 seconds
 *   node run.mjs --port 4000
 *   node run.mjs --heartbeat 2000   shorten the liveness sweep so the reaping
 *                                   step is visible without waiting 30 seconds
 */
import { DirectTransport, MultiplexTransport } from "@cyanmycelium/mcp-broker-provider";
import { startBrokerDetached } from "./broker-control.mjs";
import { connectMcp, toolText, waitForBroker } from "../lib/mcp-http-client.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const port = arg("--port", "3300");
const heartbeat = arg("--heartbeat", "5000");
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;
const SLOT = "lifecycle-demo";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stepNumber = 0;
function say(title, ...lines) {
    stepNumber += 1;
    console.log(`\n${"=".repeat(78)}`);
    console.log(`STEP ${stepNumber}: ${title}`);
    console.log("=".repeat(78));
    for (const line of lines) console.log(line);
    console.log();
}

// ---------------------------------------------------------------------------
// A provider, built by hand so every callback is visible.
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {"direct"|"multiplex"} o.kind
 * @param {string} o.label      Prefix for this provider's log lines.
 * @param {string} o.slot
 * @param {boolean} [o.aggregate]
 */
function makeProvider({ kind, label, slot, aggregate = true }) {
    const events = [];
    const note = (text) => {
        events.push(text);
        console.log(`   [${label}] ${text}`);
    };

    // THE PAIRING RULE. Direct goes with the slot-scoped path and plain frames;
    // multiplex goes with the shared base and envelope frames. Crossing them is
    // the single most common integration failure, and the sample that shows the
    // symptom is ../browser-provider/.
    const transport =
        kind === "direct"
            ? new DirectTransport(`${wsBase}/provider/${slot}`, { aggregate })
            : MultiplexTransport.create(slot, `${wsBase}/providers`, { aggregate });

    // Handlers before connect(), always. See ../browser-provider/public/app.js.
    transport.onMessage = (raw) => {
        const frame = JSON.parse(raw);
        if (frame.id === undefined || frame.id === null) return; // notification
        const reply = (result) => transport.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));

        if (frame.method === "initialize") {
            return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: label, version: "1.0.0" } });
        }
        if (frame.method === "tools/list") {
            return reply({ tools: [{ name: "whoami", description: "Names the provider instance holding this slot.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
        }
        if (frame.method === "tools/call") {
            return reply({ content: [{ type: "text", text: `${label} is holding "${slot}"` }] });
        }
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `Method not found: ${frame.method}` } }));
    };

    transport.onOpen = () => note(`onOpen: the slot "${slot}" is claimed`);
    transport.onClose = () => note("onClose: socket gone");

    // onError carries the broker's REFUSAL text. A close code other than 1000
    // reaches here before onClose, which is why this callback is where you find
    // out that 1008 happened and why.
    transport.onError = (err) => note(`onError: ${err.message}`);

    return {
        label,
        events,
        transport,
        open: () => transport.connect(),
        close: () => transport.close(),
        /** True once onOpen has fired and no close has followed. */
        get isOpen() {
            return transport.isOpen;
        },
    };
}

/** Waits until `predicate()` is true, or gives up. */
async function until(predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(100);
    }
    console.log(`   (gave up waiting for ${what} after ${timeoutMs}ms)`);
    return false;
}

// ---------------------------------------------------------------------------

async function main() {
    let broker = startBrokerDetached({
        MCP_BROKER_PORT: String(port),
        MCP_BROKER_HOST: "127.0.0.1",
        MCP_BROKER_PROTOCOL: "http",

        // Shortened so the liveness sweep is observable inside a 30 second demo.
        // The real default is 30000. It is a ping/pong on the provider socket:
        // a socket that did not answer the previous ping is terminated, which
        // frees a slot held by a peer that went away without closing.
        MCP_BROKER_PROVIDER_HEARTBEAT_MS: String(heartbeat),

        // Default. "reject" never evicts an incumbent; "liveness" evicts one the
        // heartbeat has proven dead; "always" evicts unconditionally, and is
        // honoured only when provider authentication is configured, because
        // without it an unconditional takeover is a slot-hijacking primitive.
        MCP_BROKER_PROVIDER_TAKEOVER: "liveness",
    });
    await waitForBroker(base);

    // ── 1 ───────────────────────────────────────────────────────────────────
    say(
        "Connect and register",
        `A DirectTransport opens ${wsBase}/provider/${SLOT}.`,
        `Watch for the broker's own line:  [broker] ws connect path="/provider/${SLOT}" role=dedicated-provider`,
        `That line is the broker telling you which of the three roles it filed the socket under.`,
        `If it ever says role=client for a URL you meant as a provider, that is your bug.`
    );
    const pageA = makeProvider({ kind: "direct", label: "page-A", slot: SLOT });
    pageA.open();
    await until(() => pageA.isOpen, 5000, "page-A to open");
    await sleep(400);

    // ── 2 ───────────────────────────────────────────────────────────────────
    say("Serve a call", "A client goes through the broker to the provider and back.");
    let client = await connectMcp(base, SLOT);
    console.log(`   client: tools/call whoami -> ${toolText(await client.callTool("whoami"))}`);
    await client.close();

    // ── 3 ───────────────────────────────────────────────────────────────────
    say(
        "A second provider claims the SAME slot while the first still holds it",
        "THIS IS THE RELOAD LOOP. A browser tab reloads; the old page's socket is still OPEN",
        "when the new page asks for the slot. The broker refuses the newcomer with close code 1008.",
        "",
        "Note which side gets the error: the NEWCOMER is refused, the incumbent is untouched.",
        "So the page you are looking at is the one that fails, while the page that is gone keeps the slot.",
        "",
        "Watch the ORDER of page-B's callbacks below. onOpen fires FIRST, and only then onError.",
        "The WebSocket handshake succeeds; the refusal is a close frame that arrives after it.",
        "NEVER TREAT onOpen AS PROOF THAT YOU OWN THE SLOT. It only means the socket is up."
    );
    const pageB = makeProvider({ kind: "direct", label: "page-B", slot: SLOT });
    pageB.open();
    await until(() => pageB.events.some((e) => e.includes("1008")), 6000, "page-B to be refused with 1008");
    await sleep(300);
    console.log("   The fix is on the provider side and it is three lines:");
    console.log('     window.addEventListener("pagehide", () => transport.close());');
    console.log("   The broker-side safety net is the heartbeat, which reaps a socket that stopped");
    console.log(`   answering pings (MCP_BROKER_PROVIDER_HEARTBEAT_MS, ${heartbeat}ms in this run, 30000 by default).`);
    console.log("   It bounds the damage; it does not remove the need for the listener, because a");
    console.log("   socket that is genuinely still open answers pings perfectly well.");

    // ── 4 ───────────────────────────────────────────────────────────────────
    say("Explicit release, then the newcomer gets in", "page-A calls transport.close(). The slot frees immediately, no timeout involved.");
    pageA.close();
    await sleep(500);
    const pageB2 = makeProvider({ kind: "direct", label: "page-B (retry)", slot: SLOT });
    pageB2.open();
    await until(() => pageB2.isOpen, 5000, "page-B to claim the slot");
    client = await connectMcp(base, SLOT);
    console.log(`   client: tools/call whoami -> ${toolText(await client.callTool("whoami"))}`);
    await client.close();

    // ── 5 ───────────────────────────────────────────────────────────────────
    say(
        "Deliberate broker restart",
        "The broker is killed and started again on the same port, the way a deploy or a crash does it.",
        "Two providers are watching: a DirectTransport and a MultiplexTransport, and they behave DIFFERENTLY.",
        "",
        "  DirectTransport    does NOT reconnect. Ever. onClose fires and that is the end.",
        "  MultiplexTransport reconnects on its own, with exponential backoff up to 30s,",
        "                     and re-announces every slot registered on the shared socket.",
        "",
        "That asymmetry is deliberate and is the main reason to prefer the multiplex transport",
        "for anything long-lived. It is also easy to miss, because both classes look alike.",
        "",
        "IN NODE the automatic retry may stop after one attempt; the reason is printed below if",
        "it does, and it is a Node WebSocket quirk rather than anything about the broker."
    );
    const multi = makeProvider({ kind: "multiplex", label: "multiplex-C", slot: "lifecycle-multi" });
    multi.open();
    await until(() => multi.isOpen, 5000, "multiplex-C to open");
    await sleep(300);

    console.log("\n   ...killing the broker now.\n");
    broker.stop();
    await sleep(1500);
    console.log("\n   ...both providers have seen the socket drop. Restarting the broker.\n");

    broker = startBrokerDetached({
        MCP_BROKER_PORT: String(port),
        MCP_BROKER_HOST: "127.0.0.1",
        MCP_BROKER_PROTOCOL: "http",
        MCP_BROKER_PROVIDER_HEARTBEAT_MS: String(heartbeat),
    });
    await waitForBroker(base);

    const cameBack = await until(() => multi.isOpen, 8_000, "multiplex-C to reconnect");
    console.log(`\n   multiplex-C reconnected on its own: ${cameBack}`);

    if (!cameBack) {
        // KNOWN NODE-ONLY LIMITATION, and worth stating precisely rather than
        // leaving as "sometimes it does not come back".
        //
        // Node's built-in WebSocket (undici) fires `error` on a connection that
        // never opened and then NEVER fires `close`: readyState stays 0
        // (CONNECTING) forever. Browsers fire `error` and then `close` with code
        // 1006, which is what the reconnect loop is built on. So the retry chain
        // survives in a page and stops in Node after the FIRST retry that lands
        // while the broker is still down. Verify it yourself:
        //   new WebSocket("ws://127.0.0.1:59999/nope").onclose = () => {}   // never called in Node
        //
        // Two workarounds, both one line:
        //   - re-register the transport, which is what happens just below;
        //   - or install a `ws`-based polyfill on globalThis.WebSocket before
        //     importing the package, which does fire close.
        console.log("   Node-only: the built-in WebSocket fires `error` but never `close` on a connection");
        console.log("   that failed to open, so the reconnect chain stops after the first retry that lands");
        console.log("   while the broker is down. A browser fires close(1006) and keeps retrying.");
        console.log("   Recovering by hand: close() then connect(), which re-registers the slot.");
        multi.close();
        multi.open();
        await until(() => multi.isOpen, 8000, "multiplex-C to be re-registered by hand");
        console.log(`   after an explicit close()+connect(): multiplex-C isOpen = ${multi.isOpen}`);
    }

    console.log(`\n   page-B (retry) reconnected on its own: ${pageB2.isOpen}   <- expected false, DirectTransport never retries`);
    console.log("   To bring a DirectTransport back you call connect() again yourself, from your own");
    console.log("   retry policy. Doing that is one line; NOT KNOWING you have to is the bug.");

    pageB2.open();
    await until(() => pageB2.isOpen, 5000, "page-B to be reconnected by hand");
    console.log(`   after an explicit connect(): page-B (retry) isOpen = ${pageB2.isOpen}`);

    // Proof that a reconnected socket is a *working* socket: the slot has to be
    // re-announced to the broker, not merely re-opened.
    const recheck = await connectMcp(base, SLOT);
    console.log(`   client after the restart: tools/call whoami -> ${toolText(await recheck.callTool("whoami"))}`);
    await recheck.close();

    // ── 6 ───────────────────────────────────────────────────────────────────
    say("Clean release and shutdown", "Both providers close. Ask the broker what it holds afterwards.");
    pageB2.close();
    multi.close();
    await sleep(800);

    const introspection = await connectMcp(base, "_broker");
    console.log(`   providers_list:\n   ${toolText(await introspection.callTool("providers_list"))}`);
    console.log("\n   A slot with connected:false is a slot that exists but has no provider. The broker");
    console.log("   keeps it, because a client may be waiting and a provider may come back to it.");
    await introspection.close();

    console.log(`\n${"=".repeat(78)}`);
    console.log("SCENARIO COMPLETE. Read provider-lifecycle/README.md for the annotated log.");
    console.log("=".repeat(78));

    broker.stop();
    await sleep(500);
    process.exit(0);
}

main().catch(async (err) => {
    console.error(`\nFAILED: ${err.message}`);
    process.exit(1);
});
