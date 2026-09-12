/**
 * Drives `claude_desktop_config.json` the way an MCP host would, and proves the
 * ordering problem is solved.
 *
 * It does, in order:
 *   1. spawns ENTRY 1 exactly as the host does: the broker, in stdio-bridge
 *      mode, pinned to `_all`;
 *   2. completes `initialize` over stdin/stdout BEFORE any provider exists,
 *      which is the case that fails when the bridge is pinned to a real slot;
 *   3. lists tools, and finds only the broker's own;
 *   4. starts a provider on `scene-editor`, late, the way a browser tab would;
 *   5. reads `notifications/tools/list_changed` off the SAME stdio session and
 *      lists again, now finding the provider's tools;
 *   6. reaches ENTRY 2 over HTTP, against the same single process.
 *
 * Run it before pasting the config into a host:
 *
 *   cd samples && node host-config/check.mjs
 *   cd samples && node host-config/check.mjs --port 3210     (if 3000 is busy)
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { brokerBinPath, dirOf } from "../lib/broker-bin.mjs";
import { publishProvider } from "../lib/node-provider.mjs";
import { connectMcp, toolText } from "../lib/mcp-http-client.mjs";

const here = dirOf(import.meta.url);
const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const port = portIndex >= 0 ? argv[portIndex + 1] : "3000";
const base = `http://127.0.0.1:${port}`;
const SLOT = "scene-editor";

const step = (n, text) => console.log(`\n[${n}] ${text}`);

// ---------------------------------------------------------------------------
// A newline-delimited JSON-RPC client over a child process's stdio.
// This is all an MCP host's stdio transport is.
// ---------------------------------------------------------------------------

function stdioClient(child) {
    const pending = new Map();
    const notifications = [];
    const waiters = [];
    let buffer = "";
    let nextId = 1;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;

            let frame;
            try {
                frame = JSON.parse(line);
            } catch {
                // A single non-JSON byte on stdout breaks an MCP host outright.
                // The broker redirects console.* to stderr in stdio mode for
                // exactly this reason, so seeing anything here is a real bug.
                console.error(`  !! non-JSON on stdout, an MCP host would fail here: ${line.slice(0, 200)}`);
                continue;
            }

            if (frame.id !== undefined && pending.has(frame.id)) {
                pending.get(frame.id)(frame);
                pending.delete(frame.id);
            } else if (frame.method) {
                notifications.push(frame.method);
                for (const w of waiters.splice(0)) w(frame.method);
            }
        }
    });

    const send = (frame) => child.stdin.write(JSON.stringify(frame) + "\n");

    return {
        notifications,
        notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
        request(method, params, timeoutMs = 15_000) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `No answer to "${method}" within ${timeoutMs}ms on the stdio bridge. ` +
                                    `If MCP_BROKER_STDIO_PROVIDER names a slot no provider holds, every frame including initialize hangs or errors like this.`
                            )
                        ),
                    timeoutMs
                );
                pending.set(id, (frame) => {
                    clearTimeout(timer);
                    if (frame.error) reject(new Error(`${method} failed: ${frame.error.message} (code ${frame.error.code})`));
                    else resolve(frame.result);
                });
                send({ jsonrpc: "2.0", id, method, params });
            });
        },
        /**
         * Waits for a notification that arrives AFTER `since`, which is a count
         * taken from `notifications.length` before the action you are watching.
         *
         * The `since` mark is not optional bookkeeping: the aggregate emits
         * `notifications/tools/list_changed` at broker startup, when the
         * reserved `_broker` slot registers into `_all`. Watching for the method
         * without a mark matches that startup event and returns instantly,
         * before the provider you are waiting for has been added at all.
         */
        waitForNotification(method, since, timeoutMs = 10_000) {
            if (notifications.indexOf(method, since) >= 0) return Promise.resolve(method);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`No ${method} within ${timeoutMs}ms.`)), timeoutMs);
                waiters.push((got) => {
                    if (got !== method) return;
                    clearTimeout(timer);
                    resolve(got);
                });
            });
        },
    };
}

// ---------------------------------------------------------------------------

