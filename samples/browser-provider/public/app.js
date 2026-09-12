/**
 * browser-provider: publish an MCP server from a web page to a broker slot,
 * then call one of its tools from that same page.
 *
 * This is the case the field report failed at. Every step that has a wrong
 * variant is marked below with `WRONG CHOICE`, saying what the wrong code looks
 * like and what the failure looks like when you make it. Read those four blocks
 * and you have the whole integration.
 *
 * The page is served by the broker itself (`MCP_BROKER_WWW_DIR`), so:
 *   - one process, one origin, nothing to start in a particular order,
 *   - the broker URL is just `location.host`, never a hardcoded constant,
 *   - and `allowedOrigins` STILL applies to this page. See WRONG CHOICE 4.
 */

// The bare specifier below is resolved by the <script type="importmap"> in
// index.html, which points it at ./vendor/index.js: a byte-for-byte copy of the
// package's ESM build, dropped there by prepare.mjs. In an application with a
// bundler you delete the import map and this line resolves from node_modules
// unchanged. See samples/lib/vendor.mjs for why the copy exists.
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";

import { createServer, TOOLS } from "./mcp-server.js";
import { connectMcp, toolText } from "./vendor/mcp-http-client.js";

// ---------------------------------------------------------------------------
// Page wiring
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const slotInput = $("slot");
const aggregateInput = $("aggregate");
const connectBtn = $("connect");
const disconnectBtn = $("disconnect");
const callBtn = $("call");
const echoInput = $("echo-text");
const badge = $("badge");
const logEl = $("log");
const endpointsEl = $("endpoints");

/** The live transport, or null. One page, one slot, one socket. */
let transport = null;

/** The slot the live transport claimed, needed by the client half. */
let liveSlot = null;

function log(message, level = "info") {
    const line = document.createElement("div");
    line.className = `line ${level}`;
    line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
    logEl.prepend(line);
}

function setStatus(text, state) {
    badge.textContent = text;
    badge.className = `badge ${state}`;
}

// ---------------------------------------------------------------------------
// Provider half: publish the MCP server to a broker slot
// ---------------------------------------------------------------------------

