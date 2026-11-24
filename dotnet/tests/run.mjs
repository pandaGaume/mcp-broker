// Build the .NET solution and Node broker first. This runner installs nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "../../node/node_modules/ws/wrapper.mjs";
import { startTestBroker } from "../../node/packages/broker/dist/testing/index.js";
import { connectMcp } from "../../samples/lib/mcp-http-client.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = path.join(root, "dotnet/tests/ProviderTests/bin/Release/net8.0/ProviderTests.dll");
const children = new Set();

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function eventually(check, label, milliseconds = 10_000) {
    const end = Date.now() + milliseconds;
    let lastError;
    while (Date.now() < end) {
        try {
            const result = await check();
            if (result) return result;
        } catch (error) {
            lastError = error;
        }
        await pause(40);
    }
    throw new Error(`Timed out: ${label}`, { cause: lastError });
}

async function deadline(promise, label, milliseconds = 15_000) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function launch(mode, endpoint, secret) {
    const child = spawn(process.env.DOTNET || "dotnet", [fixture, mode, endpoint], {
        cwd: root,
        env: { ...process.env, MCP_PROVIDER_SECRET: secret ?? "" },
        stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let output = "";
    let diagnostics = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { diagnostics += data; });
    const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            children.delete(child);
            resolve({ code, signal });
        });
    });
    return {
        child,
        async ready() {
            await deadline(new Promise((resolve, reject) => {
                if (output.includes("READY")) return resolve();
                const onData = () => {
                    if (output.includes("READY")) {
                        child.stdout.off("data", onData);
                        resolve();
                    }
                };
                child.stdout.on("data", onData);
                exited.then(() => reject(new Error(`Fixture exited before ready: ${output}${diagnostics}`)), reject);
            }), "provider readiness");
        },
        async success() {
            const { code, signal } = await deadline(exited, `${mode} exit`);
            assert.equal(code, 0, `${mode} exited with ${code}/${signal}: ${output}${diagnostics}`);
            assert.match(output, /PASS/, `Fixture did not report success: ${output}${diagnostics}`);
        },
    };
}

function frames(socket) {
    const pending = [];
    const received = [];
    socket.on("message", data => {
        const value = JSON.parse(data.toString());
        if (pending.length) pending.shift()(value);
        else received.push(value);
    });
    return () => deadline(received.length
        ? Promise.resolve(received.shift())
        : new Promise(resolve => pending.push(resolve)), "WebSocket frame");
}

