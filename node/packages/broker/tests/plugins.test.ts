import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrokerPlugins, type IBrokerPluginConfig, type IBrokerPluginHandle } from "../src/plugins";
import { WsTunnelBuilder } from "../src/ws/ws.tunnel.builder";
import type { WsTunnel } from "../src/ws/ws.tunnel";

const events: string[] = [];
(globalThis as unknown as { pluginTestEvents: string[] }).pluginTestEvents = events;
const dirs: string[] = [];
const brokers: WsTunnel[] = [];
const handles: IBrokerPluginHandle[] = [];
const principals = new Map([["test-provider", { id: "test-provider", allowedResources: ["/**"] }]]);

function fixture(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), "broker-plugins-"));
    dirs.push(dir);
    writeFileSync(join(dir, "plugin.mjs"), source);
    return dir;
}

async function start(): Promise<WsTunnel> {
    const broker = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1").build();
    brokers.push(broker);
    await broker.start();
    return broker;
}

const entry = (module = "./plugin.mjs", extra: Partial<IBrokerPluginConfig> = {}): IBrokerPluginConfig => ({ id: "test", module, provider: "test-provider", ...extra });
const success = `export default { apiVersion: 1, async start(ctx, config) {
    globalThis.pluginTestEvents.push('start:' + config.name);
    ctx.onCleanup(() => globalThis.pluginTestEvents.push('cleanup:' + config.name));
    return { stop() { globalThis.pluginTestEvents.push('stop:' + config.name); } };
} };`;

afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
    for (const broker of brokers.splice(0)) await broker.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    events.length = 0;
});