function connect() {
    const slot = slotInput.value.trim();
    if (!slot) {
        log("Enter a slot name first.", "err");
        return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WRONG CHOICE 1 of 4: THE URL AND THE TRANSPORT CLASS ARE ONE DECISION
    //
    // The broker exposes two provider endpoints and they carry DIFFERENT
    // FRAMING. Picking the endpoint picks the class, and vice versa:
    //
    //   /provider/<slot>   plain JSON-RPC frames         -> DirectTransport
    //   /providers         {provider, payload} envelopes -> MultiplexTransport
    //
    // What goes wrong, and what it looks like:
    //
    //   WRONG: new MultiplexTransport(...) against ws://host/provider/my-slot
    //     The socket OPENS. The handshake succeeds. Then every frame the page
    //     writes is an envelope on a path that expects a bare frame, so a
    //     client's POST to /my-slot/mcp hangs until it times out, with no error
    //     anywhere. (Current versions detect this on the first frame, warn with
    //     both corrections and close 1008, but the fix is still this line.)
    //
    //   WRONG: new DirectTransport("ws://host/providers")
    //     Mirror image: bare frames on the envelope path, and the broker never
    //     learns which slot you meant, so the slot stays empty forever.
    //
    //   WRONG: ws://host/providers/my-slot
    //     Looks like the obvious combination of the two. It is NEITHER. It falls
    //     through to the raw-WebSocket CLIENT router and is accepted as a client
    //     of a slot literally named "providers/my-slot". Nothing ever answers.
    //
    // This sample publishes one server, so: DirectTransport + /provider/<slot>.
    // Publishing several servers from one page? Use MultiplexTransport.create()
    // against /providers instead, and keep one socket for all of them.
    // ─────────────────────────────────────────────────────────────────────────
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${scheme}//${location.host}/provider/${encodeURIComponent(slot)}`;

    const server = createServer({
        name: `browser-provider (${slot})`,
        onActivity: (line, level) => log(line, level),
    });

    // The `aggregate` option sends
    //   {"jsonrpc":"2.0","method":"notifications/register","params":{"aggregate":true}}
    // as the first frame once the socket opens, which joins the broker's `_all`
    // slot in addition to this provider's own slot. Opt-in on purpose: `_all` is
    // a confidentiality boundary, so a provider that does not ask stays private
    // to its own slot.
    //
    // Ask for it when an MCP host should see this page's tools without being
    // reconfigured: `_all` exists from broker startup, answers `initialize`
    // itself, and pushes notifications/tools/list_changed as providers join, so
    // a host that started hours before this page still picks the tools up.
    transport = new DirectTransport(wsUrl, { aggregate: aggregateInput.checked });

    // ─────────────────────────────────────────────────────────────────────────
    // WRONG CHOICE 2 of 4: INSTALL THE HANDLERS *BEFORE* connect()
    //
    //   WRONG: transport.connect();
    //          transport.onMessage = (raw) => { ... };
    //
    // The broker sends `initialize` to a newly aggregated provider IMMEDIATELY,
    // and drops it from `_all` without a word when the handshake times out
    // (30s). Wiring the handler after connect() races that frame and loses:
    // intermittently on a fast local connection, always on a slow one.
    // Symptom: the slot works when a client connects to it directly, but the
    // provider never appears in `_all`, with nothing in any log to say why.
    //
    // Every assignment below therefore happens before connect() is called.
    // If you hand this transport to an MCP server object instead, the same rule
    // holds: construct and wire the server first, connect second.
    // ─────────────────────────────────────────────────────────────────────────

    transport.onMessage = (raw) => {
        let frame;
        try {
            frame = JSON.parse(raw);
        } catch {
            log(`Dropped a non-JSON frame from the broker: ${raw.slice(0, 120)}`, "err");
            return;
        }

        // A JSON-RPC batch is an array. This sample answers frames one at a time.
        const frames = Array.isArray(frame) ? frame : [frame];
        for (const one of frames) {
            const response = server.handle(one);
            if (response) transport.send(JSON.stringify(response));
        }
    };

    transport.onOpen = () => {
        liveSlot = slot;
        setStatus(`Published on "${slot}"`, "ok");
        log(`Socket open on ${wsUrl}. The slot is claimed.`, "ok");
        if (aggregateInput.checked) log("Asked to join the _all aggregate; the broker runs initialize against this page now.", "ok");
        showEndpoints(slot);
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        callBtn.disabled = false;
    };

    // DirectTransport reports a close code other than 1000 through onError
    // before onClose. 1008 is the one worth recognising: it is a POLICY refusal
    // from the broker, not a network drop, and the reason text is the broker's
    // own wording. The commonest cause is WRONG CHOICE 3, below.
    transport.onError = (error) => log(error.message, "err");

    transport.onClose = () => {
        liveSlot = null;
        setStatus("Disconnected", "off");
        log("Socket closed. The slot is free again.", "warn");
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        callBtn.disabled = true;
    };

    log(`Connecting to ${wsUrl} ...`);
    transport.connect();
}

function disconnect() {
    // DirectTransport does NOT reconnect. close() is final until connect() is
    // called again. MultiplexTransport's shared socket does reconnect, with
    // backoff; that asymmetry is deliberate and documented on both classes.
    transport?.close();
    transport = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// WRONG CHOICE 3 of 4: RELEASE THE SLOT WHEN THE PAGE GOES AWAY
//
//   WRONG: (no listener at all)
//
// A slot holds one provider socket. Close the tab, hit reload, or follow a
// link, and the browser tears the page down without necessarily closing the
// WebSocket promptly: the old socket can still be OPEN when the reloaded page's
// socket asks for the same slot. The broker then refuses the newcomer with
// close code 1008 ("slot already connected"), and the page that just reloaded
// looks permanently broken while the slot is held by a page that no longer
// exists. That is the reload loop in the field report.
//
// `pagehide` is the correct event, not `beforeunload` (which mobile Safari and
// Chrome on Android routinely skip) and not `unload` (deprecated, and it
// disables the back/forward cache). It fires on navigation, tab close, and
// bfcache suspension alike.
//
// Server-side safety nets exist and are worth knowing, but they are NOT a
// substitute for this three-line listener:
//   MCP_BROKER_PROVIDER_HEARTBEAT_MS  (default 30000) pings each provider
//       socket; a socket that misses a ping is terminated, so a slot held by a
//       dead page frees itself after roughly one interval instead of never.
//   MCP_BROKER_PROVIDER_TAKEOVER      (default "liveness") lets a newcomer
//       evict an incumbent that is known dead. "reject" never evicts;
//       "always" evicts unconditionally and is honoured only when provider
//       authentication is configured, since otherwise it is a spoofing hole.
// With the listener, the slot is free before the new page even asks.
// See samples/provider-lifecycle/ for this failure reproduced on purpose.
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener("pagehide", () => {
    transport?.close();
});

// ---------------------------------------------------------------------------
// Client half: call the tool back through the broker, from this same page
// ---------------------------------------------------------------------------

async function callTool() {
    const slot = liveSlot;
    if (!slot) return;

    // ─────────────────────────────────────────────────────────────────────────
    // WRONG CHOICE 4 of 4: A PAGE THE BROKER SERVES IS STILL A BROWSER ORIGIN
    //
    //   WRONG: starting the broker with no allowedOrigins and expecting this
    //          fetch to work because the page came from the broker's own mount
    //
    // It does not. The origin check runs on `/<slot>/mcp`, `/<slot>/sse` and
    // `/<slot>/messages` and compares the `Origin` header against the configured
    // list VERBATIM. Serving the page grants nothing. With no list configured no
    // browser origin passes at all, and this call comes back
    //     403 {"error":"invalid_origin", ...}
    // while the identical request from Node or MCP Inspector succeeds, because
    // those send no Origin header and the check applies only when one is present.
    //
    // run.mjs therefore sets MCP_BROKER_ALLOWED_ORIGINS to this page's own
    // origin. Scheme and port are part of it: http://localhost:3000 does not
    // match http://127.0.0.1:3000, and neither matches https://localhost:3000.
    // ─────────────────────────────────────────────────────────────────────────
    const text = echoInput.value;
    callBtn.disabled = true;
    try {
        log(`Client: opening a session on ${location.origin}/${slot}/mcp ...`);
        const client = await connectMcp(location.origin, slot);
        log(`Client: session ${client.sessionId}, server "${client.serverInfo?.name}".`, "ok");

        const list = await client.listTools();
        log(`Client: tools/list -> ${list.tools.map((t) => t.name).join(", ")}`);

        const result = await client.callTool("echo", { text });
        log(`Client: echo("${text}") -> "${toolText(result)}"  round trip complete`, "ok");

        await client.close();
    } catch (err) {
        log(`Client failed: ${err.message}`, "err");
        if (String(err.message).includes("403")) {
            log(`A 403 here is the origin check. Start the broker with MCP_BROKER_ALLOWED_ORIGINS=${location.origin}`, "err");
        }
    } finally {
        callBtn.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function showEndpoints(slot) {
    endpointsEl.hidden = false;
    endpointsEl.innerHTML = "";
    const rows = [
        ["Streamable HTTP (MCP Inspector, SDK clients)", `${location.origin}/${slot}/mcp`],
        ["Through the aggregate, when 'aggregate' is on", `${location.origin}/_all/mcp`],
        ["Broker introspection and self-diagnosis", `${location.origin}/_broker/mcp`],
    ];
    for (const [label, url] of rows) {
        const row = document.createElement("div");
        row.className = "endpoint";
        row.innerHTML = `<span></span><code></code>`;
        row.querySelector("span").textContent = label;
        row.querySelector("code").textContent = url;
        endpointsEl.append(row);
    }
}

function renderCatalog() {
    const el = $("catalog");
    for (const tool of TOOLS) {
        const item = document.createElement("div");
        item.className = "tool";
        item.innerHTML = `<code></code><p></p>`;
        item.querySelector("code").textContent = tool.name;
        item.querySelector("p").textContent = tool.description;
        el.append(item);
    }
}

connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
callBtn.addEventListener("click", () => void callTool());

renderCatalog();
setStatus("Disconnected", "off");
log("Ready. Press Publish to claim the slot.");