async function roundtrip() {
    const broker = await startTestBroker({
        callers: { tester: {} },
        providers: { dotnet: {} },
        configure: builder => builder.withProviderTakeover("reject").withProviderRequestTimeout(5000),
    });
    const secret = broker.providerSecret("dotnet");
    const provider = launch("host", broker.wsUrl, secret);
    const clients = [];
    async function connect(slot) {
        const client = await connectMcp(broker.url, slot, { headers: broker.bearer("tester") });
        clients.push(client);
        return client;
    }
    try {
        await provider.ready();
        const message = 'Bonjour depuis C# é 🐙 " \\ \n';
        for (const slot of ["dotnet-direct", "dotnet-private", "dotnet-mux", "dotnet-mux-private"]) {
            const client = await connect(slot);
            assert.equal((await client.listTools()).tools.length, 1);
            assert.deepEqual((await client.callTool("echo", { message })).structuredContent, { message });
            await assert.rejects(client.request("prompts/get", { name: "missing" }), error => error.rpc?.code === -32601);
        }

        const aggregate = await connect("_all");
        const tools = (await aggregate.listTools()).tools;
        for (const slot of ["dotnet-direct", "dotnet-mux"]) {
            const tool = tools.find(item => item.description.startsWith(`[${slot}]`));
            assert.ok(tool, `${slot} did not join _all`);
            assert.deepEqual((await aggregate.callTool(tool.name, { message })).structuredContent, { message });
        }
        for (const slot of ["dotnet-private", "dotnet-mux-private"])
            assert.ok(!tools.some(item => item.description.startsWith(`[${slot}]`)), `${slot} unexpectedly joined _all`);

        await launch("refusal-direct", broker.providerUrl("dotnet-direct"), secret).success();
        await launch("refusal-multiplex", broker.providersUrl, secret).success();
        await launch("auth-failure", broker.providerUrl("dotnet-denied"), "incorrect-secret").success();

        // All request ids on the provider socket belong to the broker. Parallel
        // callers may choose identical client ids and still receive their reply.
        const first = await connect("dotnet-direct");
        const second = await connect("dotnet-direct");
        const replies = await Promise.all([
            first.callTool("echo", { message: "first" }),
            second.callTool("echo", { message: "second" }),
        ]);
        assert.deepEqual(replies.map(reply => reply.structuredContent.message), ["first", "second"]);
        await Promise.all(clients.map(client => client.close()));
        clients.length = 0;
        provider.child.stdin.end("stop\n");
        await provider.success();
        const replacement = launch("host", broker.wsUrl, secret);
        await replacement.ready();
        const reattached = await connect("dotnet-direct");
        assert.deepEqual((await reattached.callTool("echo", { message: "reattached" })).structuredContent, { message: "reattached" });
        await reattached.close();
        clients.length = 0;
        replacement.child.stdin.end("stop\n");
        await replacement.success();
        console.log("PASS: direct, multiplex, aggregate opt-in, provider authentication, refusals, concurrent callers, shutdown");
    } finally {
        if (provider.child.exitCode === null) provider.child.kill();
        await Promise.all(clients.map(client => client.close()));
        await broker.stop();
    }
}

async function wire(multiplexed) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const connected = new Promise(resolve => server.once("connection", (socket, request) => {
        resolve({ socket, request, next: frames(socket) });
    }));
    await once(server, "listening");
    const endpoint = `ws://127.0.0.1:${server.address().port}/${multiplexed ? "providers" : "provider/wire"}`;
    const provider = launch(multiplexed ? "wire-multiplex" : "wire-direct", endpoint, "wire-secret");
    try {
        const { socket, request, next } = await deadline(connected, "mock connection");
        assert.equal(request.headers["x-provider-token"], "wire-secret");
        const registration = await next();
        const unwrap = value => multiplexed ? value.payload : value;
        const wrap = value => multiplexed ? { provider: "wire", payload: value } : value;
        assert.deepEqual(unwrap(registration), {
            jsonrpc: "2.0", method: "notifications/register", params: { aggregate: true },
        });
        if (multiplexed) assert.equal(registration.provider, "wire");

        socket.send("not JSON");
        socket.send("[]");
        socket.send(JSON.stringify(wrap({ jsonrpc: "2.0", id: null, error: { code: "invalid", message: "malformed error" } })));
        if (multiplexed) {
            socket.send(JSON.stringify({ provider: "missing", payload: { jsonrpc: "2.0", id: "ignored", method: "ping" } }));
            socket.send(JSON.stringify({ provider: "wire", payload: "invalid payload" }));
        }
        const message = "é🐙".repeat(25_000);
        for (const id of ["7", 7]) {
            const payload = Buffer.from(JSON.stringify(wrap({
                jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo", arguments: { message } },
            })));
            // Fragment in the middle of a UTF-8 code point, then continue the
            // same text message. The receiver must assemble bytes before JSON.
            const split = payload.indexOf(Buffer.from("é")) + 1;
            socket.send(payload.subarray(0, split), { binary: false, fin: false });
            socket.send(payload.subarray(split), { binary: false, fin: true });
            const response = await next();
            assert.equal(unwrap(response).id, id);
            assert.deepEqual(unwrap(response).result.structuredContent, { message });
            if (multiplexed) assert.equal(response.provider, "wire");
        }
        socket.close(1000, "complete");
        await provider.success();
        console.log(`PASS: ${multiplexed ? "multiplex" : "direct"} registration, fragments, Unicode, large messages, id types, malformed frames`);
    } finally {
        if (provider.child.exitCode === null) provider.child.kill();
        for (const client of server.clients) client.terminate();
        await new Promise(resolve => server.close(resolve));
    }
}

