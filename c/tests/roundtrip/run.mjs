/**
 * Roundtrip: the C provider against the Node broker of this repository.
 *
 * The only test in c/ that crosses a real network. The bench in libmcpb/tests
 * proves the codec and the recovery logic against a fake port; this proves
 * that a real broker accepts what the library sends, routes a client's call to
 * the C process and back, admits it into `_all`, and that the provider comes
 * back on its own after the broker is killed and restarted. Then the same
 * over wss://, against the broker on HTTPS with the test certificate in
 * c/tests/tls: the TLS port must verify it through the CA it is given, and
 * refuse it, in words, when it is not.
 *
 * Nothing is installed for it: the broker is `node/packages/broker/dist/bin.js`
 * (build it first), the MCP client is the fetch-only helper the samples use,
 * and the provider is the `host-provider` binary built by c/CMakeLists.txt.
 *
 *   cmake -S c -B c/build && cmake --build c/build
 *   node c/tests/roundtrip/run.mjs [path/to/host-provider]
 *
 * Exit code 0 when every step passed, 1 otherwise. Every line the provider
 * prints is echoed with a `provider |` prefix so a failure is readable.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as url from "node:url";

import { connectMcp, toolText, waitForBroker } from "../../../samples/lib/mcp-http-client.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const brokerBin = path.join(repo, "node", "packages", "broker", "dist", "bin.js");

const SLOT = "c-roundtrip";
const MUX = "c-mux"; // the multiplexed provider publishes MUX (in _all) and MUX-b (not in _all) on one socket
const TLS_SLOT = "c-tls";
const STEP_TIMEOUT_MS = 8_000;

// Test material only: self-signed, a century of validity, private key in the
// repository. The broker serves it; the C provider is given it as its CA.
const TLS_DIR = path.join(repo, "c", "tests", "tls");
const TLS_CERT = path.join(TLS_DIR, "test-cert.pem");
const TLS_KEY = path.join(TLS_DIR, "test-key.pem");

// Node's fetch reads its trust store at start-up and only from the
// environment, so for the https phase this script re-runs itself with the
// test certificate added to that store. Harmless for the http phases.
if (!(process.env.NODE_EXTRA_CA_CERTS ?? "").includes(TLS_CERT)) {
    const r = spawnSync(process.execPath, [url.fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        stdio: "inherit",
        env: { ...process.env, NODE_EXTRA_CA_CERTS: TLS_CERT },
    });
    process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------------------

function fail(message) {
    console.error(`\nFAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
}

function step(title) {
    console.log(`\n== ${title}`);
}

function ok(what) {
    console.log(`   ok: ${what}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function providerBinary() {
    const given = process.argv[2] ?? process.env.MCPB_HOST_PROVIDER;
    const candidates = given
        ? [given]
        : ["host-provider", "host-provider.exe", "Debug/host-provider.exe", "Release/host-provider.exe"].map((f) =>
              path.join(repo, "c", "build", "samples", "host-provider", f)
          );
    const found = candidates.find((c) => existsSync(c));
    if (!found) {
        fail(
            `host-provider binary not found. Looked at:\n   ${candidates.join("\n   ")}\n` +
                `Build it with: cmake -S c -B c/build && cmake --build c/build`
        );
    }
    return found;
}

// ---------------------------------------------------------------------------
// Broker process

function startBroker(port, { tls = false } = {}) {
    const child = spawn(process.execPath, [brokerBin], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            MCP_BROKER_PORT: String(port),
            MCP_BROKER_HOST: "127.0.0.1",
            MCP_BROKER_PROTOCOL: tls ? "https" : "http",
            ...(tls ? { MCP_BROKER_TLS_CERT: TLS_CERT, MCP_BROKER_TLS_KEY: TLS_KEY } : {}),
            // Short, so the liveness sweep is exercised within the test; the
            // production default is 30000.
            MCP_BROKER_PROVIDER_HEARTBEAT_MS: "2000",
        },
    });
    const relay = (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
            if (line.startsWith("[broker]")) console.log(`broker   | ${line}`);
        }
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    return child;
}

// ---------------------------------------------------------------------------
// Provider process, with a line-oriented log we can wait on

function startProvider(binary, port, name = SLOT, extra = []) {
    const child = spawn(
        binary,
        ["--host", "127.0.0.1", "--port", String(port), "--name", name, "--aggregate", "--retry-initial", "200", "--retry-max", "1000", ...extra],
        { stdio: ["ignore", "pipe", "pipe"] }
    );
    const tag = extra.includes("--multiplex") ? "mux     " : extra.includes("--tls") ? "tls     " : "provider";

    const lines = [];
    const waiters = [];
    let pending = "";
    const onData = (chunk) => {
        pending += chunk.toString();
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? "";
        for (const line of parts) {
            if (line.length === 0) continue;
            console.log(`${tag} | ${line}`);
            lines.push(line);
            for (const w of waiters.splice(0)) w.check(line) || waiters.push(w);
        }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    /** Resolves with the first NEW line matching `re`, or rejects after the timeout. */
    const waitFor = (re, what, timeoutMs = STEP_TIMEOUT_MS) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = waiters.indexOf(waiter);
                if (idx >= 0) waiters.splice(idx, 1);
                reject(new Error(`timed out after ${timeoutMs}ms waiting for the provider to print ${what}`));
            }, timeoutMs);
            const waiter = {
                check(line) {
                    if (!re.test(line)) return false;
                    clearTimeout(timer);
                    resolve(line);
                    return true;
                },
            };
            waiters.push(waiter);
        });

    return { child, lines, waitFor };
}

