// A real broker, authenticated provider, HTTP clients and the actual native library.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startTestBroker } from "../../node/packages/broker/dist/testing/index.js";
import { connectMcp } from "../../samples/lib/mcp-http-client.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const broker = await startTestBroker({
    callers: { tester: {} }, providers: { python: {} },
    configure: b => b.withProviderHeartbeat(200).withProviderRequestTimeout(5000),
});
const child = spawn(process.env.PYTHON || "python", [
    path.join(root, "python/tests/provider_fixture.py"), broker.wsUrl,
], { cwd: root, env: { ...process.env,
    PYTHONPATH: path.join(root, "python/src"),
    TEST_PROVIDER_SECRET: broker.providerSecret("python"),
}, stdio: ["pipe", "pipe", "pipe"] });
let diagnostics = "";
child.stderr.on("data", data => { diagnostics += data; });
const exited = once(child, "exit");
const clients = [];
const connect = async slot => {
    const c = await connectMcp(broker.url, slot, { headers: broker.bearer("tester") });
    clients.push(c);
    return c;
};
try {
    const inspector = await connect("_broker");
    let ready = false;
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(`Python exited: ${diagnostics}`);
        const status = await inspector.callTool("provider_status", { name: "python-slot" });
        const text = status.content.filter(x => x.type === "text").map(x => x.text).join("\n");
        if (/"connected":\s*true/.test(text)) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, `Provider never connected: ${diagnostics}`);
    const direct = await connect("python-slot");
    const tools = await direct.listTools();
    assert.equal(tools.tools.length, 4);
    const message = 'été 🐍 "\\\n';
    assert.deepEqual((await direct.callTool("echo", { message })).structuredContent, { message });
    await assert.rejects(direct.callTool("echo", { message: 123 }), /Invalid type/);
    assert.equal((await direct.callTool("fail")).isError, true);
    // Ten heartbeat sweeps must not kill the provider during a tool execution.
    assert.deepEqual((await direct.callTool("slow", { seconds: 2 })).structuredContent, { slept: 2 });
    const aggregate = await connect("_all");
    const listing = await aggregate.listTools();
    const echo = listing.tools.find(t => t.description.startsWith("[python-slot]") && t.name.endsWith("-echo"));
    assert.ok(echo, "Python provider is missing from _all");
    assert.deepEqual((await aggregate.callTool(echo.name, { message })).structuredContent, { message });
    child.stdin.end("stop\n");
    const timeout = setTimeout(() => child.kill(), 5000);
    const [code] = await exited;
    clearTimeout(timeout);
    assert.equal(code, 0, diagnostics);
    const status = await inspector.callTool("provider_status", { name: "python-slot" });
    assert.match(status.content.map(c => c.text || "").join("\n"), /"connected":\s*false/);
    console.log("PASS: native Python slot, auth, Unicode, schemas, errors, heartbeat, _all, graceful release");
} finally {
    if (child.exitCode === null) child.kill();
    await Promise.all(clients.map(c => c.close()));
    await broker.stop();
}
