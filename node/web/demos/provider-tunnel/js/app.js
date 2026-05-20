/**
 * app.js — UI wiring for the provider tunnel demo.
 *
 * Owns the DOM: console log, status badge, catalog panel, and the connect /
 * disconnect lifecycle. The two pieces of real logic are imported:
 *
 * - js/lib/broker-tunnel.js — broker connection (reusable, zero-dependency,
 *   shared across demos — lives at the web root).
 * - ./toolbox-server.js     — the demo MCP server (plain MCP, broker-agnostic).
 */
import { BrokerTunnelTransport, describeTunnelClose } from "../../../js/lib/broker-tunnel.js";
import { TOOLS, RESOURCES, createToolboxServer } from "./toolbox-server.js";

// =====================================================================
// Console + status helpers
// =====================================================================
const consoleEl = document.getElementById("console-output");

function log(msg, level = "info") {
    const ts = new Date().toLocaleTimeString("en", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    const div = document.createElement("div");
    div.className = `log-line ${level}`;
    div.innerHTML = `<span class="ts">${ts}</span><span class="msg"></span>`;
    div.querySelector(".msg").textContent = msg;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

const badgeEl = document.getElementById("status-badge");
let state = "disconnected";

function setStatus(next) {
    state = next;
    badgeEl.className = `badge ${next}`;
    badgeEl.textContent =
        { disconnected: "Disconnected", connecting: "Connecting…", connected: "Connected" }[next] ?? next;
}

// =====================================================================
// Catalog panel — rendered from the toolbox server's exported definitions.
// =====================================================================
function renderCatalog() {
    const el = document.getElementById("catalog");
    el.innerHTML = "";

    const toolGroup = document.createElement("div");
    toolGroup.className = "cat-group";
    toolGroup.innerHTML = `<div class="cat-group-title">Tools (${TOOLS.length})</div>`;
    for (const tool of TOOLS) {
        const item = document.createElement("div");
        item.className = "cat-item";
        const props = tool.inputSchema.properties ?? {};
        const required = tool.inputSchema.required ?? [];
        const params = Object.entries(props)
            .map(([pn, pd]) => {
                const req = required.includes(pn);
                return `<span class="pname">${pn}</span>${req ? '<span class="preq">*</span>' : ""}: ${pd.type}`;
            })
            .join(", ");
        item.innerHTML =
            `<div class="cat-item-name">${tool.name}</div>` +
            `<div class="cat-item-desc"></div>` +
            (params ? `<div class="cat-item-params">(${params})</div>` : "");
        item.querySelector(".cat-item-desc").textContent = tool.description;
        toolGroup.appendChild(item);
    }
    el.appendChild(toolGroup);

    const resGroup = document.createElement("div");
    resGroup.className = "cat-group";
    resGroup.innerHTML = `<div class="cat-group-title">Resources (${RESOURCES.length})</div>`;
    for (const res of RESOURCES) {
        const item = document.createElement("div");
        item.className = "cat-item";
        item.innerHTML = `<div class="cat-item-name cat-item-uri"></div>` + `<div class="cat-item-desc"></div>`;
        item.querySelector(".cat-item-uri").textContent = res.uri;
        item.querySelector(".cat-item-desc").textContent = res.description;
        resGroup.appendChild(item);
    }
    el.appendChild(resGroup);
}

// =====================================================================
// Lifecycle
// =====================================================================
let server = null;
let transport = null;
let intentionalClose = false;
let connectGraceTimer = null;
let tunnelWasOpen = false;

const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const wsUrlInput = document.getElementById("ws-url");
const nameInput = document.getElementById("server-name");
const endpointsEl = document.getElementById("endpoints");

// Derive the provider WebSocket base from the page origin: ws:// over HTTP,
// wss:// over HTTPS — avoids mixed-content errors under TLS.
(function deriveProviderUrl() {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    wsUrlInput.value = `${scheme}//${window.location.host}/provider`;
})();

function teardown() {
    server = null;
    transport = null;
    tunnelWasOpen = false;
    setStatus("disconnected");
    startBtn.disabled = false;
    stopBtn.disabled = true;
    endpointsEl.hidden = true;
}

function showEndpoints(slotName) {
    const httpScheme = window.location.protocol === "https:" ? "https:" : "http:";
    const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const enc = encodeURIComponent(slotName);
    document.getElementById("ep-http").value = `${httpScheme}//${host}/${enc}/mcp`;
    document.getElementById("ep-sse").value = `${httpScheme}//${host}/${enc}/sse`;
    document.getElementById("ep-ws").value = `${wsScheme}//${host}/${enc}`;
    endpointsEl.hidden = false;
}

// The WS "handshake check": classify how the tunnel socket closed.
// describeTunnelClose (lib/broker-tunnel.js) maps the close code to a
// diagnosis — broker rejection (1008), unreachable, or dropped.
function handleTunnelClose(code, reason) {
    // A pending success banner must not fire once the slot is rejected.
    if (connectGraceTimer) {
        clearTimeout(connectGraceTimer);
        connectGraceTimer = null;
    }
    if (intentionalClose) {
        intentionalClose = false;
        teardown();
        return;
    }
    const { level, message } = describeTunnelClose(code, reason, tunnelWasOpen);
    log(message, level);
    teardown();
}

startBtn.addEventListener("click", async () => {
    const base = wsUrlInput.value.trim().replace(/\/+$/, "");
    const slotName = nameInput.value.trim() || "demo-toolbox";
    if (!base) {
        log("Enter the broker provider base URL first.", "error");
        return;
    }
    const url = `${base}/${encodeURIComponent(slotName)}`;

    setStatus("connecting");
    startBtn.disabled = true;
    intentionalClose = false;
    tunnelWasOpen = false;
    log(`Opening tunnel WebSocket to ${url} …`, "dim");

    transport = new BrokerTunnelTransport(url);
    transport.onTunnelOpen = () => {
        tunnelWasOpen = true;
    };
    transport.onTunnelClose = handleTunnelClose;
    transport.onTunnelError = (err) => log(`Transport error: ${err.message}`, "error");

    server = createToolboxServer({ name: slotName, onActivity: log });

    try {
        // connect() awaits transport.start() — resolves when the broker accepts
        // the WebSocket upgrade. The MCP initialize handshake happens later,
        // when a real client targets the slot.
        await server.connect(transport);
    } catch (err) {
        log(`Failed to open tunnel: ${err.message}`, "error");
        // handleTunnelClose may already have run; teardown is idempotent.
        teardown();
        return;
    }

    // The broker accepts the WebSocket upgrade first, then may still reject the
    // slot at the application layer with a 1008 close (name already taken, or
    // reserved) within a few milliseconds. Hold a short grace window before
    // declaring success — handleTunnelClose cancels this timer if a rejection
    // lands first.
    connectGraceTimer = setTimeout(() => {
        connectGraceTimer = null;
        setStatus("connected");
        stopBtn.disabled = false;
        showEndpoints(slotName);
        log(`Tunnel open. Provider slot "${slotName}" is now routable through the broker.`, "ok");
        log("Point an MCP client (e.g. MCP Inspector) at the Streamable HTTP URL.", "dim");
    }, 250);
});

stopBtn.addEventListener("click", async () => {
    if (!server) return;
    intentionalClose = true;
    stopBtn.disabled = true;
    try {
        await server.close(); // closes the transport, which closes the WS
        log("Tunnel closed. Provider slot released.", "warn");
    } catch (err) {
        log(`Error while closing: ${err.message}`, "error");
    }
    teardown();
});

// =====================================================================
// Boot
// =====================================================================
renderCatalog();
log("Ready. Press Connect to tunnel this MCP server to the broker.", "dim");
