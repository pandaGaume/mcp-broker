import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startTestBroker } from "../../node/packages/broker/dist/testing/index.js";
import { connectWs } from "../lib/mcp-ws-client.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cert = path.join(root, "c/tests/tls/test-cert.pem");
const key = path.join(root, "c/tests/tls/test-key.pem");
const require = createRequire(new URL("../../node/package.json", import.meta.url));
const untrustedCa = path.join(root, "python/build/untrusted-ca.pem");
const unrelated = await require("selfsigned").generate([{ name: "commonName", value: "Unrelated test CA" }], { days: 1, keySize: 2048 });
fs.writeFileSync(untrustedCa, unrelated.cert);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function phase(tls, multiplex) {
    const broker = await startTestBroker({ callers: { tester: {} }, providers: { python: {} },
        configure: b => {
            b.withProviderHeartbeat(200).withProviderRequestTimeout(5000);
            if (tls) b.withTlsFiles(cert, key);
        },
    });
    const wsBase = broker.wsUrl.replace(/^ws:/, tls ? "wss:" : "ws:");
    const clients = [], children = [];
    const connect = async slot => {
        const c = await connectWs(wsBase, slot, { headers: broker.bearer("tester"), ...(tls ? { ca: fs.readFileSync(cert) } : {}) });
        clients.push(c);
        return c;
    };
    function publish(extra = {}) {
        const child = spawn(process.env.PYTHON || "python", [path.join(root, "python/tests/provider_fixture.py"), wsBase], {
            cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, "python/src"),
                TEST_PROVIDER_SECRET: broker.providerSecret("python"),
                ...(multiplex ? { TEST_MULTIPLEX: "1" } : {}),
                ...(tls ? { TEST_CA_FILE: cert } : {}), ...extra }, stdio: ["pipe", "pipe", "pipe"],
        });
        const record = { child, exited: once(child, "exit"), diagnostics: "" };
        child.stderr.on("data", data => { record.diagnostics += data; });
        children.push(record);
        return record;
    }
    async function stop(record) {
        record.child.stdin.end("stop\n");
        const timer = setTimeout(() => record.child.kill(), 5000);
        const [code] = await record.exited;
        clearTimeout(timer);
        assert.equal(code, 0, record.diagnostics);
    }
    try {
        const inspector = await connect("_broker");
        async function status(slot) {
            const r = await inspector.callTool("provider_status", { name: slot });
            const text = r.content.find(c => c.type === "text").text;
            return r.isError ? null : JSON.parse(text);
        }
        async function ready(slot, record) {
            for (let i = 0; i < 100; i++) {
                if (record.child.exitCode !== null) throw new Error(record.diagnostics);
                if ((await status(slot))?.connected) return;
                await delay(50);
            }
            throw new Error(`Slot ${slot} unavailable: ${record.diagnostics}`);
        }
        const provider = publish();
        await ready("python-slot", provider);
        const a = await connect("python-slot");
        const b = await connect("python-slot");
        assert.equal(a.initialized.capabilities.resources.subscribe, true);
        assert.ok(a.initialized.capabilities.prompts);
        assert.equal((await a.request("resources/list")).resources.length, 2);
        assert.equal((await a.request("resources/templates/list")).resourceTemplates.length, 1);
        const binary = (await a.request("resources/read", { uri: "memory://binary" })).contents[0];
        assert.deepEqual([...Buffer.from(binary.blob, "base64")], [0, 255, 1]);
        const templated = await a.request("resources/read", { uri: "memory://device/pump%2012" });
        assert.equal(JSON.parse(templated.contents[0].text).name, "pump 12");
        assert.equal((await a.request("prompts/list")).prompts[0].name, "diagnostic");
        const prompt = await a.request("prompts/get", { name: "diagnostic", arguments: { machine: "pump-12" } });
        assert.match(prompt.messages[0].content.text, /pump-12/);
        await assert.rejects(a.request("resources/read", { uri: "memory://missing" }), /Resource not found/);
        await a.request("resources/subscribe", { uri: "memory://state" });
        const firstUpdate = once(a.frames, "notifications/resources/updated", { signal: AbortSignal.timeout(6000) });
        await b.callTool("update", { value: 1 });
        assert.equal((await firstUpdate)[0].uri, "memory://state");
        assert.equal(JSON.parse((await a.request("resources/read", { uri: "memory://state" })).contents[0].text).value, 1);
        await b.request("resources/subscribe", { uri: "memory://state" });
        await a.request("resources/unsubscribe", { uri: "memory://state" });
        let aUpdates = 0;
        a.frames.on("notifications/resources/updated", () => aUpdates++);
        const secondUpdate = once(b.frames, "notifications/resources/updated", { signal: AbortSignal.timeout(6000) });
        await a.callTool("update", { value: 2 });
        await secondUpdate;
        assert.equal(aUpdates, 0, "Unsubscribed client received an update");
        await b.request("resources/unsubscribe", { uri: "memory://state" });
        const aggregate = await connect("_all");
        const listing = await aggregate.request("prompts/list");
        const entry = listing.prompts.find(p => p.name.endsWith("-diagnostic"));
        assert.ok(entry);
        const aggregatedPrompt = await aggregate.request("prompts/get", { name: entry.name, arguments: { machine: "pump-42" } });
        assert.match(aggregatedPrompt.messages[0].content.text, /pump-42/);
        await assert.rejects(aggregate.request("resources/list"), /Method not found/);
        if (multiplex) {
            await ready("python-secondary", provider);
            assert.equal((await status("python-slot")).transport, "ws-multiplex");
            const secondary = await connect("python-secondary");
            const response = await secondary.callTool("echo", { message: "other slot" });
            assert.equal(response.structuredContent.slot, "python-secondary");
            const refused = publish({ TEST_SECOND_SLOT: "python-extra" });
            await ready("python-extra", refused);
            const extra = await connect("python-extra");
            assert.equal((await extra.callTool("echo", { message: "still works" })).structuredContent.slot, "python-extra");
            // One refused slot does not interrupt other slots on the same tunnel.
            await stop(refused);
        }
        if (tls) {
            const untrusted = publish({ TEST_CA_FILE: untrustedCa, TEST_MULTIPLEX: "" });
            for (let i = 0; i < 300 && !/certificate|self.signed/i.test(untrusted.diagnostics); i++) await delay(50);
            assert.match(untrusted.diagnostics, /certificate|self.signed/i, "Untrusted TLS certificate was not refused");
            await stop(untrusted);
        }
        await stop(provider);
        assert.equal((await status("python-slot")).connected, false);
        // Subscriptions belong to broker clients and must be replayed on provider recovery.
        // Subscribe while the provider is online, then replace its native connection.
        const recovered = publish();
        await ready("python-slot", recovered);
        await a.request("resources/subscribe", { uri: "memory://state" });
        await stop(recovered);
        const replayed = once(a.frames, "notifications/resources/updated", { signal: AbortSignal.timeout(6000) });
        const replaced = publish();
        await ready("python-slot", replaced);
        await replayed;
        const afterRecovery = once(a.frames, "notifications/resources/updated", { signal: AbortSignal.timeout(6000) });
        await a.callTool("update", { value: 3 });
        await afterRecovery;
        await a.request("resources/unsubscribe", { uri: "memory://state" });
        await stop(replaced);
        console.log(`PASS: ${tls ? "wss" : "ws"} ${multiplex ? "multiplex" : "dedicated"}, resources, subscriptions, templates, prompts, _all${tls ? ", CA verification" : ""}`);
    } finally {
        for (const r of children) if (r.child.exitCode === null) r.child.kill();
        await Promise.all(clients.map(c => c.close()));
        await broker.stop();
    }
}

for (const tls of (process.argv.includes("--tls-only") ? [true] : [false, true]))
    for (const multiplex of [false, true]) await phase(tls, multiplex);
