/**
 * Soak: call a provider through the broker in a loop, for hours, and keep
 * the numbers a leak would move.
 *
 * Three things are exercised at once, on purpose: the device (its heap is
 * on its own monitor, this script gives it a steady load), the broker
 * process (its RSS and its per-slot pending count are sampled here), and the
 * path between them (latency percentiles and failures). A leak on any of the
 * three shows as a number that only ever grows.
 *
 *   node c/tests/soak/soak.mjs [--base http://127.0.0.1:3000] [--slot esp32-7B8C00]
 *                              [--every 5] [--report 60] [--log soak.log] [--pid 31220]
 *
 *   --every   seconds between rounds (one round = tools/list + tools/call on
 *             the slot, plus tools/call through _all)
 *   --report  seconds between summary lines
 *   --pid     broker process id, for its RSS (found automatically on Windows
 *             from the listening port when omitted)
 *
 * Every summary line is self-contained, so a log read the next morning needs
 * no context:
 *
 *   14:05:00 rounds=720 ok=2160 fail=0 | slot p50=71ms p95=190ms | _all p50=95ms p95=240ms
 *            | broker rss=61.2MB pending=0 sessions=2 | device rx/tx ok
 *
 * Ctrl+C prints a final summary. Exit code 1 if any round failed.
 */
import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

import { connectMcp, toolText } from "../../../samples/lib/mcp-http-client.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));

function arg(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const base = arg("--base", "http://127.0.0.1:3000");
const slot = arg("--slot", "esp32-7B8C00");
const everyMs = Number(arg("--every", "5")) * 1000;
const reportMs = Number(arg("--report", "60")) * 1000;
const logFile = arg("--log", path.join(here, "soak.log"));
let brokerPid = arg("--pid", null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toTimeString().slice(0, 8);

function log(line) {
    console.log(line);
    try {
        appendFileSync(logFile, line + "\n");
    } catch {
        /* the console still has it */
    }
}

function percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Broker process RSS in MB, or null when it cannot be read. */
function brokerRssMb() {
    try {
        if (process.platform === "win32") {
            if (!brokerPid) {
                const port = new URL(base).port || "80";
                const out = execSync(`netstat -ano -p tcp`, { encoding: "utf8" });
                const row = out.split(/\r?\n/).find((l) => l.includes(`:${port} `) && l.includes("LISTENING"));
                brokerPid = row ? row.trim().split(/\s+/).pop() : null;
            }
            if (!brokerPid) return null;
            const ws = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${brokerPid}).WorkingSet64"`, { encoding: "utf8" });
            return Number(ws.trim()) / 1048576;
        }
        if (!brokerPid) {
            const port = new URL(base).port || "80";
            brokerPid = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8" }).trim().split("\n")[0];
        }
        const rss = execSync(`ps -o rss= -p ${brokerPid}`, { encoding: "utf8" });
        return Number(rss.trim()) / 1024;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------

const stats = {
    rounds: 0,
    ok: 0,
    fail: 0,
    lastError: "",
    slotLatency: [],
    allLatency: [],
    firstRss: null,
    worstP95: 0,
};

async function round(n) {
    const text = `soak ${n} ${Date.now()}`;

    // A fresh session per round: that is what a real client does, and it is
    // what makes a session leak on the broker visible in `sessions`.
    let t = Date.now();
    const c = await connectMcp(base, slot);
    const tools = (await c.listTools()).tools.map((x) => x.name);
    if (!tools.includes("echo")) throw new Error(`tools/list without echo: ${tools.join(",")}`);
    const reply = toolText(await c.callTool("echo", { text }));
    if (reply !== `${slot}: ${text}`) throw new Error(`echo mismatch: ${JSON.stringify(reply)}`);
    await c.close();
    stats.slotLatency.push(Date.now() - t);

    t = Date.now();
    const a = await connectMcp(base, "_all");
    const via = toolText(await a.callTool(`${slot}-echo`, { text }));
    if (via !== `${slot}: ${text}`) throw new Error(`_all echo mismatch: ${JSON.stringify(via)}`);
    await a.close();
    stats.allLatency.push(Date.now() - t);
}

async function brokerSnapshot() {
    try {
        const b = await connectMcp(base, "_broker");
        const list = JSON.parse(toolText(await b.callTool("providers_list")));
        const diag = JSON.parse(toolText(await b.callTool("broker_diagnose")));
        await b.close();
        const me = list.providers.find((p) => p.name === slot);
        return {
            connected: me?.connected ?? false,
            pending: me?.pendingCount ?? -1,
            sessions: list.providers.reduce((s, p) => s + (p.sessionCount ?? 0), 0),
            problems: (diag.problems ?? []).map((p) => p.id),
        };
    } catch (err) {
        return { connected: false, pending: -1, sessions: -1, problems: [`snapshot failed: ${err.message}`] };
    }
}

function summary(final = false) {
    const rss = brokerRssMb();
    if (rss !== null && stats.firstRss === null) stats.firstRss = rss;
    const p95 = percentile(stats.slotLatency, 95);
    if (p95 > stats.worstP95) stats.worstP95 = p95;
    return (
        `${now()} ${final ? "FINAL " : ""}rounds=${stats.rounds} ok=${stats.ok} fail=${stats.fail}` +
        ` | slot p50=${percentile(stats.slotLatency, 50)}ms p95=${p95}ms` +
        ` | _all p50=${percentile(stats.allLatency, 50)}ms p95=${percentile(stats.allLatency, 95)}ms` +
        (rss !== null ? ` | broker rss=${rss.toFixed(1)}MB (start ${stats.firstRss.toFixed(1)}MB)` : " | broker rss=?") +
        (stats.lastError ? ` | last error: ${stats.lastError}` : "")
    );
}

async function main() {
    log(`${now()} soak start: base=${base} slot=${slot} every=${everyMs / 1000}s report=${reportMs / 1000}s log=${logFile}`);
    let lastReport = Date.now();
    let stopping = false;
    process.on("SIGINT", () => {
        stopping = true;
    });

    while (!stopping) {
        stats.rounds++;
        try {
            await round(stats.rounds);
            stats.ok++;
        } catch (err) {
            stats.fail++;
            stats.lastError = `${now()} round ${stats.rounds}: ${err.message}`;
            log(`${now()} FAIL round ${stats.rounds}: ${err.message}`);
        }

        if (Date.now() - lastReport >= reportMs) {
            const snap = await brokerSnapshot();
            log(
                summary() +
                    ` | ${slot}: ${snap.connected ? "connected" : "DISCONNECTED"} pending=${snap.pending} sessions=${snap.sessions}` +
                    (snap.problems.length ? ` problems=${snap.problems.join(",")}` : "")
            );
            // Keep the latency windows bounded: percentiles over the last
            // ~20 minutes are what a trend needs, not the whole night.
            if (stats.slotLatency.length > 500) stats.slotLatency.splice(0, stats.slotLatency.length - 500);
            if (stats.allLatency.length > 500) stats.allLatency.splice(0, stats.allLatency.length - 500);
            lastReport = Date.now();
        }
        await sleep(everyMs);
    }
    log(summary(true));
    process.exit(stats.fail > 0 ? 1 : 0);
}

main();