async function abnormalClose() {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", socket => socket.once("message", () => socket.close(1008, "test refusal")));
    await once(server, "listening");
    const provider = launch("closed-direct", `ws://127.0.0.1:${server.address().port}/provider/wire`);
    try {
        await provider.success();
        console.log("PASS: abnormal close status and reason");
    } finally {
        if (provider.child.exitCode === null) provider.child.kill();
        for (const client of server.clients) client.terminate();
        await new Promise(resolve => server.close(resolve));
    }
}

async function lifecycle(mode) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const connected = new Promise(resolve => server.once("connection", socket => resolve({ socket, next: frames(socket) })));
    await once(server, "listening");
    const provider = launch(mode, `ws://127.0.0.1:${server.address().port}/provider/wire`);
    try {
        const { socket, next } = await deadline(connected, "lifecycle connection");
        assert.equal((await next()).method, "notifications/register");
        if (mode === "message-bounds") {
            // The oversized application send must be rejected locally, leaving
            // only this small frame on the wire. Incoming excess ends the link.
            assert.equal((await next()).method, "ready");
            socket.send(JSON.stringify({ jsonrpc: "2.0", method: "large", params: { value: "x".repeat(512) } }));
        } else {
            const indices = [];
            for (let index = 0; index < 16; index++) {
                const reply = await next();
                assert.equal(reply.id, reply.result.index);
                indices.push(reply.id);
            }
            assert.deepEqual(indices.sort((a, b) => a - b), Array.from({ length: 16 }, (_, index) => index));
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: "fail", method: "fail" }));
        }
        await provider.success();
        console.log(`PASS: ${mode}`);
    } finally {
        if (provider.child.exitCode === null) provider.child.kill();
        for (const client of server.clients) client.terminate();
        await new Promise(resolve => server.close(resolve));
    }
}

async function brokerRestart() {
    const options = {
        callers: { tester: {} },
        providers: { dotnet: {} },
        configure: builder => builder.withProviderTakeover("reject").withProviderRequestTimeout(3000),
    };
    let broker = await startTestBroker(options);
    const port = Number(new URL(broker.url).port);
    const provider = launch("host", broker.wsUrl, broker.providerSecret("dotnet"));
    async function echo(slot) {
        const client = await connectMcp(broker.url, slot, { headers: broker.bearer("tester") });
        try {
            assert.deepEqual((await client.callTool("echo", { message: slot })).structuredContent, { message: slot });
            return true;
        } finally {
            await client.close();
        }
    }
    try {
        await provider.ready();
        await echo("dotnet-direct");
        await echo("dotnet-mux");
        await broker.stop();
        // Leave the listener absent through the default first retry so this
        // exercises a refused TCP connection before a successful upgrade.
        await pause(1500);
        broker = await startTestBroker({
            ...options,
            configure: builder => {
                options.configure(builder);
                builder.withPort(port);
            },
        });
        for (const slot of ["dotnet-direct", "dotnet-private", "dotnet-mux", "dotnet-mux-private"])
            await eventually(() => echo(slot), `reconnected ${slot}`);
        const aggregate = await connectMcp(broker.url, "_all", { headers: broker.bearer("tester") });
        try {
            await eventually(async () => {
                const tools = (await aggregate.listTools()).tools;
                for (const slot of ["dotnet-direct", "dotnet-mux"]) {
                    const tool = tools.find(item => item.description.startsWith(`[${slot}]`));
                    assert.ok(tool, `${slot} did not rejoin _all`);
                    assert.deepEqual((await aggregate.callTool(tool.name, { message: "restarted" })).structuredContent, { message: "restarted" });
                }
                for (const slot of ["dotnet-private", "dotnet-mux-private"])
                    assert.ok(!tools.some(item => item.description.startsWith(`[${slot}]`)), `${slot} opted into _all during reconnect`);
                return true;
            }, "aggregate recovery after restart");
        } finally {
            await aggregate.close();
        }
        provider.child.stdin.end("stop\n");
        await provider.success();
        console.log("PASS: broker restart restores direct and multiplex slots, credentials and _all membership");
    } finally {
        if (provider.child.exitCode === null) provider.child.kill();
        await broker.stop();
    }
}

