/**
 * Leak probe: the soak's round, in-process, with the garbage collector forced
 * and the broker's own collections counted between batches.
 *
 * The soak reports RSS, which grows for reasons that are not leaks (V8 sizes
 * its heap to the load and rarely gives pages back). This script asks the
 * question the soak cannot: after a full GC, does the live heap keep growing
 * with the number of rounds, and if so, which Map or Set inside the broker is
 * growing with it.
 *
 *   node --expose-gc scripts/leak-probe.mjs [rounds=2000] [provider-binary]
 *
 * The provider is the C sample (c/build/samples/host-provider), aggregate, so
 * the three surfaces the soak drives are exercised: the slot, `_all`, and
 * `_broker`. Prints one line per batch; a leak reads as a heapUsed column that
 * climbs batch after batch, and as the collection that climbs with it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as url from "node:url";

import { WsTunnelBuilder } from "../dist/index.js";
import { connectMcp, toolText, waitForBroker } from "../../../../samples/lib/mcp-http-client.mjs";

if (typeof globalThis.gc !== "function") {
    console.error("run with: node --expose-gc scripts/leak-probe.mjs");
    process.exit(2);
}

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..", "..");
const ROUNDS = Number(process.argv[2] ?? 2000);
const BATCH = 250;
const SLOT = "probe";

function providerBinary() {
    const given = process.argv[3];
    const candidates = given
        ? [given]
        : ["host-provider", "host-provider.exe"].map((f) => path.join(repo, "c", "build", "samples", "host-provider", f));
    const found = candidates.find((c) => existsSync(c));
    if (!found) {
        console.error(`host-provider not found (${candidates.join(", ")}); build c/ first`);
        process.exit(2);
    }
    return found;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on("error", reject);
    });
}

/** Every Map and Set reachable one level down from `obj`, with its size. */
function collections(obj, prefix) {
    const out = [];
    if (!obj || typeof obj !== "object") return out;
    for (const key of Object.getOwnPropertyNames(obj)) {
        const v = obj[key];
        if (v instanceof Map || v instanceof Set) out.push([`${prefix}.${key}`, v.size]);
    }
    return out;
}

function snapshot(tunnel) {
    const rows = [...collections(tunnel, "tunnel"), ...collections(tunnel._brokerServer, "_broker"), ...collections(tunnel._aggregateServer, "_all")];
    for (const [name, state] of tunnel._providers) {
        rows.push(...collections(state, `slot(${name})`));
        if (state.httpEndpoint) rows.push([`slot(${name}).endpoint.sessions`, state.httpEndpoint.sessionCount ?? state.httpEndpoint._sessions?.size ?? -1]);
    }
    return rows;
}

async function round(base, n) {
    const text = `probe ${n}`;
    const c = await connectMcp(base, SLOT);
    await c.listTools();
    const reply = toolText(await c.callTool("echo", { text }));
    if (reply !== `${SLOT}: ${text}`) throw new Error(`echo mismatch: ${reply}`);
    await c.close();

    const a = await connectMcp(base, "_all");
    const via = toolText(await a.callTool(`${SLOT}-echo`, { text }));
    if (via !== `${SLOT}: ${text}`) throw new Error(`_all mismatch: ${via}`);
    await a.close();

    if (n % 50 === 0) {
        const b = await connectMcp(base, "_broker");
        await b.callTool("providers_list");
        await b.callTool("broker_diagnose");
        await b.close();
    }
}

async function main() {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const tunnel = new WsTunnelBuilder().withPort(port).withHost("127.0.0.1").withProviderHeartbeat(2000).build();
    await tunnel.start();
    await waitForBroker(base);

    const provider = spawn(providerBinary(), ["--host", "127.0.0.1", "--port", String(port), "--name", SLOT, "--aggregate", "--retry-initial", "200"], {
        stdio: ["ignore", "ignore", "inherit"],
    });
    await new Promise((r) => setTimeout(r, 800));

    const mb = (b) => (b / 1048576).toFixed(1);
    let previous = null;
    const report = (label) => {
        globalThis.gc();
        globalThis.gc();
        const m = process.memoryUsage();
        const rows = snapshot(tunnel);
        const grew = previous ? rows.filter(([k, v]) => v > (previous.get(k) ?? 0)) : [];
        console.log(
            `${label.padEnd(12)} heapUsed=${mb(m.heapUsed)}MB rss=${mb(m.rss)}MB external=${mb(m.external)}MB` +
                (grew.length ? ` | growing: ${grew.map(([k, v]) => `${k}=${v}`).join(" ")}` : " | no collection grew")
        );
        previous = new Map(rows);
        return m.heapUsed;
    };

    // Warm-up rounds first: JIT, caches, and the first sessions all allocate
    // once; what matters is the slope after that.
    for (let n = 1; n <= BATCH; n++) await round(base, n);
    const baseline = report("warm-up");
    const samples = [];
    for (let n = BATCH + 1; n <= ROUNDS; n++) {
        await round(base, n);
        if (n % BATCH === 0) samples.push(report(`round ${n}`));
    }

    console.log("\ncollections after the last batch:");
    for (const [k, v] of snapshot(tunnel)) if (v > 0) console.log(`  ${k} = ${v}`);

    const last = samples[samples.length - 1] ?? baseline;
    const perRound = (last - baseline) / Math.max(1, ROUNDS - BATCH);
    console.log(`\nlive heap after GC: ${mb(baseline)}MB after warm-up -> ${mb(last)}MB after ${ROUNDS} rounds (${perRound.toFixed(0)} bytes per round)`);

    provider.kill();
    await tunnel.stop();
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
