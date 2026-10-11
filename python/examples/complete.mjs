// Start a broker, publish Python tools over the native library, call them, shut down.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WsTunnelBuilder } from "../../node/packages/broker/dist/index.js";
import { connectMcp } from "../../samples/lib/mcp-http-client.mjs";
import { connectWs } from "../lib/mcp-ws-client.mjs";
import fs from "node:fs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex < 0 ? 3600 : process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid --port");
const tls = process.argv.includes("--tls");
const cert = path.join(root, "c/tests/tls/test-cert.pem");
const builder = new WsTunnelBuilder().withHost("127.0.0.1").withPort(port);
if (tls) builder.withTlsFiles(cert, path.join(root, "c/tests/tls/test-key.pem"));
const broker = builder.build();
await broker.start();
const base = `http${tls ? "s" : ""}://127.0.0.1:${port}`;
const wsBase = `ws${tls ? "s" : ""}://127.0.0.1:${port}`;
const child = spawn(process.env.PYTHON || "python", [
    path.join(root, "python/examples/echo.py"), wsBase, "--managed",
    "--multiplex",
], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, "python/src"),
    ...(tls ? { MCP_PROVIDER_CA_FILE: cert } : {}) },
    stdio: ["pipe", "inherit", "pipe"] });
let diagnostics = "";
child.stderr.on("data", data => { diagnostics += data; process.stderr.write(data); });
const exited = once(child, "exit");
const clients = [];
async function connect(slot) {
    const client = tls ? await connectWs(wsBase, slot, { ca: fs.readFileSync(cert) }) : await connectMcp(base, slot);
    clients.push(client);
    return client;
}
try {
    const inspector = await connect("_broker");
    let ready = false;
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(`Python exited: ${diagnostics}`);
        const status = await inspector.callTool("provider_status", { name: "python-slot" });
        const text = status.content.map(c => c.text || "").join("\n");
        if (/"connected":\s*true/.test(text)) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error(`Python slot did not appear: ${diagnostics}`);
    const direct = await connect("python-slot");
    console.log("Published tools:", (await direct.listTools()).tools.map(t => t.name));
    const echoed = await direct.callTool("echo", { message: "Bonjour depuis Python 🐍" });
    assert.deepEqual(echoed.structuredContent, { message: "Bonjour depuis Python 🐍" });
    console.log("Direct echo:", echoed.structuredContent);
    const sum = await direct.callTool("add", { a: 40, b: 2 });
    assert.deepEqual(sum.structuredContent, { result: 42 });
    console.log("Direct add:", sum.structuredContent);
    const aggregate = await connect("_all");
    const listing = await aggregate.listTools();
    const tool = listing.tools.find(t => t.description.startsWith("[python-slot]") && t.name.endsWith("-add"));
    assert.ok(tool, "Python tools were not aggregated");
    const aggregated = await aggregate.callTool(tool.name, { a: 41 });
    assert.deepEqual(aggregated.structuredContent, { result: 42 });
    console.log("Aggregated add (default b=1):", aggregated.structuredContent);
    const resource = await direct.request("resources/read", { uri: "python://sum" });
    assert.equal(JSON.parse(resource.contents[0].text).result, 42);
    console.log("Resource:", resource.contents[0]);
    const template = await direct.request("resources/read", { uri: "python://greeting/World" });
    assert.equal(template.contents[0].text, "Hello, World!");
    const prompt = await direct.request("prompts/get", { name: "review-sum", arguments: { expression: "40 + 2 = 42" } });
    console.log("Prompt:", prompt.messages[0].content.text);
    const subscriber = await connectWs(wsBase, "python-slot", tls ? { ca: fs.readFileSync(cert) } : {});
    clients.push(subscriber);
    await subscriber.request("resources/subscribe", { uri: "python://sum" });
    const updated = once(subscriber.frames, "notifications/resources/updated", { signal: AbortSignal.timeout(6000) });
    await direct.callTool("add", { a: 20, b: 22 });
    assert.equal((await updated)[0].uri, "python://sum");
    await subscriber.request("resources/unsubscribe", { uri: "python://sum" });
    const diagnosticClient = await connect("python-diagnostics");
    assert.equal((await diagnosticClient.callTool("health")).structuredContent.status, "ready");
    console.log("Multiplexed diagnostic slot and resource notifications: OK");
    child.stdin.end("stop\n");
    const timeout = setTimeout(() => child.kill(), 5000);
    const [code] = await exited;
    clearTimeout(timeout);
    assert.equal(code, 0, diagnostics);
    console.log("PASS: Python tools, resources, templates, prompts, subscriptions, multiplexing, _all, clean shutdown");
} finally {
    if (child.exitCode === null) child.kill();
    await Promise.all(clients.map(c => c.close()));
    await broker.stop();
}