describe("deployment plugins", () => {
    it("starts in configuration order and stops in reverse order, once", async () => {
        const baseDir = fixture(success);
        const handle = await startBrokerPlugins([entry(undefined, { config: { name: "a" } }), entry(undefined, { id: "second", config: { name: "b" } })], {
            tunnel: await start(),
            baseDir,
            principals,
        });
        handles.push(handle);
        await Promise.all([handle.stop(), handle.stop()]);
        expect(events).toEqual(["start:a", "start:b", "stop:b", "cleanup:b", "stop:a", "cleanup:a"]);
    });

    it("cleans a failed start and rolls back previously started required plugins", async () => {
        const baseDir = fixture(success);
        writeFileSync(
            join(baseDir, "failure.mjs"),
            `export default { apiVersion: 1, start(ctx) {
            ctx.onCleanup(() => globalThis.pluginTestEvents.push('partial-cleanup'));
            throw new Error('cannot start');
        } };`
        );
        await expect(
            startBrokerPlugins([entry(undefined, { config: { name: "a" } }), entry("./failure.mjs", { id: "broken" })], {
                tunnel: await start(),
                baseDir,
                principals,
            })
        ).rejects.toThrow('required plugin "broken" failed');
        expect(events).toEqual(["start:a", "partial-cleanup", "stop:a", "cleanup:a"]);
    });

    it("reports optional failures and continues, but refuses an unknown identity before importing", async () => {
        const baseDir = fixture(success);
        const logs: string[] = [];
        const handle = await startBrokerPlugins([entry("./missing.mjs", { provider: "unknown", required: false }), entry(undefined, { id: "good", config: { name: "good" } })], {
            tunnel: await start(),
            baseDir,
            principals,
            log: (line) => logs.push(line),
        });
        handles.push(handle);
        expect(logs[0]).toContain('provider "unknown" is not configured');
        expect(events).toEqual(["start:good"]);
    });

    it("rejects unsupported API versions, remote modules and duplicate ids", async () => {
        const baseDir = fixture(`export default { apiVersion: 2, start() {} };`);
        const options = { tunnel: await start(), baseDir, principals };
        await expect(startBrokerPlugins([entry()], options)).rejects.toThrow("apiVersion: 1");
        await expect(startBrokerPlugins([entry("https://example.com/plugin.mjs")], options)).rejects.toThrow("installed package or a local file path");
        await expect(startBrokerPlugins([entry(), entry()], options)).rejects.toThrow("duplicate plugin id");
        await expect(startBrokerPlugins({} as IBrokerPluginConfig[], options)).rejects.toThrow("plugins must be an array");
    });

    it("resolves installed package exports from a deployment directory", async () => {
        const baseDir = fixture(success);
        const moduleDirectory = join(baseDir, "deployment");
        const pkg = join(moduleDirectory, "node_modules", "example-plugin");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", exports: { ".": { import: "./index.mjs", default: "./index.mjs" } } }));
        writeFileSync(join(pkg, "index.mjs"), success);
        handles.push(await startBrokerPlugins([entry("example-plugin", { config: { name: "installed" } })], { tunnel: await start(), baseDir, moduleDirectory, principals }));
        expect(events).toEqual(["start:installed"]);
    });

    it("publishes and aggregates a loopback slot, then disconnects it on stop", async () => {
        const baseDir = fixture(`export default { apiVersion: 1, start(ctx) {
            const t = { onMessage: null, onOpen: null, onClose: null, onError: null, isOpen: true,
                send(text) { const q = JSON.parse(text); if (q.id === undefined) return;
                    const result = q.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } }
                        : q.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
                        : { content: [{ type: 'text', text: 'ok' }] };
                    queueMicrotask(() => t.onMessage?.(JSON.stringify({ jsonrpc: '2.0', id: q.id, result })));
                }, close() { t.isOpen = false; t.onClose?.(); }
            };
            ctx.registerSlot('echo', t);
            return { stop() {} };
        } };`);
        const tunnel = await start();
        const handle = await startBrokerPlugins([entry(undefined, { aggregate: true })], { tunnel, baseDir, principals });
        handles.push(handle);
        await expect.poll(() => tunnel.getProviderInfo("echo")?.aggregate).toBe(true);
        expect(tunnel.getProviderInfo("echo")?.connected).toBe(true);
        await handle.stop();
        expect(tunnel.getProviderInfo("echo")?.connected).toBe(false);
    });

    it("releases registered slots when plugin startup throws", async () => {
        const baseDir = fixture(`export default { apiVersion: 1, start(ctx) {
            ctx.registerSlot('partial', { onMessage: null, onOpen: null, onClose: null, onError: null, isOpen: true, send() {}, close() {} });
            throw new Error('partial failure');
        } };`);
        const tunnel = await start();
        await expect(startBrokerPlugins([entry()], { tunnel, baseDir, principals })).rejects.toThrow("partial failure");
        expect(tunnel.getProviderInfo("partial")?.connected).toBe(false);
    });
    it("attempts every disposal after an error and keeps shutdown idempotent", async () => {
        const baseDir = fixture(`export default { apiVersion: 1, start(ctx, config) {
            ctx.onCleanup(() => globalThis.pluginTestEvents.push('cleanup:' + config.name));
            return { stop() { globalThis.pluginTestEvents.push('stop:' + config.name); if (config.fail) throw new Error('stop failed'); } };
        } };`);
        const handle = await startBrokerPlugins([entry(undefined, { config: { name: "a" } }), entry(undefined, { id: "b", config: { name: "b", fail: true } })], {
            tunnel: await start(),
            baseDir,
            principals,
        });
        await expect(handle.stop()).rejects.toThrow("plugin shutdown failed");
        await expect(handle.stop()).rejects.toThrow("plugin shutdown failed");
        expect(events).toEqual(["stop:b", "cleanup:b", "stop:a", "cleanup:a"]);
    });

    it("does not permit a plugin to claim a reserved slot", async () => {
        const baseDir = fixture(`export default { apiVersion: 1, start(ctx) {
            ctx.registerSlot('_broker', {});
            return { stop() {} };
        } };`);
        await expect(startBrokerPlugins([entry()], { tunnel: await start(), baseDir, principals })).rejects.toThrow('reserved slot "_broker"');
    });

    it("enforces protected-slot ownership for plugins", async () => {
        const baseDir = fixture(`export default { apiVersion: 1, start(ctx) {
            ctx.registerSlot('protected', { onMessage: null, onOpen: null, onClose: null, onError: null, isOpen: true, send() {}, close() {} });
            return { stop() {} };
        } };`);
        const tunnel = new WsTunnelBuilder()
            .withPort(0)
            .withHost("127.0.0.1")
            .withProviderPrincipals([{ id: "owner", secret: "protected-slot-test", allowedResources: ["/**"] }])
            .withProtectedSlots({ protected: { declaredBy: "owner", publishedBy: "owner" } })
            .build();
        brokers.push(tunnel);
        await tunnel.start();
        await expect(startBrokerPlugins([entry()], { tunnel, baseDir, principals })).rejects.toThrow("the slot is protected");
        expect(tunnel.getProviderInfo("protected")?.connected ?? false).toBe(false);
    });
});