async function main() {
    // ── ENTRY 1, spawned exactly as the host config spawns it ───────────────
    // `npx -y @cyanmycelium/mcp-broker` in the real config; here the resolved
    // bin, so the check runs against this repo rather than the registry.
    // stderr is inherited so the broker's own diagnostics stay visible: in
    // stdio mode it moves every console line there, keeping stdout pure
    // JSON-RPC. stdout is piped, because that is the protocol channel.
    step(1, `Spawning ENTRY 1: the broker in stdio-bridge mode, pinned to "_all", listening on ${base}`);
    const child = spawn(process.execPath, [brokerBinPath()], {
        stdio: ["pipe", "pipe", "inherit"],
        env: {
            ...process.env,
            MCP_BROKER_CONFIG: path.join(here, ".mcp-broker", "config.json"),
            MCP_BROKER_STDIO_PROVIDER: "_all",
            MCP_BROKER_PORT: String(port),
        },
    });
    child.on("error", (err) => {
        console.error(`Could not spawn the broker: ${err.message}`);
        process.exit(1);
    });

    const host = stdioClient(child);

    // ── The ordering problem, in one exchange ───────────────────────────────
    step(2, "initialize over stdio, BEFORE any provider exists");
    const init = await host.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "host-config-check", version: "0" },
    });
    host.notify("notifications/initialized");
    console.log(`    ok: server "${init.serverInfo?.name}", protocol ${init.protocolVersion}`);
    console.log(`    THIS IS THE WHOLE POINT. Pinned to a real slot instead of "_all", this handshake fails`);
    console.log(`    with 'Provider "<slot>" not connected' and the host marks the server failed.`);

    step(3, "tools/list, still with no provider connected");
    const before = await host.request("tools/list", {});
    console.log(`    ${before.tools.length} tools: ${before.tools.map((t) => t.name).join(", ")}`);

    // ── A provider appears, late ────────────────────────────────────────────
    // Mark the notification stream before doing anything, so the wait below
    // cannot match the list_changed the aggregate already emitted at startup
    // when the reserved `_broker` slot joined it.
    const mark = host.notifications.length;

    step(4, `Starting a provider on "${SLOT}" now, the way a browser tab would`);
    const provider = await publishProvider({
        brokerUrl: base,
        slot: SLOT,
        aggregate: true, // without this it never reaches _all, and the host never sees it
        log: (line) => console.log(`    ${line}`),
    });

    step(5, "Waiting for notifications/tools/list_changed on the SAME stdio session");
    await host.waitForNotification("notifications/tools/list_changed", mark);
    console.log("    received. The host refreshes its tool list on this notification.");

    const after = await host.request("tools/list", {});
    const added = after.tools.map((t) => t.name).filter((n) => !before.tools.some((t) => t.name === n));
    console.log(`    ${after.tools.length} tools now, new: ${added.join(", ")}`);

    const pingName = after.tools.map((t) => t.name).find((n) => n.endsWith("-ping"));
    if (!pingName) throw new Error(`The provider joined but its tools never reached _all. Expected a "<slot>-ping" entry.`);

    const called = await host.request("tools/call", { name: pingName, arguments: {} });
    console.log(`    tools/call ${pingName} -> ${toolText(called)}`);

    // ── ENTRY 2, same process, no second spawn ──────────────────────────────
    step(6, `Reaching ENTRY 2 over HTTP at ${base}/${SLOT}/mcp, against that same process`);
    const http = await connectMcp(base, SLOT);
    const direct = await http.listTools();
    console.log(`    tools/list -> ${direct.tools.map((t) => t.name).join(", ")}`);
    console.log(`    note the names: unprefixed here, "${pingName}" through _all. Same provider, two entries.`);
    await http.close();

    // ── Done ────────────────────────────────────────────────────────────────
    console.log("\nBOTH ENTRIES WORK AGAINST ONE PROCESS.");
    console.log("Now copy claude_desktop_config.json into your host, replacing /ABSOLUTE/PATH/TO.");

    // Release the slot BEFORE killing the broker. The other order works too, but
    // the provider then reports a 1006 abnormal close, which is noise here and
    // is exactly the diagnostic you want to stay meaningful.
    provider.close();
    setTimeout(() => {
        child.kill("SIGINT");
        setTimeout(() => process.exit(0), 500);
    }, 250);
}

main().catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    if (/EADDRINUSE|Cannot start/i.test(err.message)) {
        console.error(`  Something already holds port ${port}. Re-run with --port 3210.`);
    }
    process.exit(1);
});