async function retryBackoff(multiplexed) {
    const attempts = [];
    let rejectAll = false;
    let accepted = 0;
    const server = new WebSocketServer({
        host: "127.0.0.1", port: 0,
        verifyClient: ({ req }, done) => {
            attempts.push(performance.now());
            assert.equal(req.headers["x-provider-token"], "retry-secret");
            done(!rejectAll && attempts.length > 4, 503, "Temporarily unavailable");
        },
    });
    let resolveHealthy;
    let rejectHealthy;
    const healthy = new Promise((resolve, reject) => { resolveHealthy = resolve; rejectHealthy = reject; });
    server.on("connection", socket => {
        const next = frames(socket);
        const transientRefusal = ++accepted === 1;
        (async () => {
            const registrations = [await next()];
            if (multiplexed) registrations.push(await next());
            if (transientRefusal) {
                if (multiplexed)
                    socket.send(JSON.stringify({ provider: "wire", payload: {
                        jsonrpc: "2.0", id: null, error: { code: -32000, message: "Provider is already connected" },
                    } }));
                else socket.close(1008, "Slot already held by a live provider");
            } else resolveHealthy({ socket, next, registrations });
        })().catch(rejectHealthy);
    });
    await once(server, "listening");
    const endpoint = `ws://127.0.0.1:${server.address().port}/${multiplexed ? "providers" : "provider/wire"}`;
    const provider = launch(multiplexed ? "reconnect-multiplex" : "reconnect-direct", endpoint, "retry-secret");
    try {
        const { socket, next, registrations } = await deadline(healthy, "connection after increasing retries");
        await provider.ready();
        assert.equal(attempts.length, 6, "Expected four HTTP failures, one occupied-slot refusal, then recovery");
        const intervals = attempts.slice(1).map((time, index) => time - attempts[index]);
        for (const [index, expected] of [120, 240, 480, 480, 480].entries()) {
            assert.ok(intervals[index] >= expected - 25, `Retry ${index + 1} arrived too early: ${intervals[index]}ms`);
            assert.ok(intervals[index] < expected + 300, `Retry ${index + 1} exceeded its cap: ${intervals[index]}ms`);
        }
        const unwrap = value => multiplexed ? value.payload : value;
        assert.deepEqual(unwrap(registrations[0]), {
            jsonrpc: "2.0", method: "notifications/register", params: { aggregate: true },
        });
        if (multiplexed) {
            assert.equal(registrations[0].provider, "wire");
            assert.deepEqual(registrations[1], { provider: "private", payload: { jsonrpc: "2.0", method: "notifications/register" } });
        }
        const request = { jsonrpc: "2.0", id: "recovered", method: "tools/call", params: { name: "echo", arguments: { message: "after retries" } } };
        socket.send(JSON.stringify(multiplexed ? { provider: "wire", payload: request } : request));
        assert.deepEqual(unwrap(await next()).result.structuredContent, { message: "after retries" });

        // A healthy session resets the retry schedule. The first retry must use
        // 120 ms again, while an immediate occupied-slot refusal above must not.
        await pause(600);
        rejectAll = true;
        const disconnected = performance.now();
        socket.terminate();
        await eventually(() => attempts.length >= 7, "retry after disconnection");
        const resetDelay = attempts[6] - disconnected;
        assert.ok(resetDelay >= 95 && resetDelay < 400, `Healthy session did not reset retry delay: ${resetDelay}ms`);

        const stopped = performance.now();
        provider.child.stdin.end("stop\n");
        await provider.success();
        assert.ok(performance.now() - stopped < 1000, "Close during backoff was not prompt");
        const count = attempts.length;
        await pause(650);
        assert.equal(attempts.length, count, "Explicit close left reconnect attempts running");
        console.log(`PASS: ${multiplexed ? "multiplex" : "direct"} exponential retry cap, temporary slot refusal, stable reset and stopping retries`);
    } finally {
        if (provider.child.exitCode === null) provider.child.kill();
        for (const client of server.clients) client.terminate();
        await new Promise(resolve => server.close(resolve));
    }
}

