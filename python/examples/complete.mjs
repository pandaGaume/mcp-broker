// Start a broker, publish Python tools over the native library, call them, shut down.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WsTunnelBuilder } from "../../node/packages/broker/dist/index.js";
import { connectMcp } from "../../samples/lib/mcp-http-client.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex < 0 ? 3600 : process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid --port");
const broker = new WsTunnelBuilder().withHost("127.0.0.1").withPort(port).build();
await broker.start();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.env.PYTHON || "python", [
    path.join(root, "python/examples/echo.py"), `ws://127.0.0.1:${port}`, "--managed",
], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, "python/src") },
    stdio: ["pipe", "inherit", "pipe"] });
let diagnostics = "";
child.stderr.on("data", data => { diagnostics += data; process.stderr.write(data); });
const exited = once(child, "exit");
const clients = [];
async function connect(slot) {
    const client = await connectMcp(base, slot);
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
    child.stdin.end("stop\n");
    const timeout = setTimeout(() => child.kill(), 5000);
    const [code] = await exited;
    clearTimeout(timeout);
    assert.equal(code, 0, diagnostics);
    console.log("PASS: Python tools served by libmcpb, direct slot and _all, clean shutdown");
} finally {
    if (child.exitCode === null) child.kill();
    await Promise.all(clients.map(c => c.close()));
    await broker.stop();
}