// ---------------------------------------------------------------------------

async function main() {
    const binary = providerBinary();
    if (!existsSync(brokerBin)) {
        fail(`broker not built: ${brokerBin} is missing. Run "npm run build" in node/ first.`);
    }

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let broker = null;
    let provider = null;
    let mux = null;
    let noCa = null;

    const cleanup = () => {
        if (provider && !provider.child.killed) provider.child.kill();
        if (mux && !mux.child.killed) mux.child.kill();
        if (noCa && !noCa.child.killed) noCa.child.kill();
        if (broker && !broker.killed) broker.kill("SIGKILL");
    };
    process.on("exit", cleanup);

    try {
        step(`Start the broker on ${base}`);
        broker = startBroker(port);
        await waitForBroker(base);
        ok("broker answers");

        step("Start the C provider and wait for CONNECTED");
        provider = startProvider(binary, port);
        const connected = provider.waitFor(/^event CONNECTED /, "event CONNECTED");
        await connected;
        ok("provider connected and joined _all");

        // The broker's internal client for `_all` sends initialize at once;
        // give the exchange a moment so the catalog is populated before we
        // look at it.
        await sleep(300);

        step(`Call the tool through the provider's own slot /${SLOT}/mcp`);
        {
            const client = await connectMcp(base, SLOT);
            // The device names itself after its slot, so a client can tell
            // which of several identical firmwares answered.
            if (client.serverInfo?.name !== SLOT) {
                fail(`serverInfo.name is ${JSON.stringify(client.serverInfo)}, expected "${SLOT}"`);
            }
            ok(`initialize negotiated with serverInfo ${client.serverInfo.name} ${client.serverInfo.version}`);

            const tools = (await client.listTools()).tools.map((t) => t.name);
            if (!tools.includes("echo")) fail(`tools/list returned ${JSON.stringify(tools)}, expected "echo"`);
            ok(`tools/list -> ${tools.join(", ")}`);

            const text = toolText(await client.callTool("echo", { text: 'hello "quoted" \\ backslash' }));
            const want = `${SLOT}: hello "quoted" \\ backslash`;
            if (text !== want) fail(`tools/call echo returned ${JSON.stringify(text)}, expected ${JSON.stringify(want)}`);
            ok(`tools/call echo -> ${JSON.stringify(text)}`);

            await client.close();
        }

        step("Call the same tool through the _all aggregate");
        {
            const all = await connectMcp(base, "_all");
            const qualified = `${SLOT}-echo`;
            const tools = (await all.listTools()).tools.map((t) => t.name);
            if (!tools.includes(qualified)) {
                fail(`_all tools/list returned ${JSON.stringify(tools)}, expected "${qualified}". The register frame was not honoured.`);
            }
            ok(`_all lists ${qualified}`);

            const text = toolText(await all.callTool(qualified, { text: "via _all" }));
            if (text !== `${SLOT}: via _all`) fail(`_all tools/call returned ${JSON.stringify(text)}`);
            ok(`_all tools/call -> ${JSON.stringify(text)}`);
            await all.close();
        }

        step("Start the multiplexed provider: one socket, two slots");
        {
            mux = startProvider(binary, port, MUX, ["--multiplex"]);
            await mux.waitFor(/^event CONNECTED /, "the multiplexed provider's CONNECTED");
            await sleep(300);
            ok("connected on /providers");

            const a = await connectMcp(base, MUX);
            const ta = toolText(await a.callTool("echo", { text: "slot a" }));
            if (ta !== `${MUX}: slot a`) fail(`slot ${MUX} answered ${JSON.stringify(ta)}`);
            await a.close();
            ok(`/${MUX}/mcp served by the first slot`);

            const b = await connectMcp(base, `${MUX}-b`);
            const tb = toolText(await b.callTool("echo", { text: "slot b" }));
            if (tb !== `${MUX}-b: slot b`) fail(`slot ${MUX}-b answered ${JSON.stringify(tb)}`);
            await b.close();
            ok(`/${MUX}-b/mcp served by the second slot, same socket`);

            const all = await connectMcp(base, "_all");
            const names = (await all.listTools()).tools.map((t) => t.name);
            if (!names.includes(`${MUX}-echo`)) fail(`_all does not list ${MUX}-echo: ${names.join(",")}`);
            if (names.includes(`${MUX}-b-echo`)) fail(`_all lists ${MUX}-b-echo, which registered without aggregate`);
            const via = toolText(await all.callTool(`${MUX}-echo`, { text: "via _all" }));
            if (via !== `${MUX}: via _all`) fail(`_all call on the multiplexed slot answered ${JSON.stringify(via)}`);
            await all.close();
            ok(`_all has ${MUX}-echo and not ${MUX}-b-echo: aggregate is per slot`);
        }

        step("Kill the broker: the provider must announce the loss at once");
        {
            const lost = provider.waitFor(/^event DISCONNECTED /, "event DISCONNECTED");
            broker.kill("SIGKILL");
            const line = await lost;
            ok(`announced: ${line}`);
            // While the broker is down, attempts fail and are reported as
            // follow-ups, not as new incidents.
            const retry = await provider.waitFor(/^event RETRY_FAILED /, "event RETRY_FAILED");
            ok(`then: ${retry}`);
        }

        step("Restart the broker on the same port: both providers must come back by themselves");
        {
            const back = provider.waitFor(/^event CONNECTED /, "a second event CONNECTED");
            const muxBack = mux.waitFor(/^event CONNECTED /, "the multiplexed provider's second CONNECTED");
            broker = startBroker(port);
            await waitForBroker(base);
            const line = await back;
            if (!/connects=2/.test(line)) fail(`expected connects=2 in ${JSON.stringify(line)}`);
            ok(`recovered: ${line}`);
            const muxLine = await muxBack;
            if (!/connects=2/.test(muxLine)) fail(`expected connects=2 for the multiplexed provider in ${JSON.stringify(muxLine)}`);
            ok(`multiplexed provider recovered: ${muxLine}`);
            await sleep(300);

            const b = await connectMcp(base, `${MUX}-b`);
            const tb = toolText(await b.callTool("echo", { text: "after restart" }));
            if (tb !== `${MUX}-b: after restart`) fail(`after restart, ${MUX}-b answered ${JSON.stringify(tb)}`);
            await b.close();
            ok(`both slots re-registered on the new socket: /${MUX}-b/mcp serves again`);

            const client = await connectMcp(base, SLOT);
            const text = toolText(await client.callTool("echo", { text: "after restart" }));
            if (text !== `${SLOT}: after restart`) fail(`after restart, tools/call returned ${JSON.stringify(text)}`);
            ok(`tools/call after the restart -> ${JSON.stringify(text)}`);
            await client.close();
        }

        step("Stop the plaintext phase");
        provider.child.kill();
        mux.child.kill();
        broker.kill("SIGKILL");
        provider = null;
        mux = null;
        await sleep(200);

        // ------------------------------------------------------------------
        // wss://. The binary says so on stderr and exits 2 when it was built
        // without the TLS port; the phase is then skipped, unless the run is
        // told the port must be there (the CI is).
        const probe = spawnSync(binary, ["--tls", "--port", "1"], { encoding: "utf8", timeout: 5000 });
        if (/built without the TLS port/.test(probe.stderr ?? "")) {
            if (process.env.MCPB_ROUNDTRIP_REQUIRE_TLS) fail("host-provider was built without the TLS port, and MCPB_ROUNDTRIP_REQUIRE_TLS is set");
            console.log("\n== wss:// phase skipped: host-provider was built without the TLS port (MCPB_TLS=OFF)");
        } else {
            const tlsPort = await freePort();
            const https = `https://127.0.0.1:${tlsPort}`;

            step(`Start the broker on ${https}, with the test certificate`);
            broker = startBroker(tlsPort, { tls: true });
            await waitForBroker(https);
            ok("broker answers over HTTPS");

            step("Start the C provider over wss:// with the test CA, and wait for CONNECTED");
            provider = startProvider(binary, tlsPort, TLS_SLOT, ["--tls", "--ca", TLS_CERT]);
            await provider.waitFor(/^event CONNECTED /, "event CONNECTED over wss");
            await sleep(300);
            ok("provider connected through the TLS port");

            const client = await connectMcp(https, TLS_SLOT);
            const text = toolText(await client.callTool("echo", { text: "over tls" }));
            if (text !== `${TLS_SLOT}: over tls`) fail(`tools/call over wss returned ${JSON.stringify(text)}`);
            await client.close();
            ok(`tools/call through /${TLS_SLOT}/mcp on HTTPS -> ${JSON.stringify(text)}`);

            step("The same provider without the CA: refused in words, never in the clear");
            noCa = startProvider(binary, tlsPort, `${TLS_SLOT}-noca`, ["--tls"]);
            const refused = await noCa.waitFor(/^event RETRY_FAILED /, "event RETRY_FAILED from the provider without a CA");
            if (!/TLS handshake or certificate refused/.test(refused)) fail(`expected the TLS refusal in ${JSON.stringify(refused)}`);
            ok(`refused: ${refused}`);
            noCa.child.kill();

            step("Stop the TLS phase");
            provider.child.kill();
            broker.kill("SIGKILL");
        }
        console.log("\nroundtrip: all steps passed");
        process.exitCode = 0;
    } catch (err) {
        if (process.exitCode !== 1) {
            console.error(`\nFAIL: ${err.message}`);
            process.exitCode = 1;
        }
    } finally {
        cleanup();
    }
}

main();
