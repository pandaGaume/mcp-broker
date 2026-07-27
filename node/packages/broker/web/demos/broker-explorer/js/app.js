/**
 * app.js — UI wiring for the broker explorer demo.
 *
 * Owns the DOM: console log, status badge, live catalog, and the connect /
 * disconnect lifecycle. The MCP-over-WebSocket client is imported from
 * ./mcp-ws-client.js (standard MCP, nothing broker-specific).
 */
import { McpWebSocketClient } from "./mcp-ws-client.js";

// =====================================================================
// Console + status helpers
// =====================================================================
const consoleEl = document.getElementById("console-output");

function log(msg, level = "info") {
    const ts = new Date().toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const div = document.createElement("div");
    div.className = `log-line ${level}`;
    div.innerHTML = `<span class="ts">${ts}</span><span class="msg"></span>`;
    div.querySelector(".msg").textContent = msg;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

const badgeEl = document.getElementById("status-badge");

function setStatus(next) {
    badgeEl.className = `badge ${next}`;
    badgeEl.textContent = { disconnected: "Disconnected", connecting: "Connecting…", connected: "Connected" }[next] ?? next;
}

// =====================================================================
// Catalog panel — rendered live from the slot's tools/list response.
// =====================================================================
const catalogEl = document.getElementById("catalog");

function clearCatalog(note) {
    catalogEl.innerHTML = "";
    if (note) {
        const p = document.createElement("p");
        p.className = "empty-note";
        p.textContent = note;
        catalogEl.appendChild(p);
    }
}

function renderCatalog(tools) {
    catalogEl.innerHTML = "";
    if (tools.length === 0) {
        clearCatalog("This slot exposes no tools.");
        return;
    }

    const group = document.createElement("div");
    group.className = "cat-group";
    group.innerHTML = `<div class="cat-group-title">Tools (${tools.length})</div>`;

    for (const tool of tools) {
        const schema = tool.inputSchema ?? {};
        const props = schema.properties ?? {};
        const required = schema.required ?? [];
        const paramText = Object.entries(props)
            .map(([pn, pd]) => {
                const req = required.includes(pn);
                const type = (pd && pd.type) || "any";
                return `<span class="pname">${pn}</span>${req ? '<span class="preq">*</span>' : ""}: ${type}`;
            })
            .join(", ");

        const item = document.createElement("div");
        item.className = "cat-item";
        item.innerHTML =
            `<div class="cat-item-name"></div>` +
            `<div class="cat-item-desc"></div>` +
            (paramText ? `<div class="cat-item-params">(${paramText})</div>` : "") +
            `<div class="cat-item-call">` +
            `<input type="text" class="args-input" spellcheck="false" />` +
            `<button class="call-btn">Call</button>` +
            `</div>`;
        item.querySelector(".cat-item-name").textContent = tool.name;
        item.querySelector(".cat-item-desc").textContent = tool.description ?? "";

        // Seed the args field with a skeleton object of the declared properties.
        const skeleton = {};
        for (const pn of Object.keys(props)) skeleton[pn] = "";
        const argsInput = item.querySelector(".args-input");
        argsInput.value = JSON.stringify(skeleton);

        const callBtn = item.querySelector(".call-btn");
        callBtn.addEventListener("click", () => void callTool(tool.name, argsInput, callBtn, item));

        group.appendChild(item);
    }
    catalogEl.appendChild(group);
}

/**
 * Renders an MCP `tools/call` result into readable text.
 *
 * Prefers `structuredContent` (MCP 2025-06-18) when the tool provides it.
 * Otherwise falls back to the `content` blocks: a `text` block holding JSON is
 * parsed and pretty-printed (rather than shown double-escaped); non-JSON text
 * is kept verbatim.
 */
function formatToolResult(result) {
    if (result && result.structuredContent !== undefined) {
        return { text: JSON.stringify(result.structuredContent, null, 2), isError: result.isError === true };
    }

    const blocks = Array.isArray(result?.content) ? result.content : [];
    const parts = blocks.map((block) => {
        if (block && block.type === "text" && typeof block.text === "string") {
            try {
                return JSON.stringify(JSON.parse(block.text), null, 2);
            } catch {
                return block.text;
            }
        }
        return JSON.stringify(block, null, 2);
    });
    const text = parts.length > 0 ? parts.join("\n\n") : JSON.stringify(result, null, 2);
    return { text, isError: result?.isError === true };
}

/** Calls one tool and renders its result inline on the card. */
async function callTool(name, argsInput, callBtn, item) {
    if (!client) return;

    let args;
    try {
        args = argsInput.value.trim() ? JSON.parse(argsInput.value) : {};
    } catch {
        log(`Invalid JSON arguments for "${name}".`, "error");
        return;
    }

    let resultBox = item.querySelector(".cat-result");
    if (!resultBox) {
        resultBox = document.createElement("div");
        resultBox.className = "cat-result";
        item.appendChild(resultBox);
    }

    callBtn.disabled = true;
    resultBox.classList.remove("error");
    resultBox.textContent = "Calling…";
    log(`tools/call → ${name} ${JSON.stringify(args)}`, "dim");

    try {
        const result = await client.callTool(name, args);
        const formatted = formatToolResult(result);
        resultBox.classList.toggle("error", formatted.isError);
        resultBox.textContent = formatted.text;
        log(`tools/call ← ${name} ${formatted.isError ? "returned an error result." : "returned."}`, formatted.isError ? "warn" : "ok");
    } catch (err) {
        resultBox.classList.add("error");
        resultBox.textContent = err.message;
        log(`tools/call ← ${name} failed: ${err.message}`, "error");
    } finally {
        callBtn.disabled = false;
    }
}

// =====================================================================
// Lifecycle
// =====================================================================
let client = null;
let intentionalClose = false;

const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const wsUrlInput = document.getElementById("ws-url");
const slotInput = document.getElementById("slot-name");
const endpointsEl = document.getElementById("endpoints");

// Derive the client WebSocket base from the page origin: ws:// over HTTP,
// wss:// over HTTPS — avoids mixed-content errors under TLS.
(function deriveClientUrl() {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    wsUrlInput.value = `${scheme}//${window.location.host}`;
})();

// Slot preset chips fill the slot input.
for (const preset of document.querySelectorAll(".preset")) {
    preset.addEventListener("click", () => {
        slotInput.value = preset.dataset.slot;
    });
}

function teardown() {
    client = null;
    intentionalClose = false;
    setStatus("disconnected");
    startBtn.disabled = false;
    stopBtn.disabled = true;
    endpointsEl.hidden = true;
}

function showEndpoints(slot) {
    const httpScheme = window.location.protocol === "https:" ? "https:" : "http:";
    const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const enc = encodeURIComponent(slot);
    document.getElementById("ep-http").value = `${httpScheme}//${host}/${enc}/mcp`;
    document.getElementById("ep-sse").value = `${httpScheme}//${host}/${enc}/sse`;
    document.getElementById("ep-ws").value = `${wsScheme}//${host}/${enc}`;
    endpointsEl.hidden = false;
}

startBtn.addEventListener("click", async () => {
    const base = wsUrlInput.value.trim().replace(/\/+$/, "");
    const slot = slotInput.value.trim();
    if (!base || !slot) {
        log("Enter the broker base URL and a slot name first.", "error");
        return;
    }
    const url = `${base}/${encodeURIComponent(slot)}`;

    setStatus("connecting");
    startBtn.disabled = true;
    intentionalClose = false;
    clearCatalog("Connecting…");
    log(`Opening WebSocket to ${url} …`, "dim");

    const c = new McpWebSocketClient(url);
    c.onError = (err) => log(`Socket error: ${err.message}`, "error");
    c.onClose = () => {
        if (intentionalClose) return;
        if (client === c) {
            log("Connection closed by the broker.", "warn");
            clearCatalog("Disconnected.");
            teardown();
        }
    };

    try {
        await c.open();
        client = c;
        const info = await c.initialize();
        const serverName = info?.serverInfo?.name ?? slot;
        log(`Connected — initialized against "${serverName}".`, "ok");

        const tools = await c.listTools();
        renderCatalog(tools);
        log(`tools/list → ${tools.length} tool(s) on slot "${slot}".`, "ok");

        setStatus("connected");
        stopBtn.disabled = false;
        showEndpoints(slot);
    } catch (err) {
        log(`Connection failed: ${err.message}`, "error");
        c.close();
        clearCatalog("Not connected. Press Connect to list the slot's tools.");
        teardown();
    }
});

stopBtn.addEventListener("click", () => {
    if (!client) return;
    intentionalClose = true;
    stopBtn.disabled = true;
    client.close();
    log("Disconnected.", "warn");
    clearCatalog("Not connected. Press Connect to list the slot's tools.");
    teardown();
});

// =====================================================================
// Boot
// =====================================================================
log("Ready. Pick a slot (_broker or _all) and press Connect.", "dim");