async function openingRetries(mode) {
    let attempts = 0;
    const server = new WebSocketServer({
        host: "127.0.0.1", port: 0,
        verifyClient: (_, done) => { attempts++; done(false, 503, "Temporarily unavailable"); },
    });
    await once(server, "listening");
    const provider = launch(mode, `ws://127.0.0.1:${server.address().port}/provider/wire`);
    try {
        if (mode !== "reconnect-disabled") {
            await provider.ready();
            await eventually(() => attempts >= 2, "repeated initial connection attempts");
            provider.child.stdin.end("stop\n");
        }
        await provider.success();
        const count = attempts;
        await pause(650);
        assert.equal(attempts, count, `${mode} left retries running`);
        if (mode === "reconnect-disabled") assert.equal(attempts, 1, "AutoReconnect=false retried a failure");
        console.log(`PASS: ${mode}`);
    } finally {
        if (provider.child.exitCode === null) provider.child.kill();
        for (const client of server.clients) client.terminate();
        await new Promise(resolve => server.close(resolve));
    }
}

async function interruptedSend() {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let connections = 0;
    let resolveRecovered;
    let rejectRecovered;
    const recovered = new Promise((resolve, reject) => { resolveRecovered = resolve; rejectRecovered = reject; });
    server.on("connection", socket => {
        const next = frames(socket);
        const first = ++connections === 1;
        (async () => {
            assert.equal((await next()).method, "notifications/register");
            if (first) {
                // Terminate while the handler sends bounded 4 MiB replies. The
                // small preceding frame lets the peer interrupt a native send.
                socket.once("message", data => {
                    assert.equal(JSON.parse(data.toString()).method, "reply-start");
                    socket.terminate();
                });
                socket.send(JSON.stringify({ jsonrpc: "2.0", id: "interrupted", method: "interrupt-reply" }));
            } else resolveRecovered({ socket, next });
        })().catch(rejectRecovered);
    });
    await once(server, "listening");
    const provider = launch("send-disconnect", `ws://127.0.0.1:${server.address().port}/provider/wire`);
    try {
        const { socket, next } = await deadline(recovered, "reconnection after handler send failed");
        socket.send(JSON.stringify({
            jsonrpc: "2.0", id: "after-send-failure", method: "tools/call",
            params: { name: "echo", arguments: { message: "recovered reply" } },
        }));
        assert.deepEqual((await next()).result.structuredContent, { message: "recovered reply" });
        assert.equal(connections, 2);
        provider.child.stdin.end("stop\n");
        await provider.success();
        console.log("PASS: handler reply interrupted by a socket failure reconnects and answers again");
    } finally {
        if (provider.child.exitCode === null) provider.child.kill();
        for (const client of server.clients) client.terminate();
        await new Promise(resolve => server.close(resolve));
    }
}

try {
    await roundtrip();
    await wire(false);
    await wire(true);
    await abnormalClose();
    await lifecycle("message-bounds");
    await lifecycle("handler-failure");
    await lifecycle("handler-websocket-failure");
    await interruptedSend();
    await brokerRestart();
    await retryBackoff(false);
    await retryBackoff(true);
    await openingRetries("cancel-opening");
    await openingRetries("close-opening");
    await openingRetries("reconnect-disabled");
} finally {
    for (const child of children) child.kill();
}
